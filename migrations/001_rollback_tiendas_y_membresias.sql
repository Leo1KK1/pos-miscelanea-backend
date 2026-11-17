-- ============================================================================
-- Archivo: 001_rollback_tiendas_y_membresias.sql
-- Propósito:
--   Revertir de forma segura en entorno de desarrollo la migración
--   001_tiendas_y_membresias.sql, restaurando propietario_id, índices y
--   políticas RLS originales sobre public.productos sin perder datos.
-- ============================================================================

BEGIN;

-- 1. Reagregar propietario_id a public.productos
ALTER TABLE public.productos
    ADD COLUMN IF NOT EXISTS propietario_id uuid;

-- 2. Restaurar propietario_id desde el respaldo previo o desde el propietario de la tienda
UPDATE public.productos AS p
SET propietario_id = b.propietario_id
FROM private_backups.productos_pre_sprint1 AS b
WHERE p.id = b.id
  AND p.propietario_id IS NULL;

UPDATE public.productos AS p
SET propietario_id = m.usuario_id
FROM public.miembros_tienda AS m
WHERE p.tienda_id = m.tienda_id
  AND m.rol = 'propietario'
  AND p.propietario_id IS NULL;

DO $$
DECLARE
    v_huerfanos integer;
BEGIN
    SELECT count(*) INTO v_huerfanos
    FROM public.productos
    WHERE propietario_id IS NULL;

    IF v_huerfanos > 0 THEN
        RAISE EXCEPTION 'No se puede completar rollback: % productos no tienen propietario_id recuperable.', v_huerfanos;
    END IF;
END $$;

ALTER TABLE public.productos
    ALTER COLUMN propietario_id SET NOT NULL;

ALTER TABLE public.productos
    DROP CONSTRAINT IF EXISTS productos_propietario_id_fkey;

ALTER TABLE public.productos
    ADD CONSTRAINT productos_propietario_id_fkey
    FOREIGN KEY (propietario_id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- 3. Quitar políticas nuevas y restaurar políticas e índices originales de productos
DROP POLICY IF EXISTS productos_select_miembro_activo ON public.productos;
DROP POLICY IF EXISTS productos_insert_roles_autorizados ON public.productos;
DROP POLICY IF EXISTS productos_update_roles_autorizados ON public.productos;

DROP INDEX IF EXISTS public.productos_codigo_por_tienda;
DROP INDEX IF EXISTS public.productos_tienda_nombre_idx;
DROP INDEX IF EXISTS public.productos_tienda_actualizado_idx;

DROP TRIGGER IF EXISTS trg_productos_actualizado_en ON public.productos;

ALTER TABLE public.productos
    DROP COLUMN IF EXISTS tienda_id,
    DROP COLUMN IF EXISTS actualizado_en;

CREATE UNIQUE INDEX IF NOT EXISTS productos_codigo_por_propietario
    ON public.productos (propietario_id, codigo_barras)
    WHERE (codigo_barras IS NOT NULL);

GRANT SELECT, INSERT ON TABLE public.productos TO authenticated;

CREATE POLICY "Consultar productos propios"
    ON public.productos
    FOR SELECT
    TO authenticated
    USING (propietario_id = (SELECT auth.uid() AS uid));

CREATE POLICY "Crear productos propios"
    ON public.productos
    FOR INSERT
    TO authenticated
    WITH CHECK (propietario_id = (SELECT auth.uid() AS uid));

-- 4. Eliminar funciones y tablas introducidas en Sprint 1
DROP FUNCTION IF EXISTS public.crear_tienda_con_propietario(text, uuid);
DROP FUNCTION IF EXISTS public.es_miembro_activo_tienda(uuid);
DROP FUNCTION IF EXISTS public.rol_activo_en_tienda(uuid);

DROP TABLE IF EXISTS public.miembros_tienda;
DROP TABLE IF EXISTS public.tiendas;
DROP FUNCTION IF EXISTS public.actualizar_marca_tiempo();

COMMIT;
