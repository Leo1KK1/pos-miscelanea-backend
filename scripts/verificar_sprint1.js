/**
 * Script de verificación reproducible del Sprint 1.
 *
 * 1. Siempre comprueba arranque del servidor, rutas protegidas y manejo de errores base.
 * 2. Si se proporcionan TEST_USER_EMAIL y TEST_USER_PASSWORD en variables de entorno
 *    de la sesión de PowerShell (sin guardarlas en el código), ejecuta las pruebas
 *    completas contra Supabase:
 *      - Consulta de Tienda-Demo y verificación de integridad de los 3 productos migrados.
 *      - Creación/verificación idempotente de una 2ª tienda en la misma cuenta.
 *      - Cambio de tienda activa sin fuga de productos entre tiendas.
 *      - Bloqueo ante tienda inexistente/ajena (403).
 *      - Si además se definen TEST_USER2_EMAIL y TEST_USER2_PASSWORD, valida aislamiento
 *        cruzado tanto en la API Express como directo contra Supabase PostgREST (RLS).
 */

const assert = require('node:assert/strict');
const app = require('../src/server');
const { crearClienteSupabase } = require('../src/config/supabase');

// UUID determinista para pruebas idempotentes de la segunda tienda
const UUID_SEGUNDA_TIENDA_DEMO = '11111111-2222-4333-8444-555555555555';
const UUID_TIENDA_INEXISTENTE = '99999999-9999-4999-8999-999999999999';

async function peticionJson(baseUrl, ruta, opciones = {}) {
    const respuesta = await fetch(`${baseUrl}${ruta}`, {
        ...opciones,
        headers: {
            'Content-Type': 'application/json',
            ...(opciones.headers || {}),
        },
    });

    const cuerpo = await respuesta.json().catch(() => ({}));
    return { status: respuesta.status, body: cuerpo };
}

