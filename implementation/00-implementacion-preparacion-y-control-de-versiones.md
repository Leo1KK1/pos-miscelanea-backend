# Sprint 0 — Preparación del Entorno, Control de Versiones y Respaldo Base

| Campo | Detalle |
| :--- | :--- |
| **Sprint** | Sprint 0 |
| **Objetivo** | Asegurar la base del backend Express + Supabase Auth, blindar el control de versiones contra filtración de secretos, definir las 6 reglas arquitectónicas Offline-First y establecer el protocolo verificable de diagnóstico y respaldo previo a migraciones. |
| **Estado** | Completado (`0dd2f0a`) |
| **Rama de integración** | `main` |
| **Archivos clave creados / modificados** | `.gitignore`, `.env.example`, `package.json`, `package-lock.json`, `src/server.js`, `migrations/000_diagnostico_y_respaldo_sprint0.sql`, `docs/ARQUITECTURA_Y_TABLERO.md`, `README.md` |

---

## 1. Contexto y Decisiones Técnicas Aplicadas

Antes de evolucionar el prototipo inicial mono-usuario hacia un sistema multi-tienda para misceláneas, tiendas de abarrotes y cremerías en México, en el Sprint 0 se formalizaron las **6 reglas arquitectónicas base** que gobiernan todos los sprints posteriores:

1. **Diseño Offline-First adelantado (Regla 1):** Se reordenó la hoja de ruta para construir la persistencia SQLite local y la cola de sincronización (`sync_queue` / patrón *Outbox*) en el Sprint 5, antes de Ventas (Sprint 6) y Fiados (Sprint 7), evitando reescribir el flujo operativo de mostrador.
2. **Identificadores UUID generados en el cliente e Idempotencia (Regla 2):** Se descartó el uso de secuencias autoincrementales (`SERIAL` / `BIGSERIAL`) en tablas operativas para permitir que dispositivos sin conexión generen identificadores `UUID` localmente sin colisiones y reintenten peticiones de forma idempotente.
3. **Inventario y fiados como Libro Mayor o *Ledger* (Regla 3):** Se definió que `stock_actual` y los saldos de clientes jamás se sobrescribirán con valores absolutos, sino mediante deltas inmutables en `inventario_movimientos` y `fiado_abonos`.
4. **Venta a granel bidireccional (Regla 4):** Se estableció el uso estricto de importes enteros en centavos (`precio_centavos` como `INTEGER`) y cantidades decimales (`NUMERIC(12,3)`) para soportar cobros tanto por peso (`0.250 kg` a `160.00 MXN/kg` = `40.00 MXN` / `4000 centavos`) como por importe solicitado en mostrador (*"15.00 MXN de jamón"*).
5. **Arquitectura híbrida segura Node.js + Supabase RLS/RPC (Regla 5):** Se fijó que el backend Express opere exclusivamente con `SUPABASE_PUBLISHABLE_KEY` más el JWT del usuario autenticado por petición, prohibiendo el uso de `service_role` en tráfico operativo y delegando el aislamiento de datos a políticas *Row Level Security* (RLS) y funciones RPC atómicas.
6. **Vigencia de suscripción sin conexión con firma criptográfica (Regla 6):** Se diseñó el modelo de *Grace Period* offline firmado criptográficamente (implementado con Ed25519 en Sprint 2) bajo la regla comercial de nunca bloquear la consulta de fiados por cobrar ni de inventario aunque venza el plan.

---

## 2. Cambios en Base de Datos (PostgreSQL / Supabase)

En el Sprint 0 **no se alteró destructivamente ninguna tabla productiva**; en su lugar, se creó el script [`migrations/000_diagnostico_y_respaldo_sprint0.sql`](../migrations/000_diagnostico_y_respaldo_sprint0.sql) para auditar y resguardar el estado previo a la migración multi-tienda:

- **Esquema privado aislado (`private_backups`):**
  - Creación de `private_backups` con revocación explícita de privilegios (`REVOKE ALL ON SCHEMA private_backups FROM PUBLIC, anon, authenticated`) para impedir que las tablas de respaldo queden expuestas en la API automática PostgREST de Supabase.
