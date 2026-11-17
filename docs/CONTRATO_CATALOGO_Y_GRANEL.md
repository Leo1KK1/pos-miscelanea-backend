# Contrato de Catálogo Multi-Tienda, Precios y Venta a Granel (Sprint 3)

Este documento especifica el contrato técnico y operativo del **Sprint 3** para el sistema POS de misceláneas, tiendas de abarrotes y cremerías en México (**Node.js + Express 5 + Supabase PostgreSQL + Flutter Offline-First**):

- Modelo de datos extendido de `public.productos` e historial inmutable `public.producto_precios_historial`.
- Representación exacta de dinero en **centavos enteros** (`INTEGER`) y cantidades en **`NUMERIC(12,3)` / milésimas enteras (`BigInt`)**.
- Motor de cotización a granel bidireccional (**Peso/Volumen → Importe** e **Importe → Peso/Volumen** con redondeo comercial *half-up*) e invariantes para `venta_detalles`.
- Búsqueda UTF-8 insensible a acentos (`plegar_acentos`), botonera de acceso rápido en mostrador y paginación gradual para catálogos de **1,500+ artículos**.
- Ejemplos completos JSON y comandos reproducibles en **PowerShell (`Invoke-RestMethod`)**.

---

## 1. Modelo de Datos en PostgreSQL (`migrations/001` y `003`)

### 1.1 Tabla `public.productos`

Cada producto pertenece exclusivamente a una tienda (`tienda_id`) y utiliza `UUID` compatible con generación previa en el cliente móvil (Offline-First).

| Columna | Tipo SQL | Nulo | Default | Restricciones / Propósito |
| :--- | :--- | :---: | :--- | :--- |
| `id` | `uuid` | `NO` | `gen_random_uuid()` | Llave primaria. Acepta UUID v4/v7 generado offline para alta idempotente. |
| `tienda_id` | `uuid` | `NO` | — | `REFERENCES public.tiendas(id) ON DELETE RESTRICT`. Aísla el catálogo por sucursal. |
| `nombre` | `text` | `NO` | — | Nombre comercial visible en mostrador y ticket (`1..120` caracteres, UTF-8 íntegro con tildes y `ñ`). |
| `nombre_busqueda` | `text` | `NO` | `GENERATED ALWAYS AS (public.plegar_acentos(nombre)) STORED` | Columna calculada y almacenada automáticamente en minúsculas y sin tildes/diéresis para búsquedas instantáneas. |
| `codigo_barras` | `text` | `SÍ` | `NULL` | EAN/UPC o código interno opcional (`<= 80` caracteres). `NULL` para cremería, pan, tortillas o granel sin código. |
| `unidad_venta` | `text` | `NO` | — | `'pieza'`, `'kg'` o `'litro'`. |
| `precio_centavos` | `integer` | `NO` | — | Precio por unidad base (`1 pieza`, `1.000 kg` o `1.000 litro`) en centavos enteros (`>= 0`). |
| `controla_inventario` | `boolean` | `NO` | `true` | `true` si descuenta existencias en el kardex (Sprint 4); `false` para artículos de paso diario sin conteo estricto (ej. pan dulce o tortillas del día). |
| `es_acceso_rapido` | `boolean` | `NO` | `false` | `true` para mostrar el artículo como botón grande de toque directo en la pantalla principal de cobro. |
| `orden_acceso_rapido` | `integer` | `NO` | `100` | `CHECK (orden_acceso_rapido BETWEEN 1 AND 9999)`. Define el orden visual en la botonera rápida. |
| `activo` | `boolean` | `NO` | `true` | Baja lógica. Un producto con `activo = false` se oculta del cobro activo sin romper ventas ni kardex históricos. |
| `creado_en` | `timestamptz` | `NO` | `now()` | Fecha de alta inicial. |
| `actualizado_en` | `timestamptz` | `NO` | `now()` | Actualizado automáticamente por trigger `trg_productos_actualizado_en` en cada `UPDATE` (cursor de sync incremental). |

#### Índices clave en `public.productos`

