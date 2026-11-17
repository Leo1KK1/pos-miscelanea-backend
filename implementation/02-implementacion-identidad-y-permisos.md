# Sprint 2 — Identidad, Matriz de Permisos por Rol y Constancia Offline Ed25519

| Campo | Detalle |
| :--- | :--- |
| **Sprint** | Sprint 2 |
| **Objetivo** | Completar el ciclo de vida de sesión (`registro`, `login`, `refresh`, `logout`), implementar control de acceso jerárquico (`propietario`, `encargado`, `cajero`) con doble validación en Express y PostgreSQL, y emitir/verificar constancias criptográficas **Ed25519** para operación sin conexión (*Grace Period*). |
| **Estado** | Completado (`6569b27`) |
| **Rama de integración** | `main` |
| **Archivos clave creados / modificados** | `migrations/002_identidad_permisos_y_membresias.sql`, `migrations/002_rollback_identidad_permisos_y_membresias.sql`, `src/config/permisos.js`, `src/services/licenciaOffline.service.js`, `src/middlewares/autenticacion.js`, `src/routes/auth.routes.js`, `src/routes/tiendas.routes.js`, `src/routes/productos.routes.js`, `scripts/verificar_sprint2.js`, `docs/MATRIZ_PERMISOS_Y_SESION.md`, `.env.example`, `package.json` |

---

## 1. Contexto y Decisiones Técnicas Aplicadas

En la operación cotidiana de una tienda de abarrotes, el propietario necesita delegar el cobro en mostrador a cajeros o encargados sin arriesgar cambios no autorizados de precios, auto-escalamiento de privilegios ni pérdida de acceso a sus cuentas por cobrar cuando falla el internet:

- **Separación estricta `401` vs `403` para Offline-First (Regla 1):** Se estandarizaron los códigos de error para que la futura app Flutter distinga entre sesión expirada (`401`, que dispara rotación silenciosa con `refresh_token` sin borrar jamás SQLite ni `sync_queue`) y restricción de permisos en la tienda (`403`, donde la identidad es válida pero el rol o estado de membresía impide la operación).
- **Idempotencia en gestión de equipo (Regla 2):** Vincular repetidamente al mismo colaborador activo con el mismo rol mediante `POST /api/tiendas/:tiendaId/miembros` devuelve `200 OK` (`idempotente: true`) sin duplicar filas ni arrojar errores espurios ante reintentos de red.
- **Protección de precios en centavos por rol (Regla 4):** La edición de productos y el ajuste de `precio_centavos` quedaron restringidos exclusivamente a `propietario` y `encargado`, bloqueando a `cajero` tanto en Express como en PostgreSQL.
- **Defensa en profundidad Node.js + RLS/RPC y privilegios de columna (Regla 5):** Se prohibió la escritura directa en `miembros_tienda` desde PostgREST (canalizando altas y cambios por RPCs `SECURITY DEFINER`) y se restringió `UPDATE` en `tiendas` únicamente a la columna `nombre` para impedir que cualquier cliente autenticado altere su propia fecha de expiración de licencia.
- **Constancia criptográfica asimétrica Ed25519 y Modo Lectura garantizado (Regla 6):** Se eligió firma asimétrica **Ed25519** sobre HMAC simétrico para que la clave privada nunca salga del servidor; la app móvil solo almacena la clave pública para validar localmente la ventana offline de **96 horas**, detectar atrasos manuales en el reloj del dispositivo y mantener **siempre abierta la consulta de fiados e inventario** (`permite_consulta_fiados_inventario: true`) aunque venza la suscripción.

---

## 2. Cambios en Base de Datos (PostgreSQL / Supabase)

Definidos transaccionalmente en [`migrations/002_identidad_permisos_y_membresias.sql`](../migrations/002_identidad_permisos_y_membresias.sql):

- **Nuevas columnas y restricciones:**
  - En `public.tiendas`:
    - `estado_suscripcion` (`text NOT NULL DEFAULT 'prueba'`, valores permitidos: `prueba`, `activa`, `vencida`, `cancelada`, `suspendida`).
    - `licencia_expira_en` (`timestamptz NOT NULL DEFAULT (now() + interval '30 days')`).
    - `ventana_offline_horas` (`integer NOT NULL DEFAULT 96`, acotada entre `1` y `720` horas).
  - En `public.miembros_tienda`:
    - `agregado_por` (`uuid REFERENCES auth.users(id) ON DELETE SET NULL`), poblando retroactivamente las membresías iniciales de propietario.
