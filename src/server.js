require('dotenv').config();

const express = require('express');
const authRoutes = require('./routes/auth.routes');
const tiendasRoutes = require('./routes/tiendas.routes');
const productosRoutes = require('./routes/productos.routes');

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));

/**
 * Ruta pública para comprobar que el servidor Express está activo.
 */
app.get('/api/health', (req, res) => {
    res.json({
        estado: 'ok',
        mensaje: 'El backend de la miscelánea está funcionando.',
    });
});

/**
 * Rutas principales de la API (Sprint 1: autenticación, tiendas, membresías y productos por tienda).
 */
app.use('/api/auth', authRoutes);
app.use('/api/tiendas', tiendasRoutes);
app.use('/api/productos', productosRoutes);

/**
 * Respuesta uniforme para rutas inexistentes.
 */
app.use((req, res) => {
    res.status(404).json({
        error: 'La ruta solicitada no existe.',
    });
});

/**
 * Manejo centralizado de errores de parseo o excepciones inesperadas.
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

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Servidor iniciado en http://localhost:${PORT}`);
    });
}

module.exports = app;
