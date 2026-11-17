-- ============================================================================
-- Archivo: 003_catalogo_precios_y_granel.sql
-- Sprint 3: Catálogo completo por tienda, búsqueda UTF-8 sin sensibilidad a
--           acentos, botones de acceso rápido, control opcional de inventario
--           e historial inmutable de precios.
--
-- Prerrequisito:
--   Haber aplicado 001_tiendas_y_membresias.sql y 002_identidad_permisos_y_membresias.sql.
--
-- Qué hace esta migración (en una sola transacción atómica):
--   1. Crea función IMMUTABLE public.plegar_acentos(text) para búsquedas rápidas
--      insensibles a mayúsculas y tildes (ej. "jamon" encuentra "Jamón").
--   2. Extiende public.productos con:
--      - controla_inventario (boolean DEFAULT true)
--      - es_acceso_rapido (boolean DEFAULT false, botones grandes en mostrador)
--      - orden_acceso_rapido (integer DEFAULT 100)
--      - nombre_busqueda (columna generada normalizada para búsqueda instantánea)
--   3. Marca productos sin código existentes (ej. Queso Oaxaca, Jamón) con
--      es_acceso_rapido = true para reflejar la operación real de mostrador.
--   4. Crea tabla de auditoría inmutable public.producto_precios_historial
--      poblada exclusivamente mediante trigger SECURITY DEFINER al crear un
--      producto o modificar precio_centavos, protegiendo el historial frente a
--      alteraciones manuales por PostgREST.
-- ============================================================================

BEGIN;

-- 0. Comprobación defensiva de prerrequisitos
DO $$
BEGIN
    IF to_regclass('public.productos') IS NULL OR to_regclass('public.tiendas') IS NULL THEN
        RAISE EXCEPTION 'Aborta migración 003: faltan tablas base de Sprints 1-2.';
    END IF;
END $$;

