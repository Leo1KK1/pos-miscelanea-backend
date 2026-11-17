-- ============================================================================
-- Archivo: 001_tiendas_y_membresias.sql
-- Sprint 1: Tiendas, membresías multi-tienda, migración UUID de productos y RLS
--
-- Prerrequisito verificado:
--   Se ejecutó 000_diagnostico_y_respaldo_sprint0.sql respaldando las 3 filas
--   actuales ("Refresco de cola", "Queso Oaxaca", "Jamón") en
--   private_backups.productos_pre_sprint1.
--
-- Qué hace esta migración (en una sola transacción atómica):
--   1. Crea función y triggers de actualizado_en para sincronización incremental.
--   2. Crea public.tiendas y public.miembros_tienda con UUID y restricciones.
--   3. Migra public.productos de propietario_id -> tienda_id asignando los
--      productos actuales a "Tienda-Demo" y registrando al propietario actual
--      como miembro activo con rol 'propietario'.
--   4. Sustituye índices y políticas antiguas por políticas RLS multi-tienda
--      sin recursión (apoyadas en funciones SECURITY DEFINER acotadas a auth.uid()).
--   5. Crea RPC transaccional public.crear_tienda_con_propietario para dar de
--      alta nuevas tiendas junto con su membresía de propietario de forma atómica.
-- ============================================================================

BEGIN;

-- 0. Comprobación defensiva: verificar que exista el respaldo previo antes de migrar
DO $$
BEGIN
    IF to_regclass('private_backups.productos_pre_sprint1') IS NULL THEN
        RAISE EXCEPTION 'Aborta migración 001: primero ejecuta 000_diagnostico_y_respaldo_sprint0.sql para respaldar public.productos.';
    END IF;
END $$;

-- 1. Función reutilizable para mantener actualizado_en en cada UPDATE (útil para sync Offline-First)
CREATE OR REPLACE FUNCTION public.actualizar_marca_tiempo()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    NEW.actualizado_en := now();
    RETURN NEW;
END;
$$;

-- 2. Tabla de tiendas (UUID compatible con generación en cliente o servidor)
CREATE TABLE IF NOT EXISTS public.tiendas (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre text NOT NULL,
    estado text NOT NULL DEFAULT 'activa',
    creado_por uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    creado_en timestamptz NOT NULL DEFAULT now(),
    actualizado_en timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT tiendas_nombre_check CHECK (
        char_length(btrim(nombre)) >= 1 AND char_length(btrim(nombre)) <= 120
    ),
    CONSTRAINT tiendas_estado_check CHECK (
        estado = ANY (ARRAY['activa'::text, 'suspendida'::text])
    )
);

DROP TRIGGER IF EXISTS trg_tiendas_actualizado_en ON public.tiendas;
CREATE TRIGGER trg_tiendas_actualizado_en
BEFORE UPDATE ON public.tiendas
FOR EACH ROW
EXECUTE FUNCTION public.actualizar_marca_tiempo();

-- 3. Tabla de membresías usuario <-> tienda (relación única por tienda y usuario)
CREATE TABLE IF NOT EXISTS public.miembros_tienda (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tienda_id uuid NOT NULL REFERENCES public.tiendas(id) ON DELETE CASCADE,
    usuario_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    rol text NOT NULL,
    estado text NOT NULL DEFAULT 'activo',
    creado_en timestamptz NOT NULL DEFAULT now(),
    actualizado_en timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT miembros_tienda_usuario_unico UNIQUE (tienda_id, usuario_id),
    CONSTRAINT miembros_tienda_rol_check CHECK (
        rol = ANY (ARRAY['propietario'::text, 'encargado'::text, 'cajero'::text])
    ),
    CONSTRAINT miembros_tienda_estado_check CHECK (
        estado = ANY (ARRAY['activo'::text, 'suspendido'::text])
    )
);

CREATE INDEX IF NOT EXISTS miembros_tienda_usuario_estado_idx
    ON public.miembros_tienda (usuario_id, estado);

CREATE INDEX IF NOT EXISTS miembros_tienda_tienda_estado_idx
    ON public.miembros_tienda (tienda_id, estado);

DROP TRIGGER IF EXISTS trg_miembros_tienda_actualizado_en ON public.miembros_tienda;
CREATE TRIGGER trg_miembros_tienda_actualizado_en
BEFORE UPDATE ON public.miembros_tienda
FOR EACH ROW
EXECUTE FUNCTION public.actualizar_marca_tiempo();

