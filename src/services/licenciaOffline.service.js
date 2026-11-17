const crypto = require('node:crypto');

const PATRON_BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * Inicializa el par de claves asimétricas Ed25519 desde variables de entorno
 * (PKCS8 DER / SPKI DER en base64) o genera un par efímero en memoria una sola vez.
 */
function inicializarClavesOffline() {
    const privB64 = process.env.OFFLINE_LICENSE_PRIVATE_KEY_B64;
    const pubB64 = process.env.OFFLINE_LICENSE_PUBLIC_KEY_B64;

    if (
        typeof privB64 === 'string' &&
        privB64.trim() &&
        typeof pubB64 === 'string' &&
        pubB64.trim()
    ) {
        const privateKey = crypto.createPrivateKey({
            key: Buffer.from(privB64.trim(), 'base64'),
            format: 'der',
            type: 'pkcs8',
        });

        const publicKey = crypto.createPublicKey({
            key: Buffer.from(pubB64.trim(), 'base64'),
            format: 'der',
            type: 'spki',
        });

        const publicKeyB64 = publicKey
            .export({ type: 'spki', format: 'der' })
            .toString('base64');

        return { privateKey, publicKey, publicKeyB64 };
    }

    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const publicKeyB64 = publicKey
        .export({ type: 'spki', format: 'der' })
        .toString('base64');

    return { privateKey, publicKey, publicKeyB64 };
}

const { privateKey, publicKey, publicKeyB64 } = inicializarClavesOffline();

/**
 * Expone la clave pública Ed25519 para que clientes locales puedan verificar
 * constancias de licencia y ventana offline sin conexión al servidor.
 */
function obtenerClavePublicaOffline() {
    return {
        algoritmo: 'Ed25519',
        formato: 'spki-der-base64',
        public_key_b64: publicKeyB64,
    };
}

/**
 * Emite una constancia firmada Ed25519 con la vigencia de suscripción y ventana offline
 * (Grace Period) de la tienda para el usuario y rol activos.
 */
function emitirConstanciaOffline({ tienda, rol, usuarioId, ahora = new Date() }) {
    const fechaActual = ahora instanceof Date ? ahora : new Date(ahora);
    const estadoSuscripcion = tienda.estado_suscripcion || 'prueba';
    const licenciaExpiraDate = tienda.licencia_expira_en
        ? new Date(tienda.licencia_expira_en)
        : new Date(fechaActual.getTime() + 30 * 24 * 3600 * 1000);
    const ventanaHoras = Number(tienda.ventana_offline_horas || 96);

    const permiteNuevasVentas =
        tienda.estado === 'activa' &&
        ['prueba', 'activa'].includes(estadoSuscripcion) &&
        licenciaExpiraDate.getTime() > fechaActual.getTime();

    const ventanaHastaMs = permiteNuevasVentas
        ? Math.min(
              fechaActual.getTime() + ventanaHoras * 3600 * 1000,
              licenciaExpiraDate.getTime()
          )
        : fechaActual.getTime();

    const payload = {
        v: 1,
        tienda_id: tienda.id,
        usuario_id: usuarioId,
        rol,
        estado_tienda: tienda.estado,
        estado_suscripcion: estadoSuscripcion,
        permite_nuevas_ventas: permiteNuevasVentas,
        permite_consulta_fiados_inventario: true,
        emitido_en: fechaActual.toISOString(),
        ventana_offline_hasta: new Date(ventanaHastaMs).toISOString(),
        licencia_expira_en: licenciaExpiraDate.toISOString(),
    };

    const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString(
        'base64url'
    );
    const firmaB64 = crypto
        .sign(null, Buffer.from(payloadB64, 'utf8'), privateKey)
        .toString('base64url');

    return {
        algoritmo: 'Ed25519',
        token: `${payloadB64}.${firmaB64}`,
        payload,
    };
}

/**
 * Verifica criptográficamente una constancia offline y evalúa manipulación de reloj
 * y vigencia de la ventana de operación sin conexión.
 */
function verificarConstanciaOffline(
    token,
    { fechaActual = new Date(), ultimaFechaEventoLocal = null } = {}
) {
    const respuestaInvalida = {
        valida: false,
        ventana_vigente: false,
        motivo: 'FIRMA_O_FORMATO_INVALIDO',
        permite_nuevas_ventas: false,
        permite_consulta_fiados_inventario: false,
        payload: null,
    };

    if (typeof token !== 'string') {
        return respuestaInvalida;
    }

    const partes = token.split('.');
    if (partes.length !== 2) {
        return respuestaInvalida;
    }

    const [payloadB64, firmaB64] = partes;
    if (
        !payloadB64 ||
        !firmaB64 ||
        !PATRON_BASE64URL.test(payloadB64) ||
        !PATRON_BASE64URL.test(firmaB64)
    ) {
        return respuestaInvalida;
    }

    let firmaValida = false;
    try {
        firmaValida = crypto.verify(
            null,
            Buffer.from(payloadB64, 'utf8'),
            publicKey,
            Buffer.from(firmaB64, 'base64url')
        );
    } catch {
        return respuestaInvalida;
    }

    if (!firmaValida) {
        return respuestaInvalida;
    }

    let payload = null;
    try {
        payload = JSON.parse(
            Buffer.from(payloadB64, 'base64url').toString('utf8')
        );
    } catch {
        return respuestaInvalida;
    }

    if (
        !payload ||
        typeof payload !== 'object' ||
        Number.isNaN(Date.parse(payload.emitido_en)) ||
        Number.isNaN(Date.parse(payload.ventana_offline_hasta))
    ) {
        return respuestaInvalida;
    }

    const ahoraDate =
        fechaActual instanceof Date ? fechaActual : new Date(fechaActual);
    const ahoraMs = ahoraDate.getTime();
    const emitidoMs = new Date(payload.emitido_en).getTime();

    if (
        ahoraMs < emitidoMs ||
        (ultimaFechaEventoLocal &&
            ahoraMs < new Date(ultimaFechaEventoLocal).getTime())
    ) {
        return {
            valida: false,
            ventana_vigente: false,
            motivo: 'RELOJ_ATRASADO',
            permite_nuevas_ventas: false,
            permite_consulta_fiados_inventario: true,
            payload,
        };
    }

    const ventanaHastaMs = new Date(payload.ventana_offline_hasta).getTime();

    if (!payload.permite_nuevas_ventas || ahoraMs > ventanaHastaMs) {
        return {
            valida: true,
            ventana_vigente: false,
            motivo: 'VENTANA_OFFLINE_O_LICENCIA_VENCIDA',
            permite_nuevas_ventas: false,
            permite_consulta_fiados_inventario: true,
            payload,
        };
    }

    return {
        valida: true,
        ventana_vigente: true,
        motivo: 'OK',
        permite_nuevas_ventas: true,
        permite_consulta_fiados_inventario: true,
        payload,
    };
}

module.exports = {
    obtenerClavePublicaOffline,
    emitirConstanciaOffline,
    verificarConstanciaOffline,
};
