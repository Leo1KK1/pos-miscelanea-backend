# Punto de venta SaaS para misceláneas

Aplicación en desarrollo para apoyar la operación cotidiana de pequeñas tiendas de abarrotes, misceláneas y cremerías en México. El proyecto prioriza cobrar rápido en mostrador (por pieza, por peso o por importe en pesos), llevar control de fiados e inventario por libro mayor, aislar estrictamente los datos de cada tienda y operar **sin conexión a internet (*Offline-First*)**.

> **Estado actual:** Sprint 0 completado; iniciando **Sprint 1 (Tiendas, membresías y migración UUID)**. Consulta el detalle arquitectónico y el tablero en [docs/ARQUITECTURA_Y_TABLERO.md](docs/ARQUITECTURA_Y_TABLERO.md).

## Objetivo

Construir un sistema punto de venta móvil sencillo e intuitivo que permita a una tienda cobrar ventas en efectivo en pocos toques, controlar inventario y fiados sin sobrescrituras entre dispositivos, y seguir operando cuando falle el internet o los datos móviles dentro del local. Una misma cuenta puede pertenecer a varias tiendas con un rol específico por negocio (`propietario`, `encargado` o `cajero`).

## Estado real del repositorio

- **API inicial funcional (`src/server.js`):** Servidor Express 5 conectado con Supabase Auth y PostgreSQL mediante `@supabase/supabase-js` usando el token JWT de cada petición (sin compartir sesión entre solicitudes).
- **Rutas actuales:**
  - `GET /api/health` — comprobación de salud del servidor.
  - `POST /api/auth/login` — inicio de sesión con correo y contraseña vía Supabase Auth.
  - `GET /api/productos` — consulta de productos (actualmente ligada al usuario autenticado; en migración a `tienda_id` en Sprint 1).
  - `POST /api/productos` — alta de producto por `pieza`, `kg` o `litro` con precio entero en centavos.
- **Trabajo inmediato (Sprint 1):** Migrar de `propietario_id` a `tienda_id` con tablas `tiendas` y `miembros_tienda`, estandarizar `UUID`, aplicar políticas RLS sin recursión y seleccionar tienda activa en la API.

## Tecnologías y versiones

| Componente | Tecnología | Estado |
| --- | --- | --- |
| Runtime y API | Node.js `v24.18.0` (`>=20.0.0`), npm `11.16.0`, Express `^5.3.0` | En uso |
| Autenticación | Supabase Auth (`@supabase/supabase-js ^2.119.0`) | Conectada en API |
| Base de datos remota | PostgreSQL en Supabase (RLS + RPC transaccionales) | En uso / evolucionando a multi-tienda |
| Aplicación móvil | Flutter (Android prioritario gama media/baja) | Previsto a partir de Sprint 5 |
| Base de datos local móvil | SQLite (`drift` / `sqflite`) + cola `sync_queue` | Previsto a partir de Sprint 5 |
| Control de versiones | Git + migraciones SQL numeradas en `migrations/` | Activo |

## Decisiones arquitectónicas fundamentales

El proyecto aplica seis principios desde la base de datos y el backend para evitar retrabajo al llegar a la app móvil (detalle completo en [docs/ARQUITECTURA_Y_TABLERO.md](docs/ARQUITECTURA_Y_TABLERO.md)):

1. **Offline-First desde antes de Ventas (Sprint 5 adelantado):** La interfaz en Flutter siempre leerá y escribirá contra SQLite local; un proceso en segundo plano sincronizará la cola de eventos (`sync_queue` / patrón *Outbox*) con la API.
2. **UUIDs generados en el cliente e Idempotencia:** Todas las entidades operativas utilizan `UUID` (v4/v7) generados localmente sin depender de secuencias de PostgreSQL. Los endpoints y funciones RPC son idempotentes ante reenvíos por red intermitente.
3. **Libro mayor de inventario y fiados (`inventario_movimientos` / `fiado_abonos`):** Nunca se sobrescribe el stock ni el saldo con valores absolutos; `stock_actual` se calcula sumando algebraicamente los deltas registrados en el servidor mediante triggers/vistas.
4. **Venta a granel bidireccional (peso <-> dinero):** Soporta tanto vender por peso ($250\text{ g} \times \$160 = \$40$) como pedir por importe (*"deme \$15 de jamón/queso"*), guardando en cada detalle `cantidad` (`NUMERIC(12,3)`), `precio_unitario_historico_centavos` y `subtotal_cobrado_centavos`.
5. **Arquitectura híbrida Node.js + RLS/RPC en Supabase:** Node.js actúa como puerta de enlace validando sesión, membresía y reglas de negocio usando `SUPABASE_PUBLISHABLE_KEY` + JWT del usuario. Las tablas aplican RLS estricto y las operaciones multi-tabla (ventas, caja, abonos) se ejecutan mediante funciones PostgreSQL RPC atómicas sin dejar abierta escritura directa suelta en PostgREST.
6. **Vigencia offline firmada criptográficamente (Grace Period):** Cada sincronización exitosa entrega una constancia firmada con la hora del servidor y vigencia de licencia (ventana offline de 72–120 h), detectando atrasos manuales en el reloj del teléfono. Si vence el plan, se bloquean **nuevas ventas**, pero **siempre permanecen abiertos para consulta los fiados por cobrar y el inventario**.

