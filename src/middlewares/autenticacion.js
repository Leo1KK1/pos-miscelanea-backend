const { crearClienteSupabase } = require('../config/supabase');
const { esUuidValido } = require('../utils/validaciones');
const { tienePermiso, obtenerPermisosDeRol } = require('../config/permisos');

/**
 * Verifica que la petición incluya un token JWT válido de Supabase Auth.
 */
async function verificarSesion(req, res, next) {
    const encabezado = req.headers.authorization || '';

    if (!encabezado.startsWith('Bearer ')) {
        return res.status(401).json({
            error: 'Debes enviar un token de acceso.',
            codigo: 'TOKEN_REQUERIDO',
        });
    }

    const token = encabezado.slice('Bearer '.length).trim();

    if (!token) {
        return res.status(401).json({
            error: 'El token de acceso está vacío.',
            codigo: 'TOKEN_REQUERIDO',
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
            codigo: 'SESION_INVALIDA_O_EXPIRADA',
        });
    }

    req.token = token;
    req.usuario = user;
    req.supabase = supabase;

    next();
}

/**
 * Fábrica de middleware que resuelve la tienda activa (por parámetro :tiendaId o encabezado X-Tienda-Id),
 * comprueba en base de datos que el usuario autenticado tenga membresía activa en dicha tienda
 * y evalúa permisos/roles requeridos.
 *
 * @param {object} opciones
 * @param {string[]} [opciones.rolesPermitidos] Lista opcional de roles autorizados (ej. ['propietario', 'encargado']).
 * @param {string} [opciones.permisoRequerido] Permiso opcional de la matriz central (ej. 'productos:crear').
 */
function verificarContextoTienda(opciones = {}) {
    const { rolesPermitidos = null, permisoRequerido = null } = opciones;

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

        if (
            idPorRuta &&
            idPorEncabezado &&
            idPorRuta.toLowerCase() !== idPorEncabezado.toLowerCase()
        ) {
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
            .select('id, tienda_id, usuario_id, rol, estado, tiendas!inner(*)')
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

        if (permisoRequerido && !tienePermiso(membresia.rol, permisoRequerido)) {
            return res.status(403).json({
                error: 'Tu rol en esta tienda no tiene permiso para realizar esta acción.',
                codigo: 'PERMISO_DENEGADO',
                permiso_requerido: permisoRequerido,
                rol_actual: membresia.rol,
            });
        }

        if (
            Array.isArray(rolesPermitidos) &&
            rolesPermitidos.length > 0 &&
            !rolesPermitidos.includes(membresia.rol)
        ) {
            return res.status(403).json({
                error: 'Tu rol en esta tienda no tiene permiso para realizar esta acción.',
                codigo: 'PERMISO_DENEGADO',
                rol_actual: membresia.rol,
            });
        }

        req.contextoTienda = {
            id: membresia.tiendas.id,
            nombre: membresia.tiendas.nombre,
            estado: membresia.tiendas.estado,
            estado_suscripcion: membresia.tiendas.estado_suscripcion ?? 'prueba',
            licencia_expira_en: membresia.tiendas.licencia_expira_en ?? null,
            ventana_offline_horas: membresia.tiendas.ventana_offline_horas ?? 96,
            rol: membresia.rol,
            membresia_id: membresia.id,
            permisos: obtenerPermisosDeRol(membresia.rol),
        };

        next();
    };
}

module.exports = {
    verificarSesion,
    verificarContextoTienda,
};
