/**
 * Script de verificación reproducible del Sprint 4:
 * Inventario como Libro Mayor (inventario_movimientos), entradas por bulto/barra,
 * mermas, ajustes, política de stock negativo permitido con alerta y blindaje PostgREST.
 *
 * Bloque A (Pruebas deterministas locales — corren SIEMPRE sin credenciales):
 *   1. Permisos de inventario en MATRIZ_PERMISOS (cajero solo inventario:leer;
 *      propietario y encargado con kardex, registrar y ajustar).
 *   2. Motor determinista calculosInventario (conversión por presentación/bulto,
 *      merma, ajustes firmados, rechazos por código y evaluarAlertasStock).
 *   3. Controles HTTP sin sesión (401 en /api/inventario/existencias y /movimientos).
 *
 * Bloque B (Integración real contra Supabase con TEST_USER_EMAIL y TEST_USER_PASSWORD):
 *   1. Login propietario, localización de Tienda-Demo y aseguramiento de Tienda-Sucursal-Norte.
 *   2. Alta de producto inventariable limpio por corrida (baja lógica en finally) y
 *      rechazo 400 STOCK_ACTUAL_SOLO_LECTURA al intentar sobrescribir stock_actual.
 *   3. Flujo completo del Libro Mayor: compra de barra -> reintento idempotente (200) ->
 *      merma -> ajuste a negativo permitido con alerta -> verificación en existencias y kardex -> cuadre.
 *   4. Rechazo 409 PRODUCTO_SIN_CONTROL_INVENTARIO y aislamiento 404 entre tiendas.
 *   5. Blindaje directo en Supabase PostgREST sobre productos.stock_actual e inventario_movimientos.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const app = require('../src/server');
const { crearClienteSupabase } = require('../src/config/supabase');
const {
    MATRIZ_PERMISOS,
    tienePermiso,
    obtenerPermisosDeRol,
} = require('../src/config/permisos');
const {
    ErrorCalculoInventario,
    parsearDeltaMilesimas,
    parsearStockNoNegativoMilesimas,
    formatearDeltaMilesimas,
    prepararMovimientoInventario,
    evaluarAlertasStock,
} = require('../src/utils/calculosInventario');

const UUID_SEGUNDA_TIENDA_DEMO = '11111111-2222-4333-8444-555555555555';
const UUID_PRODUCTO_SIN_INVENTARIO = '44444444-5555-4666-8777-888888888888';

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

/**
 * Normaliza un saldo o delta numérico/textual (ej. `3.5` de JSONB o `'3.500'`)
 * a cadena exacta de 3 decimales (`NUMERIC(12,3)`), validando que no sea nulo.
 *
 * @param {number|string} valor
 * @returns {string}
 */
function normalizarCantidadExacta(valor) {
    assert.notEqual(valor, undefined, 'Se esperaba una cantidad definida.');
    assert.notEqual(valor, null, 'Se esperaba una cantidad no nula.');
    return evaluarAlertasStock({
        controla_inventario: false,
        stock_actual: valor,
        stock_minimo: 0,
    }).stock_actual;
}

function verificarPermisosInventarioLocal() {
    console.log('A.1) Verificando permisos de inventario en MATRIZ_PERMISOS...');

    const permisosInventario = [
        'inventario:leer',
        'inventario:kardex',
        'inventario:registrar',
        'inventario:ajustar',
    ];

    for (const permiso of permisosInventario) {
        assert.ok(
            Array.isArray(MATRIZ_PERMISOS[permiso]),
            `Falta definir ${permiso} en MATRIZ_PERMISOS.`
        );
        assert.equal(
            tienePermiso('propietario', permiso),
            true,
            `propietario debe tener ${permiso}.`
        );
        assert.equal(
            tienePermiso('encargado', permiso),
            true,
            `encargado debe tener ${permiso}.`
        );
    }

    assert.equal(tienePermiso('cajero', 'inventario:leer'), true);
    assert.equal(tienePermiso('cajero', 'inventario:kardex'), false);
    assert.equal(tienePermiso('cajero', 'inventario:registrar'), false);
    assert.equal(tienePermiso('cajero', 'inventario:ajustar'), false);

    const listaCajero = obtenerPermisosDeRol('cajero');
    assert.ok(listaCajero.includes('inventario:leer'));
    assert.equal(listaCajero.includes('inventario:kardex'), false);
    assert.equal(listaCajero.includes('inventario:registrar'), false);
    assert.equal(listaCajero.includes('inventario:ajustar'), false);

    console.log(
        '   OK: Permisos de inventario verificados para propietario, encargado y cajero.'
    );
}

