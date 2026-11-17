# Decisiones Arquitectónicas y Tablero de Sprints

Documento vivo de referencia técnica y seguimiento del **POS SaaS para Misceláneas en México**. Incorpora los hallazgos de validación en mostrador (operación real de tienda de abarrotes/cremería) y las **6 reglas arquitectónicas base** acordadas antes de arrancar el Sprint 1.

---

## 1. Las 6 Reglas Arquitectónicas Base

### Regla 1: Diseño Offline-First adelantado (Sprint 5 antes de Ventas y Fiados)
- La interfaz móvil en Flutter **nunca lee ni escribe directo contra la API en las operaciones diarias de mostrador**; siempre opera contra SQLite local (`drift` o `sqflite`) para garantizar cobro instantáneo en dos toques aunque falle el internet o la señal dentro del local.
- Un servicio en segundo plano procesa una cola de eventos (`sync_queue` / patrón *Outbox*) hacia la API en Node.js.
- La arquitectura de sincronización y SQLite se implementa en el **Sprint 5**, antes de construir los flujos operativos de Ventas (Sprint 6) y Fiados (Sprint 7), evitando reescribir el manejo de estado.

### Regla 2: Identificadores UUID generados en el cliente e Idempotencia estricta
- Ninguna tabla operativa depende de secuencias autoincrementales (`SERIAL` / `BIGSERIAL`) generadas por el servidor.
- Todas las entidades sincronizables (`tiendas`, `miembros_tienda`, `productos`, `inventario_movimientos`, `ventas`, `venta_detalles`, `fiados`, `fiado_abonos`, `caja_movimientos`) utilizan **`UUID` (v4 o v7)**. En operaciones offline, el UUID se genera en el dispositivo al momento de la acción.
- Tanto los endpoints en Node.js como las funciones RPC en PostgreSQL deben ser **idempotentes**: si un lote o `venta_id` / `evento_id` llega dos veces por intermitencia de red, el servidor confirma éxito sin duplicar el cobro, el abono ni el descuento de inventario.

### Regla 3: `inventario_movimientos` y `fiado_abonos` como Libro Mayor (Ledger)
- Nunca se sincroniza un valor absoluto sobrescribible como *"el stock actual de jamón es X"* ni *"el saldo del cliente es Y"*.
- Cada entrada de bulto/barra, venta, ajuste o merma inserta un delta inmutable en `inventario_movimientos` (`+3.500 kg` entrada, `-0.250 kg` venta, `-0.100 kg` merma).
- `stock_actual` en `productos` se mantiene únicamente mediante **trigger en PostgreSQL** (o vista calculada) sumando algebraicamente los deltas de `inventario_movimientos`. Así, dos dispositivos (dueño y mostrador) pueden vender sin conexión y cuadrar al sincronizar horas después.

### Regla 4: Venta a granel bidireccional (Peso -> Importe e Importe -> Peso)
- Además de calcular importe por peso ($0.250\text{ kg} \times \$160.00 = \$40.00$), el sistema soporta el caso cotidiano de miscelánea/cremería: **pedir por dinero** (*"deme \$15 de queso/jamón"*) o redondear centavos en báscula comercial.
- `venta_detalles` almacenará tres valores históricos inmutables:
  1. `cantidad` (`NUMERIC(12,3)`, ej. `0.094` kg o unidades exactas).
  2. `precio_unitario_historico_centavos` (`INTEGER`, ej. `16000` centavos/kg).
  3. `subtotal_cobrado_centavos` (`INTEGER`, ej. `1500` centavos cobrados realmente).
- No se bloquea una venta por diferencias de redondeo de 1 centavo entre `cantidad * precio_unitario` y `subtotal_cobrado_centavos`.

