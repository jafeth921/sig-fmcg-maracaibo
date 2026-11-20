# Rutix · SIG-FMCG Maracaibo

Sistema de gestión para distribuidoras de consumo masivo: preventa, inventario por
lotes, entregas a tiempo, cobranza multimoneda, cierre de caja y comprobantes en PDF.
Precios en USD con conversión automática a la tasa BCV.

- **Aplicación:** `public/index.html` (una sola página, sin compilación).
- **API:** `api/index.js` (Express, función serverless para Vercel).
- **Base de datos:** PostgreSQL (`@vercel/postgres`, compatible con Neon, Supabase, etc.).
- **Desarrollo local:** PostgreSQL embebido (PGlite), sin instalar nada más.

---

## 1. Probarlo en local

Requisitos: Node.js 20 o superior.

```bash
npm install
npm run dev
```

Abrir <http://localhost:3000>. La primera ejecución crea el esquema, carga datos de
demostración y descarga la tasa BCV. El enlace abre directamente el panel como
administrador, sin formulario de ingreso. Si cierra sesión aparece el formulario;
desde ahí puede entrar como administrador o con otro usuario.

**Usuarios de demostración**

| Usuario | Contraseña | Rol |
|---------|------------|-----|
| `admin` | `admin123` | Gerente |
| `maria` | `maria123` | Supervisor |
| `pedro` | `pedro123` | Preventista |

> Cambie estas contraseñas antes de usar el sistema con datos reales
> (menú **Mi perfil** o **Usuarios y accesos**).

La base local se guarda en `.data/pglite`. Para reiniciarla, borre esa carpeta.
Para levantar el servidor con base en memoria: `npm run dev -- --mem`.

### Probar sin conexión a internet

Las librerías de mapa, gráficos y PDF están incluidas en `public/vendor`, así que la
aplicación funciona sin depender de CDN. El mapa requiere internet para cargar las
teselas de OpenStreetMap; el resto funciona sin conexión.

---

## 2. Pruebas

```bash
npm test            # levanta un servidor temporal y prueba toda la API (105 casos)
npm run test:api    # igual, contra un servidor ya iniciado en :3000
npm run test:ui     # recorre las 18 vistas en Chromium y reporta errores JS
npm run test:roles  # menú por rol, permisos y pedido en vista móvil (390x844)
npm run check       # verifica referencias del HTML (ids, funciones, endpoints)

# Verificación de solo lectura contra el sitio publicado
npm run test:prod -- https://su-proyecto.vercel.app
```

Para las pruebas de interfaz, instale el navegador una vez y deje el servidor local
corriendo en otra terminal (`npm run dev`):

```bash
npx playwright install chromium
```

`test:ui` y `test:roles` abren <http://localhost:3000>. Las capturas quedan en
`dev/screenshots/`.

---

## 3. Publicar en Vercel (obligatorio conectar la base)

El sitio puede estar publicado y aun así fallar en todas las llamadas a `/api` si no
hay base de datos. Verifique el diagnóstico:

```
GET https://su-proyecto.vercel.app/api/health
```

- `{"ok":true, ...}` → todo correcto.
- `503` con `missing_connection_string` → falta conectar PostgreSQL (siga abajo).

### Pasos

1. En Vercel, importe este repositorio (**Add New → Project**).
2. En el proyecto: **Storage → Create Database → Postgres** (Vercel Postgres o Neon).
3. Pulse **Connect Project** para asociarla. Vercel define `POSTGRES_URL`
   automáticamente.
4. (Recomendado) En **Settings → Environment Variables** agregue:
   - `JWT_SECRET`: cadena aleatoria de 32+ caracteres
     (por ejemplo `openssl rand -hex 32`).
5. **Redeploy** para aplicar las variables.
6. Abra `/api/health` y confirme `ok: true`.
7. Entre con `admin / admin123` y cambie las contraseñas de demostración.