1. **`productos_codigo_por_tienda` (único parcial):**
   ```sql
   CREATE UNIQUE INDEX productos_codigo_por_tienda
       ON public.productos (tienda_id, codigo_barras)
       WHERE (codigo_barras IS NOT NULL);
   ```
   - **Dentro de la misma tienda:** impide duplicar un código de barras (`409 Conflict`).
   - **Entre tiendas distintas:** dos tiendas diferentes (por ejemplo `Tienda-Demo` y `Tienda-Sucursal-Norte`) **sí pueden registrar el mismo código EAN-13** (`7500000000001`) con precios, estados e inventarios independientes.
   - **Productos sin código (`codigo_barras IS NULL`):** permite tantos artículos a granel o de mostrador como la tienda necesite.
2. **`productos_tienda_busqueda_idx`:** `(tienda_id, nombre_busqueda)` acelera búsquedas por texto normalizado sin sensibilidad a tildes.
3. **`productos_tienda_acceso_rapido_idx` (parcial):** `(tienda_id, orden_acceso_rapido, nombre) WHERE (activo = true AND es_acceso_rapido = true)` resuelve de inmediato la botonera de mostrador.
4. **`productos_tienda_actualizado_idx`:** `(tienda_id, actualizado_en)` soporta la descarga incremental `?actualizado_desde=` para SQLite en Flutter.

---

### 1.2 Tabla de Auditoría Inmutable `public.producto_precios_historial`

Registra automáticamente el precio inicial y cada modificación posterior de `precio_centavos` para auditar quién y cuándo ajustó precios sin alterar ventas pasadas.

| Columna | Tipo SQL | Nulo | Default | Descripción |
| :--- | :--- | :---: | :--- | :--- |
| `id` | `uuid` | `NO` | `gen_random_uuid()` | Identificador único del evento de cambio de precio. |
| `tienda_id` | `uuid` | `NO` | — | Tienda a la que pertenece el producto (`ON DELETE CASCADE`). |
| `producto_id` | `uuid` | `NO` | — | Producto auditado (`ON DELETE CASCADE`). |
| `precio_anterior_centavos` | `integer` | `SÍ` | `NULL` | `NULL` en el alta inicial del producto; entero `>= 0` en cualquier actualización posterior. |
| `precio_nuevo_centavos` | `integer` | `NO` | — | Nuevo precio vigente en centavos enteros (`>= 0`). |
| `cambiado_por` | `uuid` | `SÍ` | — | `auth.uid()` del usuario autenticado que ejecutó el alta o cambio (`ON DELETE SET NULL`). |
| `cambiado_en` | `timestamptz` | `NO` | `now()` | Marca de tiempo exacta del servidor. |

#### Blindaje de seguridad e inmutabilidad en PostgreSQL

- **Escritura exclusiva por trigger `SECURITY DEFINER`:** El trigger `trg_productos_registrar_precio` (`AFTER INSERT OR UPDATE OF precio_centavos ON public.productos`) ejecuta `public.registrar_cambio_precio_producto()` con `SET search_path = ''`. Solo registra una nueva fila en `UPDATE` cuando `OLD.precio_centavos IS DISTINCT FROM NEW.precio_centavos`.
- **Cero privilegios de mutación desde clientes/PostgREST:**
  ```sql
  REVOKE ALL ON TABLE public.producto_precios_historial FROM PUBLIC, anon, authenticated;
  GRANT SELECT ON TABLE public.producto_precios_historial TO authenticated;
  ```
  Ni siquiera el `propietario` autenticándose directamente contra la API PostgREST de Supabase puede insertar entradas falsas, editar precios históricos ni borrar renglones de auditoría.
- **Visibilidad restringida por rol (RLS + Express):** La política `precios_historial_select_gestion` y el endpoint `GET /api/productos/:productoId/historial-precios` permiten la consulta únicamente a `propietario` y `encargado` (`403 Forbidden` para `cajero`).

---

## 2. Precios en Centavos, Cantidades en Milésimas y Redondeo *Half-Up*

### 2.1 Por qué cero punto flotante (`float` / `double`)

En JavaScript y otros lenguajes con IEEE-754 binario, operaciones cotidianas como `0.250 * 160` o `0.1 + 0.2` producen residuos binarios (`0.30000000000000004`) que descuadran cortes de caja acumulados. Por ello el sistema aplica dos invariantes estrictas:

1. **Dinero siempre en centavos enteros (`INTEGER`):**
   - `\$160.00 MXN` → `16000`
   - `\$40.00 MXN` → `4000`
   - `\$15.00 MXN` → `1500`
