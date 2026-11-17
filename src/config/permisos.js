const ROLES = Object.freeze({
    PROPIETARIO: 'propietario',
    ENCARGADO: 'encargado',
    CAJERO: 'cajero',
});

const MATRIZ_PERMISOS = Object.freeze({
    'tienda:leer': Object.freeze(['propietario', 'encargado', 'cajero']),
    'tienda:editar': Object.freeze(['propietario']),
    'miembros:leer': Object.freeze(['propietario', 'encargado']),
    'miembros:agregar': Object.freeze(['propietario', 'encargado']),
    'miembros:cambiar_rol': Object.freeze(['propietario']),
    'miembros:cambiar_estado': Object.freeze(['propietario', 'encargado']),
    'productos:leer': Object.freeze(['propietario', 'encargado', 'cajero']),
    'productos:crear': Object.freeze(['propietario', 'encargado']),
    'productos:editar': Object.freeze(['propietario', 'encargado']),
    'productos:cambiar_precio': Object.freeze(['propietario', 'encargado']),
    'inventario:leer': Object.freeze(['propietario', 'encargado', 'cajero']),
    'inventario:kardex': Object.freeze(['propietario', 'encargado']),
    'inventario:registrar': Object.freeze(['propietario', 'encargado']),
    'inventario:ajustar': Object.freeze(['propietario', 'encargado']),
});

/**
 * Comprueba si un rol posee un permiso específico según la matriz centralizada.
 *
 * @param {string} rol
 * @param {string} permiso
 * @returns {boolean}
 */
function tienePermiso(rol, permiso) {
    if (typeof rol !== 'string' || typeof permiso !== 'string') {
        return false;
    }

    if (!Object.prototype.hasOwnProperty.call(MATRIZ_PERMISOS, permiso)) {
        return false;
    }

    return MATRIZ_PERMISOS[permiso].includes(rol);
}

/**
 * Devuelve la lista de permisos otorgados a un rol determinado.
 *
 * @param {string} rol
 * @returns {string[]}
 */
function obtenerPermisosDeRol(rol) {
    if (typeof rol !== 'string') {
        return [];
    }

    return Object.entries(MATRIZ_PERMISOS)
        .filter(([, rolesPermitidos]) => rolesPermitidos.includes(rol))
        .map(([permiso]) => permiso);
}

module.exports = {
    ROLES,
    MATRIZ_PERMISOS,
    tienePermiso,
    obtenerPermisosDeRol,
};