El esquema y los datos iniciales se crean solos en la primera petición.

### Variables de entorno

| Variable | Obligatoria | Descripción |
|----------|-------------|-------------|
| `POSTGRES_URL` | Sí* | Cadena de conexión PostgreSQL. |
| `DATABASE_URL` | Alternativa | Se acepta si no existe `POSTGRES_URL`. |
| `JWT_SECRET` | Recomendada | Firma de sesiones. Si falta, se genera uno aleatorio por base de datos. |
| `PORT` | No | Puerto local (por defecto `3000`). |
| `PGLITE_DIR` | No | Carpeta de la base embebida o `memory`. |

\* En local no hace falta: se usa PGlite automáticamente.

### Usar otro proveedor de PostgreSQL

Neon, Supabase, Railway o un Postgres propio funcionan igual. Copie la cadena de
conexión (con `sslmode=require`) en `POSTGRES_URL` o `DATABASE_URL` y redespliegue.

---

## 4. Módulos

| Módulo | Descripción |
|--------|-------------|
| Dashboard | KPIs de ventas, cuentas por cobrar, entregas a tiempo, productos en anaquel, retornabilidad y alertas. |
| Puntos de venta | RIF validado (módulo 11) con ayuda y máscara segura, zonas, canal, nivel comercial con rango de crédito y límites de pedidos. |
| Mapa y visitas | Check-in con la ubicación real del dispositivo, validado por radio configurable (50 m por defecto). Ya no existe la opción de simularlo. |
| Tomar pedido | Promociones por volumen y vencimiento, venta sugerida con motivo visible, IVA e IGTF. El pago se registra aquí. |
| Entregas a tiempo | Entrega total/parcial con ajuste automático de dinero y stock, devolución de faltantes y puntualidad. |
| Ruteo | Vecino más cercano + 2-opt, capacidad del camión y tiempos estimados. |
| Inventario | Lotes, FIFO, vencimientos, ajustes, movimientos y stock mínimo. |
| Proveedores | RIF, contactos, compras y entradas de mercancía. |
| Cobranza | Abonos multimoneda, crédito con límite y saldo por cliente. |
| Cierre de caja | Cuadre por moneda, diferencias justificadas y PDF. |
| Retornables | Envases entregados/recibidos e índice de retornabilidad. |
| Auditoría RED | Conteo de frentes, share y fotografía del anaquel. |
| Comodatos | Neveras y exhibidores con mantenimiento. |
| Mermas | Registro con o sin descuento de inventario; solo un Gerente o Supervisor puede descontar stock. |
| Administración | Productos, promociones, usuarios, bitácora y parámetros fiscales. |

**Niveles de crédito sugerido:** Detalle hasta 500 USD, Mini mayorista hasta 2.000,
Mayorista hasta 8.000 y Supermercado / súper mayorista hasta 25.000. El tope absoluto
es 100.000 USD y un monto fuera del rango requiere confirmación explícita.

---

## 5. Auditoría y versiones

Esta entrega deja **dos versiones**, sin reemplazar la que ya estaba publicada:

| Versión | Cómo identificarla | Ubicación |
|---------|--------------------|-----------|
| Anterior (publicada antes de la auditoría) | Etiqueta `version-anterior-c992f71` | ZIP `sig-fmcg-VERSION-ANTERIOR-c992f71.zip` junto al proyecto |
| Nueva (corregida) | Rama `mejoras-auditoria` | Este código, desplegado en los tres enlaces |

Para volver a la anterior sin borrar nada:

```bash
git checkout version-anterior-c992f71
```

**Qué se corrigió en la nueva versión**

- **Dinero:** rechazar o entregar parcialmente ya reversa cobros y cuentas por cobrar. El
  IGTF se calcula por pago, así que los PDF siguen cuadrando aunque haya varias divisas.
- **Duplicados:** un check-in o pedido repetido con el mismo identificador devuelve
  `409` en vez de crear otro registro.