2. **Cantidades en `NUMERIC(12,3)` y milésimas enteras (`BigInt` en `src/utils/calculosGranel.js`):**
   - Toda cantidad válida se convierte mediante análisis léxico de cadenas (`parsearCantidadAMilesimas`) a **milésimas enteras** (`1` unidad = `1000` milésimas; `unidad_base_milesimas` reporta `'gramos'`, `'mililitros'` o `'milesimas_pieza'`):
     - `1.000 kg` = `1000` milésimas (`1` milésima = `1` gramo).
     - `0.250 kg` = `250` milésimas (`250` gramos).
     - `1.500 litro` = `1500` milésimas (`1500` mililitros).
     - `1 pieza` = `1000` milésimas (para `unidad_venta = 'pieza'` se exige número entero positivo sin fracción decimal; `0.5` se rechaza con `CANTIDAD_PIEZA_NO_ENTERA` y más de 3 decimales como `'0.1234'` se rechaza con `CANTIDAD_INVALIDA`).

### 2.2 Fórmula exacta de redondeo comercial *Half-Up*

Tanto el flujo directo como el inverso redondean la mitad exacta (`.5`) hacia arriba usando únicamente división entera sobre `BigInt` no negativos:

$$\text{redondearHalfUp}(N, D) = \left\lfloor \frac{2N + D}{2D} \right\rfloor$$

#### Flujo directo (`modo: 'por_cantidad'` — Peso / Volumen / Piezas → Importe)

Dado `cantidad_milesimas` ($M$) y `precio_unitario_centavos` ($P$):

$$\text{subtotal\_cobrado\_centavos} = \text{redondearHalfUp}(M \times P,\ 1000)$$

- **Ejemplo (`250 g` de jamón a `\$160.00/kg`):**
  - $M = 250$, $P = 16000$.
  - $250 \times 16000 / 1000 = 4000$ centavos (`\$40.00`).
  - `cantidad: "0.250"`, `subtotal_cobrado_centavos: 4000`, `subtotal_teorico_por_peso_centavos: 4000`, `diferencia_redondeo_centavos: 0`.

#### Flujo inverso (`modo: 'por_importe'` — *"Deme \$15 de jamón"* → Peso / Volumen)

En mostrador de miscelánea y cremería es indispensable despachar por monto en pesos (`importe_centavos` = $I$) para unidades `'kg'` y `'litro'` (no aplica a `'pieza'`, que responde `FLUJO_INVERSO_NO_APLICA_A_PIEZA`):

1. **Cantidad a despachar en báscula (redondeada al gramo/mililitro más cercano *half-up*):**
   $$M = \text{redondearHalfUp}(I \times 1000,\ P)$$
   *(Si $P = 0$ lanza `PRECIO_UNITARIO_CERO`; si el importe es tan pequeño que $M = 0$, lanza `IMPORTE_INSUFICIENTE_PARA_UNIDAD_MINIMA`).*
2. **Importe cobrado al cliente:** se respeta exactamente el monto solicitado:
   $$\text{subtotal\_cobrado\_centavos} = I$$
3. **Importe teórico por peso y diferencia de redondeo informativa:**
   $$\text{subtotal\_teorico\_por\_peso\_centavos} = \text{redondearHalfUp}(M \times P,\ 1000)$$
   $$\text{diferencia\_redondeo\_centavos} = \text{subtotal\_cobrado\_centavos} - \text{subtotal\_teorico\_por\_peso\_centavos}$$

- **Ejemplo real (*"deme \$15 de jamón"* a `\$160.00/kg`):**
  - $I = 1500$ centavos, $P = 16000$ centavos/kg.
  - Peso exacto: $1500 \times 1000 / 16000 = 93.75\text{ g}$ → redondeo *half-up* → **$M = 94$ gramos** (`cantidad = "0.094"` kg).
  - `subtotal_cobrado_centavos = 1500` (`\$15.00` exactos recibidos en caja).
  - `subtotal_teorico_por_peso_centavos = 1504` ($0.094 \times 16000 = \$15.04$).
  - `diferencia_redondeo_centavos = -4` centavos ($1500 - 1504$).

### 2.3 Por qué `venta_detalles` guarda los 3 campos históricos inmutables sin bloquear ventas

