require('dotenv').config();

const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();

const PORT = Number(process.env.PORT || 3000);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY =
    process.env.SUPABASE_PUBLISHABLE_KEY;

if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    console.error(
        'Faltan SUPABASE_URL o SUPABASE_PUBLISHABLE_KEY en el archivo .env'
    );

    process.exit(1);
}

app.use(express.json({ limit: '100kb' }));

/**
 * Crea un cliente para una petición.
 *
 * Cuando existe un token de usuario, lo envía a Supabase
 * para que PostgreSQL aplique las políticas RLS.
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

    return createClient(
        SUPABASE_URL,
        SUPABASE_PUBLISHABLE_KEY,
        opciones
    );
}

/**
 * Verifica que la petición incluya un token de usuario válido.
 */
async function verificarSesion(req, res, next) {
    const encabezado = req.headers.authorization || '';

    if (!encabezado.startsWith('Bearer ')) {
        return res.status(401).json({
            error: 'Debes enviar un token de acceso.',
        });
    }

    const token = encabezado.slice('Bearer '.length).trim();

    if (!token) {
        return res.status(401).json({
            error: 'El token de acceso está vacío.',
        });
    }

    const supabase = crearClienteSupabase(token);

    const {
        data: { user },
        error,
    } = await supabase.auth.getUser(token);

    if (error || !user) {
        return res.status(401).json({
            error: 'La sesión no es válida o ha expirado.',
        });
    }

    req.usuario = user;
    req.supabase = supabase;

    next();
}

/**
 * Ruta para comprobar que Express está funcionando.
 */
app.get('/api/health', (req, res) => {
    res.json({
        estado: 'ok',
        mensaje: 'El backend de la miscelánea está funcionando.',
    });
});

/**
 * Inicio de sesión con Supabase Auth.
 */
app.post('/api/auth/login', async (req, res) => {
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

    const { data, error } =
        await supabase.auth.signInWithPassword({
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
        expira_en: data.session.expires_at,
        usuario: {
            id: data.user.id,
            email: data.user.email,
        },
    });
});

/**
 * Consultar los productos del usuario.
 */
app.get('/api/productos', verificarSesion, async (req, res) => {
    const { data, error } = await req.supabase
        .from('productos')
        .select(
            'id, nombre, codigo_barras, unidad_venta, precio_centavos, activo, creado_en'
        )
        .order('nombre', { ascending: true });

    if (error) {
        console.error('Error al consultar productos:', error.message);

        return res.status(500).json({
            error: 'No fue posible consultar los productos.',
        });
    }

    res.json({
        productos: data,
    });
});

/**
 * Registrar un producto.
 */
app.post('/api/productos', verificarSesion, async (req, res) => {
    const {
        nombre,
        codigo_barras,
        unidad_venta,
        precio_centavos,
    } = req.body || {};

    if (
        typeof nombre !== 'string' ||
        nombre.trim().length < 1 ||
        nombre.trim().length > 120
    ) {
        return res.status(400).json({
            error: 'El nombre debe tener entre 1 y 120 caracteres.',
        });
    }

    if (!['pieza', 'kg', 'litro'].includes(unidad_venta)) {
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
        typeof codigo_barras === 'string'
            ? codigo_barras.trim()
            : null;

    if (codigoNormalizado && codigoNormalizado.length > 80) {
        return res.status(400).json({
            error: 'El código de barras no puede superar 80 caracteres.',
        });
    }

    const { data, error } = await req.supabase
        .from('productos')
        .insert({
            propietario_id: req.usuario.id,
            nombre: nombre.trim(),
            codigo_barras: codigoNormalizado || null,
            unidad_venta,
            precio_centavos,
        })
        .select(
            'id, nombre, codigo_barras, unidad_venta, precio_centavos, activo, creado_en'
        )
        .single();

    if (error) {
        if (error.code === '23505') {
            return res.status(409).json({
                error: 'Ya tienes un producto con ese código de barras.',
            });
        }

        console.error('Error al crear producto:', error.message);

        return res.status(500).json({
            error: 'No fue posible registrar el producto.',
        });
    }

    res.status(201).json({
        mensaje: 'Producto registrado correctamente.',
        producto: data,
    });
});

/**
 * Respuesta general para rutas inexistentes.
 */
app.use((req, res) => {
    res.status(404).json({
        error: 'La ruta solicitada no existe.',
    });
});

/**
 * Manejo general de errores.
 */
app.use((error, req, res, next) => {
    console.error('Error del servidor:', error.message);

    if (error.type === 'entity.parse.failed') {
        return res.status(400).json({
            error: 'El cuerpo de la petición no contiene JSON válido.',
        });
    }

    res.status(500).json({
        error: 'Ocurrió un error interno.',
    });
});

app.listen(PORT, () => {
    console.log(
        `Servidor iniciado en http://localhost:${PORT}`
    );
});