const express = require('express');
const {
    verificarSesion,
    verificarContextoTienda,
} = require('../middlewares/autenticacion');
const { tienePermiso } = require('../config/permisos');
const { esUuidValido, esFechaIsoValida } = require('../utils/validaciones');

// mergeParams permite leer :tiendaId cuando se monta bajo /api/tiendas/:tiendaId/productos
const router = express.Router({ mergeParams: true });

const COLUMNAS_PRODUCTO =
    'id, tienda_id, nombre, codigo_barras, unidad_venta, precio_centavos, activo, creado_en, actualizado_en';

const UNIDADES_VENTA_VALIDAS = ['pieza', 'kg', 'litro'];

/**
 * Consultar el catálogo de productos de la tienda activa.
 * Soporta filtro incremental opcional `?actualizado_desde=<ISO-8601>` para sincronización Offline-First.
 */
router.get(
    '/',
    verificarSesion,
    verificarContextoTienda({ permisoRequerido: 'productos:leer' }),
    async (req, res) => {
        const { actualizado_desde, solo_activos } = req.query || {};

        if (
            actualizado_desde !== undefined &&
            !esFechaIsoValida(actualizado_desde)
        ) {
            return res.status(400).json({
                error: 'El parámetro actualizado_desde debe ser una fecha ISO-8601 válida.',
            });
        }

        let consulta = req.supabase
            .from('productos')
            .select(COLUMNAS_PRODUCTO)
            .eq('tienda_id', req.contextoTienda.id);

        if (actualizado_desde !== undefined) {
            consulta = consulta.gt(
                'actualizado_en',
                new Date(actualizado_desde).toISOString()
            );
        }

        if (solo_activos === 'true') {
            consulta = consulta.eq('activo', true);
        }

        const { data, error } = await consulta.order('nombre', {
            ascending: true,
        });

        if (error) {
            console.error('Error al consultar productos:', error.message);
            return res.status(500).json({
                error: 'No fue posible consultar los productos de la tienda.',
            });
        }

        res.json({
            tienda: {
                id: req.contextoTienda.id,
                nombre: req.contextoTienda.nombre,
                rol: req.contextoTienda.rol,
            },
            productos: data,
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
        } = req.body || {};

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

        const idNormalizado = id ? id.trim() : undefined;

        // Idempotencia para reintentos offline: si el UUID ya fue registrado en esta tienda, devolver éxito sin duplicar
        if (idNormalizado) {
            const { data: existente } = await req.supabase
                .from('productos')
                .select(COLUMNAS_PRODUCTO)
                .eq('id', idNormalizado)
                .eq('tienda_id', req.contextoTienda.id)
                .maybeSingle();

            if (existente) {
                return res.status(200).json({
                    mensaje: 'El producto ya estaba registrado (respuesta idempotente).',
                    idempotente: true,
                    producto: existente,
                });
            }
        }

        const nuevoProducto = {
            tienda_id: req.contextoTienda.id,
            nombre: nombre.trim(),
            codigo_barras: codigoNormalizado || null,
            unidad_venta,
            precio_centavos,
        };

        if (idNormalizado) {
            nuevoProducto.id = idNormalizado;
        }

        const { data, error } = await req.supabase
            .from('productos')
            .insert(nuevoProducto)
            .select(COLUMNAS_PRODUCTO)
            .single();

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
 * unidad de venta, precio en centavos o estado activo).
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

        if (cuerpo.activo !== undefined) {
            if (typeof cuerpo.activo !== 'boolean') {
                return res.status(400).json({
                    error: 'El campo activo debe ser un valor booleano.',
                });
            }
            cambios.activo = cuerpo.activo;
        }

        if (Object.keys(cambios).length === 0) {
            return res.status(400).json({
                error: 'Debes enviar al menos un campo válido para actualizar el producto.',
            });
        }

        const { data, error } = await req.supabase
            .from('productos')
            .update(cambios)
            .eq('id', productoId.trim())
            .eq('tienda_id', req.contextoTienda.id)
            .select(COLUMNAS_PRODUCTO)
            .maybeSingle();

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
