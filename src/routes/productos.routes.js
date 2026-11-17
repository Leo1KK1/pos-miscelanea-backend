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
    cotizarPorCantidad,
    cotizarPorImporte,
} = require('../utils/calculosGranel');
const {
    ErrorCalculoInventario,
    parsearStockNoNegativoMilesimas,
} = require('../utils/calculosInventario');

// mergeParams permite leer :tiendaId cuando se monta bajo /api/tiendas/:tiendaId/productos
const router = express.Router({ mergeParams: true });

const COLUMNAS_PRODUCTO =
    'id, tienda_id, nombre, codigo_barras, unidad_venta, precio_centavos, controla_inventario, stock_actual, stock_minimo, es_acceso_rapido, orden_acceso_rapido, activo, creado_en, actualizado_en';

const COLUMNAS_PRODUCTO_SPRINT3 =
    'id, tienda_id, nombre, codigo_barras, unidad_venta, precio_centavos, controla_inventario, es_acceso_rapido, orden_acceso_rapido, activo, creado_en, actualizado_en';

const COLUMNAS_PRODUCTO_BASE =
    'id, tienda_id, nombre, codigo_barras, unidad_venta, precio_centavos, activo, creado_en, actualizado_en';

const UNIDADES_VENTA_VALIDAS = ['pieza', 'kg', 'litro'];

/**
 * Parsea estrictamente un parámetro de query a entero seguro.
 * Devuelve `null` si no es una cadena entera válida.
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
 * Ejecuta una consulta unitaria sobre `productos` seleccionando todas las columnas de catálogo,
 * con fallback limpio a esquemas previos si las migraciones 004 o 003 aún no han sido aplicadas (`42703`).
 *
 * @param {object} supabase
 * @param {(query: object) => object} aplicarFiltros
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
async function consultarProductoUnico(supabase, aplicarFiltros) {
    let respuesta = await aplicarFiltros(
        supabase.from('productos').select(COLUMNAS_PRODUCTO)
    ).maybeSingle();

    if (respuesta.error && respuesta.error.code === '42703') {
        respuesta = await aplicarFiltros(
            supabase.from('productos').select(COLUMNAS_PRODUCTO_SPRINT3)
        ).maybeSingle();
    }

    if (respuesta.error && respuesta.error.code === '42703') {
        respuesta = await aplicarFiltros(
            supabase.from('productos').select(COLUMNAS_PRODUCTO_BASE)
        ).maybeSingle();
    }

    return respuesta;
}

/**
 * Consultar el catálogo de productos de la tienda activa.
 * Soporta búsqueda sin tildes (`q`), filtros operativos, paginación y sincronización incremental.
 */
