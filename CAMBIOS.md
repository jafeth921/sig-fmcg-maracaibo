# Cambios aplicados

Resumen de las correcciones y mejoras realizadas sobre la versión publicada.

## Causa del fallo en producción

El sitio estaba desplegado pero **sin base de datos conectada**. Todas las llamadas a
`/api` devolvían HTTP 500 con `missing_connection_string` porque no existía la variable
`POSTGRES_URL`. El arreglo principal es de configuración (ver README, sección 3), y ahora
el sistema lo informa con claridad en lugar de fallar de forma genérica.

## Correcciones

- **Interfaz · Tomar pedido:** `USO` se usaba como variable global sin declarar dentro de
  un script en modo estricto, lo que lanzaba `ReferenceError: USO is not defined` y rompía
  la vista. Ahora está declarada (`let USO`).
- **Diagnóstico:** nuevo `GET /api/health` que indica si la base está conectada, la versión
  del esquema y, si falta, cómo solucionarlo (HTTP 503 con ayuda).
- **Errores de arranque:** si la base no responde, la interfaz muestra una pantalla clara
  con botón **Reintentar** en vez de quedarse en blanco.
- **Respuestas JSON:** errores de JSON inválido (400), cuerpo demasiado grande (413), ruta
  inexistente (404) y error interno (500) ahora devuelven JSON coherente.
- **Compatibilidad de base de datos:** se acepta `DATABASE_URL` o
  `POSTGRES_URL_NON_POOLING` cuando no existe `POSTGRES_URL` (Neon, Supabase, Railway).
- **Seguridad de sesiones:** se eliminó el secreto JWT fijo por defecto. Se toma de
  `JWT_SECRET` o se genera uno aleatorio por base de datos y se guarda en `config`.
- **Inicialización concurrente:** la creación de datos de demostración usa una "toma"
  atómica en `config`, de modo que varias instancias serverless no duplican registros.
- **Dependencias externas:** Leaflet, Chart.js y jsPDF se sirven desde `public/vendor`,
  sin depender de CDN (la aplicación ya no falla si esas CDN no están disponibles).

## Mejoras

- Índices de base de datos para pedidos, pagos, cobranzas, visitas, lotes, movimientos,
  mermas, liquidaciones y bitácora.
- Cierre ordenado del servidor local para no corromper la base embebida (PGlite).
- Modo de base en memoria (`npm run dev -- --mem`).
- Scripts: `npm run dev`, `npm start`, `npm test`, `npm run test:api`, `npm run test:ui`,
  `npm run test:roles`, `npm run test:prod`, `npm run check`.
- Documentación completa en `README.md`, plantilla `.env.example`, `.gitignore` y flujo de
  integración continua en `.github/workflows/ci.yml`.

## Ajustes de interfaz y redacción

- **Lenguaje claro:** se eliminó "OTIF" (ahora **Entregas a tiempo**) y "Cumplimiento de red"
  (ahora **Productos en anaquel**) en menús, KPIs, landing y documentación.
- **Error de la gráfica corregido:** `Ventas por zona` esperaba un arreglo pero la API
  devuelve `{ periodo, desde, hasta, zonas }`. Ahora lee `zonas`, muestra el rango de fechas,
  el total del período, el valor de cada barra y "Sin ventas" en las zonas en cero.
- **Períodos:** filtro de Hoy / Semana / Mes / Trimestre / Año en ventas por zona y nueva
  escala mensual en cantidades vendidas, con etiquetas de eje y fechas del período.
- **Mapa:** se ajusta la vista antes de cargar los mapas (evita peticiones canceladas), hay
  proveedor de respaldo si falla el principal y avisos claros si no hay ubicaciones.
- **Diseño:** barra de navegación fija con sombra al desplazarse, y sección "Todo lo que
  mueve su distribución" ampliada con una tarjeta destacada, más profundidad y un resumen
  de beneficios.

## Verificación

- **API:** 82 de 82 casos correctos (`npm test`): autenticación, permisos por rol,
  geocercas, pedidos, promociones, IGTF, entregas parciales, cobranza, inventario,
  proveedores, ruteo, cierre de caja, retornables, RED, comodatos, mermas y catálogos.
- **Interfaz:** 18 vistas sin errores de JavaScript, pedido completo con pago y
  comprobante PDF (14 KB) (`npm run test:ui`).
- **Roles y móvil:** menú correcto para Gerente (18 vistas), Supervisor (16) y
  Preventista (13); pedido funcional en 390×844 (`npm run test:roles`).
- **Referencias:** sin ids, funciones ni endpoints rotos (`npm run check`).
