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
  proveedor de respaldo solo si no carga ningún mapa, y avisos claros si no hay ubicaciones.
- **Diseño:** barra de navegación fija con sombra al desplazarse, y sección "Todo lo que
  mueve su distribución" ampliada con una tarjeta destacada, más profundidad y un resumen
  de beneficios.

## Segunda pasada de diseño

- **Portada:** barra fina de progreso al desplazarse, insignia de "Ruta activa", etiquetas
  en los puntos del mapa, animación suave en el destino y tarjetas de datos más legibles.
- **Módulos:** encabezados con etiqueta de sección, tarjetas numeradas del 01 al 09, más
  contraste al pasar el cursor y una sección final con dos llamadas a la acción.
- **Proceso:** cada paso indica cuándo ocurre (en el cliente, en la ruta, al entregar, al
  final del día) y el pie de página incluye enlaces de navegación.
- **Acceso:** insignia de "Acceso al sistema" y mejor presentación del recuadro de
  credenciales de demostración.
- **Dashboard:** encabezado con fecha actual y botón "Actualizar datos", tarjetas con
  elevación al pasar el cursor y ancho máximo para evitar estiramientos en pantallas grandes.
- **Accesibilidad:** enlace para saltar al contenido, etiquetas aria en la navegación y
  apoyo de `text-wrap: balance` en los títulos.

## Menos ruido visual

- Se quitaron los porcentajes decorativos de la portada (94 %, 96 %), el número de formas
  de pago y la numeración de los módulos. Los beneficios ahora se leen como frases cortas.
- El mapa de la portada conserva solo etiquetas de palabras: cliente, check-in y entrega.
- Las gráficas solo muestran el valor sobre las barras con ventas; las zonas en cero ya no
  repiten "Sin ventas". El detalle sigue disponible al pasar el cursor y en el resumen.

## Menos módulos en la portada

- Los diez bloques de funciones se agruparon en cuatro áreas: **Ventas y pedidos**,
  **Inventario y entregas**, **Cobro y cierre** y **Seguimiento y control**.
- Todas las funciones siguen disponibles en el sistema; solo cambia la forma de
  presentarlas en la portada, que ahora se recorre en dos filas en lugar de cuatro.

## Ingreso directo

- Al abrir cualquiera de los enlaces, el sistema entra automáticamente como
  **administrador** y muestra el panel, sin pedir usuario ni contraseña.
- Si el servidor no responde, aparece el formulario de acceso para poder entrar
  con las credenciales de demostración.
- **Cerrar sesión** sigue disponible: muestra el formulario y evita que la página
  vuelva a entrar sola. Desde ahí se puede usar **Entrar como administrador** o
  iniciar sesión con otro usuario.
- Si una sesión expira mientras se trabaja, se renueva sola al recargar.

## Diferencia visible entre los tres roles

- La barra superior muestra una **insignia de color** con el perfil activo:
  dorado para Gerente, verde para Supervisor y azul para Preventista.
- Al hacer clic en la insignia se abre **Perfiles de acceso**, donde se explica qué
  hace cada rol y se puede cambiar entre ellos sin contraseña.
- El título del inicio cambia según el perfil: *Resumen general*, *Resumen de operación*
  o *Mi jornada*. El menú sigue mostrando solo las opciones permitidas para cada rol.

## RIF, ayuda y coherencia de flujo

- **RIF:** la máscara ya no borra lo escrito. Acepta guiones, espacios y minúsculas,
  coloca los guiones de forma predecible y muestra errores concretos: letra inicial,
  cantidad de dígitos o dígito verificador. El mismo texto se usa en el servidor.
- **Ayuda contextual:** se añadieron pistas cortas y un botón `?` en RIF, razón social,
  crédito, nivel comercial, ubicación y radio de check-in. El radio ahora dice
  claramente que controla la distancia permitida para registrar la visita.
- **Nivel comercial:** los puntos de venta tienen nivel **Detalle**, **Mini mayorista**,
  **Mayorista** o **Supermercado / súper mayorista**, con rangos sugeridos de crédito
  (hasta 500, 2.000, 8.000 y 25.000 USD). El nivel se sugiere según el canal, se puede
  ajustar y un monto fuera de rango pide confirmación. Tope absoluto: 100.000 USD.
- **Condiciones comerciales:** se muestran como información del local; no se aplican
  descuentos automáticos por nivel porque el negocio aún no ha definido esa regla.
- **Venta sugerida:** cada producto explica por qué aparece (rotación, reposición,
  próximo a vencer o canal) y se puede agregar de uno en uno o todos a la vez. Queda
  claro que solo se suma al pedido y que no factura ni cobra hasta confirmar.
- **Pasos visibles:** los formularios y vistas indican **Paso 1 · Registrar local**,
  **Paso 2 · Tomar pedido para surtir** y **Paso 3 · Entregar y cobrar**. Desde el pedido
  hay un acceso directo para registrar un local nuevo.
- **Operación y Logística:** el menú separa registro/operación, logística, finanzas y
  control. Las vistas explican quién gestiona cada etapa: Gerente/Supervisor mantienen
  proveedores y entradas; el Preventista consulta existencias. Cada lote sigue mostrando
  el proveedor y su RIF.

## Verificación

- **API:** 82 de 82 casos correctos (`npm test`): autenticación, permisos por rol,
  geocercas, pedidos, promociones, IGTF, entregas parciales, cobranza, inventario,
  proveedores, ruteo, cierre de caja, retornables, RED, comodatos, mermas y catálogos.
- **Interfaz:** 18 vistas sin errores de JavaScript, pedido completo con pago y
  comprobante PDF (14 KB) (`npm run test:ui`).
- **Roles y móvil:** menú correcto para Gerente (18 vistas), Supervisor (16) y
  Preventista (13); pedido funcional en 390×844 (`npm run test:roles`).
- **Referencias:** sin ids, funciones ni endpoints rotos (`npm run check`).
