const express = require('express');
const {
    verificarSesion,
    verificarContextoTienda,
} = require('../middlewares/autenticacion');
const { ROLES, tienePermiso } = require('../config/permisos');
const { emitirConstanciaOffline } = require('../services/licenciaOffline.service');
const { esUuidValido } = require('../utils/validaciones');
const productosRouter = require('./productos.routes');
const inventarioRouter = require('./inventario.routes');

const router = express.Router();

const PATRON_EMAIL_BASICO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES_VALIDOS = Object.values(ROLES);
const ESTADOS_MEMBRESIA_VALIDOS = ['activo', 'suspendido'];

/**
 * Lista todas las tiendas activas donde el usuario autenticado posee una membresía activa.
 */
router.get('/', verificarSesion, async (req, res) => {
    const { data, error } = await req.supabase
        .from('miembros_tienda')
        .select('id, rol, estado, creado_en, tiendas!inner(*)')
        .eq('usuario_id', req.usuario.id)
        .eq('estado', 'activo')
        .eq('tiendas.estado', 'activa');

    if (error) {
        console.error('Error al consultar tiendas del usuario:', error.message);
        return res.status(500).json({
            error: 'No fue posible consultar tus tiendas asignadas.',
        });
    }

    const tiendas = (data || [])
        .map((membresia) => ({
            id: membresia.tiendas.id,
            nombre: membresia.tiendas.nombre,
            estado: membresia.tiendas.estado,
            estado_suscripcion: membresia.tiendas.estado_suscripcion ?? 'prueba',
            licencia_expira_en: membresia.tiendas.licencia_expira_en ?? null,
            ventana_offline_horas: membresia.tiendas.ventana_offline_horas ?? 96,
            rol: membresia.rol,
            membresia_id: membresia.id,
            creado_en: membresia.tiendas.creado_en,
            actualizado_en: membresia.tiendas.actualizado_en,
        }))
        .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));

    res.json({
        tiendas,
    });
});

/**
 * Crea una nueva tienda y asocia al usuario autenticado como propietario activo
 * en una sola transacción atómica (e idempotente si envía un UUID en `id`).
 */
router.post('/', verificarSesion, async (req, res) => {
    const { id, nombre } = req.body || {};

    if (
        typeof nombre !== 'string' ||
        nombre.trim().length < 1 ||
        nombre.trim().length > 120
    ) {
        return res.status(400).json({
            error: 'El nombre de la tienda debe tener entre 1 y 120 caracteres.',
        });
    }

    if (id !== undefined && id !== null && !esUuidValido(id)) {
        return res.status(400).json({
            error: 'El identificador opcional id debe ser un UUID válido.',
        });
    }

    const parametrosRpc = {
        p_nombre: nombre.trim(),
    };

    if (id) {
        parametrosRpc.p_tienda_id = id.trim();
    }

    const { data, error } = await req.supabase.rpc(
        'crear_tienda_con_propietario',
        parametrosRpc
    );

    if (error) {
        if (error.code === '23505') {
            return res.status(409).json({
                error: 'El identificador de tienda proporcionado ya existe.',
            });
        }

        console.error('Error al crear tienda:', error.message);
        return res.status(500).json({
            error: 'No fue posible crear la tienda.',
        });
    }

    const codigoEstado = data && data.idempotente ? 200 : 201;

    res.status(codigoEstado).json({
        mensaje:
            codigoEstado === 200
                ? 'La tienda ya estaba registrada (respuesta idempotente).'
                : 'Tienda creada correctamente.',
        idempotente: Boolean(data && data.idempotente),
        tienda: {
            ...data.tienda,
            rol: data.membresia.rol,
            membresia_id: data.membresia.id,
        },
    });
});

/**
 * Actualiza el nombre comercial de una tienda (exclusivo para el rol propietario).
 */
router.patch(
    '/:tiendaId',
    verificarSesion,
    verificarContextoTienda({ permisoRequerido: 'tienda:editar' }),
    async (req, res) => {
        const { nombre } = req.body || {};

        if (
            typeof nombre !== 'string' ||
            nombre.trim().length < 1 ||
            nombre.trim().length > 120
        ) {
            return res.status(400).json({
                error: 'El nombre de la tienda debe tener entre 1 y 120 caracteres.',
            });
        }

        const { data, error } = await req.supabase
            .from('tiendas')
            .update({ nombre: nombre.trim() })
            .eq('id', req.contextoTienda.id)
            .select('*')
            .single();

        if (error) {
            if (error.code === '42501') {
                return res.status(403).json({
                    error: 'No tienes permiso para actualizar esta tienda.',
                    codigo: 'PERMISO_DENEGADO',
                });
            }

            console.error('Error al actualizar tienda:', error.message);
            return res.status(500).json({
                error: 'No fue posible actualizar la tienda.',
            });
        }

        res.status(200).json({
            mensaje: 'Tienda actualizada correctamente.',
            tienda: data,
        });
    }
);

