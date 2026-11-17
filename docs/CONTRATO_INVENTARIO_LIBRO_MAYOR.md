# Contrato de Inventario como Libro Mayor, Entradas por Presentación y Alertas de Stock (Sprint 4)

Este documento especifica el contrato técnico y operativo del **Sprint 4** para el sistema POS de misceláneas, tiendas de abarrotes y cremerías en México (**Node.js + Express 5 + Supabase PostgreSQL + Flutter Offline-First**):

- Operación de `public.inventario_movimientos` como **Libro Mayor (*Ledger*) inmutable (*append-only*)** e idempotente por `UUID`.
- Mantenimiento exclusivo de `productos.stock_actual` mediante **trigger en PostgreSQL** sumando deltas algebraicos, evitando sobrescrituras (*lost updates*) cuando múltiples dispositivos venden sin conexión y sincronizan horas después.
- Política comercial acordada de **existencias negativas permitidas con alerta** (`alerta_stock_negativo` y `alerta_bajo_stock`) sin bloquear ventas ni sincronizaciones diferidas, así como el comportamiento de `controla_inventario = false`.
- Conversión exacta en milésimas (`BigInt`) de entradas por **bulto, paquete, caja o barra** (con `costo_total_centavos` opcional de referencia) y salidas por gramos, mililitros o piezas.
- Contrato completo de endpoints HTTP y ejemplos reproducibles en **PowerShell (`Invoke-RestMethod`)**.

---

## 1. Arquitectura de Libro Mayor (*Ledger*) y Sincronización Multi-Dispositivo

### 1.1 Por qué `stock_actual` jamás se sobrescribe con un valor absoluto

En una miscelánea real con operación **Offline-First** (Reglas Arquitectónicas 1, 2 y 3), es habitual que dos dispositivos trabajen sobre la misma tienda con conectividad intermitente:

1. A las `09:00`, el producto **Jamón** tiene `stock_actual = 2.000 kg`.
2. A las `10:00` (sin internet en el local), la tableta del mostrador despacha `1.250 kg` en varias ventas locales en SQLite.
3. A las `10:30` (con datos móviles en el mercado), el teléfono del propietario registra la compra de **2 barras de `3.500 kg`** (`+7.000 kg`).
4. A las `14:00`, la tableta del mostrador recupera conexión y vacía su cola `sync_queue`.

Si el sistema sincronizara estados absolutos del tipo `UPDATE productos SET stock_actual = 0.750`, la tableta sobrescribiría la compra registrada por el propietario y desaparecerían `7.000 kg` del inventario (*lost update*).

Con el diseño de **Libro Mayor (*append-only*)**:

- Ningún cliente ni endpoint actualiza `stock_actual` directamente.
- Cada hecho físico genera un evento inmutable identificado por `UUID` con su **delta algebraico (`cantidad_delta`)**:
  - Compra del propietario: `+7.000`
  - Ventas del mostrador: `-1.250`
  - Merma por recorte de orilla: `-0.150`
- El trigger `trg_inventario_movimientos_aplicar_delta` aplica en PostgreSQL:
  ```sql
  UPDATE public.productos
  SET stock_actual = stock_actual + NEW.cantidad_delta
  WHERE id = NEW.producto_id
    AND tienda_id = NEW.tienda_id;
  ```
- Como la suma algebraica es **conmutativa** y cada movimiento es **idempotente por `id` (`UUID`)**, los dispositivos pueden sincronizar en cualquier orden horas después y convergen exactamente al mismo saldo real (`2.000 + 7.000 - 1.250 - 0.150 = 7.600 kg`), sin duplicar movimientos si la red reintenta el mismo paquete.

---

## 2. Modelo de Datos y Blindaje en PostgreSQL (`migrations/004`)

### 2.1 Columnas añadidas a `public.productos`

