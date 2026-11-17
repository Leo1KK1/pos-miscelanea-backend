# Sprint 4 — Inventario como Libro Mayor, Compras Básicas, Mermas y Alertas de Stock

| Campo | Detalle |
| :--- | :--- |
| **Sprint** | Sprint 4 |
| **Objetivo** | Implementar el control de existencias como Libro Mayor inmutable (`inventario_movimientos`), soportar entradas iniciales, compras básicas a proveedores, mermas y ajustes con conversión consistente a `NUMERIC(12,3)`, emitir alertas de bajo stock y stock negativo sin bloquear la operación, y blindar `stock_actual` tanto en Express como en PostgreSQL. |
| **Estado** | Completado y verificado contra Supabase |
| **Rama de integración** | `main` (desde `feat/inventario-libro-mayor`) |
| **Archivos clave creados / modificados** | `migrations/004_inventario_libro_mayor.sql`, `migrations/004_rollback_inventario_libro_mayor.sql`, `src/config/permisos.js`, `src/utils/calculosInventario.js`, `src/routes/inventario.routes.js`, `src/routes/productos.routes.js`, `src/routes/tiendas.routes.js`, `src/server.js`, `docs/CONTRATO_INVENTARIO_LIBRO_MAYOR.md`, `scripts/verificar_sprint4.js`, `package.json` |

---

## 1. Contexto y Decisiones Técnicas Aplicadas

En la operación real de una tienda de abarrotes o cremería mexicana, la mercancía suele llegar en cajas, rejas o barras cerradas y con frecuencia se empieza a despachar en mostrador antes de capturar la nota de compra o mientras el dispositivo móvil sincroniza lotes pendientes tras recuperar conexión. El Sprint 4 resuelve este flujo respetando estrictamente las reglas arquitectónicas del proyecto:

- **Política de stock negativo permitido con alerta sin bloqueo operativo (Regla 1 y acuerdo de dominio):** Ni la venta rápida en mostrador ni la sincronización offline diferida (`sync_queue`) se detienen cuando las existencias teóricas bajan de cero. El motor permite saldos negativos y expone banderas explícitas (`alerta_bajo_stock` cuando `stock_actual <= stock_minimo` y `alerta_stock_negativo` cuando `stock_actual < 0` en artículos con `controla_inventario = true`) para que el propietario o encargado regularice compras o ajustes sin perder ventas.
- **UUIDs generados en cliente e idempotencia ante reintentos (Regla 2):** Cada registro en el kardex acepta un `id` UUID opcional generado localmente; si un reintento de red reenvía el mismo `id` para la misma dupla `(tienda_id, producto_id)`, el sistema responde `200 OK` (`idempotente: true`) devolviendo el movimiento original sin duplicar el impacto en existencias, y rechaza con `409` cualquier colisión con otro producto o tienda.
- **Inventario como Libro Mayor (*Ledger*) inmutable y `stock_actual` derivado por deltas (Regla 3):** `public.inventario_movimientos` es una bitácora *append-only* donde quedan prohibidos `UPDATE` y `DELETE`. Ningún endpoint ni cliente sobrescribe existencias directamente: `productos.stock_actual` se actualiza única y exclusivamente mediante un trigger en PostgreSQL que suma algebraicamente cada `cantidad_delta` insertado.
- **Conversión de bultos/barras a unidades consistentes `NUMERIC(12,3)` y costos en centavos enteros (Regla 4):** Las compras por presentación cerrada (ej. caja de `24` piezas o barra de jamón de `3.500 kg`) se normalizan usando aritmética entera `BigInt` en milésimas a la `unidad_venta` base del producto (`pieza`, `kg` o `litro`, exigiendo enteros exactos en `'pieza'`), mientras que `costo_total_centavos` se registra opcionalmente en centavos enteros (`INTEGER >= 0`, ej. `36000 centavos` equivalentes a `360.00 MXN`).
- **Defensa en profundidad: blindaje de columna `stock_actual` en PostgREST + RPC `SECURITY DEFINER` (Regla 5):** Se revocaron los privilegios generales `INSERT` y `UPDATE` sobre `public.productos` para el rol `authenticated`, otorgando permisos explícitos por columna que excluyen `stock_actual`. Toda alta manual en el kardex pasa por la función RPC `public.registrar_movimiento_inventario` (`SECURITY DEFINER`, `SET search_path = ''`).

