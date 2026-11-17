const express = require('express');
const {
    verificarSesion,
    verificarContextoTienda,
} = require('../middlewares/autenticacion');
const { tienePermiso } = require('../config/permisos');
const { esUuidValido, esFechaIsoValida } = require('../utils/validaciones');
const {
    plegarAcentos,
    sanitizarTerminoBusquedaPostgrest,
} = require('../utils/texto');
const {
    ErrorCalculoInventario,
    prepararMovimientoInventario,
    evaluarAlertasStock,
} = require('../utils/calculosInventario');

// mergeParams permite leer :tiendaId cuando se monta bajo /api/tiendas/:tiendaId/inventario
const router = express.Router({ mergeParams: true });

const TIPOS_KARDEX_VALIDOS = Object.freeze([
    'entrada_inicial',
    'compra',
    'venta',
    'devolucion_cancelacion',
    'merma',
    'ajuste',
]);

const COLUMNAS_EXISTENCIAS =
    'id, tienda_id, nombre, codigo_barras, unidad_venta, precio_centavos, controla_inventario, stock_actual, stock_minimo, es_acceso_rapido, orden_acceso_rapido, activo, creado_en, actualizado_en';

const COLUMNAS_MOVIMIENTOS_KARDEX =
    'id, tienda_id, producto_id, tipo_movimiento, cantidad_delta, costo_total_centavos, motivo, referencia_externa_id, registrado_por, ocurrido_en, creado_en, productos!inner(nombre, unidad_venta, codigo_barras)';

/**
 * Parsea estrictamente un parámetro de query a entero seguro.
 *
 * @param {unknown} valor
 * @returns {number|null}
 */
function parsearEnteroQuery(valor) {
    if (typeof valor !== 'string') {
        return null;
    }

    const limpio = valor.trim();
    if (!/^-?\d+$/.test(limpio)) {
        return null;
    }

    const numero = Number(limpio);
    return Number.isSafeInteger(numero) ? numero : null;
}

/**
 * Valida que un filtro booleano opcional en query sea exactamente `'true'` o `'false'`.
 *
 * @param {unknown} valor
 * @returns {boolean}
 */
function esFiltroBooleanoValido(valor) {
    return valor === undefined || valor === 'true' || valor === 'false';
}

/**
 * Consultar existencias actuales y alertas de bajo stock / stock negativo de la tienda activa.
 * Disponible para `propietario`, `encargado` y `cajero` (`inventario:leer`).
 */