De acuerdo con la **Regla Arquitectónica 4**, cuando en el **Sprint 6** se persistan las partidas de cada ticket en `public.venta_detalles` (y en SQLite local en Flutter), cada renglón almacenará de forma explícita e inmutable estos **tres valores**:

1. **`cantidad` (`NUMERIC(12,3)`):** ej. `0.094` kg — es la cantidad física exacta que salió de la vitrina y que se descontará como delta `-0.094` en el libro mayor `inventario_movimientos`.
2. **`precio_unitario_historico_centavos` (`INTEGER`):** ej. `16000` — congela el precio por kilo/litro/pieza vigente en el instante de la venta; si mañana el jamón sube a `17500`, los tickets pasados permanecen intactos.
3. **`subtotal_cobrado_centavos` (`INTEGER`):** ej. `1500` — registra el dinero real cobrado en `caja_movimientos` o anotado en `fiados`.

> **Por qué no se impone `cantidad * precio_unitario == subtotal` como bloqueo rígido:** En el ejemplo real de *"deme \$15 de jamón"* a `\$160/kg`, no existe ningún número entero de gramos cuyo producto por `16000` dé exactamente `1500` centavos (`0.093 kg` da `1488` y `0.094 kg` da `1504`). Del mismo modo, una báscula digital en mostrador puede marcar `0.251 kg` y el tendero cobrar los `\$40.00` cerrados. Guardar los tres campos desacopla el **cuadre físico en gramos** (`cantidad`) del **cuadre financiero en centavos** (`subtotal_cobrado_centavos`) sin rechazar ventas legítimas por diferencias de redondeo de pocos centavos.

### 2.4 Códigos de error deterministas del motor de granel

| Código (`codigo`) | HTTP en `/cotizar` | Condición que lo dispara |
| :--- | :---: | :--- |
| `CANTIDAD_INVALIDA` | `400` | Cantidad vacía, `<= 0`, no numérica, con más de 3 decimales (`'0.1234'`) o fuera de rango `NUMERIC(12,3)`. |
| `CANTIDAD_PIEZA_NO_ENTERA` | `400` | Producto con `unidad_venta = 'pieza'` cotizado con decimales fraccionarios (ej. `0.5` o `'1.250'`). |
| `FLUJO_INVERSO_NO_APLICA_A_PIEZA` | `400` | Intento de cotizar `por_importe` sobre un producto cuya unidad es `'pieza'`. |
| `PRECIO_UNITARIO_CERO` | `400` / `409` | Intento de calcular cantidad `por_importe` cuando el producto tiene `precio_centavos = 0`. |
| `IMPORTE_INSUFICIENTE_PARA_UNIDAD_MINIMA` | `400` | El `importe_centavos` equivale a menos de `0.5` milésimas (`0.000` kg/litro tras redondear). |
| `PRODUCTO_INACTIVO` | `409` | Intento de cotizar vía `POST /:productoId/cotizar` un artículo con `activo = false`. |

---

## 3. Contrato HTTP de Rutas de Catálogo y Ejemplos JSON

Todas las rutas requieren `Authorization: Bearer <access_token>` y contexto de tienda activa mediante la cabecera **`X-Tienda-Id: <uuid>`** en `/api/productos/*` (o mediante ruta anidada `/api/tiendas/:tiendaId/productos/*`).

### 3.1 Resumen de Endpoints