function verificarCalculosInventarioLocal() {
    console.log(
        'A.2) Verificando motor determinista calculosInventario (BigInt milésimas)...'
    );

    assert.equal(parsearDeltaMilesimas('3.500'), 3500n);
    assert.equal(parsearDeltaMilesimas('-0.150'), -150n);
    assert.equal(formatearDeltaMilesimas(7000n), '7.000');
    assert.equal(formatearDeltaMilesimas(-150n), '-0.150');

    const stockMinimoOk = parsearStockNoNegativoMilesimas('1.500', 'kg');
    assert.equal(stockMinimoOk.milesimas, 1500n);
    assert.equal(stockMinimoOk.cantidad, '1.500');

    assert.throws(
        () => parsearStockNoNegativoMilesimas('-0.500', 'kg'),
        (err) =>
            err instanceof ErrorCalculoInventario &&
            err.codigo === 'STOCK_MINIMO_INVALIDO'
    );

    // 1. Compra por presentación/bulto: 2 barras de 3.500 kg -> +7.000 kg (7000 milésimas)
    const compraBarras = prepararMovimientoInventario({
        unidad_venta: 'kg',
        tipo_movimiento: 'compra',
        presentacion_cantidad: '3.500',
        unidades_por_presentacion: 2,
        costo_total_centavos: 84000,
        motivo: 'Llegada de 2 barras de jamón de 3.5 kg',
    });
    assert.equal(compraBarras.tipo_movimiento, 'compra');
    assert.equal(compraBarras.cantidad_delta, '7.000');
    assert.equal(Number(compraBarras.cantidad_delta_milesimas), 7000);
    assert.equal(compraBarras.costo_total_centavos, 84000);
    assert.equal(
        compraBarras.motivo,
        'Llegada de 2 barras de jamón de 3.5 kg'
    );

    // Compra directa de bulto de azúcar 25.000 kg sin motivo explícito -> motivo por defecto
    const compraBultoAzucar = prepararMovimientoInventario({
        unidad_venta: 'kg',
        tipo_movimiento: 'compra',
        cantidad: '25.000',
        costo_total_centavos: 52500,
    });
    assert.equal(compraBultoAzucar.cantidad_delta, '25.000');
    assert.equal(Number(compraBultoAzucar.cantidad_delta_milesimas), 25000);
    assert.equal(compraBultoAzucar.costo_total_centavos, 52500);
    assert.ok(compraBultoAzucar.motivo.length >= 1);

    assert.throws(
        () =>
            prepararMovimientoInventario({
                unidad_venta: 'kg',
                tipo_movimiento: 'compra',
                cantidad: '3.500',
                presentacion_cantidad: '3.500',
                unidades_por_presentacion: 1,
            }),
        (err) => err.codigo === 'ENTRADA_AMBIGUA'
    );

    // 2. Merma en gramos: 0.150 kg -> -0.150 kg (exige motivo obligatorio)
    const mermaJamon = prepararMovimientoInventario({
        unidad_venta: 'kg',
        tipo_movimiento: 'merma',
        cantidad: '0.150',
        motivo: 'Orilla reseca',
    });
    assert.equal(mermaJamon.tipo_movimiento, 'merma');
    assert.equal(mermaJamon.cantidad_delta, '-0.150');
    assert.equal(Number(mermaJamon.cantidad_delta_milesimas), -150);
    assert.equal(mermaJamon.motivo, 'Orilla reseca');
    assert.equal(mermaJamon.costo_total_centavos, null);

    assert.throws(
        () =>
            prepararMovimientoInventario({
                unidad_venta: 'kg',
                tipo_movimiento: 'merma',
                cantidad: '0.150',
            }),
        (err) => err.codigo === 'MOTIVO_REQUERIDO'
    );

    assert.throws(
        () =>
            prepararMovimientoInventario({
                unidad_venta: 'kg',
                tipo_movimiento: 'merma',
                presentacion_cantidad: '3.500',
                unidades_por_presentacion: 1,
                motivo: 'No permitido en merma',
            }),
        (err) => err.codigo === 'PRESENTACION_NO_PERMITIDA'
    );

    // 3. Ajustes negativo y positivo con motivo obligatorio y cantidad_delta explícita
    const ajusteNegativo = prepararMovimientoInventario({
        unidad_venta: 'kg',
        tipo_movimiento: 'ajuste',
        cantidad_delta: '-0.250',
        motivo: 'Faltante detectado en conteo físico',
    });
    assert.equal(ajusteNegativo.tipo_movimiento, 'ajuste');
    assert.equal(ajusteNegativo.cantidad_delta, '-0.250');
    assert.equal(Number(ajusteNegativo.cantidad_delta_milesimas), -250);

    const ajustePositivo = prepararMovimientoInventario({
        unidad_venta: 'kg',
        tipo_movimiento: 'ajuste',
        cantidad_delta: '0.500',
        motivo: 'Sobrante verificado en vitrina',
    });
    assert.equal(ajustePositivo.tipo_movimiento, 'ajuste');
    assert.equal(ajustePositivo.cantidad_delta, '0.500');
    assert.equal(Number(ajustePositivo.cantidad_delta_milesimas), 500);

    assert.throws(
        () =>
            prepararMovimientoInventario({
                unidad_venta: 'kg',
                tipo_movimiento: 'ajuste',
                cantidad_delta: '-0.250',
                motivo: '   ',
            }),
        (err) => err.codigo === 'MOTIVO_REQUERIDO'
    );

    assert.throws(
        () =>
            prepararMovimientoInventario({
                unidad_venta: 'kg',
                tipo_movimiento: 'ajuste',
                cantidad: '0.250',
                motivo: 'Envió cantidad sin signo en vez de cantidad_delta',
            }),
        (err) => err.codigo === 'AJUSTE_REQUIERE_CANTIDAD_DELTA'
    );

    // 4. Rechazo de 'venta' en ruta manual y rechazo de decimal en 'pieza'
    assert.throws(
        () =>
            prepararMovimientoInventario({
                unidad_venta: 'kg',
                tipo_movimiento: 'venta',
                cantidad: '0.250',
                motivo: 'Las ventas entran por la RPC de Sprint 6',
            }),
        (err) => err.codigo === 'TIPO_MOVIMIENTO_INVALIDO'
    );

    assert.throws(
        () =>
            prepararMovimientoInventario({
                unidad_venta: 'pieza',
                tipo_movimiento: 'compra',
                cantidad: '1.500',
                motivo: 'Media pieza inválida',
            }),
        (err) => err.codigo === 'CANTIDAD_PIEZA_NO_ENTERA'
    );

    // 5. Evaluación determinista de alertas de bajo stock y stock negativo
    const alertaNegativa = evaluarAlertasStock({
        controla_inventario: true,
        stock_actual: '-0.100',
        stock_minimo: '1.000',
    });
    assert.deepEqual(alertaNegativa, {
        stock_actual: '-0.100',
        stock_minimo: '1.000',
        alerta_stock_negativo: true,
        alerta_bajo_stock: true,
    });

    const alertaBajoSinNegativo = evaluarAlertasStock({
        controla_inventario: true,
        stock_actual: '1.000',
        stock_minimo: '1.000',
    });
    assert.equal(alertaBajoSinNegativo.alerta_stock_negativo, false);
    assert.equal(alertaBajoSinNegativo.alerta_bajo_stock, true);

    const sinControlInventario = evaluarAlertasStock({
        controla_inventario: false,
        stock_actual: '-0.100',
        stock_minimo: '1.000',
    });
    assert.deepEqual(sinControlInventario, {
        stock_actual: '-0.100',
        stock_minimo: '1.000',
        alerta_stock_negativo: false,
        alerta_bajo_stock: false,
    });

    console.log(
        '   OK: Conversión por presentación, merma, ajustes, rechazos y alertas verificados.'
    );
}