| Columna | Tipo SQL | Nulo | Default | Restricciones / Propósito |
| :--- | :--- | :---: | :--- | :--- |
| `stock_actual` | `numeric(12,3)` | `NO` | `0.000` | Saldo vigente calculado **exclusivamente** por el trigger del Libro Mayor. Soporta valores positivos, cero y negativos. |
| `stock_minimo` | `numeric(12,3)` | `NO` | `0.000` | `CHECK (stock_minimo >= 0)`. Umbral configurable de punto de reorden por producto en la unidad de venta (`pieza`, `kg` o `litro`). |

Adicionalmente se agrega la restricción compuesta `productos_tienda_id_id_unico UNIQUE (tienda_id, id)` para garantizar a nivel relacional que ningún movimiento en `inventario_movimientos` pueda referenciar un `producto_id` perteneciente a otra tienda.

### 2.2 Tabla Inmutable `public.inventario_movimientos`

| Columna | Tipo SQL | Nulo | Default | Descripción |
| :--- | :--- | :---: | :--- | :--- |
| `id` | `uuid` | `NO` | `gen_random_uuid()` | Llave primaria e identificador de idempotencia generado en cliente o servidor. |
| `tienda_id` | `uuid` | `NO` | — | `REFERENCES public.tiendas(id) ON DELETE RESTRICT`. |
| `producto_id` | `uuid` | `NO` | — | FK compuesta `(tienda_id, producto_id) REFERENCES public.productos(tienda_id, id) ON DELETE RESTRICT`. |
| `tipo_movimiento` | `text` | `NO` | — | En operación manual (Sprint 4): `'entrada_inicial'`, `'compra'`, `'merma'`, `'ajuste'`. Reservados para RPC de Ventas (Sprint 6): `'venta'`, `'devolucion_cancelacion'`. |
| `cantidad_delta` | `numeric(12,3)` | `NO` | — | Delta distinto de cero: `> 0` en `entrada_inicial`, `compra` y `devolucion_cancelacion`; `< 0` en `venta` y `merma`; `<> 0` (`+` o `-`) en `ajuste`. |
| `costo_total_centavos` | `integer` | `SÍ` | `NULL` | `CHECK (costo_total_centavos >= 0)`. Costo total opcional en centavos enteros pagado por el lote/compra de referencia. |
| `motivo` | `text` | `NO` | — | `CHECK (char_length(btrim(motivo)) BETWEEN 1 AND 280)`. Justificación o nota auditable del movimiento. |
| `referencia_externa_id` | `uuid` | `SÍ` | `NULL` | Reservado para enlazar `venta_id` o `cancelacion_id` en el Sprint 6. |
| `registrado_por` | `uuid` | `SÍ` | — | `auth.uid()` del propietario o encargado que ejecutó el movimiento (`ON DELETE SET NULL`). |
| `ocurrido_en` | `timestamptz` | `NO` | `now()` | Fecha/hora real en que ocurrió el movimiento físico (compatible con captura offline). |
| `creado_en` | `timestamptz` | `NO` | `now()` | Marca de tiempo exacta de inserción en el servidor PostgreSQL. |

### 2.3 Triple capa de seguridad (Express + Privilegios de Columna + Triggers/RPC)

1. **Bloqueo en API Express (`400 STOCK_ACTUAL_SOLO_LECTURA`):** Enviar `stock_actual` en `POST /api/productos` o `PATCH /api/productos/:productoId` se rechaza de inmediato; solo `stock_minimo` es configurable en catálogo.
2. **Revocación de privilegios por columna en PostgREST (`Regla 5`):**
   - En `public.productos`, el rol `authenticated` solo posee `GRANT INSERT` y `GRANT UPDATE` sobre las columnas de catálogo (`nombre`, `codigo_barras`, `unidad_venta`, `precio_centavos`, `controla_inventario`, `es_acceso_rapido`, `orden_acceso_rapido`, `stock_minimo`, `activo`), **nunca sobre `stock_actual`**.
   - En `public.inventario_movimientos`, `authenticated` solo tiene `GRANT SELECT` sujeto a la política RLS `inventario_movimientos_select_gestion` (`propietario` y `encargado` activos de la tienda). Cualquier `INSERT`, `UPDATE` o `DELETE` directo vía cliente Supabase falla.
