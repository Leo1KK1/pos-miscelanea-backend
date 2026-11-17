# Sprint 1 — Tiendas, Membresías Multi-Tienda y Migración UUID con RLS

| Campo | Detalle |
| :--- | :--- |
| **Sprint** | Sprint 1 |
| **Objetivo** | Desacoplar el catálogo del esquema mono-usuario (`propietario_id`), introducir entidades multi-tienda (`tiendas` y `miembros_tienda`) con identificadores `UUID`, migrar sin pérdida de datos los productos existentes a `Tienda-Demo` y blindar el aislamiento con políticas RLS sin recursión. |
| **Estado** | Completado (`0ff3f96`) |
| **Rama de integración** | `main` |
| **Archivos clave creados / modificados** | `migrations/001_tiendas_y_membresias.sql`, `migrations/001_rollback_tiendas_y_membresias.sql`, `src/server.js`, `src/config/supabase.js`, `src/middlewares/autenticacion.js`, `src/utils/validaciones.js`, `src/routes/auth.routes.js`, `src/routes/tiendas.routes.js`, `src/routes/productos.routes.js`, `scripts/verificar_sprint1.js`, `package.json` |

---

## 1. Contexto y Decisiones Técnicas Aplicadas

En una miscelánea real, un propietario puede administrar más de una sucursal y delegar la operación diaria en encargados o cajeros desde distintos teléfonos. El Sprint 1 materializó esta base multi-tenant alineada con las reglas arquitectónicas del proyecto:

- **Preparación para sincronización Offline-First (Regla 1):** Se incorporó la columna `actualizado_en` mantenida automáticamente por trigger en `tiendas`, `miembros_tienda` y `productos`, junto con el filtro incremental `?actualizado_desde=<ISO-8601>` para que la futura app Flutter descargue únicamente deltas de catálogo hacia SQLite local.
- **UUIDs generados en cliente e Idempotencia (Regla 2):** Todas las llaves primarias usan `uuid` (`DEFAULT gen_random_uuid()`), permitiendo enviar un `id` UUID generado por el cliente tanto al crear tiendas (`POST /api/tiendas`) como al dar de alta productos (`POST /api/productos`), devolviendo `200 OK` con `idempotente: true` ante reintentos de red sin duplicar registros.
- **Base para Libro Mayor y precios enteros en centavos (Reglas 3 y 4):** Se preservó `precio_centavos` como entero libre de errores de punto flotante y unidades `pieza`, `kg` y `litro` listas para productos de abarrotes y cremería.
- **Arquitectura híbrida Node.js + RLS/RPC sin recursión (Regla 5):** Se eliminaron las políticas mono-usuario ligadas a `propietario_id`, reemplazándolas por funciones auxiliares `SECURITY DEFINER` con `SET search_path = ''` evaluadas estrictamente sobre `auth.uid()`, evitando ciclos recursivos al consultar `miembros_tienda` y cerrando la inserción directa de tiendas para forzar el alta atómica vía RPC.

---

## 2. Cambios en Base de Datos (PostgreSQL / Supabase)

Implementados en una transacción atómica en [`migrations/001_tiendas_y_membresias.sql`](../migrations/001_tiendas_y_membresias.sql), con verificación defensiva inicial que aborta si no existe `private_backups.productos_pre_sprint1`:

- **Tablas nuevas y columnas:**
  - `public.tiendas`: `id` (`uuid PK`), `nombre` (`1..120` caracteres), `estado` (`activa` | `suspendida`), `creado_por` (`uuid FK -> auth.users`), `creado_en`, `actualizado_en`.
  - `public.miembros_tienda`: `id` (`uuid PK`), `tienda_id` (`uuid FK -> tiendas ON DELETE CASCADE`), `usuario_id` (`uuid FK -> auth.users ON DELETE CASCADE`), `rol` (`propietario` | `encargado` | `cajero`), `estado` (`activo` | `suspendido`), `creado_en`, `actualizado_en` y restricción `UNIQUE (tienda_id, usuario_id)`.
  - `public.productos` (migración de esquema y datos): adición de `tienda_id` (`NOT NULL FK -> tiendas ON DELETE RESTRICT`) y `actualizado_en`; migración automática de las filas existentes (`Jamón`, `Queso Oaxaca` y `Refresco de cola`) hacia `Tienda-Demo` creando la membresía activa de `propietario`; retiro limpio de la columna heredada `propietario_id`.
- **Índices y triggers:**
  - Función `public.actualizar_marca_tiempo()` aplicada mediante triggers `BEFORE UPDATE` (`trg_tiendas_actualizado_en`, `trg_miembros_tienda_actualizado_en`, `trg_productos_actualizado_en`).
  - Índice único parcial por tienda `productos_codigo_por_tienda ON public.productos (tienda_id, codigo_barras) WHERE (codigo_barras IS NOT NULL)` (permitiendo múltiples productos a granel sin código de barras en la misma tienda).
  - Índices compuestos `productos_tienda_nombre_idx`, `productos_tienda_actualizado_idx`, `miembros_tienda_usuario_estado_idx` y `miembros_tienda_tienda_estado_idx`.
- **Funciones `SECURITY DEFINER` y RPC transaccional (`SET search_path = ''`):**
  - `public.rol_activo_en_tienda(p_tienda_id uuid)` y `public.es_miembro_activo_tienda(p_tienda_id uuid)`: consultan el rol del `auth.uid()` verificando simultáneamente `miembros_tienda.estado = 'activo'` y `tiendas.estado = 'activa'`, sin aceptar identificadores de usuario arbitrarios por parámetro.
  - `public.crear_tienda_con_propietario(p_nombre text, p_tienda_id uuid)`: registra en una sola transacción la tienda y su membresía `propietario`, manejando idempotencia cuando el mismo propietario reintenta el mismo `p_tienda_id` y devolviendo error `23505` si el UUID pertenece a otro usuario.