router.get(
    '/',
    verificarSesion,
    verificarContextoTienda({ permisoRequerido: 'productos:leer' }),
    async (req, res) => {
        const {
            q,
            codigo_barras,
            unidad_venta,
            acceso_rapido,
            controla_inventario,
            solo_activos,
            actualizado_desde,
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

        let codigoFiltroExacto = null;
        if (codigo_barras !== undefined) {
            if (
                typeof codigo_barras !== 'string' ||
                codigo_barras.trim().length < 1 ||
                codigo_barras.trim().length > 80
            ) {
                return res.status(400).json({
                    error: 'El filtro codigo_barras debe tener entre 1 y 80 caracteres.',
                });
            }
            codigoFiltroExacto = codigo_barras.trim();
        }

        if (
            unidad_venta !== undefined &&
            !UNIDADES_VENTA_VALIDAS.includes(unidad_venta)
        ) {
            return res.status(400).json({
                error: 'El filtro unidad_venta debe ser pieza, kg o litro.',
            });
        }

        if (
            acceso_rapido !== undefined &&
            acceso_rapido !== 'true' &&
            acceso_rapido !== 'false'
        ) {
            return res.status(400).json({
                error: "El filtro acceso_rapido debe ser 'true' o 'false'.",
            });
        }

        if (
            controla_inventario !== undefined &&
            controla_inventario !== 'true' &&
            controla_inventario !== 'false'
        ) {
            return res.status(400).json({
                error: "El filtro controla_inventario debe ser 'true' o 'false'.",
            });
        }

        if (
            solo_activos !== undefined &&
            solo_activos !== 'true' &&
            solo_activos !== 'false'
        ) {
            return res.status(400).json({
                error: "El filtro solo_activos debe ser 'true' o 'false'.",
            });
        }

        if (
            actualizado_desde !== undefined &&
            !esFechaIsoValida(actualizado_desde)
        ) {
            return res.status(400).json({
                error: 'El parámetro actualizado_desde debe ser una fecha ISO-8601 válida.',
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

        const construirConsulta = (esquema = 'sprint4') => {
            const usarEsquemaBase = esquema === 'base';
            const columnasSeleccionadas =
                esquema === 'sprint4'
                    ? COLUMNAS_PRODUCTO
                    : esquema === 'sprint3'
                      ? COLUMNAS_PRODUCTO_SPRINT3
                      : COLUMNAS_PRODUCTO_BASE;

            let consulta = req.supabase
                .from('productos')
                .select(columnasSeleccionadas)
                .eq('tienda_id', req.contextoTienda.id);

            if (terminoPlegado !== null && terminoLimpio !== null) {
                if (usarEsquemaBase) {
                    consulta = consulta.or(
                        `nombre.ilike.%${terminoLimpio}%,codigo_barras.ilike.%${terminoLimpio}%`
                    );
                } else {
                    consulta = consulta.or(
                        `nombre_busqueda.ilike.%${terminoPlegado}%,codigo_barras.ilike.%${terminoLimpio}%`
                    );
                }
            }

            if (codigoFiltroExacto !== null) {
                consulta = consulta.eq('codigo_barras', codigoFiltroExacto);
            }

            if (unidad_venta !== undefined) {
                consulta = consulta.eq('unidad_venta', unidad_venta);
            }

            if (!usarEsquemaBase && acceso_rapido !== undefined) {
                consulta = consulta.eq(
                    'es_acceso_rapido',
                    acceso_rapido === 'true'
                );
            }

            if (!usarEsquemaBase && controla_inventario !== undefined) {
                consulta = consulta.eq(
                    'controla_inventario',
                    controla_inventario === 'true'
                );
            }

            if (solo_activos === 'true') {
                consulta = consulta.eq('activo', true);
            }

            if (actualizado_desde !== undefined) {
                consulta = consulta.gt(
                    'actualizado_en',
                    new Date(actualizado_desde).toISOString()
                );
            }

            if (!usarEsquemaBase && acceso_rapido === 'true') {
                consulta = consulta
                    .order('orden_acceso_rapido', { ascending: true })
                    .order('nombre', { ascending: true });
            } else {
                consulta = consulta.order('nombre', { ascending: true });
            }

            return consulta.range(offsetNum, offsetNum + limiteNum - 1);
        };

        let { data, error } = await construirConsulta('sprint4');

        if (error && error.code === '42703') {
            ({ data, error } = await construirConsulta('sprint3'));
        }

        if (
            error &&
            error.code === '42703' &&
            acceso_rapido === undefined &&
            controla_inventario === undefined
        ) {
            ({ data, error } = await construirConsulta('base'));
        }

        if (error) {
            console.error('Error al consultar productos:', error.message);
            return res.status(500).json({
                error: 'No fue posible consultar los productos de la tienda.',
            });
        }

        const listaProductos = data || [];

        res.json({
            tienda: {
                id: req.contextoTienda.id,
                nombre: req.contextoTienda.nombre,
                rol: req.contextoTienda.rol,
            },
            paginacion: {
                limite: limiteNum,
                offset: offsetNum,
                devueltos: listaProductos.length,
            },
            productos: listaProductos,
        });
    }
);

/**
 * Buscar un producto por código de barras exacto dentro de la tienda activa (escáner de mostrador).
 * Se define ANTES de `/:productoId` para evitar colisión de rutas.
 */
router.get(
    '/por-codigo/:codigo',
    verificarSesion,
    verificarContextoTienda({ permisoRequerido: 'productos:leer' }),
    async (req, res) => {
        const codigoLimpio =
            typeof req.params.codigo === 'string'
                ? req.params.codigo.trim()
                : '';

        if (!codigoLimpio || codigoLimpio.length > 80) {
            return res.status(400).json({
                error: 'El código de barras debe tener entre 1 y 80 caracteres.',
            });
        }

        const { data: producto, error } = await consultarProductoUnico(
            req.supabase,
            (q) =>
                q
                    .eq('tienda_id', req.contextoTienda.id)
                    .eq('codigo_barras', codigoLimpio)
        );

        if (error) {
            console.error(
                'Error al consultar producto por código de barras:',
                error.message
            );
            return res.status(500).json({
                error: 'No fue posible consultar el producto por código de barras.',
            });
        }

        if (!producto) {
            return res.status(404).json({
                error: 'No existe un producto con ese código de barras en esta tienda.',
            });
        }

        res.status(200).json({
            producto,
        });
    }
);

/**
 * Consultar el historial inmutable de cambios de precio de un producto (propietario y encargado).
 */
router.get(
    '/:productoId/historial-precios',
    verificarSesion,
    verificarContextoTienda({ permisoRequerido: 'productos:editar' }),
    async (req, res) => {
        const { productoId } = req.params;

        if (!esUuidValido(productoId)) {
            return res.status(400).json({
                error: 'El identificador de producto debe ser un UUID válido.',
            });
        }

        const { data: prod, error: errorProd } = await req.supabase
            .from('productos')
            .select('id, nombre, precio_centavos')
            .eq('id', productoId.trim())
            .eq('tienda_id', req.contextoTienda.id)
            .maybeSingle();

        if (errorProd) {
            console.error(
                'Error al verificar producto para historial de precios:',
                errorProd.message
            );
            return res.status(500).json({
                error: 'No fue posible consultar el producto.',
            });
        }

        if (!prod) {
            return res.status(404).json({
                error: 'El producto no existe en la tienda activa.',
            });
        }

        const { data: historial, error: errorHistorial } = await req.supabase
            .from('producto_precios_historial')
            .select(
                'id, tienda_id, producto_id, precio_anterior_centavos, precio_nuevo_centavos, cambiado_por, cambiado_en'
            )
            .eq('tienda_id', req.contextoTienda.id)
            .eq('producto_id', prod.id)
            .order('cambiado_en', { ascending: false });

        if (errorHistorial) {
            console.error(
                'Error al consultar historial de precios:',
                errorHistorial.message
            );
            return res.status(500).json({
                error: 'No fue posible consultar el historial de precios del producto.',
            });
        }

        res.status(200).json({
            producto: {
                id: prod.id,
                nombre: prod.nombre,
                precio_actual_centavos: prod.precio_centavos,
            },
            historial: historial || [],
        });
    }
);

/**
 * Cotizar un producto para mostrador por cantidad (`pieza`, `kg`, `litro`) o por importe deseado
 * ("deme $15 de jamón"), disponible para `propietario`, `encargado` y `cajero`.
 */
router.post(
    '/:productoId/cotizar',
    verificarSesion,
    verificarContextoTienda({ permisoRequerido: 'productos:leer' }),
    async (req, res) => {
        const { productoId } = req.params;

        if (!esUuidValido(productoId)) {
            return res.status(400).json({
                error: 'El identificador de producto debe ser un UUID válido.',
            });
        }

        const { data: producto, error: errorProd } = await req.supabase
            .from('productos')
            .select('id, nombre, unidad_venta, precio_centavos, activo')
            .eq('id', productoId.trim())
            .eq('tienda_id', req.contextoTienda.id)
            .maybeSingle();

        if (errorProd) {
            console.error(
                'Error al consultar producto para cotizar:',
                errorProd.message
            );
            return res.status(500).json({
                error: 'No fue posible consultar el producto para cotización.',
            });
        }

        if (!producto) {
            return res.status(404).json({
                error: 'El producto no existe en la tienda activa.',
            });
        }

        if (!producto.activo) {
            return res.status(409).json({
                error: 'El producto está desactivado y no puede cotizarse para venta.',
                codigo: 'PRODUCTO_INACTIVO',
            });
        }

        const cuerpo = req.body || {};
        const tieneCantidad = cuerpo.cantidad !== undefined;
        const tieneImporte = cuerpo.importe_centavos !== undefined;

        if (tieneCantidad === tieneImporte) {
            return res.status(400).json({
                error: 'Debes enviar exactamente uno de los campos: cantidad o importe_centavos.',
                codigo: 'MODO_COTIZACION_INVALIDO',
            });
        }

        try {
            const cotizacion = tieneCantidad
                ? cotizarPorCantidad({
                      unidad_venta: producto.unidad_venta,
                      cantidad: cuerpo.cantidad,
                      precio_unitario_centavos: producto.precio_centavos,
                  })
                : cotizarPorImporte({
                      unidad_venta: producto.unidad_venta,
                      importe_centavos: cuerpo.importe_centavos,
                      precio_unitario_centavos: producto.precio_centavos,
                  });

            return res.status(200).json({
                producto: {
                    id: producto.id,
                    nombre: producto.nombre,
                    unidad_venta: producto.unidad_venta,
                    precio_centavos: producto.precio_centavos,
                },
                cotizacion,
            });
        } catch (err) {
            if (err && err.codigo) {
                return res.status(400).json({
                    error: err.message,
                    codigo: err.codigo,
                });
            }

            console.error('Error inesperado al cotizar producto:', err);
            return res.status(500).json({
                error: 'No fue posible calcular la cotización del producto.',
            });
        }
    }
);

/**
 * Consultar el detalle de un producto específico por UUID dentro de la tienda activa.
 */
router.get(
    '/:productoId',
    verificarSesion,
    verificarContextoTienda({ permisoRequerido: 'productos:leer' }),
    async (req, res) => {
        const { productoId } = req.params;

        if (!esUuidValido(productoId)) {
            return res.status(400).json({
                error: 'El identificador de producto debe ser un UUID válido.',
            });
        }

        const { data: producto, error } = await consultarProductoUnico(
            req.supabase,
            (q) =>
                q
                    .eq('id', productoId.trim())
                    .eq('tienda_id', req.contextoTienda.id)
        );

        if (error) {
            console.error(
                'Error al consultar detalle de producto:',
                error.message
            );
            return res.status(500).json({
                error: 'No fue posible consultar el producto.',
            });
        }

        if (!producto) {
            return res.status(404).json({
                error: 'El producto no existe en la tienda activa.',
            });
        }

        res.status(200).json({
            producto,
        });
    }
);

/**
 * Registrar un producto en la tienda activa (restringido a propietario o encargado).
 * Acepta `id` UUID opcional generado en el cliente con respuesta idempotente ante reintentos.
 */
router.post(
    '/',
    verificarSesion,
    verificarContextoTienda({ permisoRequerido: 'productos:crear' }),
    async (req, res) => {
        const {
            id,
            nombre,
            codigo_barras,
            unidad_venta,
            precio_centavos,
            controla_inventario,
            stock_actual,
            stock_minimo,
            es_acceso_rapido,
            orden_acceso_rapido,
        } = req.body || {};

        if (stock_actual !== undefined) {
            return res.status(400).json({
                error: 'El campo stock_actual solo se actualiza mediante movimientos de inventario.',
                codigo: 'STOCK_ACTUAL_SOLO_LECTURA',
            });
        }

        if (id !== undefined && id !== null && !esUuidValido(id)) {
            return res.status(400).json({
                error: 'El identificador opcional id debe ser un UUID válido.',
            });
        }

        if (
            typeof nombre !== 'string' ||
            nombre.trim().length < 1 ||
            nombre.trim().length > 120
        ) {
            return res.status(400).json({
                error: 'El nombre debe tener entre 1 y 120 caracteres.',
            });
        }

        if (!UNIDADES_VENTA_VALIDAS.includes(unidad_venta)) {
            return res.status(400).json({
                error: 'La unidad debe ser pieza, kg o litro.',
            });
        }

        if (
            !Number.isSafeInteger(precio_centavos) ||
            precio_centavos < 0 ||
            precio_centavos > 2147483647
        ) {
            return res.status(400).json({
                error: 'El precio debe ser un número entero de centavos válido.',
            });
        }

        if (
            codigo_barras !== undefined &&
            codigo_barras !== null &&
            typeof codigo_barras !== 'string'
        ) {
            return res.status(400).json({
                error: 'El código de barras debe ser texto.',
            });
        }

        const codigoNormalizado =
            typeof codigo_barras === 'string' ? codigo_barras.trim() : null;

        if (codigoNormalizado && codigoNormalizado.length > 80) {
            return res.status(400).json({
                error: 'El código de barras no puede superar 80 caracteres.',
            });
        }

        if (
            controla_inventario !== undefined &&
            typeof controla_inventario !== 'boolean'
        ) {
            return res.status(400).json({
                error: 'El campo controla_inventario debe ser un valor booleano.',
            });
        }

        if (
            es_acceso_rapido !== undefined &&
            typeof es_acceso_rapido !== 'boolean'
        ) {
            return res.status(400).json({
                error: 'El campo es_acceso_rapido debe ser un valor booleano.',
            });
        }

        if (
            orden_acceso_rapido !== undefined &&
            (!Number.isSafeInteger(orden_acceso_rapido) ||
                orden_acceso_rapido < 1 ||
                orden_acceso_rapido > 9999)
        ) {
            return res.status(400).json({
                error: 'El campo orden_acceso_rapido debe ser un número entero entre 1 y 9999.',
            });
        }

        let stockMinimoFormateado;
        if (stock_minimo !== undefined) {
            try {
                const parsedStockMin = parsearStockNoNegativoMilesimas(
                    stock_minimo,
                    unidad_venta
                );
                stockMinimoFormateado = parsedStockMin.cantidad;
            } catch (err) {
                if (
                    err instanceof ErrorCalculoInventario ||
                    (err && err.codigo)
                ) {
                    return res.status(400).json({
                        error: err.message,
                        codigo: err.codigo,
                    });
                }
                throw err;
            }
        }

        const idNormalizado = id ? id.trim() : undefined;

        // Idempotencia para reintentos offline: si el UUID ya fue registrado en esta tienda, devolver éxito sin duplicar
        if (idNormalizado) {
            const { data: existente } = await consultarProductoUnico(
                req.supabase,
                (q) =>
                    q
                        .eq('id', idNormalizado)
                        .eq('tienda_id', req.contextoTienda.id)
            );

            if (existente) {
                return res.status(200).json({
                    mensaje:
                        'El producto ya estaba registrado (respuesta idempotente).',
                    idempotente: true,
                    producto: existente,
                });
            }
        }

        const nuevoProductoBase = {
            tienda_id: req.contextoTienda.id,
            nombre: nombre.trim(),
            codigo_barras: codigoNormalizado || null,
            unidad_venta,
            precio_centavos,
        };

        if (idNormalizado) {
            nuevoProductoBase.id = idNormalizado;
        }

        const nuevoProductoSprint3 = {
            ...nuevoProductoBase,
            controla_inventario:
                controla_inventario !== undefined ? controla_inventario : true,
            es_acceso_rapido:
                es_acceso_rapido !== undefined ? es_acceso_rapido : false,
            orden_acceso_rapido:
                orden_acceso_rapido !== undefined ? orden_acceso_rapido : 100,
        };

        const nuevoProductoCompleto =
            stockMinimoFormateado !== undefined
                ? {
                      ...nuevoProductoSprint3,
                      stock_minimo: stockMinimoFormateado,
                  }
                : nuevoProductoSprint3;

        let { data, error } = await req.supabase
            .from('productos')
            .insert(nuevoProductoCompleto)
            .select(COLUMNAS_PRODUCTO)
            .single();

        // Fallback limpio a columnas de Sprint 3 si aún no se aplica la migración 004
        if (
            error &&
            (error.code === '42703' || error.code === 'PGRST204') &&
            stock_minimo === undefined
        ) {
            ({ data, error } = await req.supabase
                .from('productos')
                .insert(nuevoProductoSprint3)
                .select(COLUMNAS_PRODUCTO_SPRINT3)
                .single());
        }

        // Fallback limpio si aún no se aplica la migración 003 y no se exigieron campos exclusivos posteriores
        if (
            error &&
            (error.code === '42703' || error.code === 'PGRST204') &&
            stock_minimo === undefined &&
            controla_inventario === undefined &&
            es_acceso_rapido === undefined &&
            orden_acceso_rapido === undefined
        ) {
            ({ data, error } = await req.supabase
                .from('productos')
                .insert(nuevoProductoBase)
                .select(COLUMNAS_PRODUCTO_BASE)
                .single());
        }

        if (error) {
            if (error.code === '23505') {
                return res.status(409).json({
                    error: 'Ya existe un producto con ese código de barras o identificador en esta tienda.',
                });
            }

            console.error('Error al crear producto:', error.message);

            return res.status(500).json({
                error: 'No fue posible registrar el producto.',
            });
        }

        res.status(201).json({
            mensaje: 'Producto registrado correctamente.',
            idempotente: false,
            producto: data,
        });
    }
);

/**
 * Actualiza parcialmente un producto de la tienda activa (nombre, código de barras,
 * unidad de venta, precio en centavos, control de inventario, acceso rápido o estado activo).
 */
router.patch(
    '/:productoId',
    verificarSesion,
    verificarContextoTienda(),
    async (req, res) => {
        const cuerpo = req.body || {};

        if (
            cuerpo.precio_centavos !== undefined &&
            !tienePermiso(req.contextoTienda.rol, 'productos:cambiar_precio')
        ) {
            return res.status(403).json({
                error: 'Tu rol no tiene permiso para cambiar precios de productos.',
                codigo: 'PERMISO_DENEGADO',
            });
        }

        if (!tienePermiso(req.contextoTienda.rol, 'productos:editar')) {
            return res.status(403).json({
                error: 'Tu rol no tiene permiso para modificar productos.',
                codigo: 'PERMISO_DENEGADO',
            });
        }

        if (cuerpo.stock_actual !== undefined) {
            return res.status(400).json({
                error: 'El campo stock_actual solo se actualiza mediante movimientos de inventario.',
                codigo: 'STOCK_ACTUAL_SOLO_LECTURA',
            });
        }

        const { productoId } = req.params;
        if (!esUuidValido(productoId)) {
            return res.status(400).json({
                error: 'El identificador de producto debe ser un UUID válido.',
            });
        }

        const cambios = {};

        if (cuerpo.nombre !== undefined) {
            if (
                typeof cuerpo.nombre !== 'string' ||
                cuerpo.nombre.trim().length < 1 ||
                cuerpo.nombre.trim().length > 120
            ) {
                return res.status(400).json({
                    error: 'El nombre debe tener entre 1 y 120 caracteres.',
                });
            }
            cambios.nombre = cuerpo.nombre.trim();
        }

        if (cuerpo.codigo_barras !== undefined) {
            if (
                cuerpo.codigo_barras !== null &&
                typeof cuerpo.codigo_barras !== 'string'
            ) {
                return res.status(400).json({
                    error: 'El código de barras debe ser texto o null.',
                });
            }

            const codigoLimpio =
                typeof cuerpo.codigo_barras === 'string'
                    ? cuerpo.codigo_barras.trim()
                    : null;

            if (codigoLimpio && codigoLimpio.length > 80) {
                return res.status(400).json({
                    error: 'El código de barras no puede superar 80 caracteres.',
                });
            }

            cambios.codigo_barras = codigoLimpio || null;
        }

        if (cuerpo.unidad_venta !== undefined) {
            if (!UNIDADES_VENTA_VALIDAS.includes(cuerpo.unidad_venta)) {
                return res.status(400).json({
                    error: 'La unidad debe ser pieza, kg o litro.',
                });
            }
            cambios.unidad_venta = cuerpo.unidad_venta;
        }

        if (cuerpo.precio_centavos !== undefined) {
            if (
                !Number.isSafeInteger(cuerpo.precio_centavos) ||
                cuerpo.precio_centavos < 0 ||
                cuerpo.precio_centavos > 2147483647
            ) {
                return res.status(400).json({
                    error: 'El precio debe ser un número entero de centavos válido.',
                });
            }
            cambios.precio_centavos = cuerpo.precio_centavos;
        }

        if (cuerpo.controla_inventario !== undefined) {
            if (typeof cuerpo.controla_inventario !== 'boolean') {
                return res.status(400).json({
                    error: 'El campo controla_inventario debe ser un valor booleano.',
                });
            }
            cambios.controla_inventario = cuerpo.controla_inventario;
        }

        if (cuerpo.es_acceso_rapido !== undefined) {
            if (typeof cuerpo.es_acceso_rapido !== 'boolean') {
                return res.status(400).json({
                    error: 'El campo es_acceso_rapido debe ser un valor booleano.',
                });
            }
            cambios.es_acceso_rapido = cuerpo.es_acceso_rapido;
        }

        if (cuerpo.orden_acceso_rapido !== undefined) {
            if (
                !Number.isSafeInteger(cuerpo.orden_acceso_rapido) ||
                cuerpo.orden_acceso_rapido < 1 ||
                cuerpo.orden_acceso_rapido > 9999
            ) {
                return res.status(400).json({
                    error: 'El campo orden_acceso_rapido debe ser un número entero entre 1 y 9999.',
                });
            }
            cambios.orden_acceso_rapido = cuerpo.orden_acceso_rapido;
        }

        if (cuerpo.activo !== undefined) {
            if (typeof cuerpo.activo !== 'boolean') {
                return res.status(400).json({
                    error: 'El campo activo debe ser un valor booleano.',
                });
            }
            cambios.activo = cuerpo.activo;
        }

        if (cuerpo.stock_minimo !== undefined) {
            // Primero validar formato decimal no negativo antes de consultar BD
            try {
                parsearStockNoNegativoMilesimas(
                    cuerpo.stock_minimo,
                    cambios.unidad_venta || null
                );
            } catch (err) {
                if (
                    err instanceof ErrorCalculoInventario ||
                    (err && err.codigo)
                ) {
                    return res.status(400).json({
                        error: err.message,
                        codigo: err.codigo,
                    });
                }
                throw err;
            }

            let unidadFinal = cambios.unidad_venta;
            if (!unidadFinal) {
                const { data: prodExistente, error: errorExistente } =
                    await req.supabase
                        .from('productos')
                        .select('id, unidad_venta')
                        .eq('id', productoId.trim())
                        .eq('tienda_id', req.contextoTienda.id)
                        .maybeSingle();

                if (errorExistente) {
                    console.error(
                        'Error al consultar unidad_venta de producto:',
                        errorExistente.message
                    );
                    return res.status(500).json({
                        error: 'No fue posible consultar el producto para actualizar.',
                    });
                }

                if (!prodExistente) {
                    return res.status(404).json({
                        error: 'El producto no existe en la tienda activa.',
                    });
                }

                unidadFinal = prodExistente.unidad_venta;
            }

            try {
                const parsedStockMin = parsearStockNoNegativoMilesimas(
                    cuerpo.stock_minimo,
                    unidadFinal
                );
                cambios.stock_minimo = parsedStockMin.cantidad;
            } catch (err) {
                if (
                    err instanceof ErrorCalculoInventario ||
                    (err && err.codigo)
                ) {
                    return res.status(400).json({
                        error: err.message,
                        codigo: err.codigo,
                    });
                }
                throw err;
            }
        }

        if (Object.keys(cambios).length === 0) {
            return res.status(400).json({
                error: 'Debes enviar al menos un campo válido para actualizar el producto.',
            });
        }

        const modificaColumnasSprint3 =
            cambios.controla_inventario !== undefined ||
            cambios.es_acceso_rapido !== undefined ||
            cambios.orden_acceso_rapido !== undefined;

        let { data, error } = await req.supabase
            .from('productos')
            .update(cambios)
            .eq('id', productoId.trim())
            .eq('tienda_id', req.contextoTienda.id)
            .select(COLUMNAS_PRODUCTO)
            .maybeSingle();

        if (
            error &&
            (error.code === '42703' || error.code === 'PGRST204') &&
            cambios.stock_minimo === undefined
        ) {
            ({ data, error } = await req.supabase
                .from('productos')
                .update(cambios)
                .eq('id', productoId.trim())
                .eq('tienda_id', req.contextoTienda.id)
                .select(COLUMNAS_PRODUCTO_SPRINT3)
                .maybeSingle());
        }

        if (
            error &&
            (error.code === '42703' || error.code === 'PGRST204') &&
            cambios.stock_minimo === undefined &&
            !modificaColumnasSprint3
        ) {
            ({ data, error } = await req.supabase
                .from('productos')
                .update(cambios)
                .eq('id', productoId.trim())
                .eq('tienda_id', req.contextoTienda.id)
                .select(COLUMNAS_PRODUCTO_BASE)
                .maybeSingle());
        }

        if (error) {
            if (error.code === '23505') {
                return res.status(409).json({
                    error: 'Ya existe un producto con ese código de barras en esta tienda.',
                });
            }

            console.error('Error al actualizar producto:', error.message);
            return res.status(500).json({
                error: 'No fue posible actualizar el producto.',
            });
        }

        if (!data) {
            return res.status(404).json({
                error: 'El producto no existe en la tienda activa.',
            });
        }

        res.status(200).json({
            mensaje: 'Producto actualizado correctamente.',
            producto: data,
        });
    }
);

module.exports = router;