3. **Inmutabilidad y escritura atómica por RPC `SECURITY DEFINER`:**
   - El trigger `trg_inventario_movimientos_inmutable` (`BEFORE UPDATE OR DELETE`) impide editar o borrar filas existentes incluso por error interno: toda corrección contable debe registrarse mediante un movimiento compensatorio de `ajuste`.
   - La función `public.registrar_movimiento_inventario` valida membresía activa (`propietario` o `encargado`), verifica idempotencia por `p_movimiento_id`, bloquea la fila del producto (`SELECT ... FOR UPDATE`), comprueba `controla_inventario = true`, inserta el movimiento y retorna el movimiento junto con la existencia resultante ya actualizada por el trigger.

---

## 3. Política de Existencias Negativas con Alerta y `controla_inventario`

### 3.1 Existencias negativas permitidas con alerta (`politica_stock_negativo: "permitido_con_alerta"`)

En la operación diaria de una tienda de abarrotes o cremería **nunca se debe detener la fila del mostrador ni rechazar la sincronización de ventas** porque el sistema crea que hay `0.000` existencias:

- Es frecuente que llegue el proveedor de lácteos o refrescos, el encargado meta el producto al refrigerador y el cajero empiece a venderlo de inmediato mientras la nota de compra se captura más tarde en la noche.
- También ocurre cuando la tableta de caja sincroniza las ventas del turno antes de que el teléfono del dueño sincronice la compra de la mañana.

Por ello, el motor aplica la siguiente regla determinista (`evaluarAlertasStock` en `src/utils/calculosInventario.js` y en la RPC SQL):

| Condición del producto | `alerta_stock_negativo` | `alerta_bajo_stock` | Comportamiento operativo |
| :--- | :---: | :---: | :--- |
| `controla_inventario = true` y `stock_actual > stock_minimo` (con `stock_minimo >= 0`) | `false` | `false` | Existencia saludable. |
| `controla_inventario = true` y `0 <= stock_actual <= stock_minimo` | `false` | `true` | Punto de reorden alcanzado: sugiere surtir mercancía. |
| `controla_inventario = true` y `stock_actual < 0` | `true` | `true` | **Permitido sin bloqueo:** alerta al propietario/encargado que falta capturar una entrada/compra o cuadrar conteo físico. |
| `controla_inventario = false` (cualquier valor de stock) | `false` | `false` | Sin seguimiento de kardex ni alertas de reorden/negativo. |

### 3.2 Productos con `controla_inventario = false`

Artículos de rotación diaria sin inventario unitario estricto (ej. pan dulce suelto, tortillas del día, bolsas o hielo a granel) se configuran con `controla_inventario: false`:

- Aparecen normalmente en catálogo, botonera rápida y cobro.
- Nunca disparan `alerta_bajo_stock` ni `alerta_stock_negativo`.
- Si se intenta registrar un movimiento manual en `POST /api/inventario/movimientos` para un artículo con `controla_inventario = false`, el backend responde **`409 Conflict`** con `codigo: "PRODUCTO_SIN_CONTROL_INVENTARIO"`, indicando que debe habilitarse `controla_inventario: true` antes de llevar kardex sobre ese SKU.

---

## 4. Conversión Exacta por Presentación (Bulto / Barra / Caja) y Salidas por Gramos

Para evitar errores binarios IEEE-754 (`0.1 + 0.2`), `src/utils/calculosInventario.js` convierte toda cantidad textual o numérica a **milésimas enteras con `BigInt`** (`1 unidad = 1000 milésimas`) y formatea siempre a 3 decimales exactos (`NUMERIC(12,3)`).

