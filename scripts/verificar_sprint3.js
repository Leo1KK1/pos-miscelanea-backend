/**
 * Script de verificación reproducible del Sprint 3:
 * Catálogo completo por tienda, soporte UTF-8 y búsqueda insensible a acentos,
 * botones de acceso rápido, historial inmutable de precios y motor de granel bidireccional.
 *
 * Bloque A (Pruebas deterministas locales — corren SIEMPRE sin credenciales):
 *   1. Normalización de texto en español (plegarAcentos conservando ñ + sanitización PostgREST).
 *   2. Motor de cálculo a granel bidireccional (cotizarPorCantidad, cotizarPorImporte y rechazos).
 *   3. Controles HTTP sin sesión (401 en /por-codigo, /cotizar e /historial-precios).
 *
 * Bloque B (Integración real contra Supabase con TEST_USER_EMAIL y TEST_USER_PASSWORD):
 *   1. Login propietario, localización de Tienda-Demo y aseguramiento de Tienda-Sucursal-Norte.
 *   2. Alta idempotente UTF-8 con ñ y tildes, búsqueda sin acento (?q=jamon) y botonera rápida ordenada.
 *   3. Unicidad de código de barras por tienda (409 en la misma tienda vs 201/200 en otra sucursal).
 *   4. Cotización HTTP directa e inversa de Jamón + desactivación/reactivación segura (try/finally).
 *   5. Historial inmutable de cambios de precio y blindaje PostgREST contra inserción/borrado directo.
 */

const assert = require('node:assert/strict');
const app = require('../src/server');
const { crearClienteSupabase } = require('../src/config/supabase');
const {
    plegarAcentos,
    sanitizarTerminoBusquedaPostgrest,
} = require('../src/utils/texto');
const {
    parsearCantidadAMilesimas,
    formatearMilesimasACantidad,
    cotizarPorCantidad,
    cotizarPorImporte,
} = require('../src/utils/calculosGranel');

// UUIDs deterministas para pruebas idempotentes en la sucursal secundaria
const UUID_SEGUNDA_TIENDA_DEMO = '11111111-2222-4333-8444-555555555555';
const UUID_PRODUCTO_GRANEL_UTF8 = '44444444-5555-4666-8777-888888888888';
const UUID_PRODUCTO_CODIGO_SUCURSAL = '55555555-6666-4777-8888-999999999999';
const UUID_PRODUCTO_CONFLICTO_DEMO = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const CODIGO_REFRESCO_DEMO = '7500000000001';

async function peticionJson(baseUrl, ruta, opciones = {}) {
    const respuesta = await fetch(`${baseUrl}${ruta}`, {
        ...opciones,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            ...(opciones.headers || {}),
        },
    });

    const cuerpo = await respuesta.json().catch(() => ({}));
    return { status: respuesta.status, body: cuerpo };
}

function verificarTextoYAcentosLocal() {
    console.log('A.1) Verificando plegarAcentos y sanitización de búsqueda...');

    assert.equal(plegarAcentos('Jamón Ibérico'), 'jamon iberico');
    assert.equal(plegarAcentos('Azúcar Estándar'), 'azucar estandar');
    assert.equal(plegarAcentos('Piña'), 'piña');
    assert.equal(plegarAcentos('  Pingüino Ñoño  '), 'pinguino ñoño');
    assert.equal(plegarAcentos(''), '');

    const limpio = sanitizarTerminoBusquedaPostgrest('  Jamón, (100%)_extra\\  ');
    assert.equal(limpio, 'Jamón 100extra');

    console.log('   OK: Plegado de acentos (conservando ñ) y sanitización verificados.');
}