- **Tabla de respaldo pre-migración (`private_backups.productos_pre_sprint1`):**
  - Copia íntegra e idempotente (`CREATE TABLE IF NOT EXISTS ... WITH NO DATA` + `TRUNCATE` + `INSERT INTO ... SELECT * FROM public.productos`) que resguardó los 3 productos originales de desarrollo (`Jamón`, `Queso Oaxaca` y `Refresco de cola`) asociados entonces a `propietario_id`.
- **Diagnóstico estructurado en JSON (`diagnostico_sprint0`):**
  - Consulta única de inspección sobre `information_schema.columns`, `pg_constraint`, `pg_indexes` y `pg_policies` de `public.productos` para diseñar con exactitud quirúrgica la migración `001` y su script de reversión.
- **Estrategia de recuperación y rollback:**
  - Además de la copia interna en `private_backups.productos_pre_sprint1`, se documentó la exportación local hacia `backups/` (excluida en `.gitignore`), garantizando restauración inmediata ante cualquier fallo en migraciones posteriores.

---

## 3. Cambios en Backend (Node.js / Express)

- **Configuración base del proyecto (`package.json`):**
  - Definición de motor `node >= 20.0.0` (verificado sobre Node.js `v24.18.0` y npm `11.16.0`), CommonJS y dependencias mínimas de producción (`express ^5.3.0`, `@supabase/supabase-js ^2.119.0`, `dotenv ^18.0.10`).
  - Scripts estandarizados `npm start` (`node src/server.js`) y `npm run dev` (`node --watch src/server.js`).
- **Servidor inicial y aislamiento de sesión por petición (`src/server.js`):**
  - Límite de carga JSON (`express.json({ limit: '100kb' })`) para mitigar payloads excesivos.
  - Función `crearClienteSupabase(token)` configurada con `persistSession: false`, `autoRefreshToken: false` y `detectSessionInUrl: false`, evitando contaminación de credenciales entre peticiones concurrentes en Express.
  - Middleware `verificarSesion` validando cabeceras `Authorization: Bearer <token>` contra `supabase.auth.getUser(token)`.
  - Endpoint público de monitoreo `GET /api/health` y manejo uniforme de rutas inexistentes (`404`) y JSON malformado (`400`).
- **Higiene de secretos y control de versiones (`.gitignore` y `.env.example`):**
  - Exclusión estricta de `.env`, `.env.*`, claves privadas (`*.pem`, `*.key`, `secrets/`) y volcados locales (`backups/`, `*.bak`, `*.dump`, `*.sql.local`).
  - Plantilla `.env.example` documentada únicamente con variables seguras (`PORT`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`), advirtiendo explícitamente no incluir jamás `SUPABASE_SERVICE_ROLE_KEY`.

---

## 4. Criterios de Aceptación y Verificación Ejecutada

Dado que el Sprint 0 correspondió al aseguramiento del entorno base previo a la suite automatizada introducida en los Sprints 1–3, se ejecutaron las siguientes comprobaciones reproducibles:

1. **Verificación de higiene de Git y ausencia de secretos:**
   - Comprobación con `git status` confirmando que `.env` y `backups/` permanecen fuera del índice de Git mientras `.env.example` provee la plantilla limpia.
2. **Ejecución del respaldo y diagnóstico en Supabase SQL Editor:**
   - Ejecución de `migrations/000_diagnostico_y_respaldo_sprint0.sql` verificando `respaldo_filas_guardadas = 3` en `private_backups.productos_pre_sprint1` y confirmando que el esquema `private_backups` no es accesible por roles `anon` ni `authenticated`.
3. **Comprobación funcional del servidor Express (sin exponer credenciales):**

   ```powershell
   # 1. Instalar dependencias exactas y preparar variables locales
   npm ci
   Copy-Item .env.example .env  # Completar SUPABASE_URL y SUPABASE_PUBLISHABLE_KEY de desarrollo

   # 2. Iniciar el servidor en una terminal
   npm start

   # 3. Verificar estado de salud (200 OK) y protección sin token (401 Unauthorized)
   Invoke-RestMethod -Method Get -Uri "http://localhost:3000/api/health"
   ```