-- 4. Preparar columnas nuevas en public.productos antes de migrar datos
ALTER TABLE public.productos
    ADD COLUMN IF NOT EXISTS tienda_id uuid REFERENCES public.tiendas(id) ON DELETE RESTRICT,
    ADD COLUMN IF NOT EXISTS actualizado_en timestamptz NOT NULL DEFAULT now();

DROP TRIGGER IF EXISTS trg_productos_actualizado_en ON public.productos;
CREATE TRIGGER trg_productos_actualizado_en
BEFORE UPDATE ON public.productos
FOR EACH ROW
EXECUTE FUNCTION public.actualizar_marca_tiempo();

-- 5. Migrar datos actuales de propietario_id hacia "Tienda-Demo"
DO $$
DECLARE
    v_total_propietarios integer;
    v_orden integer := 0;
    v_nombre_tienda text;
    v_nueva_tienda_id uuid;
    v_sin_tienda integer;
    r_prop RECORD;
BEGIN
    -- Solo ejecutar migración de propietario_id si la columna todavía existe
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'productos'
          AND column_name = 'propietario_id'
    ) THEN
        SELECT count(DISTINCT propietario_id)
        INTO v_total_propietarios
        FROM public.productos
        WHERE tienda_id IS NULL;

        FOR r_prop IN
            SELECT DISTINCT propietario_id
            FROM public.productos
            WHERE tienda_id IS NULL
            ORDER BY propietario_id
        LOOP
            v_orden := v_orden + 1;

            IF v_total_propietarios = 1 OR v_orden = 1 THEN
                v_nombre_tienda := 'Tienda-Demo';
            ELSE
                v_nombre_tienda := 'Tienda-Demo-' || left(r_prop.propietario_id::text, 8);
            END IF;

            INSERT INTO public.tiendas (nombre, estado, creado_por)
            VALUES (v_nombre_tienda, 'activa', r_prop.propietario_id)
            RETURNING id INTO v_nueva_tienda_id;

            INSERT INTO public.miembros_tienda (tienda_id, usuario_id, rol, estado)
            VALUES (v_nueva_tienda_id, r_prop.propietario_id, 'propietario', 'activo');

            UPDATE public.productos
            SET tienda_id = v_nueva_tienda_id
            WHERE propietario_id = r_prop.propietario_id
              AND tienda_id IS NULL;
        END LOOP;

        SELECT count(*)
        INTO v_sin_tienda
        FROM public.productos
        WHERE tienda_id IS NULL;

        IF v_sin_tienda > 0 THEN
            RAISE EXCEPTION 'Aborta migración 001: quedaron % productos sin tienda_id asignado.', v_sin_tienda;
        END IF;
    END IF;
END $$;

-- 6. Hacer tienda_id obligatorio y retirar dependencia antigua de propietario_id
ALTER TABLE public.productos
    ALTER COLUMN tienda_id SET NOT NULL;

-- Eliminar políticas RLS antiguas ligadas a propietario_id
DROP POLICY IF EXISTS "Consultar productos propios" ON public.productos;
DROP POLICY IF EXISTS "Crear productos propios" ON public.productos;

-- Eliminar índice único antiguo y llave foránea antigua
DROP INDEX IF EXISTS public.productos_codigo_por_propietario;
ALTER TABLE public.productos
    DROP CONSTRAINT IF EXISTS productos_propietario_id_fkey;

-- Retirar columna propietario_id (respaldada en private_backups.productos_pre_sprint1)
ALTER TABLE public.productos
    DROP COLUMN IF EXISTS propietario_id;

-- Crear nuevos índices multi-tienda y de sincronización incremental
CREATE UNIQUE INDEX IF NOT EXISTS productos_codigo_por_tienda
    ON public.productos (tienda_id, codigo_barras)
    WHERE (codigo_barras IS NOT NULL);

CREATE INDEX IF NOT EXISTS productos_tienda_nombre_idx
    ON public.productos (tienda_id, nombre);

CREATE INDEX IF NOT EXISTS productos_tienda_actualizado_idx
    ON public.productos (tienda_id, actualizado_en);

