const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;

if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    console.error(
        'Faltan SUPABASE_URL o SUPABASE_PUBLISHABLE_KEY en el archivo .env'
    );
    process.exit(1);
}

/**
 * Crea un cliente aislado por petición (sin persistir sesión en memoria).
 * Cuando recibe un JWT de usuario, PostgreSQL evalúa todas las políticas RLS bajo auth.uid().
 */
function crearClienteSupabase(token) {
    const opciones = {
        auth: {
            persistSession: false,
            autoRefreshToken: false,
            detectSessionInUrl: false,
        },
    };

    if (token) {
        opciones.global = {
            headers: {
                Authorization: `Bearer ${token}`,
            },
        };
    }

    return createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, opciones);
}

module.exports = {
    crearClienteSupabase,
};
