-- ============================================================================
-- Archivo: 004_rollback_inventario_libro_mayor.sql
-- Propósito:
--   Revertir en entorno de desarrollo los objetos introducidos por
--   004_inventario_libro_mayor.sql conservando intactos los catálogos,
--   tiendas y membresías de Sprints 1 a 3.
-- ============================================================================

BEGIN;

DROP FUNCTION IF EXISTS public.registrar_movimiento_inventario(
    uuid, uuid, text, numeric, text, uuid, integer, timestamptz
);

DROP TRIGGER IF EXISTS trg_inventario_movimientos_aplicar_delta ON public.inventario_movimientos;
DROP FUNCTION IF EXISTS public.aplicar_delta_inventario_producto();

DROP TRIGGER IF EXISTS trg_inventario_movimientos_inmutable ON public.inventario_movimientos;
DROP FUNCTION IF EXISTS public.impedir_mutacion_inventario_movimientos();

DROP TABLE IF EXISTS public.inventario_movimientos;

-- Restaurar permisos de tabla general sobre public.productos de Sprints 1-3
GRANT INSERT, UPDATE ON TABLE public.productos TO authenticated;

ALTER TABLE public.productos
    DROP CONSTRAINT IF EXISTS productos_tienda_id_id_unico,
    DROP CONSTRAINT IF EXISTS productos_stock_minimo_check,
    DROP COLUMN IF EXISTS stock_minimo,
    DROP COLUMN IF EXISTS stock_actual;

COMMIT;