router.get(
    '/existencias',
    verificarSesion,
    verificarContextoTienda({ permisoRequerido: 'inventario:leer' }),
    async (req, res) => {
        const {
            q,
            solo_controlados,
            bajo_stock,
            stock_negativo,
            solo_activos,
            limite,
            offset,
        } = req.query || {};

        let terminoLimpio = null;
        let terminoPlegado = null;

        if (q !== undefined) {
            if (
                typeof q !== 'string' ||
                q.trim().length < 1 ||
                q.trim().length > 120
            ) {
                return res.status(400).json({
                    error: 'El parámetro q debe ser un texto de entre 1 y 120 caracteres.',
                });
            }

            terminoLimpio = sanitizarTerminoBusquedaPostgrest(q);
            terminoPlegado = plegarAcentos(terminoLimpio);

            if (!terminoLimpio || !terminoPlegado) {
                return res.status(400).json({
                    error: 'El parámetro q no contiene caracteres de búsqueda válidos.',
                });
            }
        }

        if (!esFiltroBooleanoValido(solo_controlados)) {
            return res.status(400).json({
                error: "El filtro solo_controlados debe ser 'true' o 'false'.",
            });
        }

        if (!esFiltroBooleanoValido(bajo_stock)) {
            return res.status(400).json({
                error: "El filtro bajo_stock debe ser 'true' o 'false'.",
            });
        }

        if (!esFiltroBooleanoValido(stock_negativo)) {
            return res.status(400).json({
                error: "El filtro stock_negativo debe ser 'true' o 'false'.",
            });
        }

        if (!esFiltroBooleanoValido(solo_activos)) {
            return res.status(400).json({
                error: "El filtro solo_activos debe ser 'true' o 'false'.",
            });
        }

        let limiteNum = 200;
        if (limite !== undefined) {
            const parseado = parsearEnteroQuery(limite);
            if (parseado === null || parseado < 1 || parseado > 500) {
                return res.status(400).json({
                    error: 'El parámetro limite debe ser un número entero entre 1 y 500.',
                });
            }
            limiteNum = parseado;
        }

        let offsetNum = 0;
        if (offset !== undefined) {
            const parseado = parsearEnteroQuery(offset);
            if (parseado === null || parseado < 0) {
                return res.status(400).json({
                    error: 'El parámetro offset debe ser un número entero mayor o igual a 0.',
                });
            }
            offsetNum = parseado;
        }

        let consulta = req.supabase
            .from('productos')
            .select(COLUMNAS_EXISTENCIAS)
            .eq('tienda_id', req.contextoTienda.id);

        if (terminoPlegado !== null && terminoLimpio !== null) {
            consulta = consulta.or(
                `nombre_busqueda.ilike.%${terminoPlegado}%,codigo_barras.ilike.%${terminoLimpio}%`
            );
        }

        if (
            solo_controlados === 'true' ||
            bajo_stock === 'true' ||
            stock_negativo === 'true'
        ) {
            consulta = consulta.eq('controla_inventario', true);
        }

        if (solo_activos === 'true') {
            consulta = consulta.eq('activo', true);
        }

        if (stock_negativo === 'true') {
            consulta = consulta.lt('stock_actual', 0);
        }

        consulta = consulta.order('nombre', { ascending: true });

        const requiereFiltroBajoStockEnMemoria = bajo_stock === 'true';
        if (!requiereFiltroBajoStockEnMemoria) {
            consulta = consulta.range(offsetNum, offsetNum + limiteNum - 1);
        }

        const { data, error } = await consulta;

        if (error) {
            console.error('Error al consultar existencias:', error.message);
            return res.status(500).json({
                error: 'No fue posible consultar las existencias de inventario de la tienda.',
            });
        }

        const enriquecidos = (data || []).map((fila) => {
            const alertas = evaluarAlertasStock({
                controla_inventario: fila.controla_inventario,
                stock_actual: fila.stock_actual,
                stock_minimo: fila.stock_minimo,
            });

            return {
                ...fila,
                stock_actual: alertas.stock_actual,
                stock_minimo: alertas.stock_minimo,
                alerta_bajo_stock: alertas.alerta_bajo_stock,
                alerta_stock_negativo: alertas.alerta_stock_negativo,
            };
        });

        const productos = requiereFiltroBajoStockEnMemoria
            ? enriquecidos
                  .filter((p) => p.alerta_bajo_stock === true)
                  .slice(offsetNum, offsetNum + limiteNum)
            : enriquecidos;

        const conBajoStock = productos.filter(
            (p) => p.alerta_bajo_stock === true
        ).length;
        const conStockNegativo = productos.filter(
            (p) => p.alerta_stock_negativo === true
        ).length;

        res.status(200).json({
            tienda: {
                id: req.contextoTienda.id,
                nombre: req.contextoTienda.nombre,
                rol: req.contextoTienda.rol,
            },
            politica_stock_negativo: 'permitido_con_alerta',
            resumen: {
                devueltos: productos.length,
                con_bajo_stock: conBajoStock,
                con_stock_negativo: conStockNegativo,
            },
            productos,
        });
    }
);

/**
 * Consultar el libro mayor (kardex) de movimientos de inventario de la tienda activa.
 * Restringido a `propietario` y `encargado` (`inventario:kardex`).
 */