---

## 2. Cambios en Base de Datos (PostgreSQL / Supabase)

Ejecutados en una sola transacción atómica dentro de [`migrations/004_inventario_libro_mayor.sql`](../migrations/004_inventario_libro_mayor.sql):

- **Columnas de inventario y llave compuesta en `public.productos`:**
  - `stock_actual numeric(12,3) NOT NULL DEFAULT 0.000`.
  - `stock_minimo numeric(12,3) NOT NULL DEFAULT 0.000` con restricción `productos_stock_minimo_check CHECK (stock_minimo >= 0)`.
  - Restricción única compuesta `productos_tienda_id_id_unico UNIQUE (tienda_id, id)` para garantizar integridad referencial intra-tienda desde tablas hijas.
  - Blindaje de privilegios por columna: `REVOKE INSERT, UPDATE ON TABLE public.productos FROM authenticated` seguido de `GRANT INSERT (...)` y `GRANT UPDATE (...)` únicamente sobre columnas editables de catálogo (incluyendo `stock_minimo`, pero dejando `stock_actual` de solo lectura frente a PostgREST).
- **Tabla Libro Mayor `public.inventario_movimientos`:**
  - Columnas: `id` (`uuid PK`), `tienda_id` (`uuid FK -> tiendas ON DELETE RESTRICT`), `producto_id` (`uuid`), `tipo_movimiento` (`entrada_inicial`, `compra`, `venta`, `devolucion_cancelacion`, `merma`, `ajuste`), `cantidad_delta` (`numeric(12,3) NOT NULL`), `costo_total_centavos` (`integer >= 0` opcional), `motivo` (`text`, entre `1` y `280` caracteres sin espacios vacíos), `referencia_externa_id` (`uuid` opcional para vincular ventas/cancelaciones futuras), `registrado_por` (`uuid FK -> auth.users ON DELETE SET NULL`), `ocurrido_en` (`timestamptz`) y `creado_en` (`timestamptz`).
  - Llave foránea compuesta `inventario_movimientos_producto_tienda_fkey FOREIGN KEY (tienda_id, producto_id) REFERENCES public.productos(tienda_id, id) ON DELETE RESTRICT`, que impide estructuralmente asociar en el kardex de una tienda un `producto_id` perteneciente a otra sucursal.
  - Restricción `inventario_movimientos_signo_delta_check`: exige `cantidad_delta > 0` en `entrada_inicial`, `compra` y `devolucion_cancelacion`; `cantidad_delta < 0` en `venta` y `merma`; y `cantidad_delta <> 0` en `ajuste`.
  - Índices `inventario_movimientos_tienda_producto_fecha_idx (tienda_id, producto_id, creado_en DESC)` e `inventario_movimientos_tienda_fecha_idx (tienda_id, creado_en DESC)`.
- **Triggers de inmutabilidad y actualización algebraica de existencias:**
  - `public.impedir_mutacion_inventario_movimientos()` asociada a `trg_inventario_movimientos_inmutable BEFORE UPDATE OR DELETE`: aborta cualquier intento de editar o eliminar filas históricas (`ERRCODE = '42501'`) exigiendo registrar un movimiento compensatorio de `ajuste`.
  - `public.aplicar_delta_inventario_producto()` (`SECURITY DEFINER`, `SET search_path = ''`) asociada a `trg_inventario_movimientos_aplicar_delta AFTER INSERT`: ejecuta `UPDATE public.productos SET stock_actual = stock_actual + NEW.cantidad_delta WHERE id = NEW.producto_id AND tienda_id = NEW.tienda_id`.