### Regla 5: Arquitectura Híbrida Segura (Node.js Gateway + Supabase RLS y RPC)
- **Cliente móvil -> API Node.js -> Supabase (con JWT del usuario + `SUPABASE_PUBLISHABLE_KEY`)**.
- No se usa `service_role` para tráfico operativo ni se abren conexiones directas sin RLS.
- Para evitar duplicar la superficie de ataque en la API PostgREST automática de Supabase:
  - Todas las tablas tienen **RLS estricto** basado en membresía activa (`miembros_tienda`) sin políticas recursivas.
  - En tablas transaccionales compuestas (`ventas`, `venta_detalles`, `inventario_movimientos`, `caja_movimientos`, `fiado_abonos`), se revoca la escritura directa suelta desde PostgREST y se ejecutan **funciones PostgreSQL RPC atómicas e idempotentes** invocadas desde Node.js tras validar reglas de negocio y sesión.

### Regla 6: Vigencia de suscripción sin conexión (Grace Period criptográfico + Modo Lectura)
- En cada sincronización exitosa, el backend Node.js devuelve una **constancia firmada criptográficamente** (HMAC-SHA256 / Ed25519) con:
  - `tienda_id`, `estado_suscripcion`, `fecha_servidor_ultima_conexion`, `fecha_vencimiento_licencia` y `ventana_offline_horas` (ej. 72 a 120 h).
- En la app móvil se valida que el reloj del dispositivo **no sea menor** al último timestamp registrado localmente (`max(creado_en)` de ventas/eventos locales o `fecha_servidor_ultima_conexion`), detectando manipulación del reloj de Android.
- **Regla de oro comercial:** Si expira la suscripción o la ventana offline, se bloquea el registro de **nuevas ventas**, pero **jamás se bloquea la consulta de fiados por cobrar ni de inventario**.

---

## 2. Hoja de Ruta Reordenada (Sprints 0 a 9)

| Sprint | Nombre | Estado | Entregable clave |
| --- | --- | --- | --- |
| **Sprint 0** | Preparación, Git y respaldo base | **Terminado** | Repo limpio sin secretos, `.env.example`, guía de respaldo SQL y arquitectura base. |
| **Sprint 1** | Tiendas, membresías y migración UUID | **Terminado** | Tablas `tiendas` y `miembros_tienda`, migración reversible de `productos` a `tienda_id`, RLS sin recursión y rutas de contexto de tienda. |
| **Sprint 2** | Identidad, roles, permisos y base de firma offline | **Siguiente** | Matriz `propietario`/`encargado`/`cajero`, renovación de sesión, emisión inicial de constancia firmada de sincronización. |
| **Sprint 3** | Catálogo, botones rápidos y reglas de granel | Pendiente | Productos con/sin código, precios en centavos, marcas `actualizado_en` para sync incremental y motor de cálculo peso <-> importe. |
| **Sprint 4** | Inventario como libro mayor (`inventario_movimientos`) | Pendiente | Entradas de bulto/pieza, ajustes y mermas por deltas con UUID e idempotencia; `stock_actual` mantenido por trigger. |
| **Sprint 5** | Base móvil Flutter Offline-First y `sync_queue` | Pendiente | App Flutter con SQLite local, patrón *Outbox* (`sync_queue`), descarga incremental de catálogo y verificación criptográfica offline. |
| **Sprint 6** | Ventas en efectivo, granel inverso y caja (Offline-First) | Pendiente | Cobro en 2 toques en SQLite + RPC transaccional idempotente en PostgreSQL (venta + detalles + descuento inventario + caja). |
| **Sprint 7** | Fiados, abonos y salidas de caja (Offline-First) | Pendiente | Libro mayor de deudas/abonos con UUID, pagos a proveedores/gastos y modo lectura garantizado ante vencimiento de plan. |
| **Sprint 8** | Planes, suscripciones y panel SaaS aislado | Pendiente | Estados de licencia, Grace Period completo (72–120 h), webhooks idempotentes y panel administrativo sin acceso a ventas/fiados. |
| **Sprint 9** | Seguridad, pruebas con tenderos y piloto | Pendiente | Pruebas de aislamiento multi-tienda, corte/reconexión intermitente, restauración de respaldos y piloto real en mostrador. |

---

## 3. Tablero Kanban Inicial

