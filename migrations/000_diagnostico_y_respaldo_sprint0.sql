-- ============================================================================
-- Archivo: 000_diagnostico_y_respaldo_sprint0.sql
-- Propósito:
--   1. Inspeccionar la estructura exacta actual de public.productos (columnas,
--      tipos de datos, restricciones e índices, políticas RLS) antes de diseñar
--      y aplicar la migración 001 del Sprint 1.
--   2. Crear un respaldo interno seguro en un esquema privado (private_backups)
--      que NO queda expuesto en la API PostgREST de Supabase.
--
-- Cómo usarlo en desarrollo:
--   Pega y ejecuta este script en el SQL Editor de Supabase.
--   Además, descarga en CSV/JSON el resultado de los productos hacia la carpeta
--   local backups/ (excluida en .gitignore).
-- ============================================================================

-- 1. Crear esquema privado para respaldos de migración (inaccesible vía API pública)
CREATE SCHEMA IF NOT EXISTS private_backups;
REVOKE ALL ON SCHEMA private_backups FROM PUBLIC;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        EXECUTE 'REVOKE ALL ON SCHEMA private_backups FROM anon';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        EXECUTE 'REVOKE ALL ON SCHEMA private_backups FROM authenticated';
    END IF;
END $$;

-- 2. Respaldar los datos actuales de public.productos (idempotente: reemplaza copia previa solo si se vuelve a correr antes de migrar)
CREATE TABLE IF NOT EXISTS private_backups.productos_pre_sprint1 AS
SELECT * FROM public.productos WITH NO DATA;

TRUNCATE TABLE private_backups.productos_pre_sprint1;

INSERT INTO private_backups.productos_pre_sprint1
SELECT * FROM public.productos;

-- 3. Diagnóstico completo en un solo JSON para revisar antes de correr 001_tiendas_y_membresias.sql
SELECT jsonb_build_object(
    'respaldo_filas_guardadas', (
        SELECT count(*) FROM private_backups.productos_pre_sprint1
    ),
    'productos_actuales_resumen', (
        SELECT coalesce(jsonb_agg(jsonb_build_object(
            'id', id,
            'propietario_id', propietario_id,
            'nombre', nombre,
            'codigo_barras', codigo_barras,
            'unidad_venta', unidad_venta,
            'precio_centavos', precio_centavos,
            'activo', activo
        )), '[]'::jsonb)
        FROM public.productos
    ),
    'columnas_productos', (
        SELECT coalesce(jsonb_agg(jsonb_build_object(
            'columna', column_name,
            'tipo', data_type,
            'udt', udt_name,
            'nullable', is_nullable,
            'default', column_default
        ) ORDER BY ordinal_position), '[]'::jsonb)
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'productos'
    ),
    'constraints_e_indices', (
        SELECT coalesce(jsonb_agg(jsonb_build_object(
            'nombre', conname,
            'tipo', contype,
            'definicion', pg_get_constraintdef(oid)
        )), '[]'::jsonb)
        FROM pg_constraint
        WHERE conrelid = 'public.productos'::regclass
    ),
    'indices', (
        SELECT coalesce(jsonb_agg(jsonb_build_object(
            'nombre', indexname,
            'definicion', indexdef
        )), '[]'::jsonb)
        FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'productos'
    ),
    'politicas_rls', (
        SELECT coalesce(jsonb_agg(jsonb_build_object(
            'policyname', policyname,
            'cmd', cmd,
            'roles', roles,
            'qual', qual,
            'with_check', with_check
        )), '[]'::jsonb)
        FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'productos'
    )
) AS diagnostico_sprint0;