- **Permisos:** el Preventista ya no puede crear locals, dar mantenimiento ni descontar
  stock; solo opera lo suyo. Un crédito fuera del rango requiere autorización de Gerente.
- **Errores:** respuestas 500 ya no muestran detalles internos. Las sesiones se revocan
  al cambiar la clave.
- **Interfaz:** pasos 2 y 3 explican que el pago se hace al tomar el pedido; el check-in
  usa ubicación real; los campos inválidos se anuncian, los modales atrapan el foco y el
  menú oculto ya no se tabula.
- **Cabeceras:** se añadió una política de seguridad (CSP) que permite solo los recursos
  usados por la aplicación.

**Riesgo pendiente solo para datos reales:** el ingreso automático y el selector de
perfiles se conservan porque son parte de la demostración. Si el sistema llega a manejar
información real, deben quitarse y exigir usuario y contraseña.

---

## 6. Estructura

```
api/index.js          API Express + esquema y datos iniciales
public/index.html     Interfaz completa (HTML + CSS + JS)
public/vendor/        Leaflet, Chart.js y jsPDF locales
dev/server.js         Servidor local con PGlite
dev/smoke.js          Pruebas de la API
dev/ui-audit.js       Recorrido de la interfaz con Playwright
dev/ui-roles.js       Verificación de roles y vista móvil
dev/check-refs.js     Referencias del HTML (ids, funciones, endpoints)
dev/test.js           Arranque + pruebas en un comando
```

La API crea y migra las tablas automáticamente (`initDB`). La versión del esquema se
guarda en `config.schema_v` y las migraciones conservan los datos existentes.

---

## 7. Seguridad

- Contraseñas con bcrypt; sesiones JWT de 8 horas, revocables al cambiar la clave.
- Bloqueo temporal tras 5 intentos fallidos de inicio de sesión.
- Roles: Gerente, Supervisor y Preventista, validados en el servidor, incluso sobre
  los objetos de cada usuario (no basta con estar autenticado).
- Validación de RIF venezolano con dígito verificador (módulo 11).
- Bitácora de las acciones importantes, incluidos créditos fuera de rango.
- Idempotencia por usuario: repetir una acción no duplica datos.
- Errores 500 sin mensajes internos; solo el servidor ve el detalle.
- Política de seguridad (CSP) y cabeceras que impiden incrustar la página en otro sitio.
- Todas las consultas usan parámetros (sin concatenar SQL).
- `JWT_SECRET` nunca tiene un valor fijo por defecto: se toma del entorno o se genera
  y guarda por base de datos.

---

## 8. Problemas frecuentes

**`/api/health` responde 503 y `missing_connection_string`**
No hay base conectada. Siga los pasos de la sección 3.

**La tasa BCV no se actualiza**
El servicio externo puede estar caído. Un Gerente o Supervisor puede fijarla a mano
desde el botón **Fijar** en la barra superior. El sistema reintenta cada 3 horas.

**Error al generar el comprobante**
El comprobante se bloquea si los datos fiscales están incompletos o si los totales no
cuadran. Revise **Empresa y fiscal** (razón social y RIF) y el RIF del cliente.

**Recuperar el acceso de administrador**
Sin acceso a ningún Gerente, actualice la clave directamente en PostgreSQL:

```sql
UPDATE usuarios
SET password_hash = crypt('nuevaClave123', gen_salt('bf', 10))
WHERE usuario = 'admin';
```

(Requiere la extensión `pgcrypto`; alternativamente genere el hash bcrypt con
`node -e "console.log(require('bcryptjs').hashSync('nuevaClave123',10))"` y guárdelo).

---

## 8. Aviso fiscal

Los parámetros de IVA e IGTF son configurables y referenciales. Confírmelos con su
contador y con la normativa vigente del SENIAT. El comprobante generado no sustituye
una factura fiscal emitida por una imprenta digital autorizada.