function verificarCalculosGranelLocal() {
    console.log('A.2) Verificando motor determinista calculosGranel (BigInt half-up)...');

    assert.equal(parsearCantidadAMilesimas('0.250'), 250n);
    assert.deepEqual(formatearMilesimasACantidad(250n), {
        cantidad: '0.250',
        cantidad_numerica: 0.25,
    });

    // 1. Flujo directo: 0.250 kg a $160.00/kg (16000 centavos) = 4000 centavos ($40.00)
    const directaJamon = cotizarPorCantidad({
        unidad_venta: 'kg',
        cantidad: '0.250',
        precio_unitario_centavos: 16000,
    });
    assert.equal(directaJamon.modo, 'por_cantidad');
    assert.equal(directaJamon.unidad_venta, 'kg');
    assert.equal(directaJamon.cantidad, '0.250');
    assert.equal(directaJamon.cantidad_numerica, 0.25);
    assert.equal(Number(directaJamon.cantidad_milesimas), 250);
    assert.equal(directaJamon.precio_unitario_historico_centavos, 16000);
    assert.equal(directaJamon.subtotal_cobrado_centavos, 4000);
    assert.equal(directaJamon.subtotal_teorico_por_peso_centavos, 4000);
    assert.equal(directaJamon.diferencia_redondeo_centavos, 0);

    // 2. Flujo inverso: "deme $15 de jamón" (1500 centavos a 16000 centavos/kg) -> 0.094 kg
    const inversaQuincePesos = cotizarPorImporte({
        unidad_venta: 'kg',
        importe_centavos: 1500,
        precio_unitario_centavos: 16000,
    });
    assert.equal(inversaQuincePesos.modo, 'por_importe');
    assert.equal(inversaQuincePesos.unidad_venta, 'kg');
    assert.equal(inversaQuincePesos.cantidad, '0.094');
    assert.equal(inversaQuincePesos.cantidad_numerica, 0.094);
    assert.equal(Number(inversaQuincePesos.cantidad_milesimas), 94);
    assert.equal(inversaQuincePesos.precio_unitario_historico_centavos, 16000);
    assert.equal(inversaQuincePesos.subtotal_cobrado_centavos, 1500);
    assert.equal(inversaQuincePesos.subtotal_teorico_por_peso_centavos, 1504);
    assert.equal(inversaQuincePesos.diferencia_redondeo_centavos, -4);

    // 3. Flujo inverso exacto: $40 a $160/kg (4000 a 16000) -> 0.250 kg sin diferencia de redondeo
    const inversaExacta = cotizarPorImporte({
        unidad_venta: 'kg',
        importe_centavos: 4000,
        precio_unitario_centavos: 16000,
    });
    assert.equal(inversaExacta.modo, 'por_importe');
    assert.equal(inversaExacta.cantidad, '0.250');
    assert.equal(Number(inversaExacta.cantidad_milesimas), 250);
    assert.equal(inversaExacta.subtotal_cobrado_centavos, 4000);
    assert.equal(inversaExacta.subtotal_teorico_por_peso_centavos, 4000);
    assert.equal(inversaExacta.diferencia_redondeo_centavos, 0);

    // 4. Rechazos deterministas esperados
    assert.throws(
        () =>
            cotizarPorCantidad({
                unidad_venta: 'pieza',
                cantidad: 0.5,
                precio_unitario_centavos: 2000,
            }),
        (err) => (err.codigo || err.code) === 'CANTIDAD_PIEZA_NO_ENTERA'
    );

    assert.throws(
        () =>
            cotizarPorImporte({
                unidad_venta: 'pieza',
                importe_centavos: 1000,
                precio_unitario_centavos: 2000,
            }),
        (err) => (err.codigo || err.code) === 'FLUJO_INVERSO_NO_APLICA_A_PIEZA'
    );

    assert.throws(
        () =>
            cotizarPorCantidad({
                unidad_venta: 'kg',
                cantidad: '0.1234',
                precio_unitario_centavos: 16000,
            }),
        (err) => (err.codigo || err.code) === 'CANTIDAD_INVALIDA'
    );

    assert.throws(
        () =>
            cotizarPorImporte({
                unidad_venta: 'kg',
                importe_centavos: 1500,
                precio_unitario_centavos: 0,
            }),
        (err) => (err.codigo || err.code) === 'PRECIO_UNITARIO_CERO'
    );

    assert.throws(
        () =>
            cotizarPorImporte({
                unidad_venta: 'kg',
                importe_centavos: 1,
                precio_unitario_centavos: 50000,
            }),
        (err) =>
            (err.codigo || err.code) === 'IMPORTE_INSUFICIENTE_PARA_UNIDAD_MINIMA'
    );

    console.log(
        '   OK: Cálculos directos, inversos ("deme $15") y validaciones de rechazo verificados.'
    );
}

