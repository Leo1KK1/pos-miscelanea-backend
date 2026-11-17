const UNIDADES_VENTA_VALIDAS = Object.freeze(['pieza', 'kg', 'litro']);

// Máximo para NUMERIC(12,3): 999999999.999 unidades = 999_999_999_999 milésimas
const MAX_MILESIMAS = 999999999999n;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const PATRON_DECIMAL_MILESIMAS = /^\d+(?:\.\d{1,3})?$/;

/**
 * Error de dominio para validaciones y cálculos de venta a granel / por importe,
 * con propiedad `codigo` mapeable a respuestas HTTP 400.
 */
class ErrorCalculoGranel extends Error {
    /**
     * @param {string} mensaje
     * @param {string} codigo
     */
    constructor(mensaje, codigo) {
        super(mensaje);
        this.name = 'ErrorCalculoGranel';
        this.codigo = codigo;
    }
}

/**
 * Convierte una cantidad positiva (número finito o cadena decimal sin notación científica,
 * hasta 3 decimales, compatible con NUMERIC(12,3)) a milésimas exactas como `BigInt`,
 * evitando por completo errores de coma flotante IEEE-754.
 *
 * @param {number|string} cantidad
 * @returns {bigint}
 */
function parsearCantidadAMilesimas(cantidad) {
    let texto;

    if (typeof cantidad === 'number') {
        if (!Number.isFinite(cantidad) || cantidad <= 0) {
            throw new ErrorCalculoGranel(
                'La cantidad debe ser un número positivo válido.',
                'CANTIDAD_INVALIDA'
            );
        }
        texto = String(cantidad);
    } else if (typeof cantidad === 'string') {
        texto = cantidad.trim();
    } else {
        throw new ErrorCalculoGranel(
            'La cantidad debe enviarse como número positivo o cadena decimal válida.',
            'CANTIDAD_INVALIDA'
        );
    }

    if (!PATRON_DECIMAL_MILESIMAS.test(texto)) {
        throw new ErrorCalculoGranel(
            'La cantidad debe ser un valor decimal positivo sin notación científica y con un máximo de 3 decimales.',
            'CANTIDAD_INVALIDA'
        );
    }

    const [parteEnteraStr, parteDecimalStr = ''] = texto.split('.');
    const parteDecimalPadded = parteDecimalStr.padEnd(3, '0');
    const milesimas =
        BigInt(parteEnteraStr) * 1000n + BigInt(parteDecimalPadded);

    if (milesimas <= 0n || milesimas > MAX_MILESIMAS) {
        throw new ErrorCalculoGranel(
            'La cantidad está fuera del rango permitido (0.001 a 999999999.999).',
            'CANTIDAD_INVALIDA'
        );
    }

    return milesimas;
}

/**
 * Formatea una cantidad expresada en milésimas (`BigInt`) a representación `NUMERIC(12,3)`
 * con exactamente 3 decimales y su equivalente numérico.
 *
 * @param {bigint} milesimasBigInt
 * @returns {{ cantidad: string, cantidad_numerica: number }}
 */
function formatearMilesimasACantidad(milesimasBigInt) {
    if (typeof milesimasBigInt !== 'bigint' || milesimasBigInt < 0n) {
        throw new ErrorCalculoGranel(
            'Las milésimas a formatear deben ser un BigInt mayor o igual a cero.',
            'CANTIDAD_INVALIDA'
        );
    }

    const entero = milesimasBigInt / 1000n;
    const fraccion = (milesimasBigInt % 1000n).toString().padStart(3, '0');
    const cantidad = `${entero.toString()}.${fraccion}`;

    return {
        cantidad,
        cantidad_numerica: Number(cantidad),
    };
}

/**
 * Obtiene la etiqueta descriptiva de la unidad base en milésimas según la unidad de venta.
 *
 * @param {'pieza'|'kg'|'litro'} unidadVenta
 * @returns {'gramos'|'mililitros'|'milesimas_pieza'}
 */
function obtenerUnidadBaseMilesimas(unidadVenta) {
    if (unidadVenta === 'kg') {
        return 'gramos';
    }
    if (unidadVenta === 'litro') {
        return 'mililitros';
    }
    return 'milesimas_pieza';
}

/**
 * Cotiza un artículo a partir de su cantidad solicitada (`pieza`, `kg` o `litro`)
 * y su precio unitario en centavos enteros, aplicando redondeo comercial half-up
 * exacto al centavo más cercano con `BigInt`.
 *
 * @param {object} parametros
 * @param {'pieza'|'kg'|'litro'} parametros.unidad_venta
 * @param {number|string} parametros.cantidad
 * @param {number} parametros.precio_unitario_centavos
 */
