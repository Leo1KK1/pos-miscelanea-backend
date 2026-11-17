# Sprint 3 — Catálogo por Tienda, Botones de Acceso Rápido, Historial de Precios y Reglas de Granel

| Campo | Detalle |
| :--- | :--- |
| **Sprint** | Sprint 3 |
| **Objetivo** | Extender el catálogo multi-tienda para soportar búsqueda UTF-8 insensible a tildes y mayúsculas, botonera de acceso rápido para productos sin código de barras, control opcional de inventario, auditoría inmutable de cambios de precio por trigger y motor de cálculo bidireccional de venta a granel (peso <-> importe). |
| **Estado** | Completado y verificado contra Supabase |
| **Rama de integración** | `main` (desde `feat/catalogo-precios-granel`) |
| **Archivos clave creados / modificados** | `migrations/003_catalogo_precios_y_granel.sql`, `migrations/003_rollback_catalogo_precios_y_granel.sql`, `src/utils/calculosGranel.js`, `src/utils/texto.js`, `src/routes/productos.routes.js`, `docs/CONTRATO_CATALOGO_Y_GRANEL.md`, `scripts/verificar_sprint3.js`, `package.json` |

---

## 1. Contexto y Decisiones Técnicas Aplicadas

En el mostrador de una miscelánea o cremería mexicana conviven productos empaquetados con código EAN/UPC (refrescos, abarrotes) con productos de alta rotación sin código de barras (pan dulce, tortillas, huevo, jamón y quesos). El Sprint 3 adapta el catálogo y el motor de precios a esta realidad operativa respetando las 6 reglas arquitectónicas:

- **Catálogo preparado para SQLite Offline-First (Regla 1):** Los flags `es_acceso_rapido`, `orden_acceso_rapido`, `controla_inventario`, `activo` y la marca `actualizado_en` permiten que la app móvil sincronice incrementalmente (`?actualizado_desde=<ISO-8601>`) tanto el catálogo general como la botonera rápida de cobro en dos toques, ocultando en mostrador los artículos desactivados lógicamente (`activo = false`) sin romper la integridad referencial de ventas pasadas.
- **UUIDs e Idempotencia en altas de catálogo (Regla 2):** Tanto productos con código de barras como productos a granel sin código (`codigo_barras = null`) aceptan `id` UUID generado en el cliente con respuesta idempotente (`200 OK`) ante reenvíos, manteniendo unicidad de código por tienda únicamente cuando `codigo_barras IS NOT NULL`.
- **Auditoría inmutable estilo Libro Mayor y flag de inventario (Regla 3):** Se incorporó `controla_inventario` (`boolean DEFAULT true`) para distinguir mercancía inventariable en el futuro kardex (`inventario_movimientos`, Sprint 4) de artículos de rotación libre (ej. recargas o pan del día), y se modeló `producto_precios_historial` como bitácora *append-only* alimentada exclusivamente por trigger en base de datos.
- **Motor de venta a granel bidireccional en centavos enteros (Regla 4):** Se definieron las reglas deterministas de conversión entre cantidad (`NUMERIC(12,3)` equivalente a gramos o mililitros enteros) e importe en centavos (`INTEGER`):
  - **Peso -> Importe:** `0.250 kg` a `16000 centavos/kg` (`160.00 MXN/kg`) produce `4000 centavos` (`40.00 MXN`).
  - **Importe -> Peso (pedir por dinero):** *"deme 15.00 MXN (`1500 centavos`) de jamón a `160.00 MXN/kg` (`16000 centavos/kg`)"* calcula `0.094 kg` (`94 g`) conservando intacto `subtotal_cobrado_centavos = 1500` y admitiendo la tolerancia de redondeo comercial de báscula (`<= 1 centavo` o equivalente a `0.001 kg`) sin bloquear la venta.
- **Arquitectura híbrida Node.js + RLS y triggers `SECURITY DEFINER` (Regla 5):** Ningún cliente ni usuario autenticado posee permisos `INSERT`, `UPDATE` o `DELETE` sobre `producto_precios_historial`; solo PostgreSQL inserta el rastro exacto (`auth.uid()`, `precio_anterior_centavos`, `precio_nuevo_centavos`) al insertar un producto o cambiar `precio_centavos`, y solo `propietario` y `encargado` pueden consultarlo vía RLS.

---

## 2. Cambios en Base de Datos (PostgreSQL / Supabase)

Implementados en una transacción atómica dentro de [`migrations/003_catalogo_precios_y_granel.sql`](../migrations/003_catalogo_precios_y_granel.sql):

