const express = require('express');
const { crearClienteSupabase } = require('../config/supabase');
const { verificarSesion } = require('../middlewares/autenticacion');

const router = express.Router();

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

module.exports = router;