-- 7. Funciones auxiliares de autorización para RLS (sin recursión y con search_path fijo)
-- Nota de seguridad: Nunca aceptan un usuario arbitrario por parámetro; siempre evalúan auth.uid().
CREATE OR REPLACE FUNCTION public.rol_activo_en_tienda(p_tienda_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT m.rol
    FROM public.miembros_tienda AS m
    INNER JOIN public.tiendas AS t
        ON t.id = m.tienda_id
    WHERE m.tienda_id = p_tienda_id
      AND m.usuario_id = (SELECT auth.uid())
      AND m.estado = 'activo'
      AND t.estado = 'activa'
    LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.es_miembro_activo_tienda(p_tienda_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT public.rol_activo_en_tienda(p_tienda_id) IS NOT NULL;
$$;

-- 8. Función RPC transaccional e idempotente para crear una tienda nueva con su propietario
CREATE OR REPLACE FUNCTION public.crear_tienda_con_propietario(
    p_nombre text,
    p_tienda_id uuid DEFAULT gen_random_uuid()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_uid uuid := (SELECT auth.uid());
    v_nombre_limpio text := btrim(coalesce(p_nombre, ''));
    v_tienda public.tiendas%ROWTYPE;
    v_membresia public.miembros_tienda%ROWTYPE;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Autenticación requerida para crear una tienda.'
            USING ERRCODE = '42501';
    END IF;

    IF char_length(v_nombre_limpio) < 1 OR char_length(v_nombre_limpio) > 120 THEN
        RAISE EXCEPTION 'El nombre de la tienda debe tener entre 1 y 120 caracteres.'
            USING ERRCODE = '22023';
    END IF;

    IF p_tienda_id IS NULL THEN
        p_tienda_id := gen_random_uuid();
    END IF;

    -- Idempotencia: si el mismo propietario reintenta con el mismo UUID de tienda, devuelve el registro existente
    SELECT *
    INTO v_tienda
    FROM public.tiendas
    WHERE id = p_tienda_id;

    IF FOUND THEN
        SELECT *
        INTO v_membresia
        FROM public.miembros_tienda
        WHERE tienda_id = p_tienda_id
          AND usuario_id = v_uid
          AND rol = 'propietario';

        IF NOT FOUND THEN
            RAISE EXCEPTION 'El identificador de tienda ya está en uso.'
                USING ERRCODE = '23505';
        END IF;

        RETURN jsonb_build_object(
            'idempotente', true,
            'tienda', jsonb_build_object(
                'id', v_tienda.id,
                'nombre', v_tienda.nombre,
                'estado', v_tienda.estado,
                'creado_en', v_tienda.creado_en,
                'actualizado_en', v_tienda.actualizado_en
            ),
            'membresia', jsonb_build_object(
                'id', v_membresia.id,
                'rol', v_membresia.rol,
                'estado', v_membresia.estado
            )
        );
    END IF;

    INSERT INTO public.tiendas (id, nombre, estado, creado_por)
    VALUES (p_tienda_id, v_nombre_limpio, 'activa', v_uid)
    RETURNING * INTO v_tienda;

    INSERT INTO public.miembros_tienda (tienda_id, usuario_id, rol, estado)
    VALUES (v_tienda.id, v_uid, 'propietario', 'activo')
    RETURNING * INTO v_membresia;

    RETURN jsonb_build_object(
        'idempotente', false,
        'tienda', jsonb_build_object(
            'id', v_tienda.id,
            'nombre', v_tienda.nombre,
            'estado', v_tienda.estado,
            'creado_en', v_tienda.creado_en,
            'actualizado_en', v_tienda.actualizado_en
        ),
        'membresia', jsonb_build_object(
            'id', v_membresia.id,
            'rol', v_membresia.rol,
            'estado', v_membresia.estado
        )
    );
END;
$$;

-- 9. Privilegios mínimos explícitos (Regla 5: cerrar superficie innecesaria en PostgREST)
REVOKE ALL ON TABLE public.tiendas FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.miembros_tienda FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.productos FROM PUBLIC, anon, authenticated;

-- Tiendas: lectura vía RLS y actualización solo para propietario; altas vía RPC crear_tienda_con_propietario
GRANT SELECT, UPDATE ON TABLE public.tiendas TO authenticated;

-- Membresías: solo lectura en Sprint 1 (altas/cambios de rol se blindarán por RPC en Sprint 2)
GRANT SELECT ON TABLE public.miembros_tienda TO authenticated;

-- Productos: lectura para miembros activos; inserción/edición restringida por RLS a propietario/encargado
GRANT SELECT, INSERT, UPDATE ON TABLE public.productos TO authenticated;

-- Permisos de ejecución sobre funciones
REVOKE ALL ON FUNCTION public.rol_activo_en_tienda(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.es_miembro_activo_tienda(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.crear_tienda_con_propietario(text, uuid) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.rol_activo_en_tienda(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.es_miembro_activo_tienda(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.crear_tienda_con_propietario(text, uuid) TO authenticated;

-- 10. Activar Row Level Security y definir políticas explícitas sin recursión
ALTER TABLE public.tiendas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.miembros_tienda ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.productos ENABLE ROW LEVEL SECURITY;

-- Políticas de public.tiendas
DROP POLICY IF EXISTS tiendas_select_miembro_activo ON public.tiendas;
CREATE POLICY tiendas_select_miembro_activo
    ON public.tiendas
    FOR SELECT
    TO authenticated
    USING (public.es_miembro_activo_tienda(id));

DROP POLICY IF EXISTS tiendas_update_propietario ON public.tiendas;
CREATE POLICY tiendas_update_propietario
    ON public.tiendas
    FOR UPDATE
    TO authenticated
    USING (public.rol_activo_en_tienda(id) = 'propietario')
    WITH CHECK (public.rol_activo_en_tienda(id) = 'propietario');

-- Políticas de public.miembros_tienda (sin autorreferencia recursiva gracias a rol_activo_en_tienda)
DROP POLICY IF EXISTS miembros_select_propios_o_gestion ON public.miembros_tienda;
CREATE POLICY miembros_select_propios_o_gestion
    ON public.miembros_tienda
    FOR SELECT
    TO authenticated
    USING (
        usuario_id = (SELECT auth.uid())
        OR public.rol_activo_en_tienda(tienda_id) = ANY (ARRAY['propietario'::text, 'encargado'::text])
    );

-- Políticas de public.productos
DROP POLICY IF EXISTS productos_select_miembro_activo ON public.productos;
CREATE POLICY productos_select_miembro_activo
    ON public.productos
    FOR SELECT
    TO authenticated
    USING (public.es_miembro_activo_tienda(tienda_id));

DROP POLICY IF EXISTS productos_insert_roles_autorizados ON public.productos;
CREATE POLICY productos_insert_roles_autorizados
    ON public.productos
    FOR INSERT
    TO authenticated
    WITH CHECK (
        public.rol_activo_en_tienda(tienda_id) = ANY (ARRAY['propietario'::text, 'encargado'::text])
    );

DROP POLICY IF EXISTS productos_update_roles_autorizados ON public.productos;
CREATE POLICY productos_update_roles_autorizados
    ON public.productos
    FOR UPDATE
    TO authenticated
    USING (
        public.rol_activo_en_tienda(tienda_id) = ANY (ARRAY['propietario'::text, 'encargado'::text])
    )
    WITH CHECK (
        public.rol_activo_en_tienda(tienda_id) = ANY (ARRAY['propietario'::text, 'encargado'::text])
    );

COMMIT;

-- ============================================================================
-- Comprobación posterior de integridad (devuelve resumen de la migración)
-- ============================================================================
SELECT jsonb_build_object(
    'tiendas_creadas', (
        SELECT coalesce(jsonb_agg(jsonb_build_object(
            'id', id,
            'nombre', nombre,
            'estado', estado
        )), '[]'::jsonb)
        FROM public.tiendas
    ),
    'membresias_creadas', (
        SELECT coalesce(jsonb_agg(jsonb_build_object(
            'tienda_id', tienda_id,
            'usuario_id', usuario_id,
            'rol', rol,
            'estado', estado
        )), '[]'::jsonb)
        FROM public.miembros_tienda
    ),
    'productos_migrados', (
        SELECT coalesce(jsonb_agg(jsonb_build_object(
            'id', id,
            'tienda_id', tienda_id,
            'nombre', nombre,
            'codigo_barras', codigo_barras,
            'unidad_venta', unidad_venta,
            'precio_centavos', precio_centavos,
            'activo', activo
        ) ORDER BY nombre), '[]'::jsonb)
        FROM public.productos
    )
) AS verificacion_migracion_001;
