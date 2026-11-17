-- ============================================================================
-- Archivo: 002_rollback_identidad_permisos_y_membresias.sql
-- Propósito:
--   Revertir de forma segura en desarrollo los objetos introducidos por
--   002_identidad_permisos_y_membresias.sql conservando las tablas y datos
--   del Sprint 1.
-- ============================================================================

BEGIN;

DROP FUNCTION IF EXISTS public.actualizar_miembro_tienda(uuid, uuid, text, text);
DROP FUNCTION IF EXISTS public.agregar_miembro_tienda(uuid, text, text);
DROP FUNCTION IF EXISTS public.listar_miembros_tienda(uuid);

-- Restaurar privilegio UPDATE general de Sprint 1 en tiendas
GRANT UPDATE ON TABLE public.tiendas TO authenticated;

ALTER TABLE public.miembros_tienda
    DROP COLUMN IF EXISTS agregado_por;

ALTER TABLE public.tiendas
    DROP CONSTRAINT IF EXISTS tiendas_estado_suscripcion_check,
    DROP CONSTRAINT IF EXISTS tiendas_ventana_offline_horas_check,
    DROP COLUMN IF EXISTS estado_suscripcion,
    DROP COLUMN IF EXISTS licencia_expira_en,
    DROP COLUMN IF EXISTS ventana_offline_horas;

-- Restaurar versión Sprint 1 de crear_tienda_con_propietario
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

GRANT EXECUTE ON FUNCTION public.crear_tienda_con_propietario(text, uuid) TO authenticated;

COMMIT;