- **RPC transaccional `public.registrar_movimiento_inventario` y políticas RLS:**
  - Valida autenticación (`auth.uid()`) y membresía activa como `propietario` o `encargado` mediante `public.rol_activo_en_tienda(p_tienda_id)`, acota los movimientos manuales a `entrada_inicial`, `compra`, `merma` y `ajuste`, resuelve idempotencia por `p_movimiento_id`, bloquea la fila del producto con `FOR UPDATE`, comprueba `controla_inventario = true` e inserta el movimiento devolviendo tanto el registro creado como el estado resultante (`stock_anterior`, `stock_actual`, `stock_minimo`, `alerta_bajo_stock`, `alerta_stock_negativo`).
  - En `public.inventario_movimientos` se revocan todos los permisos de escritura directa (`REVOKE ALL ...; GRANT SELECT ... TO authenticated;`) y se activa RLS con la política `inventario_movimientos_select_gestion` (lectura exclusiva para `propietario` y `encargado` activos de la tienda).
- **Estrategia de rollback ([`migrations/004_rollback_inventario_libro_mayor.sql`](../migrations/004_rollback_inventario_libro_mayor.sql)):**
  - Retira en orden seguro la RPC `registrar_movimiento_inventario`, los triggers `trg_inventario_movimientos_aplicar_delta` y `trg_inventario_movimientos_inmutable` junto con sus funciones, elimina `public.inventario_movimientos`, restaura `GRANT INSERT, UPDATE ON TABLE public.productos TO authenticated` y borra `productos_tienda_id_id_unico`, `productos_stock_minimo_check`, `stock_minimo` y `stock_actual` sin afectar los datos de Sprints 1 a 3.

---

## 3. Cambios en Backend (Node.js / Express)

- **Extensión de la matriz de permisos (`src/config/permisos.js`):**
  - Incorporación de permisos de dominio `inventario:*` en `MATRIZ_PERMISOS`, permitiendo la consulta operativa de existencias en tienda según rol y restringiendo el registro manual de movimientos (`entrada_inicial`, `compra`, `merma`, `ajuste`) y la auditoría del Libro Mayor exclusivamente a `propietario` y `encargado` (`403 Forbidden` para `cajero`).
- **Motor determinista de inventario con `BigInt` (`src/utils/calculosInventario.js`):**
  - Conversión exacta de cantidades y existencias a milésimas enteras (`NUMERIC(12,3)`) sin aritmética de punto flotante IEEE 754, validando enteros exactos cuando `unidad_venta = 'pieza'`.
  - Normalización de compras y entradas por presentación (conversión de bultos, cajas, paquetes o barras a unidades consistentes de venta), cálculo de deltas de ajuste a partir de conteo físico y evaluación uniforme de `alerta_bajo_stock` y `alerta_stock_negativo`.
- **Nuevas rutas de inventario (`src/routes/inventario.routes.js`, montadas en `src/server.js` y `src/routes/tiendas.routes.js`):**
  - Disponibles tanto con cabecera `X-Tienda-Id` en `/api/inventario/*` como en la subruta anidada `/api/tiendas/:tiendaId/inventario/*`.
  - `GET /api/inventario/existencias`: devuelve el estado de inventario paginado de la tienda activa con filtros operativos (búsqueda UTF-8 insensible a tildes, `controla_inventario`, solo productos con bajo stock o con stock negativo) y banderas de alerta calculadas por artículo.
  - `GET /api/inventario/movimientos`: consulta paginada y filtrable (por `producto_id`, `tipo_movimiento` y rango de fechas) de la bitácora inmutable `inventario_movimientos` para `propietario` y `encargado`.
  - `POST /api/inventario/movimientos`: registra de forma atómica e idempotente (`201 Created` o `200 OK` en reenvíos) movimientos de `entrada_inicial`, `compra` (con `costo_total_centavos` opcional y soporte de conversión por presentación), `merma` y `ajuste` con motivo obligatorio, delegando la escritura en `registrar_movimiento_inventario`.