| Método y Ruta | Permiso / Roles | Propósito | Respuestas |
| :--- | :--- | :--- | :--- |
| `GET /api/productos` | `productos:leer` (`propietario`, `encargado`, `cajero`) | Listar/buscar catálogo con filtros (`q`, `codigo_barras`, `unidad_venta`, `acceso_rapido`, `controla_inventario`, `solo_activos`, `actualizado_desde`) y paginación (`limite`, `offset`). | `200 { tienda, paginacion, productos }` |
| `GET /api/productos/por-codigo/:codigo` | `productos:leer` (`propietario`, `encargado`, `cajero`) | Búsqueda exacta e instantánea para lector láser o cámara de código de barras en la tienda activa. | `200 { producto }`, `404` si no existe |
| `GET /api/productos/:productoId` | `productos:leer` (`propietario`, `encargado`, `cajero`) | Obtener el detalle completo de un producto por su UUID. | `200 { producto }`, `404` si no pertenece a la tienda |
| `POST /api/productos` | `productos:crear` (`propietario`, `encargado`) | Registrar producto nuevo (con `id` UUID opcional idempotente). | `201` creado, `200` idempotente, `400` validación, `403` cajero, `409` código duplicado en la tienda |
| `PATCH /api/productos/:productoId` | `productos:editar` (+ `productos:cambiar_precio` si incluye `precio_centavos`) | Edición parcial: nombre, código, unidad, precio, acceso rápido, control de inventario o desactivación (`activo: false`). | `200 { mensaje, producto }`, `403`, `404`, `409` |
| `GET /api/productos/:productoId/historial-precios` | `propietario`, `encargado` (`403` para `cajero`) | Consultar la bitácora inmutable de altas y cambios de precio del producto (orden descendente por fecha). | `200 { producto, historial }`, `403`, `404` |
| `POST /api/productos/:productoId/cotizar` | `productos:leer` (`propietario`, `encargado`, `cajero`) | Cotizar un producto activo enviando **exclusivamente** `{ cantidad }` (flujo directo) o `{ importe_centavos }` (flujo inverso). | `200 { producto, cotizacion }`, `400` validación, `404` no existe, `409` producto inactivo |

---

### 3.2 Ejemplo JSON Completo: Producto por `pieza` con Código de Barras

```json
{
  "id": "a7f4c2e0-1b23-4d56-9e78-0123456789ab",
  "tienda_id": "0f8fad5b-d9cb-469f-a165-70867728950e",
  "nombre": "Refresco de cola",
  "codigo_barras": "7500000000001",
  "unidad_venta": "pieza",
  "precio_centavos": 1800,
  "controla_inventario": true,
  "es_acceso_rapido": false,
  "orden_acceso_rapido": 100,
  "activo": true,
  "creado_en": "2026-11-10T15:20:00.000Z",
  "actualizado_en": "2026-11-17T18:00:00.000Z"
}
```

### 3.3 Ejemplo JSON Completo: Producto a Granel (`kg` / `litro`) sin Código y con Botón Rápido

En cremería, chiles secos, semillas o líquidos sueltos (ej. limpiadores o leche bronca por `'litro'`), `codigo_barras` es `null` y `es_acceso_rapido` es `true` para cobrar desde la rejilla rápida del mostrador:

```json
{
  "id": "44444444-5555-4666-8777-888888888888",
  "tienda_id": "11111111-2222-4333-8444-555555555555",
  "nombre": "Chiles Jalapeños en Escabeche",
  "codigo_barras": null,
  "unidad_venta": "kg",
  "precio_centavos": 9500,
  "controla_inventario": false,
  "es_acceso_rapido": true,
  "orden_acceso_rapido": 10,
  "activo": true,
  "creado_en": "2026-11-17T21:30:00.000Z",
  "actualizado_en": "2026-11-17T21:30:00.000Z"
}
```

### 3.4 Ejemplo JSON de Cotización Inversa (`POST /api/productos/:productoId/cotizar`)

Petición (`"deme $15 de jamón"`):

```json
{
  "importe_centavos": 1500
}
```

Respuesta `200 OK`:

```json
{
  "producto": {
    "id": "8c9e6679-7425-40de-944b-e07fc1f90ae7",
    "tienda_id": "0f8fad5b-d9cb-469f-a165-70867728950e",
    "nombre": "Jamón",
    "codigo_barras": null,
    "unidad_venta": "kg",
    "precio_centavos": 16000,
    "activo": true
  },
  "cotizacion": {
    "modo": "por_importe",
    "unidad_venta": "kg",
    "cantidad": "0.094",
    "cantidad_numerica": 0.094,
    "cantidad_milesimas": 94,
    "unidad_base_milesimas": "gramos",
    "precio_unitario_historico_centavos": 16000,
    "subtotal_cobrado_centavos": 1500,
    "subtotal_teorico_por_peso_centavos": 1504,
    "diferencia_redondeo_centavos": -4
  }
}
```

---

## 4. Búsqueda Insensible a Acentos y Paginación para 1,500+ Artículos

### 4.1 Plegado de acentos en español (`plegar_acentos` / `plegarAcentos`)

