/**
 * Script de verificación reproducible del Sprint 2:
 * Identidad, ciclo de sesión, matriz de permisos por rol y constancia criptográfica offline Ed25519.
 *
 * Bloque A (Pruebas locales deterministas — corren SIEMPRE sin requerir credenciales):
 *   1. Matriz de permisos centralizada (MATRIZ_PERMISOS, tienePermiso, obtenerPermisosDeRol).
 *   2. Constancia criptográfica offline Ed25519 (vigencia OK, firma/payload adulterado,
 *      reloj atrasado vs emitido_en y vs última venta SQLite, ventana 96 h vencida y licencia vencida).
 *   3. Controles HTTP sin sesión (/api/auth/clave-publica-offline, /api/auth/refresh y rutas protegidas).
 *
 * Bloque B (Integración real contra Supabase cuando existen TEST_USER_EMAIL y TEST_USER_PASSWORD):
 *   1. Login, renovación real con POST /api/auth/refresh y verificación de constancia offline en contexto.
 *   2. Actualización/restauración de precio_centavos por propietario y blindaje PostgREST de columnas de licencia.
 *   3. Prohibición de auto-degradación y auto-suspensión del propietario (403).
 *   4. Si existen TEST_USER2_EMAIL y TEST_USER2_PASSWORD: ciclo completo multi-rol (sin acceso -> cajero ->
 *      encargado -> suspendido) validando tanto Express como PostgreSQL RLS directo, más cierre con logout.
 */

const assert = require('node:assert/strict');
const app = require('../src/server');
const { crearClienteSupabase } = require('../src/config/supabase');
const {
    ROLES,
    MATRIZ_PERMISOS,
    tienePermiso,
    obtenerPermisosDeRol,
} = require('../src/config/permisos');
const {
    obtenerClavePublicaOffline,
    emitirConstanciaOffline,
    verificarConstanciaOffline,
} = require('../src/services/licenciaOffline.service');

// UUIDs deterministas para pruebas idempotentes en la tienda secundaria de pruebas
const UUID_SEGUNDA_TIENDA_DEMO = '11111111-2222-4333-8444-555555555555';
const UUID_PRODUCTO_SUCURSAL_DEMO = '22222222-3333-4444-8555-666666666666';
const UUID_PRODUCTO_INTRUSO_CAJERO = '33333333-4444-4555-8666-777777777777';

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

function verificarMatrizPermisosLocal() {
    console.log('A.1) Verificando MATRIZ_PERMISOS y jerarquía de roles...');

    assert.equal(ROLES.PROPIETARIO, 'propietario');
    assert.equal(ROLES.ENCARGADO, 'encargado');
    assert.equal(ROLES.CAJERO, 'cajero');

    const todosLosPermisos = [
        'tienda:leer',
        'tienda:editar',
        'miembros:leer',
        'miembros:agregar',
        'miembros:cambiar_rol',
        'miembros:cambiar_estado',
        'productos:leer',
        'productos:crear',
        'productos:editar',
        'productos:cambiar_precio',
    ];

    for (const permiso of todosLosPermisos) {
        assert.ok(
            Array.isArray(MATRIZ_PERMISOS[permiso]),
            `Falta definir el permiso ${permiso} en MATRIZ_PERMISOS.`
        );
        assert.equal(
            tienePermiso('propietario', permiso),
            true,
            `El propietario debe poseer el permiso ${permiso}.`
        );
    }
    assert.equal(obtenerPermisosDeRol('propietario').length, todosLosPermisos.length);

    // Permisos de encargado
    const permisosEncargadoSi = [
        'tienda:leer',
        'miembros:leer',
        'miembros:agregar',
        'miembros:cambiar_estado',
        'productos:leer',
        'productos:crear',
        'productos:editar',
        'productos:cambiar_precio',
    ];
    const permisosEncargadoNo = ['tienda:editar', 'miembros:cambiar_rol'];

    for (const permiso of permisosEncargadoSi) {
        assert.equal(
            tienePermiso('encargado', permiso),
            true,
            `El encargado debe tener ${permiso}.`
        );
    }
    for (const permiso of permisosEncargadoNo) {
        assert.equal(
            tienePermiso('encargado', permiso),
            false,
            `El encargado NO debe tener ${permiso}.`
        );
    }

    // Permisos de cajero
    const permisosCajeroSi = ['tienda:leer', 'productos:leer'];
    const permisosCajeroNo = [
        'tienda:editar',
        'miembros:leer',
        'miembros:agregar',
        'miembros:cambiar_rol',
        'miembros:cambiar_estado',
        'productos:crear',
        'productos:editar',
        'productos:cambiar_precio',
    ];

    for (const permiso of permisosCajeroSi) {
        assert.equal(
            tienePermiso('cajero', permiso),
            true,
            `El cajero debe tener ${permiso}.`
        );
    }
    for (const permiso of permisosCajeroNo) {
        assert.equal(
            tienePermiso('cajero', permiso),
            false,
            `El cajero NO debe tener ${permiso}.`
        );
    }

    // Entradas inválidas o desconocidas
    assert.equal(tienePermiso('visitante', 'tienda:leer'), false);
    assert.equal(tienePermiso('propietario', 'permiso:no_existe'), false);
    assert.equal(tienePermiso(null, 'tienda:leer'), false);
    assert.deepEqual(obtenerPermisosDeRol('rol_inexistente'), []);

    console.log('   OK: Matriz de permisos verificada para propietario, encargado y cajero.');
}

