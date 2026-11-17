const express = require('express');
const {
    verificarSesion,
    verificarContextoTienda,
} = require('../middlewares/autenticacion');
const { esUuidValido } = require('../utils/validaciones');
const productosRouter = require('./productos.routes');

const router = express.Router();

/**
 * Lista todas las tiendas activas donde el usuario autenticado posee una membresía activa.
 */
router.get('/', verificarSesion, async (req, res) => {
    const { data, error } = await req.supabase
        .from('miembros_tienda')
        .select(
            'id, rol, estado, creado_en, tiendas!inner(id, nombre, estado, creado_en, actualizado_en)'
        )
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
 * Valida y confirma la selección de una tienda activa para operar en la sesión.
 */
router.get(
    '/:tiendaId/contexto',
    verificarSesion,
    verificarContextoTienda(),
    (req, res) => {
        res.json({
            mensaje: 'Contexto de tienda verificado correctamente.',
            tienda_activa: req.contextoTienda,
        });
    }
);

/**
 * Consulta los miembros registrados en una tienda (solo propietario o encargado).
 */
router.get(
    '/:tiendaId/miembros',
    verificarSesion,
    verificarContextoTienda({ rolesPermitidos: ['propietario', 'encargado'] }),
    async (req, res) => {
        const { data, error } = await req.supabase
            .from('miembros_tienda')
            .select('id, tienda_id, usuario_id, rol, estado, creado_en, actualizado_en')
            .eq('tienda_id', req.contextoTienda.id)
            .order('creado_en', { ascending: true });

        if (error) {
            console.error('Error al consultar miembros de tienda:', error.message);
            return res.status(500).json({
                error: 'No fue posible consultar los miembros de la tienda.',
            });
        }

        res.json({
            tienda: {
                id: req.contextoTienda.id,
                nombre: req.contextoTienda.nombre,
            },
            miembros: data,
        });
    }
);

/**
 * Subruta anidada para operar productos indicando tiendaId en la URL:
 * /api/tiendas/:tiendaId/productos
 */
router.use('/:tiendaId/productos', productosRouter);

module.exports = router;