- **Privilegios mínimos y políticas RLS:**
  - `REVOKE ALL` inicial para `PUBLIC`, `anon` y `authenticated` en las tres tablas, otorgando solo los permisos estrictamente necesarios (`SELECT, UPDATE` en `tiendas`; `SELECT` en `miembros_tienda`; `SELECT, INSERT, UPDATE` en `productos`).
  - Políticas activas: `tiendas_select_miembro_activo`, `tiendas_update_propietario`, `miembros_select_propios_o_gestion`, `productos_select_miembro_activo`, `productos_insert_roles_autorizados` y `productos_update_roles_autorizados`.
- **Estrategia de rollback ([`migrations/001_rollback_tiendas_y_membresias.sql`](../migrations/001_rollback_tiendas_y_membresias.sql)):**
  - Reagrega `propietario_id` a `public.productos`, restaura la relación de propiedad desde `private_backups.productos_pre_sprint1` y `miembros_tienda` (abortando si quedara algún huérfano), restablece el índice `productos_codigo_por_propietario` y las políticas originales, y elimina limpiamente las funciones y tablas del Sprint 1.

---

## 3. Cambios en Backend (Node.js / Express)

Se modularizó el servidor monolítico en capas claras bajo `src/`:

- **Configuración y utilerías (`src/config/supabase.js`, `src/utils/validaciones.js`):**
  - Cliente Supabase efímero por solicitud inyectando `Authorization: Bearer <token>` para ejecución nativa de RLS.
  - Validadores reutilizables `esUuidValido` (compatible con UUID v4/v7 RFC 9562) y `esFechaIsoValida` (para filtros de sincronización incremental).
- **Middlewares de sesión y contexto multi-tienda (`src/middlewares/autenticacion.js`):**
  - `verificarSesion`: autentica el JWT de Supabase Auth y adjunta `req.usuario` y `req.supabase`.
  - `verificarContextoTienda`: resuelve la tienda activa desde `:tiendaId` o cabecera `X-Tienda-Id` (rechazando con `400` si ambos se envían y difieren o si no es un UUID válido), verifica membresía y tienda activas (`403` si no pertenece o está suspendida) e inyecta `req.contextoTienda`.
- **Rutas HTTP modulares (`src/server.js`, `src/routes/*.routes.js`):**
  - `src/routes/auth.routes.js`: `POST /api/auth/login` y `GET /api/auth/me`.
  - `src/routes/tiendas.routes.js`:
    - `GET /api/tiendas`: lista las tiendas activas donde el usuario tiene membresía activa.
    - `POST /api/tiendas`: invoca la RPC `crear_tienda_con_propietario` devolviendo `201` en creación nueva o `200` en reintento idempotente.
    - `GET /api/tiendas/:tiendaId/contexto` y `GET /api/tiendas/:tiendaId/miembros`, además de montar la subruta anidada `/:tiendaId/productos`.
  - `src/routes/productos.routes.js`:
    - `GET /api/productos` (con `X-Tienda-Id` o vía `/api/tiendas/:tiendaId/productos`): catálogo aislado por tienda con soporte `?actualizado_desde=<ISO-8601>`.
    - `POST /api/productos`: alta restringida a `propietario` y `encargado`, validando centavos enteros seguros, unidad de venta (`pieza`, `kg`, `litro`), código opcional único por tienda e idempotencia por `id` UUID.

---

## 4. Criterios de Aceptación y Verificación Ejecutada

El script [`scripts/verificar_sprint1.js`](../scripts/verificar_sprint1.js) (`npm run verify:sprint1`) automatiza la validación de extremo a extremo sin almacenar credenciales en el código fuente:

- **Qué valida `scripts/verificar_sprint1.js`:**
  1. Salud del servidor (`GET /api/health` -> `200`), rechazo sin token en `/api/tiendas` y `/api/productos` (`401`) y respuesta `404` en rutas inexistentes.
  2. Inicio de sesión con cuenta principal, presencia de `Tienda-Demo` con rol `propietario` y exigencia obligatoria de `X-Tienda-Id` en `/api/productos` (`400` si se omite).
  3. Integridad de la migración `001`: presencia intacta de `Jamón`, `Queso Oaxaca` y `Refresco de cola` dentro de `Tienda-Demo`.
  4. Alta de una segunda tienda (`Tienda-Sucursal-Norte`) con UUID fijo determinista, comprobando respuesta idempotente (`200` con `idempotente: true`) al reenviar el mismo UUID y verificando cero traslape de productos al alternar `X-Tienda-Id`.
  5. Rechazo `403 Forbidden` al solicitar contexto de un UUID de tienda inexistente o ajena.
  6. Aislamiento cruzado multi-cuenta (cuando se provee un segundo usuario): verifica bloqueo `403` en Express y `0` filas visibles + rechazo de `INSERT` directo contra Supabase PostgREST (RLS).

- **Cómo reproducirlo en PowerShell (sin exponer secretos):**

  ```powershell
  # 1. Verificación rápida de controles HTTP locales sin credenciales
  npm run verify:sprint1

  # 2. Verificación completa contra Supabase (aislamiento multi-tienda + RLS directo)
  $env:TEST_USER_EMAIL="propietario@ejemplo.com"
  $env:TEST_USER_PASSWORD="<password-propietario>"
  $env:TEST_USER2_EMAIL="segundo_usuario@ejemplo.com"
  $env:TEST_USER2_PASSWORD="<password-segundo-usuario>"
  npm run verify:sprint1
  ```
