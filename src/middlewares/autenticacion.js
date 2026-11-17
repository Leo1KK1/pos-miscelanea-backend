const { crearClienteSupabase } = require('../config/supabase');
const { esUuidValido } = require('../utils/validaciones');

/**
 * Verifica que la petición incluya un token JWT válido de Supabase Auth.
 */
async function verificarSesion(req, res, next) {
    const encabezado = req.headers.authorization || '';

    if (!encabezado.startsWith('Bearer ')) {
        return res.status(401).json({
            error: 'Debes enviar un token de acceso.',
        });
    }

    const token = encabezado.slice('Bearer '.length).trim();

    if (!token) {
        return res.status(401).json({
            error: 'El token de acceso está vacío.',
        });
    }

    const supabase = crearClienteSupabase(token);

    const {
        data: { user },
        error,
    } = await supabase.auth.getUser(token);

    if (error || !user) {
        return res.status(401).json({
            error: 'La sesión no es válida o ha expirado.',
        });
    }

    req.token = token;
    req.usuario = user;
    req.supabase = supabase;

    next();
}

/**
 * Fábrica de middleware que resuelve la tienda activa (por parámetro :tiendaId o encabezado X-Tienda-Id)
 * y comprueba en base de datos que el usuario autenticado tenga membresía activa en dicha tienda.
 *
 * @param {object} opciones
 * @param {string[]} [opciones.rolesPermitidos] Lista opcional de roles autorizados (ej. ['propietario', 'encargado']).
 */
function verificarContextoTienda(opciones = {}) {
    const { rolesPermitidos = null } = opciones;

    return async function middlewareContextoTienda(req, res, next) {
        const idPorRuta =
            typeof req.params.tiendaId === 'string'
                ? req.params.tiendaId.trim()
                : '';
        const encabezadoTienda = req.headers['x-tienda-id'];
        const idPorEncabezado =
            typeof encabezadoTienda === 'string'
                ? encabezadoTienda.trim()
                : '';

        if (idPorRuta && idPorEncabezado && idPorRuta.toLowerCase() !== idPorEncabezado.toLowerCase()) {
            return res.status(400).json({
                error: 'El identificador de tienda en la ruta no coincide con el encabezado X-Tienda-Id.',
            });
        }

        const tiendaId = idPorRuta || idPorEncabezado;

        if (!tiendaId) {
            return res.status(400).json({
                error: 'Debes indicar la tienda activa mediante el encabezado X-Tienda-Id o en la ruta.',
            });
        }

        if (!esUuidValido(tiendaId)) {
            return res.status(400).json({
                error: 'El identificador de tienda (tienda_id) debe ser un UUID válido.',
            });
        }

        const { data: membresia, error } = await req.supabase
            .from('miembros_tienda')
            .select(
                'id, tienda_id, usuario_id, rol, estado, tiendas!inner(id, nombre, estado, creado_en, actualizado_en)'
            )
            .eq('tienda_id', tiendaId)
            .eq('usuario_id', req.usuario.id)
            .eq('estado', 'activo')
            .maybeSingle();

        if (error) {
            console.error('Error al verificar membresía de tienda:', error.message);
            return res.status(500).json({
                error: 'No fue posible validar el acceso a la tienda seleccionada.',
            });
        }

        if (!membresia || !membresia.tiendas || membresia.tiendas.estado !== 'activa') {
            return res.status(403).json({
                error: 'No tienes una membresía activa en la tienda solicitada.',
            });
        }

        if (
            Array.isArray(rolesPermitidos) &&
            rolesPermitidos.length > 0 &&
            !rolesPermitidos.includes(membresia.rol)
        ) {
            return res.status(403).json({
                error: 'Tu rol en esta tienda no tiene permiso para realizar esta acción.',
            });
        }

        req.contextoTienda = {
            id: membresia.tiendas.id,
            nombre: membresia.tiendas.nombre,
            estado: membresia.tiendas.estado,
            rol: membresia.rol,
            membresia_id: membresia.id,
        };

        next();
    };
}

module.exports = {
    verificarSesion,
    verificarContextoTienda,
};