router.get(
    '/movimientos',
    verificarSesion,
    verificarContextoTienda({ permisoRequerido: 'inventario:kardex' }),
    async (req, res) => {
        const {
            producto_id,
            tipo_movimiento,
            desde,
            hasta,
            limite,
            offset,
        } = req.query || {};

        if (producto_id !== undefined && !esUuidValido(producto_id)) {
            return res.status(400).json({
                error: 'El filtro producto_id debe ser un UUID válido.',
            });
        }

        if (
            tipo_movimiento !== undefined &&
            !TIPOS_KARDEX_VALIDOS.includes(tipo_movimiento)
        ) {
            return res.status(400).json({
                error: 'El filtro tipo_movimiento debe ser entrada_inicial, compra, venta, devolucion_cancelacion, merma o ajuste.',
            });
        }

        if (desde !== undefined && !esFechaIsoValida(desde)) {
            return res.status(400).json({
                error: 'El parámetro desde debe ser una fecha ISO-8601 válida.',
            });
        }

        if (hasta !== undefined && !esFechaIsoValida(hasta)) {
            return res.status(400).json({
                error: 'El parámetro hasta debe ser una fecha ISO-8601 válida.',
            });
        }

        if (
            desde !== undefined &&
            hasta !== undefined &&
            new Date(desde).getTime() > new Date(hasta).getTime()
        ) {
            return res.status(400).json({
                error: 'El parámetro desde no puede ser posterior al parámetro hasta.',
            });
        }

        let limiteNum = 100;
        if (limite !== undefined) {
            const parseado = parsearEnteroQuery(limite);
            if (parseado === null || parseado < 1 || parseado > 500) {
                return res.status(400).json({
                    error: 'El parámetro limite debe ser un número entero entre 1 y 500.',
                });
            }
            limiteNum = parseado;
        }

        let offsetNum = 0;
        if (offset !== undefined) {
            const parseado = parsearEnteroQuery(offset);
            if (parseado === null || parseado < 0) {
                return res.status(400).json({
                    error: 'El parámetro offset debe ser un número entero mayor o igual a 0.',
                });
            }
            offsetNum = parseado;
        }

        let consulta = req.supabase
            .from('inventario_movimientos')
            .select(COLUMNAS_MOVIMIENTOS_KARDEX)
            .eq('tienda_id', req.contextoTienda.id);

        if (producto_id !== undefined) {
            consulta = consulta.eq('producto_id', producto_id.trim());
        }

        if (tipo_movimiento !== undefined) {
            consulta = consulta.eq('tipo_movimiento', tipo_movimiento);
        }

        if (desde !== undefined) {
            consulta = consulta.gte(
                'ocurrido_en',
                new Date(desde).toISOString()
            );
        }

        if (hasta !== undefined) {
            consulta = consulta.lte(
                'ocurrido_en',
                new Date(hasta).toISOString()
            );
        }

        const { data, error } = await consulta
            .order('creado_en', { ascending: false })
            .range(offsetNum, offsetNum + limiteNum - 1);

        if (error) {
            if (error.code === '42501') {
                return res.status(403).json({
                    error: 'No tienes permiso para consultar el kardex de inventario.',
                    codigo: 'PERMISO_DENEGADO',
                });
            }

            console.error(
                'Error al consultar movimientos de inventario:',
                error.message
            );
            return res.status(500).json({
                error: 'No fue posible consultar el historial de movimientos de inventario.',
            });
        }

        const movimientos = data || [];

        res.status(200).json({
            tienda: {
                id: req.contextoTienda.id,
                nombre: req.contextoTienda.nombre,
                rol: req.contextoTienda.rol,
            },
            paginacion: {
                limite: limiteNum,
                offset: offsetNum,
                devueltos: movimientos.length,
            },
            movimientos,
        });
    }
);

/**
 * Registrar un movimiento manual en el libro mayor (`entrada_inicial`, `compra`, `merma` o `ajuste`)
 * mediante la RPC transaccional e idempotente `public.registrar_movimiento_inventario`.
 */