- Si `unidad_venta === 'pieza'`, cualquier cantidad o delta debe ser un entero exacto de piezas (`% 1000n === 0n`); valores fraccionarios como `'0.5'` o `'1.250'` se rechazan con `CANTIDAD_PIEZA_NO_ENTERA`.

### 4.1 Entradas (`entrada_inicial` y `compra`): Directa vs. Presentación Comercial

Al registrar una entrada o compra se debe enviar **exactamente una** de estas dos modalidades (enviar ambas produce `400 ENTRADA_AMBIGUA`):

1. **Cantidad directa en unidad de venta (`cantidad`):**
   - *Ejemplo (bulto de azúcar estándar de 25 kg a \$525.00 MXN):*
     ```json
     {
       "producto_id": "...",
       "tipo_movimiento": "compra",
       "cantidad": "25.000",
       "costo_total_centavos": 52500,
       "motivo": "Bulto de azúcar 25 kg Central de Abasto"
     }
     ```
     Resultado: `cantidad_delta = "25.000"`, `cantidad_delta_milesimas = 25000`.

2. **Conversión por presentación (`presentacion_cantidad` + `unidades_por_presentacion` entero `>= 1`, ambos requeridos al usar presentación):**
   $$\text{cantidad\_delta\_milesimas} = \text{milesimas}(\text{presentacion\_cantidad}) \times \text{unidades\_por\_presentacion}$$
   - *Ejemplo cremería (2 barras cerradas de jamón de `3.500 kg` cada una, costo total \$840.00 MXN):*
     ```json
     {
       "producto_id": "...",
       "tipo_movimiento": "compra",
       "presentacion_cantidad": "3.500",
       "unidades_por_presentacion": 2,
       "costo_total_centavos": 84000,
       "motivo": "2 barras de jamón Virginia de 3.5 kg"
     }
     ```
     Resultado: `cantidad_delta = "7.000"`, `cantidad_delta_milesimas = 7000` (`+7,000` gramos sumados a `stock_actual`).
   - *Ejemplo abarrotes por pieza (3 rejas/cajas de 12 refrescos):*
     `presentacion_cantidad: 12`, `unidades_por_presentacion: 3` → `cantidad_delta = "36.000"` (`+36` piezas).

> **Nota sobre `motivo` y `costo_total_centavos`:** En `entrada_inicial` y `compra`, si se omite `motivo`, el motor asigna un motivo descriptivo predeterminado (`"Inventario inicial"` o `"Compra de mercancía"`). `costo_total_centavos` es opcional (`integer >= 0` o `null`, aplicable únicamente en `entrada_inicial` y `compra`) para guardar cuánto costó el lote en centavos sin obligar al tendero cuando solo desea subir existencias rápido.

### 4.2 Salidas por `merma` (en gramos / mililitros / piezas) y Cuadres por `ajuste`

- **`merma` (requiere `cantidad` positiva + `motivo` obligatorio):**
  - El usuario captura cuánto producto se dañó, caducó o recortó en la misma unidad del artículo (ej. `'0.150'` para `150 gramos` de orilla reseca de jamón o queso) y el motor lo transforma en delta negativo `'-0.150'` (`-150` milésimas).
  - No acepta `presentacion_cantidad` (`PRESENTACION_NO_PERMITIDA`) ni omitir el motivo (`MOTIVO_REQUERIDO`).
- **`ajuste` (requiere `cantidad_delta` con signo explícito + `motivo` obligatorio):**
  - Se utiliza para cuadrar conteos físicos de vitrina/bodega o corregir capturas previas sin mutar filas pasadas del Libro Mayor.
  - Exige explícitamente `cantidad_delta` distinto de cero (ej. `'-0.250'` por faltante físico o `'0.500'` por sobrante en báscula). Enviar `cantidad` sin signo en un `ajuste` se rechaza con `AJUSTE_REQUIERE_CANTIDAD_DELTA` para evitar ambigüedad sobre si suma o resta.

### 4.3 Códigos de Error de `calculosInventario` (`400 Bad Request`)