-- 1. Función IMMUTABLE para normalizar texto en español (minúsculas + plegado de tildes/diéresis)
CREATE OR REPLACE FUNCTION public.plegar_acentos(p_texto text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = ''
AS $$
    SELECT translate(
        lower(btrim(p_texto)),
        'áàäâãéèëêíìïîóòöôõúùüûÁÀÄÂÃÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛ',
        'aaaaaeeeeiiiiooooouuuuaaaaaeeeeiiiiooooouuuu'
    );
$$;

-- 2. Nuevas columnas de catálogo en public.productos
ALTER TABLE public.productos
    ADD COLUMN IF NOT EXISTS controla_inventario boolean NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS es_acceso_rapido boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS orden_acceso_rapido integer NOT NULL DEFAULT 100,
    ADD COLUMN IF NOT EXISTS nombre_busqueda text GENERATED ALWAYS AS (
        public.plegar_acentos(nombre)
    ) STORED;

ALTER TABLE public.productos
    DROP CONSTRAINT IF EXISTS productos_orden_acceso_rapido_check;

ALTER TABLE public.productos
    ADD CONSTRAINT productos_orden_acceso_rapido_check CHECK (
        orden_acceso_rapido >= 1 AND orden_acceso_rapido <= 9999
    );

-- Activar acceso rápido por defecto en los productos a granel sin código ya existentes
UPDATE public.productos
SET es_acceso_rapido = true
WHERE codigo_barras IS NULL
  AND es_acceso_rapido = false;

-- Índices para búsqueda por tienda + texto normalizado y para botonera rápida de mostrador
CREATE INDEX IF NOT EXISTS productos_tienda_busqueda_idx
    ON public.productos (tienda_id, nombre_busqueda);

CREATE INDEX IF NOT EXISTS productos_tienda_acceso_rapido_idx
    ON public.productos (tienda_id, orden_acceso_rapido, nombre)
    WHERE (activo = true AND es_acceso_rapido = true);

-- 3. Tabla inmutable de historial de cambios de precio por producto
CREATE TABLE IF NOT EXISTS public.producto_precios_historial (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tienda_id uuid NOT NULL REFERENCES public.tiendas(id) ON DELETE CASCADE,
    producto_id uuid NOT NULL REFERENCES public.productos(id) ON DELETE CASCADE,
    precio_anterior_centavos integer,
    precio_nuevo_centavos integer NOT NULL,
    cambiado_por uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    cambiado_en timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT producto_precios_historial_anterior_check CHECK (
        precio_anterior_centavos IS NULL OR precio_anterior_centavos >= 0
    ),
    CONSTRAINT producto_precios_historial_nuevo_check CHECK (
        precio_nuevo_centavos >= 0
    )
);

CREATE INDEX IF NOT EXISTS producto_precios_historial_producto_fecha_idx
    ON public.producto_precios_historial (tienda_id, producto_id, cambiado_en DESC);

-- 4. Sembrar línea base de historial para productos existentes que aún no tengan registro inicial
INSERT INTO public.producto_precios_historial (
    tienda_id,
    producto_id,
    precio_anterior_centavos,
    precio_nuevo_centavos,
    cambiado_por,
    cambiado_en
)
SELECT
    p.tienda_id,
    p.id,
    NULL,
    p.precio_centavos,
    t.creado_por,
    p.creado_en
FROM public.productos AS p
INNER JOIN public.tiendas AS t
    ON t.id = p.tienda_id
WHERE NOT EXISTS (
    SELECT 1
    FROM public.producto_precios_historial AS h
    WHERE h.producto_id = p.id
);

-- 5. Trigger SECURITY DEFINER para registrar automáticamente altas y cambios de precio
CREATE OR REPLACE FUNCTION public.registrar_cambio_precio_producto()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO public.producto_precios_historial (
            tienda_id,
            producto_id,
            precio_anterior_centavos,
            precio_nuevo_centavos,
            cambiado_por
        )
        VALUES (
            NEW.tienda_id,
            NEW.id,
            NULL,
            NEW.precio_centavos,
            (SELECT auth.uid())
        );
        RETURN NEW;
    ELSIF TG_OP = 'UPDATE' AND OLD.precio_centavos IS DISTINCT FROM NEW.precio_centavos THEN
        INSERT INTO public.producto_precios_historial (
            tienda_id,
            producto_id,
            precio_anterior_centavos,
            precio_nuevo_centavos,
            cambiado_por
        )
        VALUES (
            NEW.tienda_id,
            NEW.id,
            OLD.precio_centavos,
            NEW.precio_centavos,
            (SELECT auth.uid())
        );
        RETURN NEW;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_productos_registrar_precio ON public.productos;
CREATE TRIGGER trg_productos_registrar_precio
AFTER INSERT OR UPDATE OF precio_centavos ON public.productos
FOR EACH ROW
EXECUTE FUNCTION public.registrar_cambio_precio_producto();

-- 6. Privilegios mínimos y RLS sobre public.producto_precios_historial
-- Nadie desde el cliente puede insertar, editar ni borrar historial; solo leer si es propietario o encargado.
REVOKE ALL ON TABLE public.producto_precios_historial FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.producto_precios_historial TO authenticated;

REVOKE ALL ON FUNCTION public.plegar_acentos(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.plegar_acentos(text) TO anon, authenticated;

ALTER TABLE public.producto_precios_historial ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS precios_historial_select_gestion ON public.producto_precios_historial;
CREATE POLICY precios_historial_select_gestion
    ON public.producto_precios_historial
    FOR SELECT
    TO authenticated
    USING (
        public.rol_activo_en_tienda(tienda_id) = ANY (ARRAY['propietario'::text, 'encargado'::text])
    );

COMMIT;

-- ============================================================================
-- Comprobación posterior de migración 003
-- ============================================================================
SELECT jsonb_build_object(
    'productos_catalogo_resumen', (
        SELECT coalesce(jsonb_agg(jsonb_build_object(
            'id', id,
            'nombre', nombre,
            'nombre_busqueda', nombre_busqueda,
            'unidad_venta', unidad_venta,
            'precio_centavos', precio_centavos,
            'controla_inventario', controla_inventario,
            'es_acceso_rapido', es_acceso_rapido,
            'orden_acceso_rapido', orden_acceso_rapido
        ) ORDER BY nombre), '[]'::jsonb)
        FROM public.productos
    ),
    'registros_historial_precios', (
        SELECT count(*) FROM public.producto_precios_historial
    )
) AS verificacion_migracion_003;