/**
 * Valida y confirma la selección de una tienda activa para operar en la sesión,
 * emitiendo además la constancia firmada Ed25519 para vigencia offline.
 */
router.get(
    '/:tiendaId/contexto',
    verificarSesion,
    verificarContextoTienda({ permisoRequerido: 'tienda:leer' }),
    (req, res) => {
        const constanciaOffline = emitirConstanciaOffline({
            tienda: req.contextoTienda,
            rol: req.contextoTienda.rol,
            usuarioId: req.usuario.id,
        });

        res.json({
            mensaje: 'Contexto de tienda verificado correctamente.',
            tienda_activa: req.contextoTienda,
            constancia_offline: constanciaOffline,
        });
    }
);

/**
 * Consulta los miembros registrados en una tienda (solo propietario o encargado).
 */
router.get(
    '/:tiendaId/miembros',
    verificarSesion,
    verificarContextoTienda({ permisoRequerido: 'miembros:leer' }),
    async (req, res) => {
        const { data: rpcData, error: rpcError } = await req.supabase.rpc(
            'listar_miembros_tienda',
            { p_tienda_id: req.contextoTienda.id }
        );

        if (!rpcError) {
            return res.json({
                tienda: {
                    id: req.contextoTienda.id,
                    nombre: req.contextoTienda.nombre,
                },
                miembros: Array.isArray(rpcData) ? rpcData : [],
            });
        }

        if (rpcError.code === '42501') {
            return res.status(403).json({
                error:
                    rpcError.message ||
                    'No tienes permiso para consultar los miembros de la tienda.',
                codigo: 'PERMISO_DENEGADO',
            });
        }

        // Fallback limpio si la migración 002 aún no se ha aplicado en la base de datos
        if (rpcError.code === 'PGRST202') {
            const { data, error } = await req.supabase
                .from('miembros_tienda')
                .select(
                    'id, tienda_id, usuario_id, rol, estado, creado_en, actualizado_en'
                )
                .eq('tienda_id', req.contextoTienda.id)
                .order('creado_en', { ascending: true });

            if (error) {
                console.error(
                    'Error al consultar miembros de tienda (fallback):',
                    error.message
                );
                return res.status(500).json({
                    error: 'No fue posible consultar los miembros de la tienda.',
                });
            }

            return res.json({
                tienda: {
                    id: req.contextoTienda.id,
                    nombre: req.contextoTienda.nombre,
                },
                miembros: data || [],
            });
        }

        console.error('Error al consultar miembros de tienda:', rpcError.message);
        return res.status(500).json({
            error: 'No fue posible consultar los miembros de la tienda.',
        });
    }
);

/**
 * Vincula un usuario registrado (por correo electrónico) como miembro de la tienda activa.
 */
router.post(
    '/:tiendaId/miembros',
    verificarSesion,
    verificarContextoTienda({ permisoRequerido: 'miembros:agregar' }),
    async (req, res) => {
        const { email, rol } = req.body || {};

        if (typeof email !== 'string' || !PATRON_EMAIL_BASICO.test(email.trim())) {
            return res.status(400).json({
                error: 'Debes proporcionar un correo electrónico válido.',
            });
        }

        if (typeof rol !== 'string' || !ROLES_VALIDOS.includes(rol)) {
            return res.status(400).json({
                error: 'El rol debe ser propietario, encargado o cajero.',
            });
        }

        if (req.contextoTienda.rol === ROLES.ENCARGADO && rol !== ROLES.CAJERO) {
            return res.status(403).json({
                error: 'Un encargado únicamente puede agregar miembros con rol de cajero.',
                codigo: 'JERARQUIA_ROL_INSUFICIENTE',
            });
        }

        const { data, error } = await req.supabase.rpc(
            'agregar_miembro_tienda',
            {
                p_tienda_id: req.contextoTienda.id,
                p_email: email.trim(),
                p_rol: rol,
            }
        );

        if (error) {
            if (error.code === 'P0002') {
                return res.status(404).json({
                    error:
                        error.message ||
                        'No existe una cuenta registrada con ese correo electrónico.',
                });
            }

            if (error.code === '23505') {
                return res.status(409).json({
                    error:
                        error.message ||
                        'El usuario ya tiene una membresía registrada en esta tienda.',
                });
            }

            if (error.code === '42501') {
                return res.status(403).json({
                    error:
                        error.message ||
                        'No tienes permiso para agregar este miembro a la tienda.',
                });
            }

            if (error.code === '22023') {
                return res.status(400).json({
                    error:
                        error.message ||
                        'Datos inválidos para agregar miembro a la tienda.',
                });
            }

            console.error('Error al agregar miembro a la tienda:', error.message);
            return res.status(500).json({
                error: 'No fue posible agregar el miembro a la tienda.',
            });
        }

        const esIdempotente = Boolean(data && data.idempotente === true);
        const codigoEstado = esIdempotente ? 200 : 201;

        res.status(codigoEstado).json({
            mensaje: esIdempotente
                ? 'El miembro ya estaba registrado con ese rol activo (respuesta idempotente).'
                : 'Miembro agregado correctamente a la tienda.',
            idempotente: esIdempotente,
            miembro: data.miembro,
        });
    }
);