function cotizarPorCantidad(parametros) {
    const { unidad_venta, cantidad, precio_unitario_centavos } =
        parametros || {};

    if (!UNIDADES_VENTA_VALIDAS.includes(unidad_venta)) {
        throw new ErrorCalculoGranel(
            'La unidad de venta debe ser pieza, kg o litro.',
            'UNIDAD_INVALIDA'
        );
    }

    if (
        !Number.isSafeInteger(precio_unitario_centavos) ||
        precio_unitario_centavos < 0
    ) {
        throw new ErrorCalculoGranel(
            'El precio unitario debe ser un número entero de centavos mayor o igual a cero.',
            'PRECIO_INVALIDO'
        );
    }

    const milesimas = parsearCantidadAMilesimas(cantidad);

    if (unidad_venta === 'pieza' && milesimas % 1000n !== 0n) {
        throw new ErrorCalculoGranel(
            'Los productos vendidos por pieza requieren una cantidad entera.',
            'CANTIDAD_PIEZA_NO_ENTERA'
        );
    }

    const subtotalBig =
        (milesimas * BigInt(precio_unitario_centavos) + 500n) / 1000n;

    if (subtotalBig > MAX_SAFE_BIGINT) {
        throw new ErrorCalculoGranel(
            'El subtotal calculado excede el rango entero seguro.',
            'PRECIO_INVALIDO'
        );
    }

    const { cantidad: cantidadFormateada, cantidad_numerica } =
        formatearMilesimasACantidad(milesimas);
    const subtotalCentavos = Number(subtotalBig);

    return {
        modo: 'por_cantidad',
        unidad_venta,
        cantidad: cantidadFormateada,
        cantidad_numerica,
        cantidad_milesimas: Number(milesimas),
        unidad_base_milesimas: obtenerUnidadBaseMilesimas(unidad_venta),
        precio_unitario_historico_centavos: precio_unitario_centavos,
        subtotal_cobrado_centavos: subtotalCentavos,
        subtotal_teorico_por_peso_centavos: subtotalCentavos,
        diferencia_redondeo_centavos: 0,
    };
}

/**
 * Flujo inverso de miscelánea ("deme $15 de jamón"): calcula la cantidad exacta en gramos
 * o milésimas de litro a despachar a partir de un importe deseado en centavos y el precio
 * por kg/litro en centavos, usando redondeo comercial half-up entero con `BigInt`.
 *
 * @param {object} parametros
 * @param {'pieza'|'kg'|'litro'} parametros.unidad_venta
 * @param {number} parametros.importe_centavos
 * @param {number} parametros.precio_unitario_centavos
 */
function cotizarPorImporte(parametros) {
    const { unidad_venta, importe_centavos, precio_unitario_centavos } =
        parametros || {};

    if (!UNIDADES_VENTA_VALIDAS.includes(unidad_venta)) {
        throw new ErrorCalculoGranel(
            'La unidad de venta debe ser pieza, kg o litro.',
            'UNIDAD_INVALIDA'
        );
    }

    if (unidad_venta === 'pieza') {
        throw new ErrorCalculoGranel(
            'La cotización por importe monetario solo aplica a productos vendidos por kg o litro.',
            'FLUJO_INVERSO_NO_APLICA_A_PIEZA'
        );
    }

    if (!Number.isSafeInteger(importe_centavos) || importe_centavos < 1) {
        throw new ErrorCalculoGranel(
            'El importe solicitado debe ser un número entero de centavos mayor o igual a 1.',
            'IMPORTE_INVALIDO'
        );
    }

    if (!Number.isSafeInteger(precio_unitario_centavos)) {
        throw new ErrorCalculoGranel(
            'El precio unitario debe ser un número entero seguro de centavos.',
            'PRECIO_INVALIDO'
        );
    }

    if (precio_unitario_centavos <= 0) {
        throw new ErrorCalculoGranel(
            'El producto debe tener un precio unitario mayor a cero para cotizar por importe.',
            'PRECIO_UNITARIO_CERO'
        );
    }

    const num = BigInt(importe_centavos) * 1000n;
    const den = BigInt(precio_unitario_centavos);
    const milesimas = (2n * num + den) / (2n * den);

    if (milesimas < 1n) {
        throw new ErrorCalculoGranel(
            'El importe solicitado es insuficiente para cubrir al menos 0.001 unidades del producto.',
            'IMPORTE_INSUFICIENTE_PARA_UNIDAD_MINIMA'
        );
    }

    if (milesimas > MAX_MILESIMAS) {
        throw new ErrorCalculoGranel(
            'La cantidad resultante excede el máximo permitido (999999999.999).',
            'CANTIDAD_INVALIDA'
        );
    }

    const subtotalTeoricoBig = (milesimas * den + 500n) / 1000n;
    const subtotalTeorico = Number(subtotalTeoricoBig);
    const diferenciaRedondeo = importe_centavos - subtotalTeorico;
    const { cantidad, cantidad_numerica } =
        formatearMilesimasACantidad(milesimas);

    return {
        modo: 'por_importe',
        unidad_venta,
        cantidad,
        cantidad_numerica,
        cantidad_milesimas: Number(milesimas),
        unidad_base_milesimas: unidad_venta === 'kg' ? 'gramos' : 'mililitros',
        precio_unitario_historico_centavos: precio_unitario_centavos,
        subtotal_cobrado_centavos: importe_centavos,
        subtotal_teorico_por_peso_centavos: subtotalTeorico,
        diferencia_redondeo_centavos: diferenciaRedondeo,
    };
}

module.exports = {
    ErrorCalculoGranel,
    parsearCantidadAMilesimas,
    formatearMilesimasACantidad,
    cotizarPorCantidad,
    cotizarPorImporte,
};