- **Normalización UTF-8 insensible a acentos:**
  - Función `public.plegar_acentos(p_texto text)` declarada `IMMUTABLE STRICT PARALLEL SAFE` con `SET search_path = ''`, que recorta espacios, convierte a minúsculas y pliega vocales acentuadas o con diéresis (`áéíóúü` -> `aeiouu`), permitiendo que buscar `"jamon"` o `"JAMON"` localice instantáneamente `"Jamón"`.
- **Extensión de `public.productos`:**
  - `controla_inventario boolean NOT NULL DEFAULT true`.
  - `es_acceso_rapido boolean NOT NULL DEFAULT false`.
  - `orden_acceso_rapido integer NOT NULL DEFAULT 100` con restricción `CHECK (orden_acceso_rapido >= 1 AND orden_acceso_rapido <= 9999)`.
  - `nombre_busqueda text GENERATED ALWAYS AS (public.plegar_acentos(nombre)) STORED`.
  - Migración automática de datos existentes: marca `es_acceso_rapido = true` en los productos sin código de barras ya registrados (como `Jamón` y `Queso Oaxaca` en `Tienda-Demo`).
- **Índices optimizados por tienda:**
  - `productos_tienda_busqueda_idx ON public.productos (tienda_id, nombre_busqueda)` para filtrado rápido por nombre normalizado sin *full scan* entre tiendas.
  - Índice parcial `productos_tienda_acceso_rapido_idx ON public.productos (tienda_id, orden_acceso_rapido, nombre) WHERE (activo = true AND es_acceso_rapido = true)` para servir al instante la botonera principal de mostrador.
- **Tabla de auditoría inmutable `public.producto_precios_historial` y trigger:**
  - Columnas: `id` (`uuid PK`), `tienda_id` (`uuid FK -> tiendas ON DELETE CASCADE`), `producto_id` (`uuid FK -> productos ON DELETE CASCADE`), `precio_anterior_centavos` (`integer >= 0` o `NULL` en alta inicial), `precio_nuevo_centavos` (`integer NOT NULL >= 0`), `cambiado_por` (`uuid FK -> auth.users ON DELETE SET NULL`) y `cambiado_en` (`timestamptz NOT NULL DEFAULT now()`).
  - Índice `producto_precios_historial_producto_fecha_idx (tienda_id, producto_id, cambiado_en DESC)`.
  - Sembrado inicial idempotente (`WHERE NOT EXISTS`) para que los productos migrados en Sprints previos cuenten con su registro base en el historial.
  - Función `public.registrar_cambio_precio_producto()` (`SECURITY DEFINER`, `SET search_path = ''`) invocada por el trigger `trg_productos_registrar_precio AFTER INSERT OR UPDATE OF precio_centavos ON public.productos` únicamente cuando `OLD.precio_centavos IS DISTINCT FROM NEW.precio_centavos`.
- **Privilegios y políticas RLS:**
  - `REVOKE ALL ON TABLE public.producto_precios_historial FROM PUBLIC, anon, authenticated;` y `GRANT SELECT ON TABLE public.producto_precios_historial TO authenticated;` (inmutabilidad garantizada frente a PostgREST).
  - Política `precios_historial_select_gestion`: permite `SELECT` exclusivamente cuando `public.rol_activo_en_tienda(tienda_id)` es `propietario` o `encargado` (oculto para `cajero` y para cuentas externas).
- **Estrategia de rollback ([`migrations/003_rollback_catalogo_precios_y_granel.sql`](../migrations/003_rollback_catalogo_precios_y_granel.sql)):**
  - Elimina en transacción `trg_productos_registrar_precio`, `registrar_cambio_precio_producto()`, la tabla `producto_precios_historial`, los dos índices nuevos, las cuatro columnas agregadas en `public.productos` y la función `plegar_acentos(text)`, conservando intactas todas las filas de productos, tiendas y membresías de los Sprints 1 y 2.

---

## 3. Cambios en Backend (Node.js / Express)