| Código (`codigo`) | Condición que lo dispara |
| :--- | :--- |
| `UNIDAD_INVALIDA` | `unidad_venta` distinta de `'pieza'`, `'kg'` o `'litro'`. |
| `TIPO_MOVIMIENTO_INVALIDO` | `tipo_movimiento` fuera de `'entrada_inicial'`, `'compra'`, `'merma'`, `'ajuste'` (ej. intentar enviar `'venta'` por la ruta manual). |
| `PRESENTACION_NO_PERMITIDA` | Se envió `presentacion_cantidad` o `unidades_por_presentacion` en una `merma` o `ajuste`, o `cantidad_delta` en un tipo distinto de `ajuste`. |
| `ENTRADA_AMBIGUA` | En `entrada_inicial` o `compra` se enviaron simultáneamente `cantidad` y `presentacion_cantidad` (o ninguno de los dos). |
| `PRESENTACION_INVALIDA` | `presentacion_cantidad` inválida/`<= 0` o `unidades_por_presentacion` no es un entero positivo seguro. |
| `CANTIDAD_DELTA_INVALIDA` | Cantidad o `cantidad_delta` vacía, igual a `0`, con más de 3 decimales (`'0.1234'`) o fuera del rango `NUMERIC(12,3)`. |
| `AJUSTE_REQUIERE_CANTIDAD_DELTA` | Un movimiento de `tipo_movimiento: 'ajuste'` omitió `cantidad_delta` (p. ej. envió `cantidad`). |
| `CANTIDAD_PIEZA_NO_ENTERA` | Producto con `unidad_venta = 'pieza'` recibió decimales fraccionarios (`'0.500'`). |
| `MOTIVO_REQUERIDO` | Se omitió `motivo` (o se envió en blanco) en `merma` o `ajuste`. |
| `MOTIVO_INVALIDO` | `motivo` no es texto o supera `280` caracteres tras recortar espacios. |
| `COSTO_INVALIDO` | `costo_total_centavos` no es un entero seguro `>= 0`. |
| `STOCK_MINIMO_INVALIDO` | `stock_minimo` es negativo, no numérico o tiene más de 3 decimales. |

---

## 5. Permisos por Rol y Contrato HTTP de Endpoints

### 5.1 Permisos de Inventario (`src/config/permisos.js`)

| Permiso | `propietario` | `encargado` | `cajero` | Uso en rutas |
| :--- | :---: | :---: | :---: | :--- |
| `inventario:leer` | Sí | Sí | **Sí** | `GET /existencias` — Consultar stock actual, mínimo y alertas en mostrador. |
| `inventario:kardex` | Sí | Sí | No (`403`) | `GET /movimientos` — Auditar bitácora detallada de movimientos y responsables. |
| `inventario:registrar` | Sí | Sí | No (`403`) | `POST /movimientos` con `entrada_inicial`, `compra` o `merma`. |
| `inventario:ajustar` | Sí | Sí | No (`403`) | `POST /movimientos` con `ajuste` (positivo o negativo). |

Todas las rutas requieren `Authorization: Bearer <access_token>` y contexto de tienda activa vía cabecera **`X-Tienda-Id: <uuid>`** en `/api/inventario/*` o mediante ruta anidada `/api/tiendas/:tiendaId/inventario/*`.

---

### 5.2 `GET /api/inventario/existencias`

Lista el estado de existencias y alertas calculadas de los productos de la tienda activa.

- **Query params opcionales:**
  - `q` (`1..120` chars): búsqueda insensible a tildes por nombre o código de barras.
  - `solo_controlados`: `'true'` o `'false'` (cuando es `'true'`, filtra `controla_inventario = true`).
  - `solo_activos`: `'true'` o `'false'`.
  - `bajo_stock`: `'true'` o `'false'` (cuando es `'true'`, filtra artículos controlados con `alerta_bajo_stock === true`).
  - `stock_negativo`: `'true'` o `'false'` (cuando es `'true'`, filtra artículos controlados con `stock_actual < 0`).
  - `limite` (`1..500`, default `200`) y `offset` (`>= 0`, default `0`).
