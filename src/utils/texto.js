/**
 * Normaliza un texto en español replicando exactamente `public.plegar_acentos` de PostgreSQL:
 * recorta espacios en los extremos (`btrim`), pasa a minúsculas y pliega vocales con tilde,
 * acento grave, circunflejo, virgulilla o diéresis, conservando intacta la letra `ñ`.
 *
 * @param {string} texto
 * @returns {string}
 */
function plegarAcentos(texto) {
    if (typeof texto !== 'string') {
        return '';
    }

    return texto
        .normalize('NFC')
        .trim()
        .toLowerCase()
        .replace(/[áàäâã]/g, 'a')
        .replace(/[éèëê]/g, 'e')
        .replace(/[íìïî]/g, 'i')
        .replace(/[óòöôõ]/g, 'o')
        .replace(/[úùüû]/g, 'u');
}

/**
 * Limpia caracteres especiales que rompen o alteran la sintaxis de filtros `.or(...)` e `ilike`
 * en PostgREST (comas, paréntesis, comodines `%` y `_`, barras invertidas y caracteres de control),
 * devolviendo el término seguro recortado.
 *
 * @param {string} texto
 * @returns {string}
 */
function sanitizarTerminoBusquedaPostgrest(texto) {
    if (typeof texto !== 'string') {
        return '';
    }

    return texto
        .normalize('NFC')
        .replace(/[\u0000-\u001F\u007F,()%_\\]/g, '')
        .trim();
}

module.exports = {
    plegarAcentos,
    sanitizarTerminoBusquedaPostgrest,
};