En mostrador rápido el cajero escribe sin tildes (`jamon`, `azucar`, `iberico`). La normalización aplica exactamente la misma regla en PostgreSQL (`public.plegar_acentos`) y en Node.js (`src/utils/texto.js`):

1. Recorta espacios extremos y convierte a minúsculas.
2. Sustituye vocales con tilde, acento grave, circunflejo, virgulilla o diéresis (`áàäâãéèëêíìïîóòöôõúùüû`) por su vocal base (`aeiou`).
3. **Conserva intacta la letra `ñ`** (`"Piña"` → `"piña"`, `"Jalapeños"` → `"jalapeños"`), respetando la ortografía del español sin colisionar palabras distintas.

Cuando el cliente consulta `GET /api/productos?q=jamon`:
- El backend normaliza y sanea el término con `plegarAcentos` + `sanitizarTerminoBusquedaPostgrest` (evitando inyección de operadores en filtros PostgREST).
- Busca coincidencias parciales sobre la columna generada `nombre_busqueda` (p. ej. `"Jamón"` tiene `nombre_busqueda = "jamon"`) y sobre `codigo_barras`, devolviendo `"Jamón"` al instante aun cuando el usuario no escribió la tilde.

### 4.2 Paginación gradual (`limite` / `offset`) y descarga hacia SQLite

Una tienda de abarrotes surtida maneja fácilmente **1,500 a 4,000 SKUs**. Para evitar respuestas pesadas en redes móviles lentas:

- `GET /api/productos` devuelve siempre metadatos de paginación:
  ```json
  {
    "tienda": { "id": "...", "nombre": "Tienda-Demo", "rol": "propietario" },
    "paginacion": {
      "limite": 200,
      "offset": 0,
      "devueltos": 200
    },
    "productos": [ ... ]
  }
  ```
- **Carga inicial por bloques (Bootstrap en Sprint 5):** La app Flutter solicita páginas consecutivas (`?limite=250&offset=0`, `?limite=250&offset=250`, ...) e inserta cada lote en SQLite dentro de una transacción local hasta que `paginacion.devueltos < paginacion.limite`.
- **Sincronización incremental posterior:** Una vez poblada la base local, la app guarda el mayor `actualizado_en` recibido y solo pide deltas con `?actualizado_desde=2026-11-17T21:00:00.000Z&limite=250&offset=0` (sin `solo_activos=true`, para recibir también las bajas lógicas `activo: false` y reflejarlas en SQLite).
- **Botonera de acceso rápido:** Cuando se solicita `?acceso_rapido=true&solo_activos=true`, el catálogo se entrega ordenado por `orden_acceso_rapido ASC, nombre ASC` aprovechando el índice parcial `productos_tienda_acceso_rapido_idx`.

---

## 5. Ejemplos Reproducibles en PowerShell (`Invoke-RestMethod`)

Con el servidor corriendo localmente (`npm run dev` en `http://localhost:3000`):

### 5.1 Iniciar sesión y preparar cabeceras de `Tienda-Demo`

```powershell
$baseUrl = "http://localhost:3000"

$sesion = Invoke-RestMethod -Method Post `
    -Uri "$baseUrl/api/auth/login" `
    -ContentType "application/json; charset=utf-8" `
    -Body (@{
        email    = "propietario@ejemplo.com"
        password = "TuPasswordSeguro123!"
    } | ConvertTo-Json)

$headersAuth = @{ Authorization = "Bearer $($sesion.access_token)" }

$misTiendas = Invoke-RestMethod -Method Get -Uri "$baseUrl/api/tiendas" -Headers $headersAuth
$tiendaId   = ($misTiendas.tiendas | Where-Object { $_.nombre -eq "Tienda-Demo" } | Select-Object -First 1).id

$headersTienda = @{
    Authorization = "Bearer $($sesion.access_token)"
    "X-Tienda-Id" = $tiendaId
}
```

### 5.2 Registrar un producto a granel sin código con botón de acceso rápido y UTF-8

```powershell
$nuevoGranelBody = @{
    id                  = "44444444-5555-4666-8777-888888888888"
    nombre              = "Chiles Jalapeños en Escabeche"
    codigo_barras       = $null
    unidad_venta        = "kg"
    precio_centavos     = 9500
    controla_inventario = $false
    es_acceso_rapido    = $true
    orden_acceso_rapido = 10
} | ConvertTo-Json

