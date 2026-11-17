-- ============================================================================
-- Archivo: 004_inventario_libro_mayor.sql
-- Sprint 4: Inventario como Libro Mayor (inventario_movimientos), compras
--           básicas, ajustes, mermas, alertas de bajo stock y stock negativo.
--
-- Prerrequisito:
--   Haber aplicado las migraciones 001, 002 y 003.
--
-- Qué hace esta migración (en una sola transacción atómica):
--   1. Agrega a public.productos las columnas stock_actual y stock_minimo
--      en NUMERIC(12,3), más llave única compuesta (tienda_id, id) para blindar
--      integridad referencial dentro de la misma tienda.
--   2. Blinda privilegios de columna en public.productos para que ningún cliente
--      autenticado pueda insertar ni sobrescribir stock_actual directamente por
--      PostgREST (Regla 3: stock_actual solo cambia sumando deltas del libro mayor).
--   3. Crea public.inventario_movimientos (append-only, inmutable ante UPDATE y
--      DELETE) con UUID, idempotencia, motivo obligatorio y validación de signo.
--   4. Crea trigger SECURITY DEFINER que actualiza productos.stock_actual
--      sumando algebraicamente cada delta insertado (permitiendo saldos negativos
--      con alerta sin bloquear ventas ni sincronizaciones diferidas).
--   5. Crea RPC transaccional e idempotente public.registrar_movimiento_inventario
--      restringida a propietario y encargado activos.
-- ============================================================================

BEGIN;

-- 0. Comprobación defensiva de prerrequisitos
DO $$
BEGIN
    IF to_regclass('public.productos') IS NULL OR to_regclass('public.producto_precios_historial') IS NULL THEN
        RAISE EXCEPTION 'Aborta migración 004: primero debes aplicar las migraciones 001, 002 y 003.';
    END IF;
END $$;

-- 1. Columnas de existencias y llave única compuesta por tienda en public.productos
ALTER TABLE public.productos
    ADD COLUMN IF NOT EXISTS stock_actual numeric(12,3) NOT NULL DEFAULT 0.000,
    ADD COLUMN IF NOT EXISTS stock_minimo numeric(12,3) NOT NULL DEFAULT 0.000;

ALTER TABLE public.productos
    DROP CONSTRAINT IF EXISTS productos_stock_minimo_check,
    DROP CONSTRAINT IF EXISTS productos_tienda_id_id_unico;

ALTER TABLE public.productos
    ADD CONSTRAINT productos_stock_minimo_check CHECK (stock_minimo >= 0),
    ADD CONSTRAINT productos_tienda_id_id_unico UNIQUE (tienda_id, id);

-- Blindaje de columnas en public.productos (Reglas 3 y 5):
-- authenticated NO puede hacer INSERT ni UPDATE sobre stock_actual (ni tienda_id/creado_en/actualizado_en)
REVOKE INSERT, UPDATE ON TABLE public.productos FROM authenticated;

GRANT INSERT (
    id,
    tienda_id,
    nombre,
    codigo_barras,
    unidad_venta,
    precio_centavos,
    controla_inventario,
    es_acceso_rapido,
    orden_acceso_rapido,
    stock_minimo,
    activo
) ON TABLE public.productos TO authenticated;

GRANT UPDATE (
    nombre,
    codigo_barras,
    unidad_venta,
    precio_centavos,
    controla_inventario,
    es_acceso_rapido,
    orden_acceso_rapido,
    stock_minimo,
    activo
) ON TABLE public.productos TO authenticated;

