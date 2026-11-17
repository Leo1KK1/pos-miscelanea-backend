# Punto de venta SaaS para misceláneas

Aplicación en desarrollo para apoyar la operación cotidiana de pequeñas tiendas de abarrotes, misceláneas y cremerías en México. El proyecto prioriza cobrar rápido en mostrador (por pieza, por peso o por importe en pesos), llevar control de fiados e inventario por libro mayor, aislar estrictamente los datos de cada tienda y operar **sin conexión a internet (*Offline-First*)**.

> **Estado actual:** Sprints 0, 1, 2 y 3 completados y verificados en desarrollo; listo para iniciar **Sprint 4 (Inventario como libro mayor `inventario_movimientos` y compras básicas)**. Consulta el detalle arquitectónico y el tablero en [docs/ARQUITECTURA_Y_TABLERO.md](docs/ARQUITECTURA_Y_TABLERO.md).

## Objetivo

Construir un sistema punto de venta móvil sencillo e intuitivo que permita a una tienda cobrar ventas en efectivo en pocos toques, controlar inventario y fiados sin sobrescrituras entre dispositivos, y seguir operando cuando falle el internet o los datos móviles dentro del local. Una misma cuenta puede pertenecer a varias tiendas con un rol específico por negocio (`propietario`, `encargado` o `cajero`).

## Estado real del repositorio

- **API modular en Express 5 (`src/`):** Conectada con Supabase Auth y PostgreSQL mediante `@supabase/supabase-js` usando el token JWT de cada petición (sin compartir sesión entre solicitudes).
- **Rutas disponibles (Sprints 1 y 2):**
  - `GET /api/health` — comprobación de salud del servidor.
  - `POST /api/auth/registro` — alta de usuario en Supabase Auth.
  - `POST /api/auth/login` — inicio de sesión con correo y contraseña.
  - `POST /api/auth/refresh` — renovación segura de sesión (`refresh_token` rotado).
  - `POST /api/auth/logout` — cierre explícito de sesión actual.
  - `GET /api/auth/me` — identidad del usuario autenticado.
  - `GET /api/auth/clave-publica-offline` — clave pública **Ed25519** para verificar constancias de licencia sin conexión en la app móvil.
  - `GET /api/tiendas` — tiendas activas donde el usuario posee membresía activa (`propietario`, `encargado` o `cajero`).
  - `POST /api/tiendas` — alta atómica e idempotente de nueva tienda junto con membresía de `propietario`.
  - `PATCH /api/tiendas/:tiendaId` — edición del nombre comercial (`propietario`).
  - `GET /api/tiendas/:tiendaId/contexto` — valida pertenencia activa, expone permisos del rol y emite la **constancia criptográfica offline Ed25519** (Grace Period).
  - `GET /api/tiendas/:tiendaId/miembros` — lista miembros con correo (`propietario` y `encargado`).
  - `POST /api/tiendas/:tiendaId/miembros` — vincula un miembro por correo respetando jerarquía (`propietario` o `encargado` para `cajero`).
  - `PATCH /api/tiendas/:tiendaId/miembros/:miembroId` — cambia rol (`propietario`) o suspende/reactiva membresías sin permitir dejar una tienda sin propietario activo.
  - `GET /api/productos` y `POST /api/productos` (con `X-Tienda-Id: <uuid>` o bajo `/api/tiendas/:tiendaId/productos`) — catálogo aislado por tienda con búsqueda sin tildes (`?q=`), botonera rápida (`?acceso_rapido=true`), control opcional de inventario y paginación gradual (`limite`/`offset`).
  - `GET /api/productos/por-codigo/:codigo` — búsqueda exacta instantánea por código de barras dentro de la tienda activa.
  - `GET /api/productos/:productoId` y `PATCH /api/productos/:productoId` — consulta individual, baja lógica (`activo`), configuración de acceso rápido y cambio de precio protegido por rol (`propietario` y `encargado`).
  - `GET /api/productos/:productoId/historial-precios` — consulta del historial inmutable de cambios de precio (`propietario` y `encargado`).
  - `POST /api/productos/:productoId/cotizar` — cotización exacta por peso/cantidad (`cantidad`) o por dinero (*"deme \$15 de jamón"*, `importe_centavos`) sin errores de punto flotante.
- **Documentación técnica y por Sprint:**
  - [docs/MATRIZ_PERMISOS_Y_SESION.md](docs/MATRIZ_PERMISOS_Y_SESION.md) y [docs/CONTRATO_CATALOGO_Y_GRANEL.md](docs/CONTRATO_CATALOGO_Y_GRANEL.md).
  - Bitácora detallada por sprint en [`implementation/`](implementation/): Sprints `00`, `01`, `02` y `03`.
- **Migraciones versionadas (`migrations/`):**
  - `000_diagnostico_y_respaldo_sprint0.sql` — respaldo previo en `private_backups.productos_pre_sprint1`.
  - `001_tiendas_y_membresias.sql` (+ `001_rollback_...`) — `tiendas`, `miembros_tienda`, migración a `Tienda-Demo` y RLS base.
  - `002_identidad_permisos_y_membresias.sql` (+ `002_rollback_...`) — RPCs de gestión jerárquica de miembros, blindaje de columnas de licencia en `tiendas` y soporte de Grace Period offline.
  - `003_catalogo_precios_y_granel.sql` (+ `003_rollback_...`) — normalización UTF-8 `plegar_acentos`, acceso rápido, `controla_inventario` y auditoría inmutable `producto_precios_historial` por trigger.

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
   - `OFFLINE_LICENSE_PRIVATE_KEY_B64` y `OFFLINE_LICENSE_PUBLIC_KEY_B64`: par de claves asimétricas **Ed25519** (DER en Base64) usadas por el servidor para firmar constancias de vigencia offline sin exponer claves privadas en la app móvil.

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
| **Sprint 1** | Crear `tiendas` y `miembros_tienda`, migrar `productos` a `tienda_id` con UUID y aplicar RLS. | Completado |
| **Sprint 2** | Identidad, sesiones, matriz de permisos por rol y base de constancia firmada offline. | Completado |
| **Sprint 3** | Catálogo por tienda (con y sin código, botones rápidos) y reglas bidireccionales de granel. | Completado |
| **Sprint 4** | Inventario como libro mayor (`inventario_movimientos` por deltas) y compras básicas. | **Siguiente** |
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
