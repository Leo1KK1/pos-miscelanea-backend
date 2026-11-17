const express = require('express');
const { crearClienteSupabase } = require('../config/supabase');
const { verificarSesion } = require('../middlewares/autenticacion');
const { obtenerClavePublicaOffline } = require('../services/licenciaOffline.service');

const router = express.Router();

const PATRON_EMAIL_BASICO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Inicio de sesión con correo y contraseña mediante Supabase Auth.
 */
router.post('/login', async (req, res) => {
    const { email, password } = req.body || {};

    if (
        typeof email !== 'string' ||
        typeof password !== 'string' ||
        !email.trim() ||
        !password
    ) {
        return res.status(400).json({
            error: 'Debes enviar correo y contraseña.',
        });
    }

    const supabase = crearClienteSupabase();

    const { data, error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
    });

    if (error || !data.session) {
        return res.status(401).json({
            error: 'No fue posible iniciar sesión. Revisa tus datos.',
        });
    }

    res.json({
        mensaje: 'Inicio de sesión correcto.',
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expira_en: data.session.expires_at,
        usuario: {
            id: data.user.id,
            email: data.user.email,
        },
    });
});

/**
 * Registro de un nuevo usuario con correo y contraseña mediante Supabase Auth.
 */
router.post('/registro', async (req, res) => {
    const { email, password } = req.body || {};

    if (typeof email !== 'string' || !PATRON_EMAIL_BASICO.test(email.trim())) {
        return res.status(400).json({
            error: 'Debes proporcionar un correo electrónico válido.',
        });
    }

    if (typeof password !== 'string' || password.length < 8) {
        return res.status(400).json({
            error: 'La contraseña debe tener al menos 8 caracteres.',
        });
    }

    const supabase = crearClienteSupabase();

    const { data, error } = await supabase.auth.signUp({
        email: email.trim(),
        password,
    });

    if (error) {
        const mensajeError = (error.message || '').toLowerCase();
        if (
            mensajeError.includes('already registered') ||
            mensajeError.includes('already exists')
        ) {
            return res.status(409).json({
                error: 'Ya existe una cuenta registrada con ese correo electrónico.',
            });
        }

        return res.status(400).json({
            error: 'No fue posible registrar la cuenta. Verifica el correo y la contraseña.',
        });
    }

    if (!data || !data.user) {
        return res.status(400).json({
            error: 'No fue posible completar el registro de la cuenta.',
        });
    }

    if (
        Array.isArray(data.user.identities) &&
        data.user.identities.length === 0
    ) {
        return res.status(409).json({
            error: 'Ya existe una cuenta registrada con ese correo electrónico.',
        });
    }

    res.status(201).json({
        mensaje: data.session
            ? 'Cuenta registrada correctamente.'
            : 'Cuenta registrada correctamente. Revisa tu correo electrónico para confirmar la cuenta.',
        usuario: {
            id: data.user.id,
            email: data.user.email,
        },
        requiere_confirmacion_correo: !data.session,
        access_token: data.session?.access_token || null,
        refresh_token: data.session?.refresh_token || null,
        expira_en: data.session?.expires_at || null,
    });
});

/**
 * Renovación de sesión usando el refresh_token emitido por Supabase Auth.
 */
router.post('/refresh', async (req, res) => {
    const { refresh_token } = req.body || {};

    if (typeof refresh_token !== 'string' || !refresh_token.trim()) {
        return res.status(400).json({
            error: 'Debes proporcionar un refresh_token válido.',
        });
    }

    const supabase = crearClienteSupabase();

    const { data, error } = await supabase.auth.refreshSession({
        refresh_token: refresh_token.trim(),
    });

    if (error || !data || !data.session || !data.user) {
        return res.status(401).json({
            error: 'No fue posible renovar la sesión. Inicia sesión nuevamente.',
            codigo: 'REFRESH_INVALIDO_O_EXPIRADO',
        });
    }

    res.status(200).json({
        mensaje: 'Sesión renovada correctamente.',
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expira_en: data.session.expires_at,
        usuario: {
            id: data.user.id,
            email: data.user.email,
        },
    });
});

/**
 * Cierre explícito de la sesión activa.
 */
router.post('/logout', verificarSesion, async (req, res) => {
    await req.supabase.auth.signOut({ scope: 'local' });

    res.status(200).json({
        mensaje: 'Sesión cerrada correctamente.',
    });
});

/**
 * Consulta la identidad de la sesión actual.
 */
router.get('/me', verificarSesion, async (req, res) => {
    res.json({
        usuario: {
            id: req.usuario.id,
            email: req.usuario.email,
        },
    });
});

/**
 * Expone la clave pública Ed25519 para verificar localmente constancias de vigencia offline.
 */
router.get('/clave-publica-offline', (req, res) => {
    res.json(obtenerClavePublicaOffline());
});

module.exports = router;
