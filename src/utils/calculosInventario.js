const UNIDADES_VENTA_VALIDAS = Object.freeze(['pieza', 'kg', 'litro']);
const TIPOS_MOVIMIENTO_MANUALES = Object.freeze([
    'entrada_inicial',
    'compra',
    'merma',
    'ajuste',
]);

// Rango exacto para NUMERIC(12,3): -999999999.999 a 999999999.999 unidades (en milésimas)
const MAX_MILESIMAS = 999999999999n;
const MIN_MILESIMAS = -999999999999n;
const MAX_ENTERO_PG_INT4 = 2147483647;

const PATRON_DELTA_MILESIMAS = /^[+-]?\d+(?:\.\d{1,3})?$/;
const PATRON_NO_NEGATIVO_MILESIMAS = /^\+?\d+(?:\.\d{1,3})?$/;

/**
 * Error de dominio para validaciones y cálculos de inventario (libro mayor),
 * con propiedad `codigo` mapeable a respuestas HTTP 400.
 */
class ErrorCalculoInventario extends Error {
    /**
     * @param {string} mensaje
     * @param {string} codigo
     */
    constructor(mensaje, codigo) {
        super(mensaje);
        this.name = 'ErrorCalculoInventario';
        this.codigo = codigo;
    }
}

/**
 * Formatea un valor en milésimas (`BigInt`) a cadena decimal exacta con 3 decimales
 * compatible con `NUMERIC(12,3)` y signo negativo cuando `< 0n` (ej. `'3.500'`, `'-0.250'`, `'0.000'`).
 *
 * @param {bigint} milesimasBigInt
 * @returns {string}
 */
function formatearDeltaMilesimas(milesimasBigInt) {
    if (typeof milesimasBigInt !== 'bigint') {
        throw new ErrorCalculoInventario(
            'El valor en milésimas a formatear debe ser un BigInt.',
            'CANTIDAD_DELTA_INVALIDA'
        );
    }

    const esNegativo = milesimasBigInt < 0n;
    const magnitud = esNegativo ? -milesimasBigInt : milesimasBigInt;
    const entero = magnitud / 1000n;
    const fraccion = (magnitud % 1000n).toString().padStart(3, '0');

    return `${esNegativo ? '-' : ''}${entero.toString()}.${fraccion}`;
}

/**
 * Convierte un número finito distinto de cero o cadena decimal con signo opcional (`+` o `-`)
 * y hasta 3 decimales (sin notación científica) a milésimas exactas como `BigInt` con signo.
 *
 * @param {number|string} valor
 * @returns {bigint}
 */
function parsearDeltaMilesimas(valor) {
    let texto;

    if (typeof valor === 'number') {
        if (!Number.isFinite(valor) || valor === 0) {
            throw new ErrorCalculoInventario(
                'La cantidad delta debe ser un número finito distinto de cero.',
                'CANTIDAD_DELTA_INVALIDA'
            );
        }
        texto = String(valor);
    } else if (typeof valor === 'string') {
        texto = valor.trim();
    } else {
        throw new ErrorCalculoInventario(
            'La cantidad delta debe enviarse como número o cadena decimal válida.',
            'CANTIDAD_DELTA_INVALIDA'
        );
    }

    if (!PATRON_DELTA_MILESIMAS.test(texto)) {
        throw new ErrorCalculoInventario(
            'La cantidad delta debe ser un valor decimal válido sin notación científica y con un máximo de 3 decimales.',
            'CANTIDAD_DELTA_INVALIDA'
        );
    }

    const esNegativo = texto.startsWith('-');
    const sinSigno = texto.replace(/^[+-]/, '');
    const [parteEnteraStr, parteDecimalStr = ''] = sinSigno.split('.');
    const parteDecimalPadded = parteDecimalStr.padEnd(3, '0');
    const magnitud =
        BigInt(parteEnteraStr) * 1000n + BigInt(parteDecimalPadded);

    if (magnitud === 0n) {
        throw new ErrorCalculoInventario(
            'La cantidad delta del movimiento no puede ser cero.',
            'CANTIDAD_DELTA_INVALIDA'
        );
    }

    const resultado = esNegativo ? -magnitud : magnitud;

    if (resultado > MAX_MILESIMAS || resultado < MIN_MILESIMAS) {
        throw new ErrorCalculoInventario(
            'La cantidad delta está fuera del rango permitido (-999999999.999 a 999999999.999).',
            'CANTIDAD_DELTA_INVALIDA'
        );
    }

    return resultado;
}