async function ejecutar() {
    const servidor = app.listen(0);
    await new Promise((resolve) => servidor.once('listening', resolve));

    const { port } = servidor.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
        console.log('1) Comprobando salud y validaciones sin sesión...');

        const salud = await peticionJson(baseUrl, '/api/health');
        assert.equal(salud.status, 200);
        assert.equal(salud.body.estado, 'ok');

        const sinTokenTiendas = await peticionJson(baseUrl, '/api/tiendas');
        assert.equal(sinTokenTiendas.status, 401);

        const sinTokenProductos = await peticionJson(baseUrl, '/api/productos');
        assert.equal(sinTokenProductos.status, 401);

        const rutaNoExiste = await peticionJson(baseUrl, '/api/no-existe');
        assert.equal(rutaNoExiste.status, 404);

        console.log('   OK: Controles base del servidor verificados.');

        const email1 = process.env.TEST_USER_EMAIL;
        const pass1 = process.env.TEST_USER_PASSWORD;

        if (!email1 || !pass1) {
            console.log(
                '\nAviso: Para correr también las pruebas multi-tienda contra Supabase, ejecuta en PowerShell:'
            );
            console.log(
                '  $env:TEST_USER_EMAIL="tu-correo"; $env:TEST_USER_PASSWORD="tu-password"; npm run verify:sprint1'
            );
            return;
        }

        console.log('\n2) Iniciando sesión con cuenta principal...');
        const login1 = await peticionJson(baseUrl, '/api/auth/login', {
            method: 'POST',
            body: JSON.stringify({ email: email1, password: pass1 }),
        });
        assert.equal(
            login1.status,
            200,
            `Fallo login cuenta 1: ${JSON.stringify(login1.body)}`
        );
        const token1 = login1.body.access_token;

        console.log('3) Consultando tiendas asignadas y verificando Tienda-Demo...');
        const misTiendasInicial = await peticionJson(baseUrl, '/api/tiendas', {
            headers: { Authorization: `Bearer ${token1}` },
        });
        assert.equal(misTiendasInicial.status, 200);

        const tiendaDemo = misTiendasInicial.body.tiendas.find(
            (t) => t.nombre === 'Tienda-Demo'
        );
        assert.ok(
            tiendaDemo,
            'No se encontró Tienda-Demo en las tiendas activas del propietario.'
        );
        assert.equal(tiendaDemo.rol, 'propietario');

        console.log('4) Comprobando que /api/productos exige X-Tienda-Id...');
        const prodSinHeader = await peticionJson(baseUrl, '/api/productos', {
            headers: { Authorization: `Bearer ${token1}` },
        });
        assert.equal(prodSinHeader.status, 400);

        console.log(
            '5) Verificando integridad de productos migrados en Tienda-Demo...'
        );
        const prodTiendaDemo = await peticionJson(baseUrl, '/api/productos', {
            headers: {
                Authorization: `Bearer ${token1}`,
                'X-Tienda-Id': tiendaDemo.id,
            },
        });
        assert.equal(prodTiendaDemo.status, 200);

        const nombresProductos = prodTiendaDemo.body.productos.map(
            (p) => p.nombre
        );
        for (const esperado of ['Jamón', 'Queso Oaxaca', 'Refresco de cola']) {
            assert.ok(
                nombresProductos.includes(esperado),
                `Falta producto migrado esperado: ${esperado}`
            );
        }
        console.log(
            `   OK: Productos en Tienda-Demo (${prodTiendaDemo.body.productos.length}): ${nombresProductos.join(', ')}`
        );

        console.log(
            '6) Verificando segunda tienda en la misma cuenta (idempotente) y cambio de contexto...'
        );
        const crearSegunda = await peticionJson(baseUrl, '/api/tiendas', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token1}` },
            body: JSON.stringify({
                id: UUID_SEGUNDA_TIENDA_DEMO,
                nombre: 'Tienda-Sucursal-Norte',
            }),
        });
        assert.ok(
            [200, 201].includes(crearSegunda.status),
            `Error al crear/obtener segunda tienda: ${JSON.stringify(crearSegunda.body)}`
        );

        // Reintento idempotente con el mismo UUID
        const reintentoSegunda = await peticionJson(baseUrl, '/api/tiendas', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token1}` },
            body: JSON.stringify({
                id: UUID_SEGUNDA_TIENDA_DEMO,
                nombre: 'Tienda-Sucursal-Norte',
            }),
        });
        assert.equal(reintentoSegunda.status, 200);
        assert.equal(reintentoSegunda.body.idempotente, true);

        const prodSegundaTienda = await peticionJson(baseUrl, '/api/productos', {
            headers: {
                Authorization: `Bearer ${token1}`,
                'X-Tienda-Id': UUID_SEGUNDA_TIENDA_DEMO,
            },
        });
        assert.equal(prodSegundaTienda.status, 200);
        const idsDemo = new Set(prodTiendaDemo.body.productos.map((p) => p.id));
        const traslape = prodSegundaTienda.body.productos.filter((p) =>
            idsDemo.has(p.id)
        );
        assert.equal(
            traslape.length,
            0,
            'Fuga de datos: aparecieron productos de Tienda-Demo al consultar la segunda tienda.'
        );
        console.log(
            '   OK: La cuenta opera dos tiendas independientes sin mezclar productos.'
        );

        console.log('7) Comprobando rechazo ante tienda no asignada...');
        const accesoNoAutorizado = await peticionJson(
            baseUrl,
            `/api/tiendas/${UUID_TIENDA_INEXISTENTE}/contexto`,
            {
                headers: { Authorization: `Bearer ${token1}` },
            }
        );
        assert.equal(accesoNoAutorizado.status, 403);
        console.log('   OK: Acceso denegado (403) para tienda ajena o inexistente.');

        const email2 = process.env.TEST_USER2_EMAIL;
        const pass2 = process.env.TEST_USER2_PASSWORD;

        if (email2 && pass2) {
            console.log(
                '\n8) Verificando aislamiento multi-cuenta con segundo usuario (API + RLS directo)...'
            );
            const login2 = await peticionJson(baseUrl, '/api/auth/login', {
                method: 'POST',
                body: JSON.stringify({ email: email2, password: pass2 }),
            });
            assert.equal(
                login2.status,
                200,
                `Fallo login cuenta 2: ${JSON.stringify(login2.body)}`
            );
            const token2 = login2.body.access_token;

            // Vía API Express
            const intentoLeerTienda1 = await peticionJson(
                baseUrl,
                '/api/productos',
                {
                    headers: {
                        Authorization: `Bearer ${token2}`,
                        'X-Tienda-Id': tiendaDemo.id,
                    },
                }
            );
            assert.equal(intentoLeerTienda1.status, 403);

            // Vía cliente Supabase directo (comprueba RLS en PostgreSQL)
            const supabaseUsuario2 = crearClienteSupabase(token2);
            const { data: prodRls } = await supabaseUsuario2
                .from('productos')
                .select('id')
                .eq('tienda_id', tiendaDemo.id);
            assert.equal((prodRls || []).length, 0);

            const { error: errorInsertRls } = await supabaseUsuario2
                .from('productos')
                .insert({
                    tienda_id: tiendaDemo.id,
                    nombre: 'Intento intruso',
                    unidad_venta: 'pieza',
                    precio_centavos: 1000,
                });
            assert.ok(
                errorInsertRls,
                'RLS permitió insertar un producto en una tienda ajena.'
            );

            console.log(
                '   OK: Cuenta 2 bloqueada tanto en Express (403) como en PostgREST RLS.'
            );
        } else {
            console.log(
                '\nNota opcional: Define TEST_USER2_EMAIL y TEST_USER2_PASSWORD para validar también el bloqueo cruzado con un segundo usuario.'
            );
        }

        console.log('\nVerificación completa de Sprint 1 exitosa.');
    } finally {
        await new Promise((resolve) => servidor.close(resolve));
    }
}

ejecutar().catch((error) => {
    console.error('\nFallo en verificación de Sprint 1:', error);
    process.exit(1);
});