- **Respuesta `200 OK`:**
  ```json
  {
    "tienda": {
      "id": "11111111-2222-4333-8444-555555555555",
      "nombre": "Tienda-Sucursal-Norte",
      "rol": "propietario"
    },
    "politica_stock_negativo": "permitido_con_alerta",
    "resumen": {
      "devueltos": 1,
      "con_bajo_stock": 1,
      "con_stock_negativo": 1
    },
    "productos": [
      {
        "id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
        "tienda_id": "11111111-2222-4333-8444-555555555555",
        "nombre": "Jamón Virginia Mostrador",
        "codigo_barras": null,
        "unidad_venta": "kg",
        "precio_centavos": 17000,
        "controla_inventario": true,
        "stock_actual": "-0.150",
        "stock_minimo": "1.000",
        "alerta_bajo_stock": true,
        "alerta_stock_negativo": true,
        "activo": true
      }
    ]
  }
  ```

---

### 5.3 `GET /api/inventario/movimientos`

Consulta el kardex inmutable de la tienda (ordenado del movimiento más reciente al más antiguo). Restringido a `propietario` y `encargado` (`inventario:kardex`).

- **Query params opcionales:**
  - `producto_id` (`UUID`): filtra el kardex de un producto específico.
  - `tipo_movimiento`: `'entrada_inicial'`, `'compra'`, `'venta'`, `'devolucion_cancelacion'`, `'merma'` o `'ajuste'`.
  - `desde` / `hasta` (fechas ISO-8601 sobre `ocurrido_en`).
  - `limite` (`1..500`, default `100`) y `offset` (`>= 0`, default `0`).
- **Respuesta `200 OK`:**
  ```json
  {
    "tienda": {
      "id": "11111111-2222-4333-8444-555555555555",
      "nombre": "Tienda-Sucursal-Norte",
      "rol": "propietario"
    },
    "paginacion": {
      "limite": 100,
      "offset": 0,
      "devueltos": 3
    },
    "movimientos": [
      {
        "id": "d4f5a6b7-1111-4222-8333-444455556666",
        "tienda_id": "11111111-2222-4333-8444-555555555555",
        "producto_id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
        "tipo_movimiento": "ajuste",
        "cantidad_delta": "-3.400",
        "costo_total_centavos": null,
        "motivo": "Desfase previo a registrar preventa",
        "referencia_externa_id": null,
        "registrado_por": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        "ocurrido_en": "2026-11-17T22:15:00.000Z",
        "creado_en": "2026-11-17T22:15:00.120Z"
      }
    ]
  }
  ```

---

### 5.4 `POST /api/inventario/movimientos`

Registra de forma transaccional e idempotente una entrada inicial, compra, merma o ajuste en el Libro Mayor.

- **Cuerpo JSON:**
  - `id` (`UUID`, opcional): recomendado para idempotencia ante reintentos de red o cola offline.
  - `producto_id` (`UUID`, requerido): producto perteneciente a la tienda activa con `controla_inventario = true`.
  - `tipo_movimiento` (requerido): `'entrada_inicial'`, `'compra'`, `'merma'` o `'ajuste'`.
  - Cantidad según tipo:
    - En `entrada_inicial` / `compra`: `cantidad` **o bien** el par `presentacion_cantidad` + `unidades_por_presentacion`.
    - En `merma`: `cantidad` positiva.
    - En `ajuste`: `cantidad_delta` con signo (`+` o `-`).
  - `motivo` (`string`, `1..280` chars; obligatorio en `merma` y `ajuste`, opcional con valor por defecto en entradas/compras).
  - `costo_total_centavos` (`integer >= 0`, opcional).
  - `ocurrido_en` (`ISO-8601`, opcional).
