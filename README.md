# Punto de venta SaaS para misceláneas

Aplicación en desarrollo para apoyar la operación de pequeñas tiendas y misceláneas en México. El proyecto busca ofrecer una solución móvil sencilla para registrar ventas, consultar inventario y administrar una o varias tiendas desde una misma cuenta.

> **Estado:** etapa inicial de desarrollo. Este README se basa en el plan de trabajo; las instrucciones específicas de la API deben completarse después de revisar el código existente.

## Objetivo

Construir un primer prototipo funcional que permita a una tienda registrar ventas en efectivo por pieza o por peso, llevar un inventario básico y continuar vendiendo cuando no haya conexión a internet. La información se organizará por tienda y cada usuario tendrá los permisos correspondientes a su membresía.

## Estado actual

De acuerdo con el plan del proyecto:

- Existe una API inicial con Node.js y Express conectada a Supabase Auth y PostgreSQL.
- Hay productos de prueba asociados a un propietario.
- La separación de datos entre tiendas todavía no se ha validado.
- Las membresías por tienda, la aplicación móvil y la sincronización sin conexión forman parte del trabajo pendiente.

El código y las pruebas del repositorio serán la referencia para mantener actualizada esta sección.

## Alcance previsto

### Para las tiendas

- Acceso de usuarios y selección de tienda activa.
- Administración de varias tiendas desde una misma cuenta, con permisos por tienda.
- Catálogo de productos por pieza o peso, con código opcional.
- Inventario básico, entradas, ajustes y mermas.
- Ventas en efectivo, cálculo de cambio y registro de caja.
- Registro de fiados y abonos.
- Venta en efectivo sin internet y sincronización posterior. El primer piloto se plantea con una caja por tienda.

Estas funciones son objetivos del proyecto y no se presentan como implementadas hasta que se desarrollen y comprueben. Los pagos electrónicos integrados requieren conexión; su proveedor y alcance se definirán posteriormente.

### Para la administración del SaaS

Se prevé un panel para consultar planes, suscripciones, datos de contacto y eventos técnicos necesarios para operar el servicio. El panel deberá limitar el acceso a los datos comerciales de las tiendas. Los permisos privilegiados de infraestructura también necesitan controles, pues el diseño del panel por sí solo no impide técnicamente el acceso a la base de datos.

## Tecnologías previstas

| Componente | Tecnología | Estado |
| --- | --- | --- |
| API | Node.js y Express | API inicial existente según el plan |
| Autenticación | Supabase Auth | Conectada a la API inicial según el plan |
| Base de datos remota | PostgreSQL con Supabase | En uso inicial según el plan |
| Aplicación móvil | Flutter | Pendiente |
| Almacenamiento local | SQLite | Previsto para la app móvil |
| Control de versiones | Git | Preparación y revisión inicial |

## Arquitectura general prevista

La aplicación móvil se comunicará con la API, que validará la sesión, la membresía y los permisos antes de acceder a los datos correspondientes. La base de datos también deberá aplicar controles de aislamiento. El dispositivo almacenará localmente el catálogo y las ventas pendientes de sincronizar cuando se implemente el modo sin conexión.

La estrategia de aislamiento, las políticas RLS, el acceso local y la sincronización deben diseñarse y verificarse antes de su uso con información real.

## Preparación del entorno de desarrollo

Estas instrucciones son una base para completar con la configuración real. No se han revisado el código, las versiones ni los nombres de variables del repositorio.

### Requisitos

- Git y Node.js con npm. **Pendiente:** registrar la versión de Node.js compatible con la API.
- Acceso a un proyecto de Supabase destinado a desarrollo.
- Flutter y las herramientas de Android cuando comience el desarrollo de la aplicación móvil.

### Instalación de la API existente

1. Abre una terminal en la carpeta que contiene el archivo `package.json` de la API.
2. Comprueba la versión de Node.js y revisa los scripts disponibles:

   ```bash
   node --version
   npm --version
   npm run
   ```

3. Instala las dependencias. Si existe un `package-lock.json` actualizado, ejecuta:

   ```bash
   npm ci
   ```

   Si aún no existe ese archivo, revisa el proyecto y usa `npm install` para instalar las dependencias declaradas.