async function ejecutar() {
    console.log('=== BLOQUE A: Pruebas locales deterministas (sin credenciales) ===\n');

    verificarTextoYAcentosLocal();
    verificarCalculosGranelLocal();

    const servidor = app.listen(0);
    await new Promise((resolve) => servidor.once('listening', resolve));

    const { port } = servidor.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
        console.log('A.3) Verificando controles HTTP sin sesión en rutas de catálogo y granel...');

        const rutasProtegidasSprint3 = [
            {
                metodo: 'GET',
                ruta: `/api/productos/por-codigo/${CODIGO_REFRESCO_DEMO}`,
            },
            {
                metodo: 'POST',
                ruta: `/api/productos/${UUID_PRODUCTO_GRANEL_UTF8}/cotizar`,
                body: JSON.stringify({ cantidad: '0.250' }),
            },
            {
                metodo: 'GET',
                ruta: `/api/productos/${UUID_PRODUCTO_GRANEL_UTF8}/historial-precios`,
            },
            {
                metodo: 'GET',
                ruta: `/api/productos/${UUID_PRODUCTO_GRANEL_UTF8}`,
            },
        ];

        for (const item of rutasProtegidasSprint3) {
            const resp = await peticionJson(baseUrl, item.ruta, {
                method: item.metodo,
                body: item.body,
            });
            assert.equal(
                resp.status,
                401,
                `Se esperaba 401 sin sesión en ${item.metodo} ${item.ruta}, recibido ${resp.status}`
            );
        }

        console.log('   OK: Rutas nuevas de catálogo protegidas con 401 sin token.');

        const email1 = process.env.TEST_USER_EMAIL;
        const pass1 = process.env.TEST_USER_PASSWORD;

        if (!email1 || !pass1) {
            console.log(
                '\nAviso: Bloque A completado con éxito. Para ejecutar también el Bloque B contra Supabase:'
            );
            console.log(
                '  $env:TEST_USER_EMAIL="tu-correo"; $env:TEST_USER_PASSWORD="tu-password"; node scripts/verificar_sprint3.js'
            );
            return;
        }

        console.log('\n=== BLOQUE B: Pruebas de integración contra Supabase ===\n');

        console.log(
            'B.1) Iniciando sesión propietario, localizando Tienda-Demo y asegurando Tienda-Sucursal-Norte...'
        );
        const login1 = await peticionJson(baseUrl, '/api/auth/login', {
            method: 'POST',
            body: JSON.stringify({ email: email1, password: pass1 }),
        });
        assert.equal(
            login1.status,
            200,
            `Fallo login cuenta propietario: ${JSON.stringify(login1.body)}`
        );
        const token1 = login1.body.access_token;

        const misTiendas = await peticionJson(baseUrl, '/api/tiendas', {
            headers: { Authorization: `Bearer ${token1}` },
        });
        assert.equal(misTiendas.status, 200);

        const tiendaDemo = misTiendas.body.tiendas.find(
            (t) => t.nombre === 'Tienda-Demo'
        );
        assert.ok(tiendaDemo, 'No se encontró Tienda-Demo para el propietario.');
        assert.equal(tiendaDemo.rol, 'propietario');

        const asegurarSucursal = await peticionJson(baseUrl, '/api/tiendas', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token1}` },
            body: JSON.stringify({
                id: UUID_SEGUNDA_TIENDA_DEMO,
                nombre: 'Tienda-Sucursal-Norte',
            }),
        });
        assert.ok(
            [200, 201].includes(asegurarSucursal.status),
            `Error al asegurar Tienda-Sucursal-Norte: ${JSON.stringify(asegurarSucursal.body)}`
        );

        const headersDemo = {
            Authorization: `Bearer ${token1}`,
            'X-Tienda-Id': tiendaDemo.id,
        };
        const headersSucursal = {
            Authorization: `Bearer ${token1}`,
            'X-Tienda-Id': UUID_SEGUNDA_TIENDA_DEMO,
        };

        console.log('   OK: Contextos listos para Tienda-Demo y Tienda-Sucursal-Norte.');

        console.log(
            'B.2) Verificando UTF-8 (acentos y ñ), búsqueda sin tilde (?q=jamon) y acceso rápido...'
        );
        const nombreUtf8Esperado = 'Chiles Jalapeños en Escabeche';
        const altaGranelUtf8 = await peticionJson(baseUrl, '/api/productos', {
            method: 'POST',
            headers: headersSucursal,
            body: JSON.stringify({
                id: UUID_PRODUCTO_GRANEL_UTF8,
                nombre: nombreUtf8Esperado,
                unidad_venta: 'kg',
                precio_centavos: 9500,
                codigo_barras: null,
                es_acceso_rapido: true,
                orden_acceso_rapido: 10,
                controla_inventario: false,
            }),
        });
        assert.ok(
            [200, 201].includes(altaGranelUtf8.status),
            `Error al registrar producto granel UTF-8: ${JSON.stringify(altaGranelUtf8.body)}`
        );

        // Si preexistía de una corrida interrumpida con algún valor distinto, normalizar estado base
        const prodActual = altaGranelUtf8.body.producto;
        if (
            prodActual.nombre !== nombreUtf8Esperado ||
            prodActual.precio_centavos !== 9500 ||
            prodActual.codigo_barras !== null ||
            prodActual.es_acceso_rapido !== true ||
            prodActual.orden_acceso_rapido !== 10 ||
            prodActual.controla_inventario !== false ||
            prodActual.activo !== true
        ) {
            const normalizarBase = await peticionJson(
                baseUrl,
                `/api/productos/${UUID_PRODUCTO_GRANEL_UTF8}`,
                {
                    method: 'PATCH',
                    headers: headersSucursal,
                    body: JSON.stringify({
                        nombre: nombreUtf8Esperado,
                        precio_centavos: 9500,
                        codigo_barras: null,
                        es_acceso_rapido: true,
                        orden_acceso_rapido: 10,
                        controla_inventario: false,
                        activo: true,
                    }),
                }
            );
            assert.equal(normalizarBase.status, 200);
        }

        const detalleUtf8 = await peticionJson(
            baseUrl,
            `/api/productos/${UUID_PRODUCTO_GRANEL_UTF8}`,
            { headers: headersSucursal }
        );
        assert.equal(detalleUtf8.status, 200);
        assert.equal(detalleUtf8.body.producto.nombre, nombreUtf8Esperado);
        assert.equal(detalleUtf8.body.producto.codigo_barras, null);
        assert.equal(detalleUtf8.body.producto.unidad_venta, 'kg');
        assert.equal(detalleUtf8.body.producto.precio_centavos, 9500);
        assert.equal(detalleUtf8.body.producto.es_acceso_rapido, true);
        assert.equal(detalleUtf8.body.producto.orden_acceso_rapido, 10);
        assert.equal(detalleUtf8.body.producto.controla_inventario, false);
        assert.equal(detalleUtf8.body.producto.activo, true);

        // Búsqueda sin tilde en Tienda-Demo: ?q=jamon debe encontrar "Jamón"
        const busquedaJamon = await peticionJson(
            baseUrl,
            '/api/productos?q=jamon',
            { headers: headersDemo }
        );
        assert.equal(busquedaJamon.status, 200);
        assert.ok(busquedaJamon.body.paginacion, 'La respuesta debe incluir metadatos de paginacion.');
        assert.equal(typeof busquedaJamon.body.paginacion.limite, 'number');
        assert.equal(typeof busquedaJamon.body.paginacion.offset, 'number');
        assert.equal(
            busquedaJamon.body.paginacion.devueltos,
            busquedaJamon.body.productos.length
        );

        const jamonDemo = busquedaJamon.body.productos.find(
            (p) => p.nombre === 'Jamón'
        );
        assert.ok(
            jamonDemo,
            `La búsqueda ?q=jamon no devolvió "Jamón". Recibido: ${JSON.stringify(busquedaJamon.body.productos)}`
        );

        // Consulta de botonera rápida activa y verificación de ordenamiento
        const rapidosSucursal = await peticionJson(
            baseUrl,
            '/api/productos?acceso_rapido=true&solo_activos=true',
            { headers: headersSucursal }
        );
        assert.equal(rapidosSucursal.status, 200);
        assert.ok(
            rapidosSucursal.body.productos.some(
                (p) => p.id === UUID_PRODUCTO_GRANEL_UTF8
            ),
            'El producto de acceso rápido recién asegurado debe aparecer en ?acceso_rapido=true&solo_activos=true.'
        );
        for (let i = 0; i < rapidosSucursal.body.productos.length; i += 1) {
            const actual = rapidosSucursal.body.productos[i];
            assert.equal(actual.es_acceso_rapido, true);
            assert.equal(actual.activo, true);
            if (i > 0) {
                const anterior = rapidosSucursal.body.productos[i - 1];
                assert.ok(
                    actual.orden_acceso_rapido >= anterior.orden_acceso_rapido,
                    'Los productos de acceso rápido deben devolverse ordenados por orden_acceso_rapido ascendente.'
                );
            }
        }

        const rapidosDemo = await peticionJson(
            baseUrl,
            '/api/productos?acceso_rapido=true&solo_activos=true',
            { headers: headersDemo }
        );
        assert.equal(rapidosDemo.status, 200);
        assert.ok(
            rapidosDemo.body.productos.length >= 1,
            'Tienda-Demo debe devolver sus productos a granel marcados con acceso rápido.'
        );
        for (let i = 1; i < rapidosDemo.body.productos.length; i += 1) {
            assert.ok(
                rapidosDemo.body.productos[i].orden_acceso_rapido >=
                    rapidosDemo.body.productos[i - 1].orden_acceso_rapido,
                'Botonera rápida en Tienda-Demo fuera de orden.'
            );
        }

        console.log(
            '   OK: UTF-8 con ñ/tildes, búsqueda ?q=jamon y botonera de acceso rápido verificados.'
        );

        console.log(
            'B.3) Verificando unicidad de código de barras por tienda vs aislamiento entre sucursales...'
        );
        const duplicadoMismaTienda = await peticionJson(
            baseUrl,
            '/api/productos',
            {
                method: 'POST',
                headers: headersDemo,
                body: JSON.stringify({
                    id: UUID_PRODUCTO_CONFLICTO_DEMO,
                    nombre: 'Duplicado Refresco Tienda Demo',
                    codigo_barras: CODIGO_REFRESCO_DEMO,
                    unidad_venta: 'pieza',
                    precio_centavos: 2100,
                }),
            }
        );
        assert.equal(
            duplicadoMismaTienda.status,
            409,
            `Se esperaba 409 al duplicar código ${CODIGO_REFRESCO_DEMO} en Tienda-Demo, recibido ${duplicadoMismaTienda.status}`
        );

        const mismoCodigoOtraTienda = await peticionJson(
            baseUrl,
            '/api/productos',
            {
                method: 'POST',
                headers: headersSucursal,
                body: JSON.stringify({
                    id: UUID_PRODUCTO_CODIGO_SUCURSAL,
                    nombre: 'Refresco de Cola Sucursal Norte',
                    codigo_barras: CODIGO_REFRESCO_DEMO,
                    unidad_venta: 'pieza',
                    precio_centavos: 1950,
                }),
            }
        );
        assert.ok(
            [200, 201].includes(mismoCodigoOtraTienda.status),
            `Tiendas distintas deben poder usar el mismo código de barras: ${JSON.stringify(mismoCodigoOtraTienda.body)}`
        );

        const porCodigoDemo = await peticionJson(
            baseUrl,
            `/api/productos/por-codigo/${CODIGO_REFRESCO_DEMO}`,
            { headers: headersDemo }
        );
        assert.equal(porCodigoDemo.status, 200);
        assert.equal(porCodigoDemo.body.producto.tienda_id, tiendaDemo.id);
        assert.equal(
            porCodigoDemo.body.producto.codigo_barras,
            CODIGO_REFRESCO_DEMO
        );
        assert.notEqual(
            porCodigoDemo.body.producto.id,
            UUID_PRODUCTO_CODIGO_SUCURSAL,
            'Fuga entre tiendas: /por-codigo en Tienda-Demo devolvió el registro de Tienda-Sucursal-Norte.'
        );

        const porCodigoSucursal = await peticionJson(
            baseUrl,
            `/api/productos/por-codigo/${CODIGO_REFRESCO_DEMO}`,
            { headers: headersSucursal }
        );
        assert.equal(porCodigoSucursal.status, 200);
        assert.equal(
            porCodigoSucursal.body.producto.id,
            UUID_PRODUCTO_CODIGO_SUCURSAL
        );

        console.log(
            '   OK: Duplicado rechazado en misma tienda (409) y permitido/aislado entre sucursales.'
        );

        console.log(
            'B.4) Verificando cotización HTTP directa e inversa y bloqueo al desactivar producto...'
        );
        const cotDirectaHttp = await peticionJson(
            baseUrl,
            `/api/productos/${jamonDemo.id}/cotizar`,
            {
                method: 'POST',
                headers: headersDemo,
                body: JSON.stringify({ cantidad: '0.250' }),
            }
        );
        assert.equal(
            cotDirectaHttp.status,
            200,
            `Error en cotización directa de Jamón: ${JSON.stringify(cotDirectaHttp.body)}`
        );
        assert.equal(cotDirectaHttp.body.cotizacion.modo, 'por_cantidad');
        assert.equal(cotDirectaHttp.body.cotizacion.cantidad, '0.250');
        assert.equal(
            cotDirectaHttp.body.cotizacion.subtotal_cobrado_centavos,
            4000
        );

        const cotInversaHttp = await peticionJson(
            baseUrl,
            `/api/productos/${jamonDemo.id}/cotizar`,
            {
                method: 'POST',
                headers: headersDemo,
                body: JSON.stringify({ importe_centavos: 1500 }),
            }
        );
        assert.equal(
            cotInversaHttp.status,
            200,
            `Error en cotización inversa de Jamón: ${JSON.stringify(cotInversaHttp.body)}`
        );
        assert.equal(cotInversaHttp.body.cotizacion.modo, 'por_importe');
        assert.equal(cotInversaHttp.body.cotizacion.cantidad, '0.094');
        assert.equal(
            cotInversaHttp.body.cotizacion.subtotal_cobrado_centavos,
            1500
        );
        assert.equal(
            cotInversaHttp.body.cotizacion.subtotal_teorico_por_peso_centavos,
            1504
        );
        assert.equal(
            cotInversaHttp.body.cotizacion.diferencia_redondeo_centavos,
            -4
        );

        // Desactivar temporalmente el producto de prueba y reactivar siempre en finally
        try {
            const desactivarResp = await peticionJson(
                baseUrl,
                `/api/productos/${UUID_PRODUCTO_GRANEL_UTF8}`,
                {
                    method: 'PATCH',
                    headers: headersSucursal,
                    body: JSON.stringify({ activo: false }),
                }
            );
            assert.equal(desactivarResp.status, 200);
            assert.equal(desactivarResp.body.producto.activo, false);

            const activosSucursal = await peticionJson(
                baseUrl,
                '/api/productos?solo_activos=true',
                { headers: headersSucursal }
            );
            assert.equal(activosSucursal.status, 200);
            assert.equal(
                activosSucursal.body.productos.some(
                    (p) => p.id === UUID_PRODUCTO_GRANEL_UTF8
                ),
                false,
                'Un producto desactivado NO debe aparecer cuando se filtra con ?solo_activos=true.'
            );

            const cotizarInactivo = await peticionJson(
                baseUrl,
                `/api/productos/${UUID_PRODUCTO_GRANEL_UTF8}/cotizar`,
                {
                    method: 'POST',
                    headers: headersSucursal,
                    body: JSON.stringify({ cantidad: '0.500' }),
                }
            );
            assert.equal(
                cotizarInactivo.status,
                409,
                `Cotizar un producto inactivo debe responder 409, recibido ${cotizarInactivo.status}`
            );
        } finally {
            const reactivarResp = await peticionJson(
                baseUrl,
                `/api/productos/${UUID_PRODUCTO_GRANEL_UTF8}`,
                {
                    method: 'PATCH',
                    headers: headersSucursal,
                    body: JSON.stringify({ activo: true }),
                }
            );
            assert.equal(reactivarResp.status, 200);
            assert.equal(reactivarResp.body.producto.activo, true);
        }

        console.log(
            '   OK: Cotización HTTP (4000 centavos y 0.094 kg) y baja/reactivación verificadas.'
        );

        console.log(
            'B.5) Verificando historial inmutable de precios y blindaje directo en PostgREST...'
        );
        try {
            const subirPrecio = await peticionJson(
                baseUrl,
                `/api/productos/${UUID_PRODUCTO_GRANEL_UTF8}`,
                {
                    method: 'PATCH',
                    headers: headersSucursal,
                    body: JSON.stringify({ precio_centavos: 9800 }),
                }
            );
            assert.equal(subirPrecio.status, 200);
            assert.equal(subirPrecio.body.producto.precio_centavos, 9800);
        } finally {
            const restaurarPrecio = await peticionJson(
                baseUrl,
                `/api/productos/${UUID_PRODUCTO_GRANEL_UTF8}`,
                {
                    method: 'PATCH',
                    headers: headersSucursal,
                    body: JSON.stringify({ precio_centavos: 9500 }),
                }
            );
            assert.equal(restaurarPrecio.status, 200);
            assert.equal(restaurarPrecio.body.producto.precio_centavos, 9500);
        }

        const historialResp = await peticionJson(
            baseUrl,
            `/api/productos/${UUID_PRODUCTO_GRANEL_UTF8}/historial-precios`,
            { headers: headersSucursal }
        );
        assert.equal(
            historialResp.status,
            200,
            `Error al consultar historial de precios: ${JSON.stringify(historialResp.body)}`
        );
        assert.ok(Array.isArray(historialResp.body.historial));
        assert.ok(
            historialResp.body.historial.length >= 2,
            'El historial debe contener al menos el incremento y la restauración de precio.'
        );

        const registroSubida = historialResp.body.historial.find(
            (h) =>
                h.precio_anterior_centavos === 9500 &&
                h.precio_nuevo_centavos === 9800
        );
        const registroRestauracion = historialResp.body.historial.find(
            (h) =>
                h.precio_anterior_centavos === 9800 &&
                h.precio_nuevo_centavos === 9500
        );
        assert.ok(
            registroSubida,
            'Falta registro en historial con transición 9500 -> 9800.'
        );
        assert.ok(
            registroRestauracion,
            'Falta registro en historial con transición 9800 -> 9500.'
        );

        // Blindaje PostgREST: ningún cliente autenticado puede insertar ni borrar historial directamente
        const supabasePropietario = crearClienteSupabase(token1);

        const { error: errorInsertHistorial } = await supabasePropietario
            .from('producto_precios_historial')
            .insert({
                tienda_id: UUID_SEGUNDA_TIENDA_DEMO,
                producto_id: UUID_PRODUCTO_GRANEL_UTF8,
                precio_anterior_centavos: 9500,
                precio_nuevo_centavos: 100,
            });
        assert.ok(
            errorInsertHistorial,
            'Fallo de seguridad: PostgREST permitió insertar manualmente en producto_precios_historial.'
        );

        const { error: errorDeleteHistorial } = await supabasePropietario
            .from('producto_precios_historial')
            .delete()
            .eq('producto_id', UUID_PRODUCTO_GRANEL_UTF8);
        assert.ok(
            errorDeleteHistorial,
            'Fallo de seguridad: PostgREST permitió borrar registros de producto_precios_historial.'
        );

        console.log(
            '   OK: Cambios registrados por trigger y tabla producto_precios_historial blindada en PostgREST.'
        );

        console.log('\nVerificación completa de Sprint 3 exitosa.');
    } finally {
        await new Promise((resolve) => servidor.close(resolve));
    }
}

ejecutar().catch((error) => {
    console.error('\nFallo en verificación de Sprint 3:', error);
    process.exit(1);
});