function verificarConstanciaOfflineLocal() {
    console.log('A.2) Verificando constancia criptográfica offline Ed25519...');

    const infoClave = obtenerClavePublicaOffline();
    assert.equal(infoClave.algoritmo, 'Ed25519');
    assert.equal(typeof infoClave.public_key_b64, 'string');
    assert.ok(infoClave.public_key_b64.length > 20);

    const ahoraBase = new Date('2026-11-17T12:00:00.000Z');
    const tiendaActiva = {
        id: UUID_SEGUNDA_TIENDA_DEMO,
        nombre: 'Tienda Prueba Offline',
        estado: 'activa',
        estado_suscripcion: 'activa',
        ventana_offline_horas: 96,
        licencia_expira_en: new Date(
            ahoraBase.getTime() + 30 * 24 * 3600 * 1000
        ).toISOString(),
    };
    const usuarioIdPrueba = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

    const emitida = emitirConstanciaOffline({
        tienda: tiendaActiva,
        rol: 'cajero',
        usuarioId: usuarioIdPrueba,
        ahora: ahoraBase,
    });

    assert.equal(emitida.algoritmo, 'Ed25519');
    assert.equal(typeof emitida.token, 'string');
    assert.equal(emitida.payload.v, 1);
    assert.equal(emitida.payload.tienda_id, tiendaActiva.id);
    assert.equal(emitida.payload.usuario_id, usuarioIdPrueba);
    assert.equal(emitida.payload.rol, 'cajero');
    assert.equal(emitida.payload.permite_nuevas_ventas, true);
    assert.equal(emitida.payload.permite_consulta_fiados_inventario, true);

    // 1) Constancia recién emitida (+1 hora) -> OK
    const verifOk = verificarConstanciaOffline(emitida.token, {
        fechaActual: new Date(ahoraBase.getTime() + 1 * 3600 * 1000),
    });
    assert.equal(verifOk.valida, true);
    assert.equal(verifOk.ventana_vigente, true);
    assert.equal(verifOk.motivo, 'OK');
    assert.equal(verifOk.permite_nuevas_ventas, true);
    assert.equal(verifOk.permite_consulta_fiados_inventario, true);

    // 2) Constancia adulterada (intento de escalar rol en payload o corromper firma)
    const [payloadOriginalB64, firmaOriginalB64] = emitida.token.split('.');
    const payloadFalsificadoB64 = Buffer.from(
        JSON.stringify({ ...emitida.payload, rol: 'propietario' }),
        'utf8'
    ).toString('base64url');
    const verifPayloadAdulterado = verificarConstanciaOffline(
        `${payloadFalsificadoB64}.${firmaOriginalB64}`,
        { fechaActual: ahoraBase }
    );
    assert.equal(verifPayloadAdulterado.valida, false);
    assert.equal(verifPayloadAdulterado.motivo, 'FIRMA_O_FORMATO_INVALIDO');
    assert.equal(verifPayloadAdulterado.permite_nuevas_ventas, false);

    const primerChar = firmaOriginalB64[0] === 'A' ? 'B' : 'A';
    const firmaAdulterada = `${primerChar}${firmaOriginalB64.slice(1)}`;
    const verifFirmaAdulterada = verificarConstanciaOffline(
        `${payloadOriginalB64}.${firmaAdulterada}`,
        { fechaActual: ahoraBase }
    );
    assert.equal(verifFirmaAdulterada.valida, false);
    assert.equal(verifFirmaAdulterada.motivo, 'FIRMA_O_FORMATO_INVALIDO');

    const verifMalformada = verificarConstanciaOffline('constancia-invalida', {
        fechaActual: ahoraBase,
    });
    assert.equal(verifMalformada.valida, false);
    assert.equal(verifMalformada.motivo, 'FIRMA_O_FORMATO_INVALIDO');

    // 3) Reloj atrasado respecto a emitido_en (-30 minutos)
    const verifRelojAntesEmision = verificarConstanciaOffline(emitida.token, {
        fechaActual: new Date(ahoraBase.getTime() - 30 * 60 * 1000),
    });
    assert.equal(verifRelojAntesEmision.valida, false);
    assert.equal(verifRelojAntesEmision.motivo, 'RELOJ_ATRASADO');
    assert.equal(verifRelojAntesEmision.permite_nuevas_ventas, false);
    assert.equal(verifRelojAntesEmision.permite_consulta_fiados_inventario, true);

    // Reloj atrasado respecto a la última venta/evento local en SQLite
    const verifRelojAntesSqlite = verificarConstanciaOffline(emitida.token, {
        fechaActual: new Date(ahoraBase.getTime() + 2 * 3600 * 1000),
        ultimaFechaEventoLocal: new Date(ahoraBase.getTime() + 5 * 3600 * 1000),
    });
    assert.equal(verifRelojAntesSqlite.valida, false);
    assert.equal(verifRelojAntesSqlite.motivo, 'RELOJ_ATRASADO');
    assert.equal(verifRelojAntesSqlite.permite_nuevas_ventas, false);
    assert.equal(verifRelojAntesSqlite.permite_consulta_fiados_inventario, true);

    // 4) Ventana offline de 96 h superada (+100 horas) -> bloquea ventas pero conserva lectura de fiados e inventario
    const verifVentanaVencida = verificarConstanciaOffline(emitida.token, {
        fechaActual: new Date(ahoraBase.getTime() + 100 * 3600 * 1000),
    });
    assert.equal(verifVentanaVencida.valida, true);
    assert.equal(verifVentanaVencida.ventana_vigente, false);
    assert.equal(
        verifVentanaVencida.motivo,
        'VENTANA_OFFLINE_O_LICENCIA_VENCIDA'
    );
    assert.equal(verifVentanaVencida.permite_nuevas_ventas, false);
    assert.equal(verifVentanaVencida.permite_consulta_fiados_inventario, true);

    // Suscripción vencida desde el origen -> valida firma pero bloquea nuevas ventas
    const emitidaSuscripcionVencida = emitirConstanciaOffline({
        tienda: {
            ...tiendaActiva,
            estado_suscripcion: 'vencida',
        },
        rol: 'propietario',
        usuarioId: usuarioIdPrueba,
        ahora: ahoraBase,
    });
    const verifSuscripcionVencida = verificarConstanciaOffline(
        emitidaSuscripcionVencida.token,
        {
            fechaActual: new Date(ahoraBase.getTime() + 1 * 3600 * 1000),
        }
    );
    assert.equal(verifSuscripcionVencida.valida, true);
    assert.equal(verifSuscripcionVencida.ventana_vigente, false);
    assert.equal(
        verifSuscripcionVencida.motivo,
        'VENTANA_OFFLINE_O_LICENCIA_VENCIDA'
    );
    assert.equal(verifSuscripcionVencida.permite_nuevas_ventas, false);
    assert.equal(
        verifSuscripcionVencida.permite_consulta_fiados_inventario,
        true
    );

    console.log(
        '   OK: Firma Ed25519, anti-manipulación de reloj y Grace Period de 96 h verificados.'
    );
}