/**
 * Parsea un valor de stock no negativo (`>= 0`, hasta 3 decimales) a milésimas exactas `BigInt`.
 * Si `unidadVenta === 'pieza'`, exige cantidad entera (`milesimas % 1000n === 0n`).
 *
 * @param {number|string} valor
 * @param {'pieza'|'kg'|'litro'|null} [unidadVenta=null]
 * @returns {{ milesimas: bigint, cantidad: string }}
 */
function parsearStockNoNegativoMilesimas(valor, unidadVenta = null) {
    if (
        unidadVenta !== null &&
        unidadVenta !== undefined &&
        !UNIDADES_VENTA_VALIDAS.includes(unidadVenta)
    ) {
        throw new ErrorCalculoInventario(
            'La unidad de venta debe ser pieza, kg o litro.',
            'UNIDAD_INVALIDA'
        );
    }

    let texto;

    if (typeof valor === 'number') {
        if (!Number.isFinite(valor) || valor < 0 || Object.is(valor, -0)) {
            throw new ErrorCalculoInventario(
                'El stock mínimo debe ser un número mayor o igual a cero.',
                'STOCK_MINIMO_INVALIDO'
            );
        }
        texto = String(valor);
    } else if (typeof valor === 'string') {
        texto = valor.trim();
    } else {
        throw new ErrorCalculoInventario(
            'El stock mínimo debe enviarse como número o cadena decimal no negativa.',
            'STOCK_MINIMO_INVALIDO'
        );
    }

    if (!PATRON_NO_NEGATIVO_MILESIMAS.test(texto)) {
        throw new ErrorCalculoInventario(
            'El stock mínimo debe ser mayor o igual a cero, sin notación científica y con un máximo de 3 decimales.',
            'STOCK_MINIMO_INVALIDO'
        );
    }

    const sinSigno = texto.replace(/^\+/, '');
    const [parteEnteraStr, parteDecimalStr = ''] = sinSigno.split('.');
    const parteDecimalPadded = parteDecimalStr.padEnd(3, '0');
    const milesimas =
        BigInt(parteEnteraStr) * 1000n + BigInt(parteDecimalPadded);

    if (milesimas > MAX_MILESIMAS) {
        throw new ErrorCalculoInventario(
            'El stock mínimo excede el rango máximo permitido (999999999.999).',
            'STOCK_MINIMO_INVALIDO'
        );
    }

    if (unidadVenta === 'pieza' && milesimas % 1000n !== 0n) {
        throw new ErrorCalculoInventario(
            'Los productos vendidos por pieza requieren cantidades enteras sin decimales fraccionarios.',
            'CANTIDAD_PIEZA_NO_ENTERA'
        );
    }

    return {
        milesimas,
        cantidad: formatearDeltaMilesimas(milesimas),
    };
}

/**
 * Parsea internamente la cantidad positiva de una presentación comercial (bulto, barra o caja).
 *
 * @param {unknown} valor
 * @returns {bigint}
 */
function parsearPresentacionPositivaMilesimas(valor) {
    let milesimas;
    try {
        milesimas = parsearDeltaMilesimas(valor);
    } catch {
        throw new ErrorCalculoInventario(
            'El campo presentacion_cantidad debe ser un valor positivo válido con hasta 3 decimales.',
            'PRESENTACION_INVALIDA'
        );
    }

    if (milesimas <= 0n) {
        throw new ErrorCalculoInventario(
            'El campo presentacion_cantidad debe ser mayor a cero.',
            'PRESENTACION_INVALIDA'
        );
    }

    return milesimas;
}