### Terminado
- **[S0-01]** Revisar estructura inicial de API Express + Supabase Auth (`Node v24.18.0`, `/api/health` verificado).
- **[S0-02]** Configurar `.gitignore` seguro, `.env.example` sin credenciales y scripts `start` / `dev` en `package.json`.
- **[S0-03]** Documentar las 6 decisiones arquitectónicas y reordenar Sprints en `README.md` y `docs/`.
- **[S0-04]** Crear script `migrations/000_diagnostico_y_respaldo_sprint0.sql` para respaldar datos de prueba antes de tocar `productos`.
- **[HU-00 / S1-00]** Diagnóstico y respaldo verificable en `private_backups.productos_pre_sprint1` (3 productos originales resguardados).
- **[HU-01 / S1-01]** Tablas `tiendas` y `miembros_tienda` con `UUID`, roles (`propietario`, `encargado`, `cajero`) y alta atómica e idempotente (`crear_tienda_con_propietario`).
- **[HU-02 / S1-02]** Migración `001_tiendas_y_membresias.sql` aplicada y verificada en `Tienda-Demo` conservando íntegros `Jamón`, `Queso Oaxaca` y `Refresco de cola`.
- **[HU-03 / S1-03]** Selección y validación de tienda activa (`X-Tienda-Id` / `:tiendaId`), aislamiento multi-tienda verificado con `npm run verify:sprint1` y políticas RLS sin recursión. *(Nota pendiente para Sprint 2: ejecutar la prueba cruzada con `TEST_USER2` al probar invitaciones, roles `cajero`/`encargado` y membresías suspendidas).*

### En preparación (Sprint 2 — Identidad, roles, permisos y base de licencia offline)
- **[HU-04 / S2-01]** Definir renovación (`refresh`), cierre y expiración de sesión en la API, más emisión inicial de la constancia firmada criptográficamente con hora del servidor para operación sin conexión (Regla 6).
- **[HU-05 / S2-02]** Implementar matriz de permisos y rutas/RPC para invitar o registrar miembros en una tienda (`encargado`, `cajero`), cambiar rol y suspender/reactivar membresías.
- **[HU-06 / S2-03]** Validar con segundo usuario de prueba (`TEST_USER2`) membresías suspendidas, bloqueo de `cajero` al intentar cambiar precios o roles y bloqueo de acceso cruzado directo en PostgREST.

### Pendiente (Sprints 3 a 9)
- **[HU-04 / S2]** Matriz de permisos por rol (restringir cambios de precio, invitaciones y bajas de miembros a roles autorizados).
- **[HU-05 / S3]** Productos sin código de barras / acceso rápido para cremería, pan, tortillas y huevo, con soporte UTF-8 y códigos únicos por tienda.
- **[HU-06 / S4]** Kardex inmutable `inventario_movimientos` con cálculo automático de `stock_actual` por suma de deltas.
- **[HU-07 / S5]** Almacenamiento local SQLite en Flutter y cola `sync_queue` con reintentos idempotentes.
- **[HU-08 / S6]** Venta mixta (pieza + granel por peso o por importe en pesos) en transacción atómica RPC.
- **[HU-09 / S7]** Fiados, abonos parciales y consulta garantizada en modo vencido.

---

## 4. Procedimiento de Respaldo y Recuperación (Desarrollo)

Antes de aplicar cualquier migración sobre tablas existentes:

1. Abre el **SQL Editor** de tu proyecto de desarrollo en Supabase.
2. Ejecuta `migrations/000_diagnostico_y_respaldo_sprint0.sql`.
3. Este script realiza dos acciones seguras:
   - Muestra la estructura exacta actual de `public.productos` (columnas, tipos, índices, políticas RLS) y sus filas actuales.
   - Crea una copia exacta en `private_backups.productos_pre_sprint1` (esquema privado inaccesible desde la API pública PostgREST).
4. Adicionalmente, exporta el resultado de `SELECT * FROM public.productos;` como archivo CSV/JSON desde el editor de Supabase y guárdalo localmente dentro de `c:\pos-miscelanea-backend\backups\` (carpeta excluida por `.gitignore`).
5. **Prueba de restauración:** Si una migración en desarrollo necesita revertirse, ejecuta el script `rollback` correspondiente o restaura las filas desde `private_backups.productos_pre_sprint1`.