- **Blindaje antifraude de columnas en `public.tiendas`:**
  - `REVOKE UPDATE ON TABLE public.tiendas FROM authenticated;` seguido de `GRANT UPDATE (nombre) ON TABLE public.tiendas TO authenticated;`. Así, ni siquiera el propietario puede modificar `estado_suscripcion`, `licencia_expira_en`, `ventana_offline_horas` ni `estado` invocando PostgREST directamente con su JWT.
- **Funciones RPC `SECURITY DEFINER` (`SET search_path = ''`):**
  - `public.crear_tienda_con_propietario(p_nombre, p_tienda_id)` (actualizada): expone en su respuesta los metadatos de licencia base y registra `agregado_por`.
  - `public.listar_miembros_tienda(p_tienda_id)`: cruza `miembros_tienda` con `auth.users` para devolver el correo de cada integrante únicamente si el solicitante es `propietario` o `encargado` activo.
  - `public.agregar_miembro_tienda(p_tienda_id, p_email, p_rol)`: vincula cuentas existentes por correo de manera atómica e idempotente; impide acceso a `cajero` y asegura que un `encargado` solo pueda dar de alta miembros con rol `cajero`.
  - `public.actualizar_miembro_tienda(p_tienda_id, p_miembro_id, p_nuevo_rol, p_nuevo_estado)`: bloquea la fila objetivo con `FOR UPDATE`, prohíbe auto-edición o auto-suspensión (`usuario_id = auth.uid()`), exige ser `propietario` para cambiar roles, limita a `encargado` a suspender/reactivar únicamente a `cajero` y garantiza la **invariante de seguridad** de conservar siempre al menos `1` propietario activo en la tienda.
- **Estrategia de rollback ([`migrations/002_rollback_identidad_permisos_y_membresias.sql`](../migrations/002_rollback_identidad_permisos_y_membresias.sql)):**
  - Elimina las tres RPCs de gestión de miembros, restaura `GRANT UPDATE ON TABLE public.tiendas TO authenticated`, retira `agregado_por` y las columnas de licencia en `tiendas`, y restablece la versión de Sprint 1 de `crear_tienda_con_propietario` preservando todas las tiendas, membresías y productos existentes.

---

## 3. Cambios en Backend (Node.js / Express)

- **Matriz centralizada de permisos (`src/config/permisos.js`):**
  - Define de forma inmutable (`Object.freeze`) los roles `propietario`, `encargado` y `cajero`, los 10 permisos base (`tienda:leer`, `tienda:editar`, `miembros:leer`, `miembros:agregar`, `miembros:cambiar_rol`, `miembros:cambiar_estado`, `productos:leer`, `productos:crear`, `productos:editar`, `productos:cambiar_precio`) y los ayudantes `tienePermiso` y `obtenerPermisosDeRol`.
- **Servicio criptográfico de vigencia offline (`src/services/licenciaOffline.service.js`):**
  - Carga el par de claves **Ed25519** desde `OFFLINE_LICENSE_PRIVATE_KEY_B64` / `OFFLINE_LICENSE_PUBLIC_KEY_B64` (DER en Base64) o genera un par efímero seguro en memoria para desarrollo local.
  - `obtenerClavePublicaOffline()`: expone la clave pública en formato `spki-der-base64`.
  - `emitirConstanciaOffline()`: genera y firma el token compacto `<payload_base64url>.<firma_ed25519_base64url>` acotando `ventana_offline_hasta` al mínimo entre `ahora + ventana_offline_horas` y `licencia_expira_en`.
  - `verificarConstanciaOffline()`: verifica la firma Ed25519, detecta manipulación de reloj (`RELOJ_ATRASADO` frente a `emitido_en` o frente al último evento local en SQLite `ultimaFechaEventoLocal`) y evalúa expiración de ventana o licencia manteniendo siempre `permite_consulta_fiados_inventario: true`.