async function ejecutar() {
    console.log('=== BLOQUE A: Pruebas locales deterministas (sin credenciales) ===\n');

    verificarPermisosInventarioLocal();
    verificarCalculosInventarioLocal();

    const servidor = app.listen(0);
    await new Promise((resolve) => servidor.once('listening', resolve));

    const { port } = servidor.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
        console.log('A.3) Verificando controles HTTP sin sesión en rutas de inventario...');

        const rutasProtegidasSprint4 = [
            { metodo: 'GET', ruta: '/api/inventario/existencias' },
            { metodo: 'GET', ruta: '/api/inventario/movimientos' },
            {
                metodo: 'POST',
                ruta: '/api/inventario/movimientos',
                body: JSON.stringify({
                    producto_id: UUID_PRODUCTO_SIN_INVENTARIO,
                    tipo_movimiento: 'compra',
                    cantidad: '1.000',
                }),
            },
            {
                metodo: 'GET',
                ruta: `/api/tiendas/${UUID_SEGUNDA_TIENDA_DEMO}/inventario/existencias`,
            },
            {
                metodo: 'GET',
                ruta: `/api/tiendas/${UUID_SEGUNDA_TIENDA_DEMO}/inventario/movimientos`,
            },
        ];

        for (const item of rutasProtegidasSprint4) {
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

        console.log('   OK: Rutas de inventario protegidas con 401 sin token.');

        const email1 = process.env.TEST_USER_EMAIL;
        const pass1 = process.env.TEST_USER_PASSWORD;

        if (!email1 || !pass1) {
            console.log(
                '\nAviso: Bloque A completado con éxito. Para ejecutar también el Bloque B contra Supabase:'
            );
            console.log(
                '  $env:TEST_USER_EMAIL="tu-correo"; $env:TEST_USER_PASSWORD="tu-password"; node scripts/verificar_sprint4.js'
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
        const usuario1Id = login1.body.usuario.id;

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

        // UUID único por corrida para garantizar saldo inicial 0.000 en un Libro Mayor append-only
        const productoCorridaId = crypto.randomUUID();
        const movCompraId = crypto.randomUUID();
        const movMermaId = crypto.randomUUID();
        const movAjusteNegativoId = crypto.randomUUID();
        const movCuadreFinalId = crypto.randomUUID();
        let productoCorridaCreado = false;

        try {
            console.log(
                'B.2) Creando producto inventariable de prueba y validando STOCK_ACTUAL_SOLO_LECTURA...'
            );

            const intentoPostConStock = await peticionJson(
                baseUrl,
                '/api/productos',
                {
                    method: 'POST',
                    headers: headersSucursal,
                    body: JSON.stringify({
                        nombre: 'Intento Stock Directo Alta',
                        unidad_venta: 'kg',
                        precio_centavos: 15000,
                        stock_actual: '5.000',
                    }),
                }
            );
            assert.equal(intentoPostConStock.status, 400);
            assert.equal(
                intentoPostConStock.body.codigo,
                'STOCK_ACTUAL_SOLO_LECTURA'
            );

            const altaProdInventario = await peticionJson(
                baseUrl,
                '/api/productos',
                {
                    method: 'POST',
                    headers: headersSucursal,
                    body: JSON.stringify({
                        id: productoCorridaId,
                        nombre: `Jamón Kardex Sprint4 ${productoCorridaId.slice(0, 8)}`,
                        unidad_venta: 'kg',
                        precio_centavos: 17000,
                        controla_inventario: true,
                        stock_minimo: '1.000',
                    }),
                }
            );
            assert.equal(
                altaProdInventario.status,
                201,
                `Error al crear producto inventariable (verifica haber aplicado migrations/004_inventario_libro_mayor.sql): ${JSON.stringify(altaProdInventario.body)}`
            );
            productoCorridaCreado = true;

            assert.equal(
                altaProdInventario.body.producto.controla_inventario,
                true
            );
            assert.equal(
                normalizarCantidadExacta(
                    altaProdInventario.body.producto.stock_actual
                ),
                '0.000'
            );
            assert.equal(
                normalizarCantidadExacta(
                    altaProdInventario.body.producto.stock_minimo
                ),
                '1.000'
            );

            const intentoPatchStockDirecto = await peticionJson(
                baseUrl,
                `/api/productos/${productoCorridaId}`,
                {
                    method: 'PATCH',
                    headers: headersSucursal,
                    body: JSON.stringify({ stock_actual: '10.000' }),
                }
            );
            assert.equal(intentoPatchStockDirecto.status, 400);
            assert.equal(
                intentoPatchStockDirecto.body.codigo,
                'STOCK_ACTUAL_SOLO_LECTURA'
            );

            console.log(
                '   OK: Producto inventariable en 0.000 kg creado y stock_actual directo rechazado con 400.'
            );

            console.log(
                'B.3) Ejecutando flujo del Libro Mayor (compra -> idempotencia -> merma -> negativo con alerta -> kardex -> cuadre)...'
            );

            const payloadCompraBarra = {
                id: movCompraId,
                producto_id: productoCorridaId,
                tipo_movimiento: 'compra',
                presentacion_cantidad: '3.500',
                unidades_por_presentacion: 1,
                costo_total_centavos: 42000,
                motivo: 'Barra de jamón 3.5 kg',
            };

            // 1) Compra inicial de barra de 3.500 kg -> 201 Created, stock_actual = 3.500
            const compraResp = await peticionJson(
                baseUrl,
                '/api/inventario/movimientos',
                {
                    method: 'POST',
                    headers: headersSucursal,
                    body: JSON.stringify(payloadCompraBarra),
                }
            );
            assert.equal(
                compraResp.status,
                201,
                `Error al registrar compra: ${JSON.stringify(compraResp.body)}`
            );
            assert.equal(compraResp.body.idempotente, false);
            assert.equal(compraResp.body.movimiento.id, movCompraId);
            assert.equal(compraResp.body.movimiento.tipo_movimiento, 'compra');
            assert.equal(
                normalizarCantidadExacta(
                    compraResp.body.movimiento.cantidad_delta
                ),
                '3.500'
            );
            assert.equal(compraResp.body.movimiento.costo_total_centavos, 42000);
            assert.equal(
                normalizarCantidadExacta(compraResp.body.existencia.stock_actual),
                '3.500'
            );
            assert.equal(compraResp.body.existencia.alerta_bajo_stock, false);
            assert.equal(
                compraResp.body.existencia.alerta_stock_negativo,
                false
            );

            // 2) Reintento idempotente con el MISMO UUID -> 200 OK, NO duplica a 7.000
            const reintentoCompraResp = await peticionJson(
                baseUrl,
                '/api/inventario/movimientos',
                {
                    method: 'POST',
                    headers: headersSucursal,
                    body: JSON.stringify(payloadCompraBarra),
                }
            );
            assert.equal(reintentoCompraResp.status, 200);
            assert.equal(reintentoCompraResp.body.idempotente, true);
            assert.equal(reintentoCompraResp.body.movimiento.id, movCompraId);
            assert.equal(
                normalizarCantidadExacta(
                    reintentoCompraResp.body.existencia.stock_actual
                ),
                '3.500'
            );

            // 3) Merma de 0.250 kg -> 201 Created, stock_actual = 3.250
            const mermaResp = await peticionJson(
                baseUrl,
                '/api/inventario/movimientos',
                {
                    method: 'POST',
                    headers: headersSucursal,
                    body: JSON.stringify({
                        id: movMermaId,
                        producto_id: productoCorridaId,
                        tipo_movimiento: 'merma',
                        cantidad: '0.250',
                        motivo: 'Recorte de orilla reseca',
                    }),
                }
            );
            assert.equal(
                mermaResp.status,
                201,
                `Error al registrar merma: ${JSON.stringify(mermaResp.body)}`
            );
            assert.equal(mermaResp.body.idempotente, false);
            assert.equal(
                normalizarCantidadExacta(
                    mermaResp.body.movimiento.cantidad_delta
                ),
                '-0.250'
            );
            assert.equal(
                normalizarCantidadExacta(mermaResp.body.existencia.stock_actual),
                '3.250'
            );
            assert.equal(mermaResp.body.existencia.alerta_bajo_stock, false);
            assert.equal(mermaResp.body.existencia.alerta_stock_negativo, false);

            // 4) Ajuste negativo de -3.400 kg -> stock_actual = -0.150 kg permitido con doble alerta
            const ajusteNegResp = await peticionJson(
                baseUrl,
                '/api/inventario/movimientos',
                {
                    method: 'POST',
                    headers: headersSucursal,
                    body: JSON.stringify({
                        id: movAjusteNegativoId,
                        producto_id: productoCorridaId,
                        tipo_movimiento: 'ajuste',
                        cantidad_delta: '-3.400',
                        motivo: 'Desfase previo a registrar preventa',
                    }),
                }
            );
            assert.equal(
                ajusteNegResp.status,
                201,
                `Error al registrar ajuste a negativo: ${JSON.stringify(ajusteNegResp.body)}`
            );
            assert.equal(ajusteNegResp.body.idempotente, false);
            assert.equal(
                normalizarCantidadExacta(
                    ajusteNegResp.body.movimiento.cantidad_delta
                ),
                '-3.400'
            );
            assert.equal(
                normalizarCantidadExacta(
                    ajusteNegResp.body.existencia.stock_actual
                ),
                '-0.150'
            );
            assert.equal(
                ajusteNegResp.body.existencia.alerta_stock_negativo,
                true
            );
            assert.equal(ajusteNegResp.body.existencia.alerta_bajo_stock, true);

            // 5) Verificar aparición y alertas en GET /api/inventario/existencias?stock_negativo=true
            const existenciasNegResp = await peticionJson(
                baseUrl,
                '/api/inventario/existencias?stock_negativo=true',
                { headers: headersSucursal }
            );
            assert.equal(existenciasNegResp.status, 200);
            assert.equal(
                existenciasNegResp.body.politica_stock_negativo,
                'permitido_con_alerta'
            );
            assert.ok(existenciasNegResp.body.resumen.con_stock_negativo >= 1);
            assert.ok(existenciasNegResp.body.resumen.con_bajo_stock >= 1);

            const prodEnExistencias = existenciasNegResp.body.productos.find(
                (p) => p.id === productoCorridaId
            );
            assert.ok(
                prodEnExistencias,
                'El producto con saldo -0.150 debe aparecer en /api/inventario/existencias?stock_negativo=true.'
            );
            assert.equal(prodEnExistencias.stock_actual, '-0.150');
            assert.equal(prodEnExistencias.stock_minimo, '1.000');
            assert.equal(prodEnExistencias.alerta_stock_negativo, true);
            assert.equal(prodEnExistencias.alerta_bajo_stock, true);

            // 6) Consultar kardex en GET /api/inventario/movimientos?producto_id=... (exactamente 3 filas)
            const kardexResp = await peticionJson(
                baseUrl,
                `/api/inventario/movimientos?producto_id=${productoCorridaId}`,
                { headers: headersSucursal }
            );
            assert.equal(kardexResp.status, 200);
            assert.equal(
                kardexResp.body.movimientos.length,
                3,
                'El kardex debe contener exactamente los 3 movimientos (sin duplicar el reintento idempotente).'
            );

            const idsEnKardex = kardexResp.body.movimientos.map((m) => m.id);
            assert.ok(idsEnKardex.includes(movCompraId));
            assert.ok(idsEnKardex.includes(movMermaId));
            assert.ok(idsEnKardex.includes(movAjusteNegativoId));

            for (const mov of kardexResp.body.movimientos) {
                assert.equal(mov.producto_id, productoCorridaId);
                assert.equal(mov.tienda_id, UUID_SEGUNDA_TIENDA_DEMO);
                assert.equal(mov.registrado_por, usuario1Id);
                assert.ok(
                    typeof mov.motivo === 'string' && mov.motivo.length >= 1
                );
            }

            // 7) Cuadre compensatorio (+1.650 kg -> stock_actual = 1.500 kg, limpia alertas)
            const cuadreResp = await peticionJson(
                baseUrl,
                '/api/inventario/movimientos',
                {
                    method: 'POST',
                    headers: headersSucursal,
                    body: JSON.stringify({
                        id: movCuadreFinalId,
                        producto_id: productoCorridaId,
                        tipo_movimiento: 'ajuste',
                        cantidad_delta: '1.650',
                        motivo: 'Cuadre tras capturar entrada pendiente de proveedor',
                    }),
                }
            );
            assert.equal(cuadreResp.status, 201);
            assert.equal(
                normalizarCantidadExacta(cuadreResp.body.existencia.stock_actual),
                '1.500'
            );
            assert.equal(
                cuadreResp.body.existencia.alerta_stock_negativo,
                false
            );
            assert.equal(cuadreResp.body.existencia.alerta_bajo_stock, false);

            console.log(
                '   OK: Libro Mayor verificado (idempotencia, stock negativo -0.150 con alerta, kardex de 3 eventos y cuadre a 1.500).'
            );

            console.log(
                'B.4) Verificando rechazo en producto sin control de inventario (409) y aislamiento entre tiendas (404)...'
            );

            const asegurarSinInventario = await peticionJson(
                baseUrl,
                '/api/productos',
                {
                    method: 'POST',
                    headers: headersSucursal,
                    body: JSON.stringify({
                        id: UUID_PRODUCTO_SIN_INVENTARIO,
                        nombre: 'Chiles Jalapeños en Escabeche',
                        unidad_venta: 'kg',
                        precio_centavos: 9500,
                        codigo_barras: null,
                        es_acceso_rapido: true,
                        orden_acceso_rapido: 10,
                        controla_inventario: false,
                    }),
                }
            );
            assert.ok([200, 201].includes(asegurarSinInventario.status));

            if (
                asegurarSinInventario.body.producto.controla_inventario !==
                    false ||
                asegurarSinInventario.body.producto.activo !== true
            ) {
                const normalizarSinInv = await peticionJson(
                    baseUrl,
                    `/api/productos/${UUID_PRODUCTO_SIN_INVENTARIO}`,
                    {
                        method: 'PATCH',
                        headers: headersSucursal,
                        body: JSON.stringify({
                            controla_inventario: false,
                            activo: true,
                        }),
                    }
                );
                assert.equal(normalizarSinInv.status, 200);
            }

            const movEnSinControl = await peticionJson(
                baseUrl,
                '/api/inventario/movimientos',
                {
                    method: 'POST',
                    headers: headersSucursal,
                    body: JSON.stringify({
                        producto_id: UUID_PRODUCTO_SIN_INVENTARIO,
                        tipo_movimiento: 'compra',
                        cantidad: '5.000',
                        motivo: 'Intento sobre producto sin control de kardex',
                    }),
                }
            );
            assert.equal(movEnSinControl.status, 409);
            assert.equal(
                movEnSinControl.body.codigo,
                'PRODUCTO_SIN_CONTROL_INVENTARIO'
            );

            // Producto perteneciente a Tienda-Demo -> intentar moverlo desde Tienda-Sucursal-Norte debe dar 404
            const catalogoDemo = await peticionJson(
                baseUrl,
                '/api/productos',
                { headers: headersDemo }
            );
            assert.equal(catalogoDemo.status, 200);
            assert.ok(
                catalogoDemo.body.productos.length >= 1,
                'Tienda-Demo debe contar con al menos un producto para probar aislamiento.'
            );
            const productoOtraTienda = catalogoDemo.body.productos[0];

            const movCruzadoOtraTienda = await peticionJson(
                baseUrl,
                '/api/inventario/movimientos',
                {
                    method: 'POST',
                    headers: headersSucursal,
                    body: JSON.stringify({
                        producto_id: productoOtraTienda.id,
                        tipo_movimiento: 'compra',
                        cantidad: '2.000',
                        motivo: 'Intento cruzado entre tiendas',
                    }),
                }
            );
            assert.equal(
                movCruzadoOtraTienda.status,
                404,
                `Se esperaba 404 al apuntar a un producto de otra tienda, recibido ${movCruzadoOtraTienda.status}`
            );

            console.log(
                '   OK: Rechazo 409 PRODUCTO_SIN_CONTROL_INVENTARIO y aislamiento 404 entre tiendas verificados.'
            );

            console.log(
                'B.5) Verificando blindaje directo en Supabase PostgREST (productos.stock_actual e inventario_movimientos)...'
            );

            const supabasePropietario = crearClienteSupabase(token1);

            const { error: errorUpdateStockDirecto } = await supabasePropietario
                .from('productos')
                .update({ stock_actual: 999 })
                .eq('id', productoCorridaId);
            assert.ok(
                errorUpdateStockDirecto,
                'Fallo de seguridad: PostgREST permitió sobrescribir productos.stock_actual directamente.'
            );

            const { error: errorInsertMovDirecto } = await supabasePropietario
                .from('inventario_movimientos')
                .insert({
                    tienda_id: UUID_SEGUNDA_TIENDA_DEMO,
                    producto_id: productoCorridaId,
                    tipo_movimiento: 'ajuste',
                    cantidad_delta: 50,
                    motivo: 'Inserción directa no autorizada',
                });
            assert.ok(
                errorInsertMovDirecto,
                'Fallo de seguridad: PostgREST permitió INSERT directo en inventario_movimientos.'
            );

            const {
                data: filasUpdateMovDirecto,
                error: errorUpdateMovDirecto,
            } = await supabasePropietario
                .from('inventario_movimientos')
                .update({ motivo: 'Motivo adulterado en PostgREST' })
                .eq('id', movCompraId)
                .select('id');
            assert.ok(
                Boolean(errorUpdateMovDirecto) ||
                    (filasUpdateMovDirecto || []).length === 0,
                'Fallo de seguridad: PostgREST permitió UPDATE sobre inventario_movimientos.'
            );

            const {
                data: filasDeleteMovDirecto,
                error: errorDeleteMovDirecto,
            } = await supabasePropietario
                .from('inventario_movimientos')
                .delete()
                .eq('id', movCompraId)
                .select('id');
            assert.ok(
                Boolean(errorDeleteMovDirecto) ||
                    (filasDeleteMovDirecto || []).length === 0,
                'Fallo de seguridad: PostgREST permitió DELETE sobre inventario_movimientos.'
            );

            console.log(
                '   OK: Blindaje de columna stock_actual e inmutabilidad de inventario_movimientos verificados en PostgREST.'
            );

            console.log('\nVerificación completa de Sprint 4 exitosa.');
        } finally {
            if (productoCorridaCreado) {
                const bajaLimpieza = await peticionJson(
                    baseUrl,
                    `/api/productos/${productoCorridaId}`,
                    {
                        method: 'PATCH',
                        headers: headersSucursal,
                        body: JSON.stringify({ activo: false }),
                    }
                );
                assert.equal(
                    bajaLimpieza.status,
                    200,
                    `No se pudo desactivar el producto temporal de prueba ${productoCorridaId}`
                );
            }
        }
    } finally {
        await new Promise((resolve) => servidor.close(resolve));
    }
}

ejecutar().catch((error) => {
    console.error('\nFallo en verificación de Sprint 4:', error);
    process.exit(1);
});