/**
 * Valida y normaliza un movimiento manual de inventario para el libro mayor,
 * soportando captura directa, conversión por presentación (bulto/barra/caja),
 * mermas (conversión automática a delta negativo) y ajustes firmados.
 *
 * @param {object} parametros
 */
function prepararMovimientoInventario(parametros) {
    const {
        unidad_venta,
        tipo_movimiento,
        cantidad,
        presentacion_cantidad,
        unidades_por_presentacion,
        cantidad_delta,
        motivo,
        costo_total_centavos,
    } = parametros || {};

    if (!UNIDADES_VENTA_VALIDAS.includes(unidad_venta)) {
        throw new ErrorCalculoInventario(
            'La unidad de venta del producto debe ser pieza, kg o litro.',
            'UNIDAD_INVALIDA'
        );
    }

    const tipoNormalizado =
        typeof tipo_movimiento === 'string' ? tipo_movimiento.trim() : '';

    if (!TIPOS_MOVIMIENTO_MANUALES.includes(tipoNormalizado)) {
        throw new ErrorCalculoInventario(
            'El tipo de movimiento manual debe ser entrada_inicial, compra, merma o ajuste.',
            'TIPO_MOVIMIENTO_INVALIDO'
        );
    }

    const tienePresentacionCantidad =
        presentacion_cantidad !== undefined && presentacion_cantidad !== null;
    const tieneUnidadesPorPresentacion =
        unidades_por_presentacion !== undefined &&
        unidades_por_presentacion !== null;
    const usaPresentacion =
        tienePresentacionCantidad || tieneUnidadesPorPresentacion;

    const tieneCantidad = cantidad !== undefined && cantidad !== null;
    const tieneCantidadDelta =
        cantidad_delta !== undefined && cantidad_delta !== null;

    let deltaMilesimas;

    if (usaPresentacion) {
        if (
            tipoNormalizado !== 'entrada_inicial' &&
            tipoNormalizado !== 'compra'
        ) {
            throw new ErrorCalculoInventario(
                'La conversión por presentación (bulto/barra/caja) solo está permitida en entrada_inicial o compra.',
                'PRESENTACION_NO_PERMITIDA'
            );
        }

        if (tieneCantidad || tieneCantidadDelta) {
            throw new ErrorCalculoInventario(
                'No debes enviar cantidad ni cantidad_delta cuando utilizas presentacion_cantidad y unidades_por_presentacion.',
                'ENTRADA_AMBIGUA'
            );
        }

        if (!tienePresentacionCantidad || !tieneUnidadesPorPresentacion) {
            throw new ErrorCalculoInventario(
                'Debes indicar tanto presentacion_cantidad como unidades_por_presentacion.',
                'PRESENTACION_INVALIDA'
            );
        }

        const milesimasPresentacion =
            parsearPresentacionPositivaMilesimas(presentacion_cantidad);

        if (
            !Number.isSafeInteger(unidades_por_presentacion) ||
            unidades_por_presentacion < 1
        ) {
            throw new ErrorCalculoInventario(
                'El campo unidades_por_presentacion debe ser un número entero mayor o igual a 1.',
                'PRESENTACION_INVALIDA'
            );
        }

        deltaMilesimas =
            milesimasPresentacion * BigInt(unidades_por_presentacion);
    } else if (
        tipoNormalizado === 'entrada_inicial' ||
        tipoNormalizado === 'compra'
    ) {
        if (tieneCantidad && tieneCantidadDelta) {
            throw new ErrorCalculoInventario(
                'Envía únicamente el campo cantidad para entradas iniciales o compras (no cantidad_delta).',
                'ENTRADA_AMBIGUA'
            );
        }

        if (tieneCantidadDelta || !tieneCantidad) {
            throw new ErrorCalculoInventario(
                'Las entradas iniciales y compras requieren una cantidad positiva en el campo cantidad.',
                'CANTIDAD_DELTA_INVALIDA'
            );
        }

        const milesimasPositivas = parsearDeltaMilesimas(cantidad);
        if (milesimasPositivas <= 0n) {
            throw new ErrorCalculoInventario(
                'La cantidad para entradas iniciales y compras debe ser mayor a cero.',
                'CANTIDAD_DELTA_INVALIDA'
            );
        }

        deltaMilesimas = milesimasPositivas;
    } else if (tipoNormalizado === 'merma') {
        if (tieneCantidad && tieneCantidadDelta) {
            throw new ErrorCalculoInventario(
                'Envía únicamente el campo cantidad positivo para registrar una merma.',
                'ENTRADA_AMBIGUA'
            );
        }

        if (tieneCantidadDelta || !tieneCantidad) {
            throw new ErrorCalculoInventario(
                'Las mermas requieren una cantidad positiva en el campo cantidad.',
                'CANTIDAD_DELTA_INVALIDA'
            );
        }

        const milesimasPositivas = parsearDeltaMilesimas(cantidad);
        if (milesimasPositivas <= 0n) {
            throw new ErrorCalculoInventario(
                'La cantidad de merma debe enviarse como un valor positivo mayor a cero.',
                'CANTIDAD_DELTA_INVALIDA'
            );
        }

        deltaMilesimas = -milesimasPositivas;
    } else {
        // tipoNormalizado === 'ajuste'
        if (tieneCantidad || !tieneCantidadDelta) {
            throw new ErrorCalculoInventario(
                'Los movimientos de ajuste requieren el campo cantidad_delta con signo distinto de cero (no cantidad).',
                'AJUSTE_REQUIERE_CANTIDAD_DELTA'
            );
        }

        deltaMilesimas = parsearDeltaMilesimas(cantidad_delta);
    }

    if (deltaMilesimas > MAX_MILESIMAS || deltaMilesimas < MIN_MILESIMAS) {
        throw new ErrorCalculoInventario(
            'La cantidad resultante del movimiento excede el rango permitido (-999999999.999 a 999999999.999).',
            'CANTIDAD_DELTA_INVALIDA'
        );
    }

    if (unidad_venta === 'pieza' && deltaMilesimas % 1000n !== 0n) {
        throw new ErrorCalculoInventario(
            'Los productos vendidos por pieza requieren movimientos en cantidades enteras.',
            'CANTIDAD_PIEZA_NO_ENTERA'
        );
    }

    if (
        motivo !== undefined &&
        motivo !== null &&
        typeof motivo !== 'string'
    ) {
        throw new ErrorCalculoInventario(
            'El motivo del movimiento debe ser una cadena de texto.',
            'MOTIVO_INVALIDO'
        );
    }

    let motivoLimpio = typeof motivo === 'string' ? motivo.trim() : '';

    if (tipoNormalizado === 'merma' || tipoNormalizado === 'ajuste') {
        if (!motivoLimpio) {
            throw new ErrorCalculoInventario(
                'Debes indicar un motivo explícito para registrar una merma o un ajuste de inventario.',
                'MOTIVO_REQUERIDO'
            );
        }
    } else if (!motivoLimpio) {
        motivoLimpio =
            tipoNormalizado === 'entrada_inicial'
                ? 'Inventario inicial'
                : 'Compra de mercancía';
    }

    if (motivoLimpio.length < 1 || motivoLimpio.length > 280) {
        throw new ErrorCalculoInventario(
            'El motivo del movimiento debe tener entre 1 y 280 caracteres.',
            'MOTIVO_INVALIDO'
        );
    }

    let costoNormalizado = null;
    if (costo_total_centavos !== undefined && costo_total_centavos !== null) {
        if (
            tipoNormalizado !== 'entrada_inicial' &&
            tipoNormalizado !== 'compra'
        ) {
            throw new ErrorCalculoInventario(
                'El campo costo_total_centavos solo aplica a entradas iniciales o compras.',
                'COSTO_INVALIDO'
            );
        }

        if (
            !Number.isSafeInteger(costo_total_centavos) ||
            costo_total_centavos < 0 ||
            costo_total_centavos > MAX_ENTERO_PG_INT4
        ) {
            throw new ErrorCalculoInventario(
                'El campo costo_total_centavos debe ser un número entero mayor o igual a cero.',
                'COSTO_INVALIDO'
            );
        }

        costoNormalizado = costo_total_centavos;
    }

    return {
        tipo_movimiento: tipoNormalizado,
        cantidad_delta: formatearDeltaMilesimas(deltaMilesimas),
        cantidad_delta_milesimas: Number(deltaMilesimas),
        motivo: motivoLimpio,
        costo_total_centavos: costoNormalizado,
    };
}

