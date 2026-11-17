-- ============================================================================
-- Archivo: 002_identidad_permisos_y_membresias.sql
-- Sprint 2: Identidad, matriz de permisos en BD, gestión segura de membresías
--           y metadatos base para vigencia offline (Grace Period)
--
-- Prerrequisito:
--   Haber aplicado 001_tiendas_y_membresias.sql.
--
-- Qué hace esta migración (en una sola transacción atómica):
--   1. Agrega a public.tiendas los campos controlados de suscripción y ventana
--      offline (estado_suscripcion, licencia_expira_en, ventana_offline_horas)
--      protegidos contra edición por parte de usuarios autenticados.
--   2. Agrega rastro de auditoría agregado_por en public.miembros_tienda.
--   3. Restringe UPDATE en public.tiendas exclusivamente a la columna (nombre)
--      para que ningún usuario pueda auto-extender su licencia por PostgREST.
--   4. Crea funciones RPC SECURITY DEFINER (con search_path = '') para:
--      - listar_miembros_tienda(p_tienda_id)
--      - agregar_miembro_tienda(p_tienda_id, p_email, p_rol) (idempotente)
--      - actualizar_miembro_tienda(p_tienda_id, p_miembro_id, p_nuevo_rol, p_nuevo_estado)
--      aplicando estrictamente la jerarquía propietario > encargado > cajero y
--      evitando que una tienda quede sin propietarios activos.
-- ============================================================================

BEGIN;

-- 0. Comprobación defensiva de prerrequisito
DO $$
BEGIN
    IF to_regclass('public.tiendas') IS NULL OR to_regclass('public.miembros_tienda') IS NULL THEN
        RAISE EXCEPTION 'Aborta migración 002: primero debes aplicar 001_tiendas_y_membresias.sql.';
    END IF;
END $$;

-- 1. Metadatos de vigencia de suscripción y ventana offline en public.tiendas (Regla 6)
ALTER TABLE public.tiendas
    ADD COLUMN IF NOT EXISTS estado_suscripcion text NOT NULL DEFAULT 'prueba',
    ADD COLUMN IF NOT EXISTS licencia_expira_en timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
    ADD COLUMN IF NOT EXISTS ventana_offline_horas integer NOT NULL DEFAULT 96;

ALTER TABLE public.tiendas
    DROP CONSTRAINT IF EXISTS tiendas_estado_suscripcion_check,
    DROP CONSTRAINT IF EXISTS tiendas_ventana_offline_horas_check;

ALTER TABLE public.tiendas
    ADD CONSTRAINT tiendas_estado_suscripcion_check CHECK (
        estado_suscripcion = ANY (
            ARRAY['prueba'::text, 'activa'::text, 'vencida'::text, 'cancelada'::text, 'suspendida'::text]
        )
    ),
    ADD CONSTRAINT tiendas_ventana_offline_horas_check CHECK (
        ventana_offline_horas >= 1 AND ventana_offline_horas <= 720
    );

-- 2. Auditoría de quién registró cada membresía
ALTER TABLE public.miembros_tienda
    ADD COLUMN IF NOT EXISTS agregado_por uuid REFERENCES auth.users(id) ON DELETE SET NULL;

-- Completar agregado_por en membresías iniciales de propietario si estaba nulo
UPDATE public.miembros_tienda
SET agregado_por = usuario_id
WHERE rol = 'propietario'
  AND agregado_por IS NULL;

-- 3. Blindaje de privilegios de columna sobre public.tiendas (Regla 5)
-- Un propietario puede actualizar el nombre comercial de su tienda, pero JAMÁS
-- modificar estado, estado_suscripcion, licencia_expira_en ni ventana_offline_horas.
REVOKE UPDATE ON TABLE public.tiendas FROM authenticated;
GRANT UPDATE (nombre) ON TABLE public.tiendas TO authenticated;