- **Extensión de middleware y rutas HTTP:**
  - `src/middlewares/autenticacion.js`: `verificarContextoTienda` acepta `{ permisoRequerido, rolesPermitidos }` e inyecta `permisos` y metadatos de suscripción en `req.contextoTienda`.
  - `src/routes/auth.routes.js`: se añadieron `POST /api/auth/registro` (validación de correo, contraseña `>= 8` caracteres y detección `409` de cuenta duplicada), `POST /api/auth/refresh`, `POST /api/auth/logout` y `GET /api/auth/clave-publica-offline`.
  - `src/routes/tiendas.routes.js`: se añadieron `PATCH /api/tiendas/:tiendaId` (edición de nombre comercial para `propietario`), emisión de `constancia_offline` en `GET /api/tiendas/:tiendaId/contexto`, `POST /api/tiendas/:tiendaId/miembros` y `PATCH /api/tiendas/:tiendaId/miembros/:miembroId`.
  - `src/routes/productos.routes.js`: se añadió `PATCH /api/productos/:productoId` (también accesible en `/api/tiendas/:tiendaId/productos/:productoId`) validando específicamente `productos:cambiar_precio` cuando el cuerpo incluye `precio_centavos` y `productos:editar` para el resto de atributos.

---

## 4. Criterios de Aceptación y Verificación Ejecutada

El script [`scripts/verificar_sprint2.js`](../scripts/verificar_sprint2.js) (`npm run verify:sprint2`) se divide en dos bloques complementarios:

- **Bloque A — Pruebas locales deterministas (corren siempre sin requerir credenciales):**
  1. Verificación exhaustiva de `MATRIZ_PERMISOS` para `propietario`, `encargado`, `cajero` y entradas inválidas.
  2. Pruebas unitarias criptográficas de `licenciaOffline.service.js`: constancia vigente (`OK`), rechazo de payload o firma adulterada (`FIRMA_O_FORMATO_INVALIDO`), detección de reloj atrasado respecto a `emitido_en` y respecto a `ultimaFechaEventoLocal` (`RELOJ_ATRASADO`), y bloqueo de nuevas ventas conservando modo lectura ante ventana de 96 h superada o suscripción vencida (`VENTANA_OFFLINE_O_LICENCIA_VENCIDA`).
  3. Controles HTTP sin sesión: entrega de clave pública Ed25519 (`200`), validaciones en `/api/auth/refresh` (`400` / `401`) y rechazo `401` en todas las rutas protegidas.
- **Bloque B — Integración real contra Supabase (con variables de entorno de sesión):**
  1. Inicio de sesión del propietario, rotación real con `POST /api/auth/refresh` y verificación criptográfica del token `constancia_offline` emitido por `/api/tiendas/:tiendaId/contexto`.
  2. Subida y restauración de `precio_centavos` (ej. incremento temporal de `100 centavos` / `1.00 MXN`) y comprobación de que PostgREST rechaza cualquier intento directo del propietario por alterar `estado_suscripcion` o `licencia_expira_en`.
  3. Rechazo `403` ante intentos de auto-degradación o auto-suspensión del propio propietario.
  4. Ciclo completo multi-rol con una segunda cuenta (`sin acceso` -> `cajero` -> `encargado` -> `suspendido`), comprobando que un `cajero` lee catálogo (`200`) pero recibe `403` (y bloqueo RLS directo) al intentar crear productos, cambiar precios o leer miembros; que un `encargado` consulta miembros (`200`) pero no puede alterar al propietario (`403`); y que al pasar a `suspendido` pierde acceso de inmediato tanto en Express (`403`) como en PostgREST RLS (`0` filas), cerrando finalmente con `POST /api/auth/logout`.

- **Cómo reproducirlo en PowerShell (sin exponer secretos):**

  ```powershell
  # 1. Ejecutar Bloque A local determinista (sin conexión ni credenciales)
  npm run verify:sprint2

  # 2. Ejecutar Bloques A + B completos contra Supabase
  $env:TEST_USER_EMAIL="propietario@ejemplo.com"
  $env:TEST_USER_PASSWORD="<password-propietario>"
  $env:TEST_USER2_EMAIL="colaborador@ejemplo.com"
  $env:TEST_USER2_PASSWORD="<password-colaborador>"
  npm run verify:sprint2
  ```