/**
 * Convierte un saldo de stock (`stock_actual` o `stock_minimo`) a milésimas `BigInt`,
 * tolerando `0`, `'0.000'`, `null` o `undefined` como `0n`.
 *
 * @param {number|string|bigint|null|undefined} valor
 * @returns {bigint}
 */
function convertirSaldoAMilesimas(valor) {
    if (valor === null || valor === undefined) {
        return 0n;
    }

    if (typeof valor === 'bigint') {
        return valor;
    }

    if (typeof valor === 'number') {
        if (!Number.isFinite(valor)) {
            throw new ErrorCalculoInventario(
                'El saldo de stock debe ser un valor numérico finito.',
                'CANTIDAD_DELTA_INVALIDA'
            );
        }
        if (valor === 0) {
            return 0n;
        }
        return parsearDeltaMilesimas(valor);
    }

    if (typeof valor === 'string') {
        const limpio = valor.trim();
        if (!limpio) {
            return 0n;
        }
        if (!PATRON_DELTA_MILESIMAS.test(limpio)) {
            throw new ErrorCalculoInventario(
                'El saldo de stock no tiene un formato decimal NUMERIC(12,3) válido.',
                'CANTIDAD_DELTA_INVALIDA'
            );
        }
        const esNegativo = limpio.startsWith('-');
        const sinSigno = limpio.replace(/^[+-]/, '');
        const [enteroStr, decimalStr = ''] = sinSigno.split('.');
        const magnitud =
            BigInt(enteroStr) * 1000n + BigInt(decimalStr.padEnd(3, '0'));
        if (magnitud === 0n) {
            return 0n;
        }
        return esNegativo ? -magnitud : magnitud;
    }

    throw new ErrorCalculoInventario(
        'El saldo de stock tiene un tipo de dato no soportado.',
        'CANTIDAD_DELTA_INVALIDA'
    );
}

/**
 * Evalúa de forma determinista las banderas de bajo stock y stock negativo
 * empleando exclusivamente aritmética `BigInt` en milésimas.
 *
 * @param {object} parametros
 * @param {boolean} parametros.controla_inventario
 * @param {number|string|null|undefined} parametros.stock_actual
 * @param {number|string|null|undefined} parametros.stock_minimo
 */
function evaluarAlertasStock(parametros) {
    const { controla_inventario, stock_actual, stock_minimo } =
        parametros || {};

    const actualMil = convertirSaldoAMilesimas(stock_actual);
    const minMil = convertirSaldoAMilesimas(stock_minimo);

    return {
        stock_actual: formatearDeltaMilesimas(actualMil),
        stock_minimo: formatearDeltaMilesimas(minMil),
        alerta_stock_negativo: Boolean(controla_inventario && actualMil < 0n),
        alerta_bajo_stock: Boolean(controla_inventario && actualMil <= minMil),
    };
}

module.exports = {
    ErrorCalculoInventario,
    parsearDeltaMilesimas,
    parsearStockNoNegativoMilesimas,
    formatearDeltaMilesimas,
    prepararMovimientoInventario,
    evaluarAlertasStock,
};