- **Códigos de respuesta:**
  - `201 Created` (`idempotente: false`): movimiento insertado y `stock_actual` actualizado por trigger.
  - `200 OK` (`idempotente: true`): el `id` UUID ya había sido procesado para ese producto y tienda; devuelve el movimiento y la existencia actual **sin volver a sumar ni descontar**.
  - `400 Bad Request`: error de validación (`codigo` determinista de `ErrorCalculoInventario` o UUID/fecha inválida).
  - `403 Forbidden`: usuario con rol `cajero`.
  - `404 Not Found`: el `producto_id` no existe o pertenece a otra tienda.
  - `409 Conflict`:
    - `codigo: "PRODUCTO_SIN_CONTROL_INVENTARIO"` cuando el producto tiene `controla_inventario = false`.
    - Conflicto de UUID si el mismo `id` de movimiento fue usado previamente para otro producto o tienda.

- **Ejemplo de respuesta `201 Created`:**
  ```json
  {
    "mensaje": "Movimiento de inventario registrado correctamente.",
    "idempotente": false,
    "movimiento": {
      "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      "tienda_id": "11111111-2222-4333-8444-555555555555",
      "producto_id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      "tipo_movimiento": "compra",
      "cantidad_delta": "3.500",
      "costo_total_centavos": 42000,
      "motivo": "Barra de jamón 3.5 kg",
      "registrado_por": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "ocurrido_en": "2026-11-17T22:10:00.000Z",
      "creado_en": "2026-11-17T22:10:00.095Z"
    },
    "existencia": {
      "producto_id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      "nombre": "Jamón Virginia Mostrador",
      "unidad_venta": "kg",
      "stock_anterior": "0.000",
      "stock_actual": "3.500",
      "stock_minimo": "1.000",
      "alerta_bajo_stock": false,
      "alerta_stock_negativo": false
    }
  }
  ```

---

## 6. Ejemplos Reproducibles en PowerShell (`Invoke-RestMethod`)

Con la migración `migrations/004_inventario_libro_mayor.sql` aplicada en Supabase y el servidor local en ejecución (`npm run dev` en `http://localhost:3000`):

### 6.1 Iniciar sesión y preparar cabeceras de tienda

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
$misTiendas  = Invoke-RestMethod -Method Get -Uri "$baseUrl/api/tiendas" -Headers $headersAuth
$tiendaId    = ($misTiendas.tiendas | Where-Object { $_.nombre -eq "Tienda-Demo" } | Select-Object -First 1).id

$headersTienda = @{
    Authorization = "Bearer $($sesion.access_token)"
    "X-Tienda-Id" = $tiendaId
}
```

### 6.2 Configurar `stock_minimo` en un producto a granel (`Jamón`)

```powershell
$catalogo = Invoke-RestMethod -Method Get `
    -Uri "$baseUrl/api/productos?q=jamon" `
    -Headers $headersTienda

$jamon = $catalogo.productos | Where-Object { $_.nombre -eq "Jamón" } | Select-Object -First 1

# Configurar punto de reorden en 1.500 kg (enviar stock_actual aquí daría 400 STOCK_ACTUAL_SOLO_LECTURA)
Invoke-RestMethod -Method Patch `
    -Uri "$baseUrl/api/productos/$($jamon.id)" `
    -Headers $headersTienda `
    -ContentType "application/json; charset=utf-8" `
    -Body (@{
        controla_inventario = $true
        stock_minimo        = "1.500"
    } | ConvertTo-Json)
```

### 6.3 Registrar compra por barras (`2 x 3.500 kg = +7.000 kg`) y verificar idempotencia

```powershell
$movimientoCompraId = [guid]::NewGuid().ToString()

$compraBody = @{
    id                        = $movimientoCompraId
    producto_id               = $jamon.id
    tipo_movimiento           = "compra"
    presentacion_cantidad     = "3.500"
    unidades_por_presentacion = 2
    costo_total_centavos      = 84000
    motivo                    = "Llegada de 2 barras cerradas de jamón (3.5 kg c/u)"
} | ConvertTo-Json

