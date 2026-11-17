const PATRON_UUID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Comprueba si un valor es un UUID válido (compatible con v4, v7 y variantes estándar RFC 9562).
 */
function esUuidValido(valor) {
    return typeof valor === 'string' && PATRON_UUID.test(valor.trim());
}

/**
 * Comprueba si una cadena es una fecha ISO-8601 válida para filtros de sincronización incremental.
 */
function esFechaIsoValida(valor) {
    if (typeof valor !== 'string' || !valor.trim()) {
        return false;
    }

    const marca = Date.parse(valor);
    return !Number.isNaN(marca);
}

module.exports = {
    esUuidValido,
    esFechaIsoValida,
};