- **Gestión ampliada de catálogo y búsqueda UTF-8 (`src/routes/productos.routes.js`):**
  - Soporte completo para crear (`POST /api/productos`), listar (`GET /api/productos`) y actualizar parcialmente (`PATCH /api/productos/:productoId`) los atributos de catálogo de Sprint 3: `controla_inventario`, `es_acceso_rapido`, `orden_acceso_rapido` (`1..9999`) y baja/reactivación lógica mediante `activo` (`boolean`), manteniendo compatibilidad con la ruta anidada `/api/tiendas/:tiendaId/productos`.
  - Filtros de consulta combinables por tienda activa: búsqueda UTF-8 insensible a tildes y mayúsculas sobre nombre (vía `nombre_busqueda` plegado) o coincidencia por `codigo_barras`, filtro de botonera rápida (`solo_acceso_rapido` ordenado por `orden_acceso_rapido ASC, nombre ASC`), filtro de activos (`solo_activos=true`) y delta incremental (`actualizado_desde=<ISO-8601>`).
  - Consulta del historial de precios de un producto restringida a roles de gestión (`propietario` y `encargado`), respaldada tanto por la matriz de permisos de Express (`src/config/permisos.js`) como por la política RLS `precios_historial_select_gestion`.
- **Motor y validaciones de granel bidireccional:**
  - Cálculo exacto con aritmética entera (milésimas de unidad `kg`/`litro` y centavos enteros MXN) evitando errores de punto flotante IEEE 754 (`0.1 + 0.2`):
    - Conversión directa **cantidad -> subtotal en centavos** (aplicable a `pieza`, `kg` y `litro`, exigiendo enteros exactos cuando `unidad_venta = 'pieza'`).
    - Conversión inversa **importe solicitado en centavos -> cantidad en `kg`/`litro` con 3 decimales** (`NUMERIC(12,3)`), devolviendo `cantidad`, `precio_unitario_historico_centavos` y `subtotal_cobrado_centavos` listos para persistirse en ventas offline y validarse en el servidor.

---

## 4. Criterios de Aceptación y Verificación Ejecutada

La verificación automatizada del Sprint 3 (`scripts/verificar_sprint3.js` / `npm run verify:sprint3`) sigue el patrón de dos bloques sin credenciales embebidas:

- **Bloque A — Pruebas locales deterministas (sin conexión ni secretos):**
  1. Normalización y plegado UTF-8 en español (búsquedas con y sin tildes, diéresis, eñes y mayúsculas/minúsculas).
  2. Motor matemático bidireccional de granel:
     - `Peso -> Importe`: ej. `0.250 kg` a `16000 centavos` (`160.00 MXN`) = `4000 centavos` (`40.00 MXN`).
     - `Importe -> Peso`: ej. pedir `1500 centavos` (`15.00 MXN`) de producto a `16000 centavos/kg` = `0.094 kg` conservando `subtotal_cobrado_centavos = 1500` dentro de la tolerancia de redondeo comercial.
     - Rechazo de cantidades fraccionarias cuando `unidad_venta = 'pieza'`, precios negativos o importes inválidos.
  3. Validaciones HTTP locales (`400` / `401`) sobre parámetros de búsqueda, orden de acceso rápido fuera de rango y rutas protegidas sin token.
- **Bloque B — Integración contra Supabase (con variables de entorno de sesión):**
  1. Búsqueda insensible a tildes en `Tienda-Demo` (ej. buscar `"jamon"` o `"oaxaca"` y recuperar `Jamón` / `Queso Oaxaca`) y consulta ordenada de botones rápidos (`es_acceso_rapido = true`).
  2. Alta idempotente de productos sin código de barras (pan/tortillas/cremería), edición de `orden_acceso_rapido` / `controla_inventario` y desactivación lógica (`activo: false`) verificando su exclusión al filtrar `solo_activos=true`.
  3. Verificación automática del trigger `trg_productos_registrar_precio`: al modificar y restaurar `precio_centavos`, `producto_precios_historial` registra las entradas exactas con `precio_anterior_centavos`, `precio_nuevo_centavos` y `cambiado_por`.
  4. Blindaje de seguridad sobre `producto_precios_historial`: comprobación de que ningún usuario puede insertar ni alterar filas manualmente vía PostgREST y que un usuario con rol `cajero` recibe `403` en Express y `0` filas en PostgREST RLS al intentar leer el historial de precios.

- **Cómo reproducirlo en PowerShell (sin exponer secretos):**

  ```powershell
  # 1. Ejecutar Bloque A local determinista (cálculos de granel, UTF-8 y validaciones HTTP)
  npm run verify:sprint3

  # 2. Ejecutar Bloques A + B completos contra Supabase
  $env:TEST_USER_EMAIL="propietario@ejemplo.com"
  $env:TEST_USER_PASSWORD="<password-propietario>"
  $env:TEST_USER2_EMAIL="colaborador@ejemplo.com"
  $env:TEST_USER2_PASSWORD="<password-colaborador>"
  npm run verify:sprint3
  ```