$creado = Invoke-RestMethod -Method Post `
    -Uri "$baseUrl/api/productos" `
    -Headers $headersTienda `
    -ContentType "application/json; charset=utf-8" `
    -Body $nuevoGranelBody

$creado.producto
```

### 5.3 Escaneo por código, búsqueda sin acentos, botonera rápida y paginación

```powershell
# 1. Escaneo directo por código de barras
$escaneo = Invoke-RestMethod -Method Get `
    -Uri "$baseUrl/api/productos/por-codigo/7500000000001" `
    -Headers $headersTienda
$escaneo.producto

# 2. Búsqueda insensible a tildes ("jamon" encuentra "Jamón")
$busqueda = Invoke-RestMethod -Method Get `
    -Uri "$baseUrl/api/productos?q=jamon&solo_activos=true" `
    -Headers $headersTienda
$busqueda.productos

# 3. Botonera de acceso rápido ordenada para mostrador
$rapidos = Invoke-RestMethod -Method Get `
    -Uri "$baseUrl/api/productos?acceso_rapido=true&solo_activos=true" `
    -Headers $headersTienda
$rapidos.productos | Select-Object nombre, unidad_venta, precio_centavos, orden_acceso_rapido

# 4. Paginación gradual por bloques (catálogos de 1,500+ productos)
$pagina1 = Invoke-RestMethod -Method Get `
    -Uri "$baseUrl/api/productos?limite=100&offset=0" `
    -Headers $headersTienda
$pagina1.paginacion
```

### 5.4 Cotizar venta a granel por peso (`0.250 kg`) y por importe (*"deme \$15"*)

```powershell
$jamon = ($busqueda.productos | Where-Object { $_.nombre -eq "Jamón" } | Select-Object -First 1)

# Flujo directo: 250 gramos -> 4000 centavos ($40.00 MXN)
$cotDirecta = Invoke-RestMethod -Method Post `
    -Uri "$baseUrl/api/productos/$($jamon.id)/cotizar" `
    -Headers $headersTienda `
    -ContentType "application/json" `
    -Body (@{ cantidad = "0.250" } | ConvertTo-Json)
$cotDirecta.cotizacion

# Flujo inverso: $15.00 MXN (1500 centavos) -> "0.094" kg (94 gramos)
$cotInversa = Invoke-RestMethod -Method Post `
    -Uri "$baseUrl/api/productos/$($jamon.id)/cotizar" `
    -Headers $headersTienda `
    -ContentType "application/json" `
    -Body (@{ importe_centavos = 1500 } | ConvertTo-Json)
$cotInversa.cotizacion
```

### 5.5 Actualizar precio, consultar historial inmutable y desactivar producto

```powershell
# Cambiar precio de 9500 ($95.00/kg) a 9800 ($98.00/kg)
Invoke-RestMethod -Method Patch `
    -Uri "$baseUrl/api/productos/44444444-5555-4666-8777-888888888888" `
    -Headers $headersTienda `
    -ContentType "application/json" `
    -Body (@{ precio_centavos = 9800 } | ConvertTo-Json)

# Consultar bitácora inmutable de cambios de precio (solo propietario o encargado)
$historial = Invoke-RestMethod -Method Get `
    -Uri "$baseUrl/api/productos/44444444-5555-4666-8777-888888888888/historial-precios" `
    -Headers $headersTienda
$historial.historial

# Baja lógica (oculta en ?solo_activos=true y bloquea /cotizar con 409)
Invoke-RestMethod -Method Patch `
    -Uri "$baseUrl/api/productos/44444444-5555-4666-8777-888888888888" `
    -Headers $headersTienda `
    -ContentType "application/json" `
    -Body (@{ activo = $false } | ConvertTo-Json)
```

### 5.6 Ejecutar la suite automatizada del Sprint 3

```powershell
# Bloque A (pruebas deterministas locales de acentos, granel y seguridad HTTP sin credenciales):
node scripts/verificar_sprint3.js

# Bloque A + Bloque B completo contra Supabase:
$env:TEST_USER_EMAIL="propietario@ejemplo.com"
$env:TEST_USER_PASSWORD="TuPasswordSeguro123!"
node scripts/verificar_sprint3.js
```