## Preparación del entorno de desarrollo

### Requisitos

- Git y Node.js `>=20.0.0` (desarrollado y probado en `v24.18.0` con npm `11.16.0`).
- Acceso a un proyecto de Supabase exclusivo para desarrollo.

### Instalación y ejecución

1. Clona o abre el repositorio en `c:\pos-miscelanea-backend` y comprueba versiones:

   ```powershell
   node --version
   npm --version
   ```

2. Instala las dependencias exactas declaradas en `package-lock.json`:

   ```powershell
   npm ci
   ```

3. Crea tu archivo `.env` local tomando como plantilla `.env.example` y completa tus valores de desarrollo:

   ```powershell
   Copy-Item .env.example .env
   ```

   Variables utilizadas:
   - `PORT`: puerto HTTP local (por defecto `3000`).
   - `SUPABASE_URL`: URL del proyecto de Supabase de desarrollo.
   - `SUPABASE_PUBLISHABLE_KEY`: clave pública (`anon` / `publishable`) de Supabase.
   - `OFFLINE_LICENSE_SECRET`: clave secreta local del servidor (mínimo 32 bytes hex) reservada para firmar constancias de vigencia offline.

4. Inicia el servidor:

   ```powershell
   # Ejecución normal
   npm start

   # Desarrollo con recarga automática de Node
   npm run dev
   ```

5. Comprueba que el servidor responde:

   ```powershell
   Invoke-RestMethod -Uri "http://localhost:3000/api/health"
   ```

> **Seguridad:** Nunca subas `.env`, claves privadas, `service_role`, volcados con datos reales ni respaldos al repositorio. Antes de aplicar migraciones en Supabase, ejecuta siempre el procedimiento de respaldo descrito en `migrations/000_diagnostico_y_respaldo_sprint0.sql`.

## Plan de desarrollo (Hoja de ruta reordenada)

| Etapa | Objetivo principal | Estado |
| --- | --- | --- |
| **Sprint 0** | Proteger API existente, configurar Git, `.env.example`, respaldo SQL y arquitectura base. | Completado |
| **Sprint 1** | Crear `tiendas` y `miembros_tienda`, migrar `productos` a `tienda_id` con UUID y aplicar RLS. | **En curso** |
| **Sprint 2** | Identidad, sesiones, matriz de permisos por rol y base de constancia firmada offline. | Pendiente |
| **Sprint 3** | Catálogo por tienda (con y sin código, botones rápidos) y reglas bidireccionales de granel. | Pendiente |
| **Sprint 4** | Inventario como libro mayor (`inventario_movimientos` por deltas) y compras básicas. | Pendiente |
| **Sprint 5** | **Base móvil Flutter Offline-First:** SQLite local, cola `sync_queue` (Outbox) y vigencia offline. | Pendiente |
| **Sprint 6** | Ventas en efectivo, granel inverso y caja (SQLite + RPC atómica e idempotente). | Pendiente |
| **Sprint 7** | Fiados, abonos (`fiado_abonos`), salidas de caja y modo lectura garantizado al vencer plan. | Pendiente |
| **Sprint 8** | Administración de planes, suscripciones, Grace Period completo y panel SaaS aislado. | Pendiente |
| **Sprint 9** | Pruebas de seguridad, aislamiento entre tiendas, corte/recuperación de red y piloto real. | Pendiente |

## Forma de trabajo con Git y Migraciones

1. Comprueba siempre `git status` antes de preparar cambios y nunca incluyas secretos ni respaldos (`backups/`).
2. Desarrolla cada funcionalidad en una rama corta descriptiva (por ejemplo, `feat/tiendas-membresias`) e intégrala en `main` tras verificar criterios de aceptación.
3. Guarda todo cambio de esquema como archivo numerado en `migrations/` junto con su estrategia de reversión (`rollback`) y documéntalo antes de aplicarlo en Supabase.

## Licencia

Pendiente de definir por el propietario del proyecto.