# Primera llamada -> 201 Created (idempotente = false, suma +7.000 kg)
$altaCompra = Invoke-RestMethod -Method Post `
    -Uri "$baseUrl/api/inventario/movimientos" `
    -Headers $headersTienda `
    -ContentType "application/json; charset=utf-8" `
    -Body $compraBody
$altaCompra.existencia

# Reintento de red con el MISMO UUID -> 200 OK (idempotente = true, NO duplica a +14.000 kg)
$reintentoCompra = Invoke-RestMethod -Method Post `
    -Uri "$baseUrl/api/inventario/movimientos" `
    -Headers $headersTienda `
    -ContentType "application/json; charset=utf-8" `
    -Body $compraBody
$reintentoCompra | Select-Object idempotente, @{N="stock_actual";E={$_.existencia.stock_actual}}
```

### 6.4 Registrar compra de bulto de azúcar (`25.000 kg`), merma en gramos y ajuste con motivo

```powershell
# Merma de 150 gramos (0.150 kg) por orilla reseca -> delta -0.150 kg
$merma = Invoke-RestMethod -Method Post `
    -Uri "$baseUrl/api/inventario/movimientos" `
    -Headers $headersTienda `
    -ContentType "application/json; charset=utf-8" `
    -Body (@{
        producto_id     = $jamon.id
        tipo_movimiento = "merma"
        cantidad        = "0.150"
        motivo          = "Recorte de orilla reseca en rebanadora"
    } | ConvertTo-Json)
$merma.existencia

# Ajuste físico negativo (-0.250 kg) con motivo obligatorio
$ajuste = Invoke-RestMethod -Method Post `
    -Uri "$baseUrl/api/inventario/movimientos" `
    -Headers $headersTienda `
    -ContentType "application/json; charset=utf-8" `
    -Body (@{
        producto_id     = $jamon.id
        tipo_movimiento = "ajuste"
        cantidad_delta  = "-0.250"
        motivo          = "Cuadre de conteo físico al cierre de turno"
    } | ConvertTo-Json)
$ajuste.existencia
```

### 6.5 Consultar existencias con alertas y auditar el kardex del producto

```powershell
# Existencias generales y resumen de alertas de la tienda
$existencias = Invoke-RestMethod -Method Get `
    -Uri "$baseUrl/api/inventario/existencias?solo_activos=true" `
    -Headers $headersTienda
$existencias.resumen
$existencias.productos | Select-Object nombre, stock_actual, stock_minimo, alerta_bajo_stock, alerta_stock_negativo

# Filtrar únicamente artículos en stock negativo (pendientes de capturar factura de compra)
$negativos = Invoke-RestMethod -Method Get `
    -Uri "$baseUrl/api/inventario/existencias?stock_negativo=true" `
    -Headers $headersTienda
$negativos.productos

# Consultar kardex inmutable del producto (solo propietario o encargado)
$kardex = Invoke-RestMethod -Method Get `
    -Uri "$baseUrl/api/inventario/movimientos?producto_id=$($jamon.id)&limite=20" `
    -Headers $headersTienda
$kardex.movimientos | Select-Object ocurrido_en, tipo_movimiento, cantidad_delta, costo_total_centavos, motivo
```

### 6.6 Ejecutar la suite automatizada del Sprint 4

```powershell
# Bloque A (pruebas deterministas locales de permisos, conversión por bulto/barra, alertas y seguridad HTTP sin credenciales):
node scripts/verificar_sprint4.js

# Bloque A + Bloque B completo contra Supabase (Libro Mayor, idempotencia, stock negativo con alerta, aislamiento y blindaje PostgREST):
$env:TEST_USER_EMAIL="propietario@ejemplo.com"
$env:TEST_USER_PASSWORD="TuPasswordSeguro123!"
node scripts/verificar_sprint4.js
```
