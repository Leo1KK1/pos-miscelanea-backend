-- ============================================================================
-- Archivo: 003_rollback_catalogo_precios_y_granel.sql
-- Propósito:
--   Revertir en entorno de desarrollo los cambios de esquema introducidos por
--   003_catalogo_precios_y_granel.sql conservando intactos los productos,
--   tiendas y membresías de Sprints 1 y 2.
-- ============================================================================

BEGIN;

DROP TRIGGER IF EXISTS trg_productos_registrar_precio ON public.productos;
DROP FUNCTION IF EXISTS public.registrar_cambio_precio_producto();

DROP TABLE IF EXISTS public.producto_precios_historial;

DROP INDEX IF EXISTS public.productos_tienda_acceso_rapido_idx;
DROP INDEX IF EXISTS public.productos_tienda_busqueda_idx;

ALTER TABLE public.productos
    DROP CONSTRAINT IF EXISTS productos_orden_acceso_rapido_check,
    DROP COLUMN IF EXISTS nombre_busqueda,
    DROP COLUMN IF EXISTS orden_acceso_rapido,
    DROP COLUMN IF EXISTS es_acceso_rapido,
    DROP COLUMN IF EXISTS controla_inventario;

DROP FUNCTION IF EXISTS public.plegar_acentos(text);

COMMIT;