4. Configura las variables de entorno que la API utiliza. Si el proyecto ya incluye un `.env.example`, úsalo como referencia para crear tu archivo local `.env`. **Pendiente:** documentar los nombres exactos de las variables y sus valores de ejemplo sin credenciales reales.
5. Inicia la API con el script que aparezca en `npm run` y corresponda al proyecto. **Pendiente:** documentar aquí el comando exacto, puerto y ruta de comprobación tras revisar `package.json` y el código.
6. Comprueba que la API se conecta al entorno de desarrollo y que los productos de prueba continúan disponibles. No ejecutes migraciones sobre datos existentes sin antes revisar sus efectos y contar con un respaldo comprobado.

> No agregues `.env`, claves privadas, tokens, volcados de la base de datos ni información personal al repositorio. Una clave de servicio o una contraseña de base de datos nunca debe incluirse en la app móvil ni en código público.

## Datos y seguridad

- Cada tienda deberá contar con sus propios datos y sus miembros autorizados.
- Una persona podrá pertenecer a varias tiendas y tener un rol en cada una.
- Los roles previstos inicialmente son **propietario**, **encargado** y **cajero**; sus permisos se definirán mediante una matriz.
- La pertenencia y los permisos deberán comprobarse en el servidor y reforzarse con políticas apropiadas en la base de datos.
- Las migraciones de base de datos se versionarán y se probarán en desarrollo, con una estrategia de recuperación para proteger los datos existentes.
- Las ventas guardadas solo en el dispositivo estarán expuestas a pérdida si este se daña o se extravía antes de sincronizarlas.

## Plan de desarrollo

Las iteraciones son orientativas y se pueden ajustar según el tiempo disponible.

| Etapa | Objetivo principal |
| --- | --- |
| Sprint 0 | Revisar y proteger la API existente, preparar Git y respaldos. |
| Sprint 1 | Crear tiendas y membresías; migrar los productos existentes. |
| Sprint 2 | Definir identidad, sesiones, roles y permisos. |
| Sprint 3 | Desarrollar el catálogo y las reglas de precios. |
| Sprint 4 | Incorporar inventario y compras básicas. |
| Sprint 5 | Implementar ventas en efectivo y caja. |
| Sprint 6 | Registrar fiados, abonos y movimientos de caja. |
| Sprint 7 | Crear la aplicación móvil y la sincronización sin conexión. |
| Sprint 8 | Administrar planes, suscripciones y el servicio SaaS. |
| Sprint 9 | Realizar pruebas de seguridad, piloto y preparación de lanzamiento. |

La prioridad inmediata es completar el Sprint 0 y después diseñar y ensayar la migración a tiendas y membresías sin perder los productos de prueba.

## Forma de trabajo con Git

1. Revisa el estado del repositorio con `git status`.
2. Trabaja en una rama descriptiva para cada cambio, por ejemplo `feat/tiendas-membresias`.
3. Revisa los archivos y realiza las comprobaciones que correspondan antes de crear un commit.
4. Integra los cambios en la rama principal después de revisarlos. Confirma primero el nombre de esa rama.

Ejemplos de mensajes de commit:

```text
chore: preparar configuracion inicial
feat: agregar membresias por tienda
fix: corregir validacion de productos
```

Antes del primer commit, comprueba que `.gitignore` excluya los archivos de secretos, dependencias locales y respaldos. Revisa los archivos preparados con `git status` y `git diff --cached`. No inicialices Git otra vez si la carpeta ya pertenece a un repositorio.

## Pruebas

**Pendiente:** registrar los comandos reales de análisis y pruebas disponibles en el repositorio.

Como mínimo, durante el desarrollo se deberán comprobar el acceso entre tiendas, los permisos de cada rol, la conservación de datos durante migraciones, los cálculos de venta, los movimientos de inventario y los reintentos de sincronización. Se documentarán los resultados y las limitaciones de cada prueba.

## Decisiones pendientes

- Nombre definitivo del producto y alcance del primer piloto.
- Política de inventario negativo, descuentos, devoluciones y caducidades.
- Acceso y autorización sin conexión, así como resolución de conflictos.
- Planes, precios y proveedor de cobro de suscripciones.
- Versiones, variables de entorno, scripts y estructura definitiva del repositorio.

## Licencia

Pendiente de definir por el propietario del proyecto.