-- 4. Actualizar crear_tienda_con_propietario para incluir metadatos de suscripción y agregado_por
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
                'estado_suscripcion', v_tienda.estado_suscripcion,
                'licencia_expira_en', v_tienda.licencia_expira_en,
                'ventana_offline_horas', v_tienda.ventana_offline_horas,
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

    INSERT INTO public.miembros_tienda (tienda_id, usuario_id, rol, estado, agregado_por)
    VALUES (v_tienda.id, v_uid, 'propietario', 'activo', v_uid)
    RETURNING * INTO v_membresia;

    RETURN jsonb_build_object(
        'idempotente', false,
        'tienda', jsonb_build_object(
            'id', v_tienda.id,
            'nombre', v_tienda.nombre,
            'estado', v_tienda.estado,
            'estado_suscripcion', v_tienda.estado_suscripcion,
            'licencia_expira_en', v_tienda.licencia_expira_en,
            'ventana_offline_horas', v_tienda.ventana_offline_horas,
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

-- 5. RPC: Listar miembros de una tienda con correo electrónico (solo propietario o encargado activos)
CREATE OR REPLACE FUNCTION public.listar_miembros_tienda(p_tienda_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_uid uuid := (SELECT auth.uid());
    v_rol_actor text;
    v_resultado jsonb;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Autenticación requerida.'
            USING ERRCODE = '42501';
    END IF;

    v_rol_actor := public.rol_activo_en_tienda(p_tienda_id);

    IF v_rol_actor IS NULL OR v_rol_actor NOT IN ('propietario', 'encargado') THEN
        RAISE EXCEPTION 'Solo el propietario o un encargado activo pueden consultar los miembros de la tienda.'
            USING ERRCODE = '42501';
    END IF;

    SELECT coalesce(
        jsonb_agg(
            jsonb_build_object(
                'id', m.id,
                'tienda_id', m.tienda_id,
                'usuario_id', m.usuario_id,
                'email', u.email,
                'rol', m.rol,
                'estado', m.estado,
                'agregado_por', m.agregado_por,
                'creado_en', m.creado_en,
                'actualizado_en', m.actualizado_en
            )
            ORDER BY m.creado_en ASC
        ),
        '[]'::jsonb
    )
    INTO v_resultado
    FROM public.miembros_tienda AS m
    INNER JOIN auth.users AS u
        ON u.id = m.usuario_id
    WHERE m.tienda_id = p_tienda_id;

    RETURN v_resultado;
END;
$$;

-- 6. RPC: Agregar / vincular un miembro a la tienda por correo registrado (atómica e idempotente)
CREATE OR REPLACE FUNCTION public.agregar_miembro_tienda(
    p_tienda_id uuid,
    p_email text,
    p_rol text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_uid uuid := (SELECT auth.uid());
    v_rol_actor text;
    v_email_limpio text := lower(btrim(coalesce(p_email, '')));
    v_rol_limpio text := btrim(coalesce(p_rol, ''));
    v_usuario_destino_id uuid;
    v_usuario_email text;
    v_membresia public.miembros_tienda%ROWTYPE;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Autenticación requerida.'
            USING ERRCODE = '42501';
    END IF;

    IF v_email_limpio = '' OR position('@' IN v_email_limpio) = 0 THEN
        RAISE EXCEPTION 'Debes proporcionar un correo electrónico válido.'
            USING ERRCODE = '22023';
    END IF;

    IF v_rol_limpio NOT IN ('propietario', 'encargado', 'cajero') THEN
        RAISE EXCEPTION 'El rol debe ser propietario, encargado o cajero.'
            USING ERRCODE = '22023';
    END IF;

    v_rol_actor := public.rol_activo_en_tienda(p_tienda_id);

    IF v_rol_actor IS NULL THEN
        RAISE EXCEPTION 'No tienes una membresía activa en esta tienda.'
            USING ERRCODE = '42501';
    END IF;

    IF v_rol_actor = 'cajero' THEN
        RAISE EXCEPTION 'Un cajero no tiene permiso para agregar miembros a la tienda.'
            USING ERRCODE = '42501';
    END IF;

    IF v_rol_actor = 'encargado' AND v_rol_limpio <> 'cajero' THEN
        RAISE EXCEPTION 'Un encargado únicamente puede agregar miembros con rol de cajero.'
            USING ERRCODE = '42501';
    END IF;

    SELECT u.id, u.email
    INTO v_usuario_destino_id, v_usuario_email
    FROM auth.users AS u
    WHERE lower(u.email) = v_email_limpio
      AND u.deleted_at IS NULL
    LIMIT 1;

    IF v_usuario_destino_id IS NULL THEN
        RAISE EXCEPTION 'No existe una cuenta registrada con ese correo electrónico.'
            USING ERRCODE = 'P0002';
    END IF;

    -- Comprobar si ya existe relación usuario <-> tienda
    SELECT *
    INTO v_membresia
    FROM public.miembros_tienda
    WHERE tienda_id = p_tienda_id
      AND usuario_id = v_usuario_destino_id;

    IF FOUND THEN
        IF v_membresia.rol = v_rol_limpio AND v_membresia.estado = 'activo' THEN
            RETURN jsonb_build_object(
                'idempotente', true,
                'miembro', jsonb_build_object(
                    'id', v_membresia.id,
                    'tienda_id', v_membresia.tienda_id,
                    'usuario_id', v_membresia.usuario_id,
                    'email', v_usuario_email,
                    'rol', v_membresia.rol,
                    'estado', v_membresia.estado,
                    'agregado_por', v_membresia.agregado_por,
                    'creado_en', v_membresia.creado_en,
                    'actualizado_en', v_membresia.actualizado_en
                )
            );
        END IF;

        RAISE EXCEPTION 'El usuario ya tiene una membresía registrada en esta tienda; modifica su rol o estado.'
            USING ERRCODE = '23505';
    END IF;

    INSERT INTO public.miembros_tienda (tienda_id, usuario_id, rol, estado, agregado_por)
    VALUES (p_tienda_id, v_usuario_destino_id, v_rol_limpio, 'activo', v_uid)
    RETURNING * INTO v_membresia;

    RETURN jsonb_build_object(
        'idempotente', false,
        'miembro', jsonb_build_object(
            'id', v_membresia.id,
            'tienda_id', v_membresia.tienda_id,
            'usuario_id', v_membresia.usuario_id,
            'email', v_usuario_email,
            'rol', v_membresia.rol,
            'estado', v_membresia.estado,
            'agregado_por', v_membresia.agregado_por,
            'creado_en', v_membresia.creado_en,
            'actualizado_en', v_membresia.actualizado_en
        )
    );
END;
$$;

-- 7. RPC: Actualizar rol o estado (suspender/reactivar) de un miembro respetando jerarquía
CREATE OR REPLACE FUNCTION public.actualizar_miembro_tienda(
    p_tienda_id uuid,
    p_miembro_id uuid,
    p_nuevo_rol text DEFAULT NULL,
    p_nuevo_estado text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_uid uuid := (SELECT auth.uid());
    v_rol_actor text;
    v_objetivo public.miembros_tienda%ROWTYPE;
    v_rol_final text;
    v_estado_final text;
    v_propietarios_activos integer;
    v_email_objetivo text;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Autenticación requerida.'
            USING ERRCODE = '42501';
    END IF;

    IF p_nuevo_rol IS NULL AND p_nuevo_estado IS NULL THEN
        RAISE EXCEPTION 'Debes indicar un nuevo rol o un nuevo estado.'
            USING ERRCODE = '22023';
    END IF;

    v_rol_actor := public.rol_activo_en_tienda(p_tienda_id);

    IF v_rol_actor IS NULL OR v_rol_actor = 'cajero' THEN
        RAISE EXCEPTION 'No tienes permiso para modificar membresías en esta tienda.'
            USING ERRCODE = '42501';
    END IF;

    SELECT *
    INTO v_objetivo
    FROM public.miembros_tienda
    WHERE id = p_miembro_id
      AND tienda_id = p_tienda_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'La membresía indicada no existe en esta tienda.'
            USING ERRCODE = 'P0002';
    END IF;

    IF v_objetivo.usuario_id = v_uid THEN
        RAISE EXCEPTION 'No puedes modificar tu propio rol ni suspender tu propia membresía.'
            USING ERRCODE = '42501';
    END IF;

    v_rol_final := coalesce(btrim(p_nuevo_rol), v_objetivo.rol);
    v_estado_final := coalesce(btrim(p_nuevo_estado), v_objetivo.estado);

    IF v_rol_final NOT IN ('propietario', 'encargado', 'cajero') THEN
        RAISE EXCEPTION 'El rol debe ser propietario, encargado o cajero.'
            USING ERRCODE = '22023';
    END IF;

    IF v_estado_final NOT IN ('activo', 'suspendido') THEN
        RAISE EXCEPTION 'El estado de la membresía debe ser activo o suspendido.'
            USING ERRCODE = '22023';
    END IF;

    -- Reglas de jerarquía: solo el propietario puede cambiar roles o tocar a propietarios/encargados
    IF v_rol_final <> v_objetivo.rol AND v_rol_actor <> 'propietario' THEN
        RAISE EXCEPTION 'Solo el propietario puede cambiar el rol de un miembro.'
            USING ERRCODE = '42501';
    END IF;

    IF v_rol_actor = 'encargado' AND v_objetivo.rol <> 'cajero' THEN
        RAISE EXCEPTION 'Un encargado solo puede suspender o reactivar miembros con rol de cajero.'
            USING ERRCODE = '42501';
    END IF;

    UPDATE public.miembros_tienda
    SET rol = v_rol_final,
        estado = v_estado_final
    WHERE id = p_miembro_id
      AND tienda_id = p_tienda_id
    RETURNING * INTO v_objetivo;

    -- Invariante de seguridad: toda tienda debe conservar al menos un propietario activo
    SELECT count(*)
    INTO v_propietarios_activos
    FROM public.miembros_tienda
    WHERE tienda_id = p_tienda_id
      AND rol = 'propietario'
      AND estado = 'activo';

    IF v_propietarios_activos < 1 THEN
        RAISE EXCEPTION 'Operación rechazada: la tienda debe mantener al menos un propietario activo.'
            USING ERRCODE = '42501';
    END IF;

    SELECT u.email
    INTO v_email_objetivo
    FROM auth.users AS u
    WHERE u.id = v_objetivo.usuario_id;

    RETURN jsonb_build_object(
        'miembro', jsonb_build_object(
            'id', v_objetivo.id,
            'tienda_id', v_objetivo.tienda_id,
            'usuario_id', v_objetivo.usuario_id,
            'email', v_email_objetivo,
            'rol', v_objetivo.rol,
            'estado', v_objetivo.estado,
            'agregado_por', v_objetivo.agregado_por,
            'creado_en', v_objetivo.creado_en,
            'actualizado_en', v_objetivo.actualizado_en
        )
    );
END;
$$;

-- 8. Permisos explícitos de ejecución sobre las nuevas funciones RPC
REVOKE ALL ON FUNCTION public.listar_miembros_tienda(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.agregar_miembro_tienda(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.actualizar_miembro_tienda(uuid, uuid, text, text) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.listar_miembros_tienda(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.agregar_miembro_tienda(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.actualizar_miembro_tienda(uuid, uuid, text, text) TO authenticated;

COMMIT;

-- ============================================================================
-- Comprobación posterior de migración 002
-- ============================================================================
SELECT jsonb_build_object(
    'tiendas_licencia_base', (
        SELECT coalesce(jsonb_agg(jsonb_build_object(
            'id', id,
            'nombre', nombre,
            'estado', estado,
            'estado_suscripcion', estado_suscripcion,
            'ventana_offline_horas', ventana_offline_horas,
            'licencia_expira_en', licencia_expira_en
        )), '[]'::jsonb)
        FROM public.tiendas
    ),
    'rpc_instaladas', (
        SELECT coalesce(jsonb_agg(proname ORDER BY proname), '[]'::jsonb)
        FROM pg_proc
        WHERE pronamespace = 'public'::regnamespace
          AND proname IN (
              'crear_tienda_con_propietario',
              'listar_miembros_tienda',
              'agregar_miembro_tienda',
              'actualizar_miembro_tienda',
              'rol_activo_en_tienda',
              'es_miembro_activo_tienda'
          )
    )
) AS verificacion_migracion_002;