-- 2. Tabla Libro Mayor (Ledger) de movimientos de inventario
CREATE TABLE IF NOT EXISTS public.inventario_movimientos (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tienda_id uuid NOT NULL REFERENCES public.tiendas(id) ON DELETE RESTRICT,
    producto_id uuid NOT NULL,
    tipo_movimiento text NOT NULL,
    cantidad_delta numeric(12,3) NOT NULL,
    costo_total_centavos integer,
    motivo text NOT NULL,
    referencia_externa_id uuid,
    registrado_por uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    ocurrido_en timestamptz NOT NULL DEFAULT now(),
    creado_en timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT inventario_movimientos_producto_tienda_fkey
        FOREIGN KEY (tienda_id, producto_id)
        REFERENCES public.productos(tienda_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT inventario_movimientos_tipo_check CHECK (
        tipo_movimiento = ANY (
            ARRAY[
                'entrada_inicial'::text,
                'compra'::text,
                'venta'::text,
                'devolucion_cancelacion'::text,
                'merma'::text,
                'ajuste'::text
            ]
        )
    ),
    CONSTRAINT inventario_movimientos_signo_delta_check CHECK (
        cantidad_delta <> 0
        AND (
            (tipo_movimiento IN ('entrada_inicial', 'compra', 'devolucion_cancelacion') AND cantidad_delta > 0)
            OR (tipo_movimiento IN ('venta', 'merma') AND cantidad_delta < 0)
            OR (tipo_movimiento = 'ajuste' AND cantidad_delta <> 0)
        )
    ),
    CONSTRAINT inventario_movimientos_costo_check CHECK (
        costo_total_centavos IS NULL OR costo_total_centavos >= 0
    ),
    CONSTRAINT inventario_movimientos_motivo_check CHECK (
        char_length(btrim(motivo)) >= 1 AND char_length(btrim(motivo)) <= 280
    )
);

CREATE INDEX IF NOT EXISTS inventario_movimientos_tienda_producto_fecha_idx
    ON public.inventario_movimientos (tienda_id, producto_id, creado_en DESC);

CREATE INDEX IF NOT EXISTS inventario_movimientos_tienda_fecha_idx
    ON public.inventario_movimientos (tienda_id, creado_en DESC);

-- 3. Inmutabilidad estricta del libro mayor: prohibir UPDATE y DELETE incluso por accidente interno
CREATE OR REPLACE FUNCTION public.impedir_mutacion_inventario_movimientos()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    RAISE EXCEPTION 'El historial de inventario_movimientos es inmutable; registra un movimiento compensatorio de ajuste.'
        USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_inventario_movimientos_inmutable ON public.inventario_movimientos;
CREATE TRIGGER trg_inventario_movimientos_inmutable
BEFORE UPDATE OR DELETE ON public.inventario_movimientos
FOR EACH ROW
EXECUTE FUNCTION public.impedir_mutacion_inventario_movimientos();

-- 4. Trigger SECURITY DEFINER que suma algebraicamente el delta sobre productos.stock_actual
CREATE OR REPLACE FUNCTION public.aplicar_delta_inventario_producto()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    UPDATE public.productos
    SET stock_actual = stock_actual + NEW.cantidad_delta
    WHERE id = NEW.producto_id
      AND tienda_id = NEW.tienda_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'El producto % no pertenece a la tienda %.', NEW.producto_id, NEW.tienda_id
            USING ERRCODE = 'P0002';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_inventario_movimientos_aplicar_delta ON public.inventario_movimientos;
CREATE TRIGGER trg_inventario_movimientos_aplicar_delta
AFTER INSERT ON public.inventario_movimientos
FOR EACH ROW
EXECUTE FUNCTION public.aplicar_delta_inventario_producto();

-- 5. RPC transaccional e idempotente para movimientos operativos de inventario (Sprint 4)
CREATE OR REPLACE FUNCTION public.registrar_movimiento_inventario(
    p_tienda_id uuid,
    p_producto_id uuid,
    p_tipo_movimiento text,
    p_cantidad_delta numeric(12,3),
    p_motivo text,
    p_movimiento_id uuid DEFAULT gen_random_uuid(),
    p_costo_total_centavos integer DEFAULT NULL,
    p_ocurrido_en timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_uid uuid := (SELECT auth.uid());
    v_rol_actor text;
    v_tipo text := btrim(coalesce(p_tipo_movimiento, ''));
    v_motivo text := btrim(coalesce(p_motivo, ''));
    v_producto public.productos%ROWTYPE;
    v_existente public.inventario_movimientos%ROWTYPE;
    v_insertado public.inventario_movimientos%ROWTYPE;
    v_stock_anterior numeric(12,3);
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Autenticación requerida.'
            USING ERRCODE = '42501';
    END IF;

    v_rol_actor := public.rol_activo_en_tienda(p_tienda_id);

    IF v_rol_actor IS NULL OR v_rol_actor NOT IN ('propietario', 'encargado') THEN
        RAISE EXCEPTION 'Solo el propietario o un encargado activo pueden registrar movimientos manuales de inventario.'
            USING ERRCODE = '42501';
    END IF;

    IF v_tipo NOT IN ('entrada_inicial', 'compra', 'merma', 'ajuste') THEN
        RAISE EXCEPTION 'El tipo de movimiento manual debe ser entrada_inicial, compra, merma o ajuste.'
            USING ERRCODE = '22023';
    END IF;

    IF p_cantidad_delta IS NULL OR p_cantidad_delta = 0 THEN
        RAISE EXCEPTION 'La cantidad_delta del movimiento debe ser distinta de cero.'
            USING ERRCODE = '22023';
    END IF;

    IF v_tipo IN ('entrada_inicial', 'compra') AND p_cantidad_delta <= 0 THEN
        RAISE EXCEPTION 'Las entradas iniciales y compras requieren un delta positivo.'
            USING ERRCODE = '22023';
    END IF;

    IF v_tipo = 'merma' AND p_cantidad_delta >= 0 THEN
        RAISE EXCEPTION 'Las mermas requieren un delta negativo.'
            USING ERRCODE = '22023';
    END IF;

    IF char_length(v_motivo) < 1 OR char_length(v_motivo) > 280 THEN
        RAISE EXCEPTION 'El motivo del movimiento debe tener entre 1 y 280 caracteres.'
            USING ERRCODE = '22023';
    END IF;

    IF p_costo_total_centavos IS NOT NULL AND p_costo_total_centavos < 0 THEN
        RAISE EXCEPTION 'El costo_total_centavos no puede ser negativo.'
            USING ERRCODE = '22023';
    END IF;

    IF p_movimiento_id IS NULL THEN
        p_movimiento_id := gen_random_uuid();
    END IF;

    -- Idempotencia ante reintentos de red: si el UUID ya existe en esta tienda y producto, devolver sin duplicar
    SELECT *
    INTO v_existente
    FROM public.inventario_movimientos
    WHERE id = p_movimiento_id;

    IF FOUND THEN
        IF v_existente.tienda_id <> p_tienda_id OR v_existente.producto_id <> p_producto_id THEN
            RAISE EXCEPTION 'El identificador de movimiento ya fue utilizado para otro registro.'
                USING ERRCODE = '23505';
        END IF;

        SELECT *
        INTO v_producto
        FROM public.productos
        WHERE id = p_producto_id
          AND tienda_id = p_tienda_id;

        RETURN jsonb_build_object(
            'idempotente', true,
            'movimiento', jsonb_build_object(
                'id', v_existente.id,
                'tienda_id', v_existente.tienda_id,
                'producto_id', v_existente.producto_id,
                'tipo_movimiento', v_existente.tipo_movimiento,
                'cantidad_delta', v_existente.cantidad_delta,
                'costo_total_centavos', v_existente.costo_total_centavos,
                'motivo', v_existente.motivo,
                'registrado_por', v_existente.registrado_por,
                'ocurrido_en', v_existente.ocurrido_en,
                'creado_en', v_existente.creado_en
            ),
            'existencia', jsonb_build_object(
                'producto_id', v_producto.id,
                'nombre', v_producto.nombre,
                'unidad_venta', v_producto.unidad_venta,
                'stock_anterior', NULL,
                'stock_actual', v_producto.stock_actual,
                'stock_minimo', v_producto.stock_minimo,
                'alerta_bajo_stock', (v_producto.controla_inventario AND v_producto.stock_actual <= v_producto.stock_minimo),
                'alerta_stock_negativo', (v_producto.controla_inventario AND v_producto.stock_actual < 0)
            )
        );
    END IF;

    -- Bloquear fila del producto para garantizar consistencia concurrente dentro de la tienda
    SELECT *
    INTO v_producto
    FROM public.productos
    WHERE id = p_producto_id
      AND tienda_id = p_tienda_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'El producto no existe en la tienda activa.'
            USING ERRCODE = 'P0002';
    END IF;

    IF NOT v_producto.controla_inventario THEN
        RAISE EXCEPTION 'Este producto tiene desactivado controla_inventario; actívalo antes de registrar movimientos en su kardex.'
            USING ERRCODE = 'P0001';
    END IF;

    v_stock_anterior := v_producto.stock_actual;

    INSERT INTO public.inventario_movimientos (
        id,
        tienda_id,
        producto_id,
        tipo_movimiento,
        cantidad_delta,
        costo_total_centavos,
        motivo,
        registrado_por,
        ocurrido_en
    )
    VALUES (
        p_movimiento_id,
        p_tienda_id,
        p_producto_id,
        v_tipo,
        p_cantidad_delta,
        p_costo_total_centavos,
        v_motivo,
        v_uid,
        coalesce(p_ocurrido_en, now())
    )
    RETURNING * INTO v_insertado;

    -- Leer el producto ya actualizado por el trigger trg_inventario_movimientos_aplicar_delta
    SELECT *
    INTO v_producto
    FROM public.productos
    WHERE id = p_producto_id
      AND tienda_id = p_tienda_id;

    RETURN jsonb_build_object(
        'idempotente', false,
        'movimiento', jsonb_build_object(
            'id', v_insertado.id,
            'tienda_id', v_insertado.tienda_id,
            'producto_id', v_insertado.producto_id,
            'tipo_movimiento', v_insertado.tipo_movimiento,
            'cantidad_delta', v_insertado.cantidad_delta,
            'costo_total_centavos', v_insertado.costo_total_centavos,
            'motivo', v_insertado.motivo,
            'registrado_por', v_insertado.registrado_por,
            'ocurrido_en', v_insertado.ocurrido_en,
            'creado_en', v_insertado.creado_en
        ),
        'existencia', jsonb_build_object(
            'producto_id', v_producto.id,
            'nombre', v_producto.nombre,
            'unidad_venta', v_producto.unidad_venta,
            'stock_anterior', v_stock_anterior,
            'stock_actual', v_producto.stock_actual,
            'stock_minimo', v_producto.stock_minimo,
            'alerta_bajo_stock', (v_producto.controla_inventario AND v_producto.stock_actual <= v_producto.stock_minimo),
            'alerta_stock_negativo', (v_producto.controla_inventario AND v_producto.stock_actual < 0)
        )
    );
END;
$$;

-- 6. Privilegios mínimos y RLS en public.inventario_movimientos
REVOKE ALL ON TABLE public.inventario_movimientos FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.inventario_movimientos TO authenticated;

REVOKE ALL ON FUNCTION public.registrar_movimiento_inventario(
    uuid, uuid, text, numeric, text, uuid, integer, timestamptz
) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.registrar_movimiento_inventario(
    uuid, uuid, text, numeric, text, uuid, integer, timestamptz
) TO authenticated;

ALTER TABLE public.inventario_movimientos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS inventario_movimientos_select_gestion ON public.inventario_movimientos;
CREATE POLICY inventario_movimientos_select_gestion
    ON public.inventario_movimientos
    FOR SELECT
    TO authenticated
    USING (
        public.rol_activo_en_tienda(tienda_id) = ANY (ARRAY['propietario'::text, 'encargado'::text])
    );

COMMIT;

-- ============================================================================
-- Comprobación posterior de migración 004
-- ============================================================================
SELECT jsonb_build_object(
    'productos_existencias_base', (
        SELECT coalesce(jsonb_agg(jsonb_build_object(
            'id', id,
            'nombre', nombre,
            'unidad_venta', unidad_venta,
            'controla_inventario', controla_inventario,
            'stock_actual', stock_actual,
            'stock_minimo', stock_minimo
        ) ORDER BY nombre), '[]'::jsonb)
        FROM public.productos
    ),
    'movimientos_registrados', (
        SELECT count(*) FROM public.inventario_movimientos
    )
) AS verificacion_migracion_004;