/**
 * Actualiza el rol o el estado (activo / suspendido) de una membresía existente en la tienda.
 */
router.patch(
    '/:tiendaId/miembros/:miembroId',
    verificarSesion,
    verificarContextoTienda({ rolesPermitidos: ['propietario', 'encargado'] }),
    async (req, res) => {
        const { miembroId } = req.params;

        if (!esUuidValido(miembroId)) {
            return res.status(400).json({
                error: 'El identificador de membresía debe ser un UUID válido.',
            });
        }

        const { rol, estado } = req.body || {};
        const incluyeRol = rol !== undefined && rol !== null;
        const incluyeEstado = estado !== undefined && estado !== null;

        if (!incluyeRol && !incluyeEstado) {
            return res.status(400).json({
                error: 'Debes proporcionar al menos un nuevo rol o un nuevo estado.',
            });
        }

        if (incluyeRol) {
            if (!tienePermiso(req.contextoTienda.rol, 'miembros:cambiar_rol')) {
                return res.status(403).json({
                    error: 'Solo el propietario puede cambiar el rol de un miembro.',
                    codigo: 'PERMISO_DENEGADO',
                });
            }

            if (typeof rol !== 'string' || !ROLES_VALIDOS.includes(rol)) {
                return res.status(400).json({
                    error: 'El rol debe ser propietario, encargado o cajero.',
                });
            }
        }

        if (incluyeEstado) {
            if (
                !tienePermiso(req.contextoTienda.rol, 'miembros:cambiar_estado')
            ) {
                return res.status(403).json({
                    error: 'Tu rol no tiene permiso para cambiar el estado de miembros.',
                    codigo: 'PERMISO_DENEGADO',
                });
            }

            if (
                typeof estado !== 'string' ||
                !ESTADOS_MEMBRESIA_VALIDOS.includes(estado)
            ) {
                return res.status(400).json({
                    error: 'El estado de la membresía debe ser activo o suspendido.',
                });
            }
        }

        const { data, error } = await req.supabase.rpc(
            'actualizar_miembro_tienda',
            {
                p_tienda_id: req.contextoTienda.id,
                p_miembro_id: miembroId.trim(),
                p_nuevo_rol: incluyeRol ? rol : null,
                p_nuevo_estado: incluyeEstado ? estado : null,
            }
        );

        if (error) {
            if (error.code === 'P0002') {
                return res.status(404).json({
                    error:
                        error.message ||
                        'La membresía indicada no existe en esta tienda.',
                });
            }

            if (error.code === '42501') {
                return res.status(403).json({
                    error:
                        error.message ||
                        'No tienes permiso para modificar esta membresía.',
                });
            }

            if (error.code === '22023') {
                return res.status(400).json({
                    error:
                        error.message ||
                        'Datos inválidos para actualizar la membresía.',
                });
            }

            console.error('Error al actualizar membresía:', error.message);
            return res.status(500).json({
                error: 'No fue posible actualizar la membresía.',
            });
        }

        res.status(200).json({
            mensaje: 'Membresía actualizada correctamente.',
            miembro: data.miembro,
        });
    }
);

/**
 * Subruta anidada para operar productos indicando tiendaId en la URL:
 * /api/tiendas/:tiendaId/productos
 */
router.use('/:tiendaId/productos', productosRouter);

/**
 * Subruta anidada para operar existencias y movimientos de inventario por tienda:
 * /api/tiendas/:tiendaId/inventario
 */
router.use('/:tiendaId/inventario', inventarioRouter);

module.exports = router;