- **Protección de `stock_actual` en catálogo (`src/routes/productos.routes.js`):**
  - Exposición de `stock_actual` y `stock_minimo` en las consultas de productos, soporte para configurar `stock_minimo` en `POST /api/productos` y `PATCH /api/productos/:productoId`, y bloqueo explícito `400 Bad Request` con código `STOCK_ACTUAL_SOLO_LECTURA` si el cliente intenta enviar `stock_actual` al crear o editar un producto.

---

## 4. Criterios de Aceptación y Verificación Ejecutada

El script [`scripts/verificar_sprint4.js`](../scripts/verificar_sprint4.js) (`npm run verify:sprint4`) valida el Sprint 4 en dos bloques reproducibles sin secretos embebidos:

- **Bloque A — Pruebas locales deterministas (corren siempre sin conexión ni credenciales):**
  1. Comprobación de los nuevos permisos `inventario:*` en `MATRIZ_PERMISOS` para `propietario`, `encargado` y `cajero`.
  2. Pruebas unitarias sobre `src/utils/calculosInventario.js` (`BigInt`): parseo y suma exacta en milésimas (`pieza`, `kg`, `litro`), conversión de compras por bulto/caja/barra a unidad base, cálculo de deltas de ajuste físico, rechazo de decimales en `'pieza'`, validación de signos según `tipo_movimiento` y cálculo de `alerta_bajo_stock` / `alerta_stock_negativo`.
  3. Controles HTTP locales sin token (`401`) sobre `/api/inventario/existencias` y `/api/inventario/movimientos`.
- **Bloque B — Integración real contra Supabase (con variables de entorno de sesión):**
  1. Verificación del rechazo `STOCK_ACTUAL_SOLO_LECTURA` (`400`) en `POST` y `PATCH /api/productos` y comprobación de que PostgREST impide modificar `stock_actual` directamente con el JWT del propietario.
  2. Flujo completo e idempotente del Libro Mayor vía `POST /api/inventario/movimientos`: registro de `entrada_inicial`, `compra` con `costo_total_centavos` (ej. `36000 centavos` / `360.00 MXN`), reenvío del mismo UUID verificando respuesta idempotente (`200 OK`, `idempotente: true`) sin duplicar stock, `merma` y `ajuste` negativo que deja `stock_actual < 0` sin bloquear la operación y encendiendo `alerta_stock_negativo: true` y `alerta_bajo_stock: true` en `GET /api/inventario/existencias`, restaurando finalmente el saldo mediante un ajuste compensatorio.
  3. Rechazo controlado al intentar mover inventario en productos con `controla_inventario = false` y verificación de aislamiento multi-tienda (imposibilidad de afectar productos de otra sucursal).
  4. Comprobación de inmutabilidad estricta y RLS en PostgREST: bloqueo de `INSERT`, `UPDATE` y `DELETE` directos sobre `inventario_movimientos`, y verificación multi-rol confirmando que un usuario `cajero` no puede registrar movimientos ni leer la bitácora del kardex (`403` en Express y `0` filas en PostgREST RLS).

- **Cómo reproducirlo en PowerShell (sin exponer secretos):**

  ```powershell
  # 1. Ejecutar Bloque A local determinista (aritmética BigInt de inventario, permisos y controles HTTP)
  npm run verify:sprint4

  # 2. Ejecutar Bloques A + B completos contra Supabase
  $env:TEST_USER_EMAIL="propietario@ejemplo.com"
  $env:TEST_USER_PASSWORD="<password-propietario>"
  $env:TEST_USER2_EMAIL="colaborador@ejemplo.com"
  $env:TEST_USER2_PASSWORD="<password-colaborador>"
  npm run verify:sprint4
  ```