async function ejecutar() {
    console.log('=== BLOQUE A: Pruebas locales deterministas (sin credenciales) ===\n');

    verificarMatrizPermisosLocal();
    verificarConstanciaOfflineLocal();

    const servidor = app.listen(0);
    await new Promise((resolve) => servidor.once('listening', resolve));

    const { port } = servidor.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
        console.log('A.3) Verificando rutas HTTP públicas y rechazos sin sesión...');

        const clavePublicaHttp = await peticionJson(
            baseUrl,
            '/api/auth/clave-publica-offline'
        );
        assert.equal(clavePublicaHttp.status, 200);
        assert.equal(clavePublicaHttp.body.algoritmo, 'Ed25519');
        assert.equal(typeof clavePublicaHttp.body.public_key_b64, 'string');

        const refreshSinToken = await peticionJson(baseUrl, '/api/auth/refresh', {
            method: 'POST',
            body: JSON.stringify({}),
        });
        assert.equal(refreshSinToken.status, 400);

        const refreshInvalido = await peticionJson(baseUrl, '/api/auth/refresh', {
            method: 'POST',
            body: JSON.stringify({ refresh_token: 'refresh-token-invalido-test' }),
        });
        assert.equal(refreshInvalido.status, 401);

        const rutasProtegidas = [
            { metodo: 'GET', ruta: '/api/auth/me' },
            { metodo: 'POST', ruta: '/api/auth/logout' },
            { metodo: 'GET', ruta: '/api/tiendas' },
            { metodo: 'GET', ruta: '/api/productos' },
            {
                metodo: 'PATCH',
                ruta: `/api/productos/${UUID_PRODUCTO_SUCURSAL_DEMO}`,
            },
        ];

        for (const item of rutasProtegidas) {
            const resp = await peticionJson(baseUrl, item.ruta, {
                method: item.metodo,
            });
            assert.equal(
                resp.status,
                401,
                `Se esperaba 401 sin token en ${item.metodo} ${item.ruta}, recibido ${resp.status}`
            );
        }

        console.log('   OK: Rutas HTTP base y controles 400/401 verificados.');

        const email1 = process.env.TEST_USER_EMAIL;
        const pass1 = process.env.TEST_USER_PASSWORD;

        if (!email1 || !pass1) {
            console.log(
                '\nAviso: Bloque A completado con éxito. Para ejecutar también el Bloque B contra Supabase:'
            );
            console.log(
                '  $env:TEST_USER_EMAIL="tu-correo"; $env:TEST_USER_PASSWORD="tu-password"; node scripts/verificar_sprint2.js'
            );
            return;
        }

        console.log('\n=== BLOQUE B: Pruebas de integración contra Supabase ===\n');

        console.log(
            'B.1) Login propietario, rotación con /api/auth/refresh y constancia offline real...'
        );
        const login1 = await peticionJson(baseUrl, '/api/auth/login', {
            method: 'POST',
            body: JSON.stringify({ email: email1, password: pass1 }),
        });
        assert.equal(
            login1.status,
            200,
            `Fallo login cuenta 1: ${JSON.stringify(login1.body)}`
        );
        assert.ok(login1.body.access_token);
        assert.ok(login1.body.refresh_token);

        const refresh1 = await peticionJson(baseUrl, '/api/auth/refresh', {
            method: 'POST',
            body: JSON.stringify({ refresh_token: login1.body.refresh_token }),
        });
        assert.equal(
            refresh1.status,
            200,
            `Fallo refresh cuenta 1: ${JSON.stringify(refresh1.body)}`
        );
        assert.ok(refresh1.body.access_token);

        const token1 = refresh1.body.access_token;

        const perfil1 = await peticionJson(baseUrl, '/api/auth/me', {
            headers: { Authorization: `Bearer ${token1}` },
        });
        assert.equal(perfil1.status, 200);
        assert.equal(perfil1.body.usuario.id, login1.body.usuario.id);

        const misTiendas = await peticionJson(baseUrl, '/api/tiendas', {
            headers: { Authorization: `Bearer ${token1}` },
        });
        assert.equal(misTiendas.status, 200);

        const tiendaDemo = misTiendas.body.tiendas.find(
            (t) => t.nombre === 'Tienda-Demo'
        );
        assert.ok(tiendaDemo, 'No se encontró Tienda-Demo para la cuenta propietario.');
        assert.equal(tiendaDemo.rol, 'propietario');

        const contextoDemo = await peticionJson(
            baseUrl,
            `/api/tiendas/${tiendaDemo.id}/contexto`,
            {
                headers: { Authorization: `Bearer ${token1}` },
            }
        );
        assert.equal(contextoDemo.status, 200);
        assert.ok(
            contextoDemo.body.constancia_offline,
            'El endpoint /contexto debe incluir constancia_offline.'
        );
        assert.equal(contextoDemo.body.constancia_offline.algoritmo, 'Ed25519');

        const verifServidor = verificarConstanciaOffline(
            contextoDemo.body.constancia_offline.token
        );
        assert.equal(verifServidor.valida, true);
        assert.equal(verifServidor.ventana_vigente, true);
        assert.equal(verifServidor.motivo, 'OK');
        assert.equal(verifServidor.payload.tienda_id, tiendaDemo.id);
        assert.equal(verifServidor.payload.rol, 'propietario');

        console.log(
            '   OK: Refresh funcional y constancia offline de Tienda-Demo verificada.'
        );

        console.log(
            'B.2) Actualización y restauración de precio_centavos + blindaje de columnas de licencia...'
        );
        const catalogoDemo = await peticionJson(baseUrl, '/api/productos', {
            headers: {
                Authorization: `Bearer ${token1}`,
                'X-Tienda-Id': tiendaDemo.id,
            },
        });
        assert.equal(catalogoDemo.status, 200);
        assert.ok(
            catalogoDemo.body.productos.length > 0,
            'Tienda-Demo debe tener al menos un producto para probar edición de precio.'
        );

        const productoObjetivo = catalogoDemo.body.productos[0];
        const precioOriginal = productoObjetivo.precio_centavos;
        const precioTemporal = precioOriginal + 100;

        try {
            const patchSubida = await peticionJson(
                baseUrl,
                `/api/productos/${productoObjetivo.id}`,
                {
                    method: 'PATCH',
                    headers: {
                        Authorization: `Bearer ${token1}`,
                        'X-Tienda-Id': tiendaDemo.id,
                    },
                    body: JSON.stringify({ precio_centavos: precioTemporal }),
                }
            );
            assert.equal(
                patchSubida.status,
                200,
                `Error al actualizar precio: ${JSON.stringify(patchSubida.body)}`
            );
            assert.equal(patchSubida.body.producto.precio_centavos, precioTemporal);
        } finally {
            const patchRestaurar = await peticionJson(
                baseUrl,
                `/api/productos/${productoObjetivo.id}`,
                {
                    method: 'PATCH',
                    headers: {
                        Authorization: `Bearer ${token1}`,
                        'X-Tienda-Id': tiendaDemo.id,
                    },
                    body: JSON.stringify({ precio_centavos: precioOriginal }),
                }
            );
            assert.equal(patchRestaurar.status, 200);
            assert.equal(
                patchRestaurar.body.producto.precio_centavos,
                precioOriginal
            );
        }

        // Intento directo por PostgREST de alterar licencia_expira_en / estado_suscripcion
        const supabasePropietario = crearClienteSupabase(token1);
        const { error: errorAlterarLicencia } = await supabasePropietario
            .from('tiendas')
            .update({
                estado_suscripcion: 'activa',
                licencia_expira_en: '2099-12-31T23:59:59.000Z',
            })
            .eq('id', tiendaDemo.id);
        assert.ok(
            errorAlterarLicencia,
            'Fallo de seguridad: PostgREST permitió modificar columnas protegidas de licencia en public.tiendas.'
        );

        console.log(
            '   OK: Precio actualizado/restaurado y GRANT UPDATE (nombre) bloqueó edición de licencia.'
        );

        console.log(
            'B.3) Verificando que el propietario NO puede auto-degradarse ni auto-suspenderse...'
        );
        const miembrosDemoResp = await peticionJson(
            baseUrl,
            `/api/tiendas/${tiendaDemo.id}/miembros`,
            {
                headers: { Authorization: `Bearer ${token1}` },
            }
        );
        assert.equal(miembrosDemoResp.status, 200);
        const membresiaPropDemo = miembrosDemoResp.body.miembros.find(
            (m) => m.usuario_id === login1.body.usuario.id
        );
        assert.ok(membresiaPropDemo, 'No se localizó la membresía del propietario.');

        const autoDegradar = await peticionJson(
            baseUrl,
            `/api/tiendas/${tiendaDemo.id}/miembros/${membresiaPropDemo.id}`,
            {
                method: 'PATCH',
                headers: { Authorization: `Bearer ${token1}` },
                body: JSON.stringify({ rol: 'cajero' }),
            }
        );
        assert.equal(autoDegradar.status, 403);

        const autoSuspender = await peticionJson(
            baseUrl,
            `/api/tiendas/${tiendaDemo.id}/miembros/${membresiaPropDemo.id}`,
            {
                method: 'PATCH',
                headers: { Authorization: `Bearer ${token1}` },
                body: JSON.stringify({ estado: 'suspendido' }),
            }
        );
        assert.equal(autoSuspender.status, 403);

        console.log('   OK: Auto-degradación y auto-suspensión rechazadas con 403.');

        let tokenParaLogout = token1;
        const email2 = process.env.TEST_USER2_EMAIL;
        const pass2 = process.env.TEST_USER2_PASSWORD;

        if (email2 && pass2) {
            console.log(
                '\nB.4) Ejecutando flujo multi-rol con segunda cuenta (cajero -> encargado -> suspendido)...'
            );

            // Asegurar tienda secundaria de pruebas y un producto base de forma idempotente
            const asegurarSucursal = await peticionJson(baseUrl, '/api/tiendas', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token1}` },
                body: JSON.stringify({
                    id: UUID_SEGUNDA_TIENDA_DEMO,
                    nombre: 'Tienda-Sucursal-Norte',
                }),
            });
            assert.ok([200, 201].includes(asegurarSucursal.status));

            const asegurarProdSucursal = await peticionJson(
                baseUrl,
                '/api/productos',
                {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${token1}`,
                        'X-Tienda-Id': UUID_SEGUNDA_TIENDA_DEMO,
                    },
                    body: JSON.stringify({
                        id: UUID_PRODUCTO_SUCURSAL_DEMO,
                        nombre: 'Galletas Marías Prueba',
                        unidad_venta: 'pieza',
                        precio_centavos: 1800,
                    }),
                }
            );
            assert.ok([200, 201].includes(asegurarProdSucursal.status));

            // Iniciar sesión con Cuenta 2 (o registrarla si AUTO_REGISTER_USER2=true)
            let login2 = await peticionJson(baseUrl, '/api/auth/login', {
                method: 'POST',
                body: JSON.stringify({ email: email2, password: pass2 }),
            });

            if (
                login2.status !== 200 &&
                process.env.AUTO_REGISTER_USER2 === 'true'
            ) {
                const reg2 = await peticionJson(baseUrl, '/api/auth/registro', {
                    method: 'POST',
                    body: JSON.stringify({ email: email2, password: pass2 }),
                });
                assert.ok(
                    [200, 201, 409].includes(reg2.status),
                    `No fue posible auto-registrar Cuenta 2: ${JSON.stringify(reg2.body)}`
                );

                if (reg2.body.access_token) {
                    login2 = { status: 200, body: reg2.body };
                } else {
                    login2 = await peticionJson(baseUrl, '/api/auth/login', {
                        method: 'POST',
                        body: JSON.stringify({ email: email2, password: pass2 }),
                    });
                }
            }

            assert.equal(
                login2.status,
                200,
                `Fallo login cuenta 2: ${JSON.stringify(login2.body)}`
            );
            const token2 = login2.body.access_token;
            const usuario2Id = login2.body.usuario.id;
            tokenParaLogout = token2;

            // Verificar que Cuenta 2 NO accede a Tienda-Demo (ni en Express ni en PostgREST RLS)
            const accesoTiendaDemo = await peticionJson(
                baseUrl,
                '/api/productos',
                {
                    headers: {
                        Authorization: `Bearer ${token2}`,
                        'X-Tienda-Id': tiendaDemo.id,
                    },
                }
            );
            assert.equal(accesoTiendaDemo.status, 403);

            const supabaseUsuario2 = crearClienteSupabase(token2);
            const { data: filasDemoRls } = await supabaseUsuario2
                .from('productos')
                .select('id')
                .eq('tienda_id', tiendaDemo.id);
            assert.equal((filasDemoRls || []).length, 0);

            // Consultar miembros actuales en Tienda-Sucursal-Norte para garantizar estado limpio idempotente
            const miembrosSucursalAntes = await peticionJson(
                baseUrl,
                `/api/tiendas/${UUID_SEGUNDA_TIENDA_DEMO}/miembros`,
                {
                    headers: { Authorization: `Bearer ${token1}` },
                }
            );
            assert.equal(miembrosSucursalAntes.status, 200);

            const membresiaPropSucursal = miembrosSucursalAntes.body.miembros.find(
                (m) => m.usuario_id === login1.body.usuario.id
            );
            assert.ok(membresiaPropSucursal);

            let membresiaUsuario2 = miembrosSucursalAntes.body.miembros.find(
                (m) => m.usuario_id === usuario2Id
            );

            if (membresiaUsuario2) {
                // Si existía de una corrida previa (ej. suspendido), reactivarlo como cajero activo
                const reactivarCajero = await peticionJson(
                    baseUrl,
                    `/api/tiendas/${UUID_SEGUNDA_TIENDA_DEMO}/miembros/${membresiaUsuario2.id}`,
                    {
                        method: 'PATCH',
                        headers: { Authorization: `Bearer ${token1}` },
                        body: JSON.stringify({ rol: 'cajero', estado: 'activo' }),
                    }
                );
                assert.equal(reactivarCajero.status, 200);
                membresiaUsuario2 = reactivarCajero.body.miembro;
            }

            // Vincular (o confirmar de forma idempotente) a Cuenta 2 como cajero
            const altaCajero = await peticionJson(
                baseUrl,
                `/api/tiendas/${UUID_SEGUNDA_TIENDA_DEMO}/miembros`,
                {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${token1}` },
                    body: JSON.stringify({ email: email2, rol: 'cajero' }),
                }
            );
            assert.ok(
                [200, 201].includes(altaCajero.status),
                `Error al vincular cajero: ${JSON.stringify(altaCajero.body)}`
            );
            membresiaUsuario2 = altaCajero.body.miembro;
            assert.equal(membresiaUsuario2.rol, 'cajero');
            assert.equal(membresiaUsuario2.estado, 'activo');

            // Permisos como CAJERO: puede leer productos (200), pero NO crear, editar precio ni gestionar miembros (403)
            const cajeroLeeProductos = await peticionJson(
                baseUrl,
                '/api/productos',
                {
                    headers: {
                        Authorization: `Bearer ${token2}`,
                        'X-Tienda-Id': UUID_SEGUNDA_TIENDA_DEMO,
                    },
                }
            );
            assert.equal(cajeroLeeProductos.status, 200);
            assert.ok(cajeroLeeProductos.body.productos.length >= 1);

            const cajeroCreaProducto = await peticionJson(
                baseUrl,
                '/api/productos',
                {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${token2}`,
                        'X-Tienda-Id': UUID_SEGUNDA_TIENDA_DEMO,
                    },
                    body: JSON.stringify({
                        id: UUID_PRODUCTO_INTRUSO_CAJERO,
                        nombre: 'Producto No Autorizado Cajero',
                        unidad_venta: 'pieza',
                        precio_centavos: 1500,
                    }),
                }
            );
            assert.equal(cajeroCreaProducto.status, 403);

            const cajeroCambiaPrecio = await peticionJson(
                baseUrl,
                `/api/productos/${UUID_PRODUCTO_SUCURSAL_DEMO}`,
                {
                    method: 'PATCH',
                    headers: {
                        Authorization: `Bearer ${token2}`,
                        'X-Tienda-Id': UUID_SEGUNDA_TIENDA_DEMO,
                    },
                    body: JSON.stringify({ precio_centavos: 9900 }),
                }
            );
            assert.equal(cajeroCambiaPrecio.status, 403);

            const cajeroLeeMiembros = await peticionJson(
                baseUrl,
                `/api/tiendas/${UUID_SEGUNDA_TIENDA_DEMO}/miembros`,
                {
                    headers: { Authorization: `Bearer ${token2}` },
                }
            );
            assert.equal(cajeroLeeMiembros.status, 403);

            const cajeroCambiaRol = await peticionJson(
                baseUrl,
                `/api/tiendas/${UUID_SEGUNDA_TIENDA_DEMO}/miembros/${membresiaPropSucursal.id}`,
                {
                    method: 'PATCH',
                    headers: { Authorization: `Bearer ${token2}` },
                    body: JSON.stringify({ rol: 'cajero' }),
                }
            );
            assert.equal(cajeroCambiaRol.status, 403);

            // Comprobar RLS directo en PostgreSQL con el JWT del cajero
            const { error: errorInsertCajeroRls } = await supabaseUsuario2
                .from('productos')
                .insert({
                    id: UUID_PRODUCTO_INTRUSO_CAJERO,
                    tienda_id: UUID_SEGUNDA_TIENDA_DEMO,
                    nombre: 'Intruso PostgREST Cajero',
                    unidad_venta: 'pieza',
                    precio_centavos: 1200,
                });
            assert.ok(
                errorInsertCajeroRls,
                'RLS permitió a un cajero insertar productos directamente en PostgREST.'
            );

            const { data: filasEditadasCajeroRls, error: errorUpdateCajeroRls } =
                await supabaseUsuario2
                    .from('productos')
                    .update({ precio_centavos: 9900 })
                    .eq('id', UUID_PRODUCTO_SUCURSAL_DEMO)
                    .select('id');
            assert.ok(
                Boolean(errorUpdateCajeroRls) ||
                    (filasEditadasCajeroRls || []).length === 0,
                'RLS permitió a un cajero modificar el precio directamente en PostgREST.'
            );

            console.log(
                '   OK: Restricciones de cajero verificadas en Express (403) y en PostgREST RLS.'
            );

            // Promover a ENCARGADO con Cuenta 1
            const promoverEncargado = await peticionJson(
                baseUrl,
                `/api/tiendas/${UUID_SEGUNDA_TIENDA_DEMO}/miembros/${membresiaUsuario2.id}`,
                {
                    method: 'PATCH',
                    headers: { Authorization: `Bearer ${token1}` },
                    body: JSON.stringify({ rol: 'encargado' }),
                }
            );
            assert.equal(promoverEncargado.status, 200);
            assert.equal(promoverEncargado.body.miembro.rol, 'encargado');

            const encargadoLeeMiembros = await peticionJson(
                baseUrl,
                `/api/tiendas/${UUID_SEGUNDA_TIENDA_DEMO}/miembros`,
                {
                    headers: { Authorization: `Bearer ${token2}` },
                }
            );
            assert.equal(encargadoLeeMiembros.status, 200);
            assert.ok(encargadoLeeMiembros.body.miembros.length >= 2);

            const encargadoIntentaDegradarProp = await peticionJson(
                baseUrl,
                `/api/tiendas/${UUID_SEGUNDA_TIENDA_DEMO}/miembros/${membresiaPropSucursal.id}`,
                {
                    method: 'PATCH',
                    headers: { Authorization: `Bearer ${token2}` },
                    body: JSON.stringify({ rol: 'cajero' }),
                }
            );
            assert.equal(encargadoIntentaDegradarProp.status, 403);

            console.log(
                '   OK: Encargado puede consultar miembros (200) pero NO alterar al propietario (403).'
            );

            // Suspender membresía de Cuenta 2 con Cuenta 1
            const suspenderCuenta2 = await peticionJson(
                baseUrl,
                `/api/tiendas/${UUID_SEGUNDA_TIENDA_DEMO}/miembros/${membresiaUsuario2.id}`,
                {
                    method: 'PATCH',
                    headers: { Authorization: `Bearer ${token1}` },
                    body: JSON.stringify({ estado: 'suspendido' }),
                }
            );
            assert.equal(suspenderCuenta2.status, 200);
            assert.equal(suspenderCuenta2.body.miembro.estado, 'suspendido');

            const accesoSuspendidoExpress = await peticionJson(
                baseUrl,
                '/api/productos',
                {
                    headers: {
                        Authorization: `Bearer ${token2}`,
                        'X-Tienda-Id': UUID_SEGUNDA_TIENDA_DEMO,
                    },
                }
            );
            assert.equal(accesoSuspendidoExpress.status, 403);

            const { data: filasSuspendidoRls } = await supabaseUsuario2
                .from('productos')
                .select('id')
                .eq('tienda_id', UUID_SEGUNDA_TIENDA_DEMO);
            assert.equal((filasSuspendidoRls || []).length, 0);

            console.log(
                '   OK: Miembro suspendido pierde acceso inmediato en Express (403) y PostgREST RLS (0 filas).'
            );
        } else {
            console.log(
                '\nNota opcional: Define TEST_USER2_EMAIL y TEST_USER2_PASSWORD para validar también el flujo multi-rol (cajero/encargado/suspendido).'
            );
        }

        console.log('\nB.5) Verificando cierre explícito de sesión (POST /api/auth/logout)...');
        const cierreSesion = await peticionJson(baseUrl, '/api/auth/logout', {
            method: 'POST',
            headers: { Authorization: `Bearer ${tokenParaLogout}` },
        });
        assert.equal(cierreSesion.status, 200);
        console.log('   OK: Cierre de sesión ejecutado correctamente.');

        console.log('\nVerificación completa de Sprint 2 exitosa.');
    } finally {
        await new Promise((resolve) => servidor.close(resolve));
    }
}

ejecutar().catch((error) => {
    console.error('\nFallo en verificación de Sprint 2:', error);
    process.exit(1);
});