router.post(
    '/movimientos',
    verificarSesion,
    verificarContextoTienda(),
    async (req, res) => {
        const cuerpo = req.body || {};
        const tipoSolicitado =
            typeof cuerpo.tipo_movimiento === 'string'
                ? cuerpo.tipo_movimiento.trim()
                : '';

        const permisoRequerido =
            tipoSolicitado === 'ajuste'
                ? 'inventario:ajustar'
                : 'inventario:registrar';

        if (!tienePermiso(req.contextoTienda.rol, permisoRequerido)) {
            return res.status(403).json({
                error: 'Tu rol en esta tienda no tiene permiso para registrar este movimiento de inventario.',
                codigo: 'PERMISO_DENEGADO',
                permiso_requerido: permisoRequerido,
                rol_actual: req.contextoTienda.rol,
            });
        }

        const { id, producto_id, ocurrido_en } = cuerpo;

        if (id !== undefined && id !== null && !esUuidValido(id)) {
            return res.status(400).json({
                error: 'El identificador opcional id del movimiento debe ser un UUID válido.',
                codigo: 'ID_MOVIMIENTO_INVALIDO',
            });
        }

        if (!esUuidValido(producto_id)) {
            return res.status(400).json({
                error: 'El campo producto_id es obligatorio y debe ser un UUID válido.',
                codigo: 'PRODUCTO_ID_INVALIDO',
            });
        }

        if (
            ocurrido_en !== undefined &&
            ocurrido_en !== null &&
            !esFechaIsoValida(ocurrido_en)
        ) {
            return res.status(400).json({
                error: 'El campo opcional ocurrido_en debe ser una fecha ISO-8601 válida.',
                codigo: 'FECHA_OCURRIDO_INVALIDA',
            });
        }

        const { data: producto, error: errorProducto } = await req.supabase
            .from('productos')
            .select(
                'id, tienda_id, nombre, unidad_venta, controla_inventario, activo'
            )
            .eq('id', producto_id.trim())
            .eq('tienda_id', req.contextoTienda.id)
            .maybeSingle();

        if (errorProducto) {
            console.error(
                'Error al consultar producto para movimiento de inventario:',
                errorProducto.message
            );
            return res.status(500).json({
                error: 'No fue posible verificar el producto en la tienda activa.',
            });
        }

        if (!producto) {
            return res.status(404).json({
                error: 'El producto no existe en la tienda activa.',
            });
        }

        if (!producto.controla_inventario) {
            return res.status(409).json({
                error: 'Este producto tiene desactivado el control de inventario.',
                codigo: 'PRODUCTO_SIN_CONTROL_INVENTARIO',
            });
        }

        let prep;
        try {
            prep = prepararMovimientoInventario({
                ...cuerpo,
                unidad_venta: producto.unidad_venta,
            });
        } catch (err) {
            if (err instanceof ErrorCalculoInventario || (err && err.codigo)) {
                return res.status(400).json({
                    error: err.message,
                    codigo: err.codigo,
                });
            }

            console.error('Error inesperado al validar movimiento:', err);
            return res.status(500).json({
                error: 'No fue posible procesar los datos del movimiento de inventario.',
            });
        }

        const parametrosRpc = {
            p_tienda_id: req.contextoTienda.id,
            p_producto_id: producto.id,
            p_tipo_movimiento: prep.tipo_movimiento,
            p_cantidad_delta: prep.cantidad_delta,
            p_motivo: prep.motivo,
            ...(id ? { p_movimiento_id: id.trim() } : {}),
            p_costo_total_centavos: prep.costo_total_centavos,
            ...(ocurrido_en
                ? { p_ocurrido_en: new Date(ocurrido_en).toISOString() }
                : {}),
        };

        const { data, error } = await req.supabase.rpc(
            'registrar_movimiento_inventario',
            parametrosRpc
        );

        if (error) {
            if (error.code === 'P0002') {
                return res.status(404).json({
                    error:
                        error.message ||
                        'El producto no existe en la tienda activa.',
                });
            }

            if (error.code === 'P0001') {
                return res.status(409).json({
                    error:
                        error.message ||
                        'Este producto tiene desactivado el control de inventario.',
                    codigo: 'PRODUCTO_SIN_CONTROL_INVENTARIO',
                });
            }

            if (error.code === '23505') {
                return res.status(409).json({
                    error:
                        error.message ||
                        'El identificador de movimiento ya fue utilizado para otro registro.',
                    codigo: 'MOVIMIENTO_ID_CONFLICTO',
                });
            }

            if (error.code === '42501') {
                return res.status(403).json({
                    error:
                        error.message ||
                        'No tienes permiso para registrar este movimiento de inventario.',
                    codigo: 'PERMISO_DENEGADO',
                });
            }

            if (error.code === '22023') {
                return res.status(400).json({
                    error:
                        error.message ||
                        'Datos inválidos para registrar el movimiento de inventario.',
                });
            }

            console.error(
                'Error en RPC registrar_movimiento_inventario:',
                error.message
            );
            return res.status(500).json({
                error: 'No fue posible registrar el movimiento de inventario.',
            });
        }

        const esIdempotente = Boolean(data && data.idempotente === true);
        const codigoEstado = esIdempotente ? 200 : 201;

        res.status(codigoEstado).json({
            mensaje: esIdempotente
                ? 'El movimiento de inventario ya estaba registrado (respuesta idempotente).'
                : 'Movimiento de inventario registrado correctamente.',
            idempotente: esIdempotente,
            movimiento: data.movimiento,
            existencia: data.existencia,
        });
    }
);

module.exports = router;
