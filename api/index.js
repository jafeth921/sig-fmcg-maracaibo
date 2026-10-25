const express = require('express');
const { sql } = require('@vercel/postgres');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const JWT_SECRET = process.env.JWT_SECRET || 'sig-fmcg-maracaibo-2026';
const ALMACEN = { nombre: 'Almacén Central', lat: 10.6540, lng: -71.6300 };

app.use(express.json({ limit: '4mb' }));

// ---------- Utilidades ----------
const h = fn => (req, res) =>
  Promise.resolve(fn(req, res)).catch(e => {
    console.error(e);
    res.status(500).json({ error: e.message });
  });

const hoy = () => new Date().toISOString().slice(0, 10);

function hav(lat1, lon1, lat2, lon2) {
  const R = 6371000, r = x => x * Math.PI / 180;
  const dLat = r(lat2 - lat1), dLon = r(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---------- Base de datos ----------
async function initDB() {
  await sql`CREATE TABLE IF NOT EXISTS usuarios (id SERIAL PRIMARY KEY, nombre TEXT, cedula TEXT, usuario TEXT UNIQUE, password_hash TEXT, rol TEXT, zona_id INTEGER, activo INTEGER DEFAULT 1)`;
  await sql`CREATE TABLE IF NOT EXISTS zonas (id SERIAL PRIMARY KEY, nombre TEXT UNIQUE, color TEXT)`;
  await sql`CREATE TABLE IF NOT EXISTS pdvs (id SERIAL PRIMARY KEY, codigo TEXT UNIQUE, razon_social TEXT, nombre TEXT, direccion TEXT, zona_id INTEGER, lat DOUBLE PRECISION, lng DOUBLE PRECISION, geofence_radio_m INTEGER DEFAULT 50, saldo_cestas INTEGER DEFAULT 0, saldo_botellas INTEGER DEFAULT 0, limite_cestas INTEGER DEFAULT 10, limite_botellas INTEGER DEFAULT 20, canal TEXT DEFAULT 'Abasto/Bodega')`;
  await sql`CREATE TABLE IF NOT EXISTS productos (id SERIAL PRIMARY KEY, codigo TEXT UNIQUE, nombre TEXT, precio DOUBLE PRECISION, retornable INTEGER DEFAULT 0, tipo_envase TEXT, fecha_vencimiento TEXT)`;
  await sql`CREATE TABLE IF NOT EXISTS promociones (id SERIAL PRIMARY KEY, nombre TEXT, producto_id INTEGER, tipo TEXT, min_cantidad INTEGER, descuento_pct DOUBLE PRECISION, activa INTEGER DEFAULT 1)`;
  await sql`CREATE TABLE IF NOT EXISTS pedidos (id SERIAL PRIMARY KEY, pdv_id INTEGER, usuario_id INTEGER, fecha TEXT, subtotal DOUBLE PRECISION DEFAULT 0, descuento DOUBLE PRECISION DEFAULT 0, total DOUBLE PRECISION, estado TEXT DEFAULT 'Confirmado', metodo_pago TEXT DEFAULT 'Efectivo')`;
  await sql`CREATE TABLE IF NOT EXISTS pedido_items (id SERIAL PRIMARY KEY, pedido_id INTEGER, producto_id INTEGER, cantidad INTEGER, precio_unitario DOUBLE PRECISION, descuento_pct DOUBLE PRECISION DEFAULT 0, subtotal DOUBLE PRECISION)`;
  await sql`CREATE TABLE IF NOT EXISTS visitas (id SERIAL PRIMARY KEY, pdv_id INTEGER, usuario_id INTEGER, fecha_checkin TEXT, lat DOUBLE PRECISION, lng DOUBLE PRECISION, distancia_m DOUBLE PRECISION, estado TEXT DEFAULT 'Efectiva')`;
  await sql`CREATE TABLE IF NOT EXISTS activos_comodato (id SERIAL PRIMARY KEY, pdv_id INTEGER, codigo_qr TEXT UNIQUE, tipo TEXT, marca TEXT, temperatura_actual DOUBLE PRECISION, temp_min DOUBLE PRECISION DEFAULT 2, temp_max DOUBLE PRECISION DEFAULT 8, fecha_instalacion TEXT, ultimo_mantenimiento TEXT)`;
  await sql`CREATE TABLE IF NOT EXISTS cadena_frio (id SERIAL PRIMARY KEY, camion TEXT, temperatura DOUBLE PRECISION, alerta INTEGER DEFAULT 0, fecha TEXT)`;
  await sql`CREATE TABLE IF NOT EXISTS red_auditorias (id SERIAL PRIMARY KEY, pdv_id INTEGER, usuario_id INTEGER, cumplimiento_pct DOUBLE PRECISION, marca_propia_pct DOUBLE PRECISION, competencia_pct DOUBLE PRECISION, fecha TEXT)`;
  await sql`CREATE TABLE IF NOT EXISTS mermas (id SERIAL PRIMARY KEY, pdv_id INTEGER, producto_id INTEGER, cantidad INTEGER, causa TEXT, responsable TEXT, fecha TEXT)`;
  await sql`CREATE TABLE IF NOT EXISTS liquidaciones (id SERIAL PRIMARY KEY, usuario_id INTEGER, fecha TEXT, efectivo_esperado DOUBLE PRECISION, efectivo_entregado DOUBLE PRECISION, transferencias DOUBLE PRECISION DEFAULT 0, diferencia DOUBLE PRECISION)`;

  const check = await sql`SELECT COUNT(*) AS c FROM usuarios`;
  if (parseInt(check.rows[0].c) === 0) {
    const a = bcrypt.hashSync('admin123', 10);
    const m = bcrypt.hashSync('maria123', 10);
    const p = bcrypt.hashSync('pedro123', 10);
    await sql`INSERT INTO usuarios (nombre,usuario,password_hash,rol) VALUES ('Gerente','admin',${a},'Gerente'),('María','maria',${m},'Supervisor'),('Pedro','pedro',${p},'Preventista')`;
    await sql`INSERT INTO zonas (nombre,color) VALUES ('Centro','#0B6E4F'),('Bella Vista','#F4A261'),('Las Pulgas','#E63946')`;
    await sql`INSERT INTO pdvs (codigo,nombre,zona_id,lat,lng,saldo_cestas,saldo_botellas,canal) VALUES
      ('PDV-001','Bodega Esperanza',1,10.6427,-71.6125,2,0,'Abasto/Bodega'),
      ('PDV-002','Panadería Trigal',1,10.6450,-71.6150,0,0,'Panadería'),
      ('PDV-007','Mayorista Pulgas',3,10.6472,-71.6565,15,25,'Mayorista')`;
    await sql`INSERT INTO productos (codigo,nombre,precio,retornable,tipo_envase) VALUES
      ('REF-2L','Refresco 2L',35,1,'Botella'),
      ('AGU-C12','Agua Cesta',120,1,'Cesta'),
      ('JUG-1L','Jugo 1L',28,0,NULL)`;
    await sql`INSERT INTO promociones (nombre,producto_id,tipo,min_cantidad,descuento_pct) VALUES ('Agua x5 → 10% dcto',2,'Volumen',5,10)`;
    await sql`INSERT INTO activos_comodato (pdv_id,codigo_qr,tipo,marca,temperatura_actual,fecha_instalacion,ultimo_mantenimiento) VALUES
      (1,'QR-NEV-001','Nevera','Frigilux',4.5,'2025-03-10','2026-08-15'),
      (2,'QR-EXH-002','Exhibidor','Imbera',NULL,'2025-06-22','2026-07-01')`;
  }
}

// Espera a que la BD esté lista antes de atender cualquier /api
let ready = null;
app.use('/api', (req, res, next) => {
  if (!ready) ready = initDB();
  ready.then(() => next()).catch(e => {
    ready = null;
    console.error('initDB:', e);
    res.status(500).json({ error: 'Error de base de datos: ' + e.message + ' (¿conectaste Postgres en Vercel → Storage?)' });
  });
});

// ---------- Auth ----------
function auth(req, res, next) {
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  if (!t) return res.status(401).json({ error: 'No autorizado' });
  try { req.user = jwt.verify(t, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Token inválido' }); }
}

app.post('/api/login', h(async (req, res) => {
  const { usuario, password } = req.body || {};
  const { rows } = await sql`SELECT * FROM usuarios WHERE usuario = ${usuario} AND activo = 1`;
  const u = rows[0];
  if (!u || !bcrypt.compareSync(password || '', u.password_hash))
    return res.status(401).json({ error: 'Credenciales incorrectas' });
  const token = jwt.sign({ id: u.id, nombre: u.nombre, rol: u.rol }, JWT_SECRET, { expiresIn: '8h' });
  res.json({ token, user: { id: u.id, nombre: u.nombre, rol: u.rol } });
}));

// ---------- Catálogos ----------
app.get('/api/zonas', auth, h(async (req, res) => res.json((await sql`SELECT * FROM zonas ORDER BY id`).rows)));
app.get('/api/productos', auth, h(async (req, res) => res.json((await sql`SELECT * FROM productos ORDER BY id`).rows)));
app.get('/api/promociones', auth, h(async (req, res) =>
  res.json((await sql`SELECT pr.*, p.nombre AS producto FROM promociones pr JOIN productos p ON pr.producto_id=p.id WHERE pr.activa=1`).rows)));

// ---------- PDVs (CRUD) ----------
app.get('/api/pdvs', auth, h(async (req, res) => {
  const { rows } = await sql`SELECT p.*, z.nombre AS zona_nombre, COALESCE(z.color,'#888888') AS zona_color
    FROM pdvs p LEFT JOIN zonas z ON p.zona_id = z.id ORDER BY p.id`;
  res.json(rows);
}));

app.post('/api/pdvs', auth, h(async (req, res) => {
  const d = req.body;
  if (!d.codigo || !d.nombre) return res.status(400).json({ error: 'Código y nombre son obligatorios' });
  try {
    const r = await sql`INSERT INTO pdvs (codigo,razon_social,nombre,direccion,zona_id,lat,lng,geofence_radio_m,saldo_cestas,saldo_botellas,limite_cestas,limite_botellas,canal)
      VALUES (${d.codigo},${d.razon_social},${d.nombre},${d.direccion},${d.zona_id},${d.lat},${d.lng},${d.geofence_radio_m},${d.saldo_cestas},${d.saldo_botellas},${d.limite_cestas},${d.limite_botellas},${d.canal}) RETURNING id`;
    res.json({ id: r.rows[0].id });
  } catch (e) {
    if (String(e.message).includes('duplicate')) return res.status(400).json({ error: 'Ya existe un PDV con ese código' });
    throw e;
  }
}));

app.put('/api/pdvs/:id', auth, h(async (req, res) => {
  const d = req.body, id = +req.params.id;
  await sql`UPDATE pdvs SET codigo=${d.codigo}, razon_social=${d.razon_social}, nombre=${d.nombre}, direccion=${d.direccion}, zona_id=${d.zona_id},
    lat=${d.lat}, lng=${d.lng}, geofence_radio_m=${d.geofence_radio_m}, saldo_cestas=${d.saldo_cestas}, saldo_botellas=${d.saldo_botellas},
    limite_cestas=${d.limite_cestas}, limite_botellas=${d.limite_botellas}, canal=${d.canal} WHERE id=${id}`;
  res.json({ ok: true });
}));

app.delete('/api/pdvs/:id', auth, h(async (req, res) => {
  await sql`DELETE FROM pdvs WHERE id=${+req.params.id}`;
  res.json({ ok: true });
}));

// ---------- Visitas / Geofencing ----------
app.post('/api/visitas/checkin', auth, h(async (req, res) => {
  const { pdv_id, lat, lng } = req.body;
  const pdv = (await sql`SELECT * FROM pdvs WHERE id = ${pdv_id}`).rows[0];
  if (!pdv) return res.status(404).json({ error: 'PDV no encontrado' });
  const dist = hav(lat, lng, pdv.lat, pdv.lng);
  if (dist > pdv.geofence_radio_m)
    return res.status(400).json({ error: 'FUERA DE GEOFENCE', mensaje: `Estás a ${Math.round(dist)}m (máx. ${pdv.geofence_radio_m}m).` });
  const r = await sql`INSERT INTO visitas (pdv_id,usuario_id,fecha_checkin,lat,lng,distancia_m) VALUES (${pdv_id},${req.user.id},${new Date().toISOString()},${lat},${lng},${dist}) RETURNING id`;
  res.json({ id: r.rows[0].id, distancia_m: Math.round(dist) });
}));

app.get('/api/visitas', auth, h(async (req, res) =>
  res.json((await sql`SELECT v.*, p.nombre AS pdv_nombre, COALESCE(u.nombre,'—') AS vendedor
    FROM visitas v JOIN pdvs p ON v.pdv_id=p.id LEFT JOIN usuarios u ON v.usuario_id=u.id ORDER BY v.id DESC LIMIT 50`).rows)));

// ---------- Smart Order ----------
app.get('/api/smart-order/:id', auth, h(async (req, res) => {
  const { rows } = await sql`SELECT pr.nombre, ROUND(AVG(pi.cantidad))::int AS cantidad_sugerida, COUNT(*) AS veces
    FROM pedido_items pi JOIN pedidos pe ON pi.pedido_id=pe.id JOIN productos pr ON pi.producto_id=pr.id
    WHERE pe.pdv_id=${+req.params.id} GROUP BY pr.nombre ORDER BY veces DESC LIMIT 5`;
  res.json(rows);
}));

// ---------- Pedidos ----------
app.post('/api/pedidos', auth, h(async (req, res) => {
  const { pdv_id, items, metodo_pago } = req.body;
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Pedido vacío' });
  const pdv = (await sql`SELECT * FROM pdvs WHERE id = ${pdv_id}`).rows[0];
  if (!pdv) return res.status(404).json({ error: 'PDV no encontrado' });
  if (pdv.saldo_cestas > pdv.limite_cestas || pdv.saldo_botellas > pdv.limite_botellas)
    return res.status(400).json({ error: 'BLOQUEADO', mensaje: 'Cliente bloqueado: excede el límite de retornables' });

  const promos = (await sql`SELECT * FROM promociones WHERE activa=1`).rows;
  let subtotal = 0, descuento = 0;
  const lineas = [];

  for (const it of items) {
    const p = (await sql`SELECT * FROM productos WHERE id = ${it.producto_id}`).rows[0];
    if (!p) continue;
    const cant = parseInt(it.cantidad) || 0;
    if (cant <= 0) continue;
    const sub = p.precio * cant;
    let pct = 0;
    const pv = promos.find(x => x.producto_id === p.id && x.tipo === 'Volumen' && cant >= x.min_cantidad);
    if (pv) pct += pv.descuento_pct;
    if (p.fecha_vencimiento) {
      const dias = Math.ceil((new Date(p.fecha_vencimiento) - new Date()) / 86400000);
      if (dias >= 0 && dias <= 30) {
        const ps = promos.find(x => x.producto_id === p.id && x.tipo === 'ShortDate');
        if (ps) pct += ps.descuento_pct;
      }
    }
    subtotal += sub;
    descuento += sub * pct / 100;
    lineas.push({ p, cant, pct, sub });
  }
  if (!lineas.length) return res.status(400).json({ error: 'Sin productos válidos' });

  const total = subtotal - descuento;
  const pid = (await sql`INSERT INTO pedidos (pdv_id,usuario_id,fecha,subtotal,descuento,total,metodo_pago)
    VALUES (${pdv_id},${req.user.id},${new Date().toISOString()},${subtotal},${descuento},${total},${metodo_pago || 'Efectivo'}) RETURNING id`).rows[0].id;

  for (const l of lineas) {
    await sql`INSERT INTO pedido_items (pedido_id,producto_id,cantidad,precio_unitario,descuento_pct,subtotal)
      VALUES (${pid},${l.p.id},${l.cant},${l.p.precio},${l.pct},${l.sub * (1 - l.pct / 100)})`;
    if (l.p.retornable && l.p.tipo_envase === 'Cesta')
      await sql`UPDATE pdvs SET saldo_cestas = saldo_cestas + ${l.cant} WHERE id = ${pdv_id}`;
    if (l.p.retornable && l.p.tipo_envase === 'Botella')
      await sql`UPDATE pdvs SET saldo_botellas = saldo_botellas + ${l.cant} WHERE id = ${pdv_id}`;
  }
  res.json({ id: pid, subtotal, descuento, total });
}));

app.get('/api/pedidos', auth, h(async (req, res) => {
  const pedidos = (await sql`SELECT pe.*, p.nombre AS pdv_nombre, COALESCE(u.nombre,'—') AS vendedor
    FROM pedidos pe JOIN pdvs p ON pe.pdv_id=p.id LEFT JOIN usuarios u ON pe.usuario_id=u.id
    WHERE LEFT(pe.fecha,10) = ${hoy()} ORDER BY pe.id DESC LIMIT 100`).rows;
  for (const pe of pedidos)
    pe.items = (await sql`SELECT pi.*, pr.nombre FROM pedido_items pi JOIN productos pr ON pi.producto_id=pr.id WHERE pi.pedido_id=${pe.id}`).rows;
  res.json(pedidos);
}));

// ---------- KPIs ----------
app.get('/api/kpis', auth, h(async (req, res) => {
  const ventas = (await sql`SELECT COALESCE(SUM(total),0) AS t FROM pedidos WHERE LEFT(fecha,10)=${hoy()}`).rows[0].t;
  const bloq = (await sql`SELECT COUNT(*) AS c FROM pdvs WHERE saldo_cestas>limite_cestas OR saldo_botellas>limite_botellas`).rows[0].c;
  const frio = (await sql`SELECT temperatura, alerta FROM cadena_frio ORDER BY id DESC LIMIT 50`).rows;
  const red = (await sql`SELECT AVG(cumplimiento_pct) AS a FROM red_auditorias`).rows[0].a;
  const tempActual = frio.length ? frio[0].temperatura : 4.0;
  const adh = frio.length ? Math.round((1 - frio.filter(x => x.alerta).length / frio.length) * 100) : 100;
  res.json({
    dropRate: 85,                        // pendiente: calcular con visitas vs pedidos
    cumplimientoRED: Math.round(red || 0),
    adherenciaTermica: adh,
    retornabilidad: 98,                  // pendiente: calcular con control_retornables
    otif: 95,                            // pendiente: requiere datos de entregas
    ventasHoy: parseFloat(ventas),
    tempActual,
    bloqueados: parseInt(bloq)
  });
}));

app.get('/api/ventas-zona', auth, h(async (req, res) =>
  res.json((await sql`SELECT z.nombre, z.color, COALESCE(SUM(pe.total),0) AS total
    FROM zonas z LEFT JOIN pdvs p ON p.zona_id=z.id LEFT JOIN pedidos pe ON pe.pdv_id=p.id
    GROUP BY z.id, z.nombre, z.color ORDER BY z.id`).rows)));

// ---------- Retornables ----------
app.get('/api/retornables', auth, h(async (req, res) =>
  res.json((await sql`SELECT id, codigo, nombre, saldo_cestas, saldo_botellas, limite_cestas, limite_botellas FROM pdvs ORDER BY id`).rows)));

app.post('/api/retornables/devolucion', auth, h(async (req, res) => {
  const { pdv_id, tipo, cantidad } = req.body;
  const pdv = (await sql`SELECT * FROM pdvs WHERE id = ${pdv_id}`).rows[0];
  if (!pdv) return res.status(404).json({ error: 'PDV no encontrado' });
  let nuevo;
  if (tipo === 'Cesta') {
    nuevo = Math.max(0, pdv.saldo_cestas - cantidad);
    await sql`UPDATE pdvs SET saldo_cestas = ${nuevo} WHERE id = ${pdv_id}`;
  } else {
    nuevo = Math.max(0, pdv.saldo_botellas - cantidad);
    await sql`UPDATE pdvs SET saldo_botellas = ${nuevo} WHERE id = ${pdv_id}`;
  }
  res.json({ ok: true, nuevo_saldo: nuevo });
}));

// ---------- Auditoría RED ----------
app.post('/api/red', auth, h(async (req, res) => {
  const { pdv_id, cumplimiento_pct } = req.body;   // la foto no se guarda (límite 4.5MB en Vercel)
  await sql`INSERT INTO red_auditorias (pdv_id,usuario_id,cumplimiento_pct,marca_propia_pct,competencia_pct,fecha)
    VALUES (${pdv_id},${req.user.id},${cumplimiento_pct},${cumplimiento_pct},${100 - cumplimiento_pct},${new Date().toISOString()})`;
  res.json({ ok: true });
}));
app.get('/api/red', auth, h(async (req, res) =>
  res.json((await sql`SELECT r.*, p.nombre AS pdv_nombre FROM red_auditorias r JOIN pdvs p ON r.pdv_id=p.id ORDER BY r.id DESC LIMIT 50`).rows)));

// ---------- Cadena de frío ----------
app.post('/api/frio', auth, h(async (req, res) => {
  const t = parseFloat(req.body.temperatura);
  const alerta = (t > 8 || t < 2) ? 1 : 0;
  await sql`INSERT INTO cadena_frio (camion,temperatura,alerta,fecha) VALUES (${req.body.camion || 'MC-001'},${t},${alerta},${new Date().toISOString()})`;
  res.json({ ok: true, alerta });
}));
app.get('/api/frio', auth, h(async (req, res) =>
  res.json((await sql`SELECT * FROM cadena_frio ORDER BY id DESC LIMIT 30`).rows.reverse())));

// ---------- Comodatos ----------
app.get('/api/comodatos', auth, h(async (req, res) =>
  res.json((await sql`SELECT a.*, p.nombre AS pdv_nombre FROM activos_comodato a JOIN pdvs p ON a.pdv_id=p.id ORDER BY a.id`).rows)));

app.post('/api/comodatos/:id/verificar', auth, h(async (req, res) => {
  const t = parseFloat(req.body.temperatura_actual);
  if (isNaN(t)) return res.status(400).json({ error: 'Temperatura inválida' });
  const a = (await sql`SELECT * FROM activos_comodato WHERE id=${+req.params.id}`).rows[0];
  if (!a) return res.status(404).json({ error: 'Activo no encontrado' });
  await sql`UPDATE activos_comodato SET temperatura_actual=${t} WHERE id=${a.id}`;
  res.json({ ok: true, alerta: t > a.temp_max || t < a.temp_min });
}));

// ---------- VRP (vecino más cercano) ----------
app.post('/api/vrp', auth, h(async (req, res) => {
  const ids = (req.body.pdv_ids || []).map(Number);
  const todos = (await sql`SELECT id, nombre, lat, lng FROM pdvs`).rows;
  let pendientes = todos.filter(p => ids.includes(p.id));
  if (!pendientes.length) return res.status(400).json({ error: 'Sin PDVs seleccionados' });

  const ruta = [{ nombre: ALMACEN.nombre, distancia_desde_anterior_m: 0 }];
  let actual = ALMACEN, totalM = 0;
  while (pendientes.length) {
    let mejor = 0, mejorD = Infinity;
    pendientes.forEach((p, i) => {
      const d = hav(actual.lat, actual.lng, p.lat, p.lng);
      if (d < mejorD) { mejorD = d; mejor = i; }
    });
    const sig = pendientes.splice(mejor, 1)[0];
    totalM += mejorD;
    ruta.push({ nombre: sig.nombre, distancia_desde_anterior_m: Math.round(mejorD) });
    actual = sig;
  }
  res.json({ ruta, total_km: +(totalM / 1000).toFixed(2) });
}));

// ---------- Mermas ----------
app.post('/api/mermas', auth, h(async (req, res) => {
  const { pdv_id, producto_id, cantidad, causa } = req.body;
  await sql`INSERT INTO mermas (pdv_id,producto_id,cantidad,causa,responsable,fecha)
    VALUES (${pdv_id},${producto_id},${cantidad},${causa},${req.user.nombre},${new Date().toISOString()})`;
  res.json({ ok: true });
}));
app.get('/api/mermas', auth, h(async (req, res) =>
  res.json((await sql`SELECT m.*, pr.nombre AS producto, p.nombre AS pdv_nombre
    FROM mermas m LEFT JOIN productos pr ON m.producto_id=pr.id LEFT JOIN pdvs p ON m.pdv_id=p.id ORDER BY m.id DESC LIMIT 50`).rows)));

// ---------- Liquidaciones ----------
app.post('/api/liquidaciones', auth, h(async (req, res) => {
  const { efectivo_entregado, transferencias } = req.body;
  const esp = (await sql`SELECT COALESCE(SUM(total),0) AS t FROM pedidos
    WHERE usuario_id=${req.user.id} AND metodo_pago='Efectivo' AND LEFT(fecha,10)=${hoy()}`).rows[0].t;
  const esperado = parseFloat(esp);
  const dif = (parseFloat(efectivo_entregado) || 0) - esperado;
  await sql`INSERT INTO liquidaciones (usuario_id,fecha,efectivo_esperado,efectivo_entregado,transferencias,diferencia)
    VALUES (${req.user.id},${new Date().toISOString()},${esperado},${efectivo_entregado || 0},${transferencias || 0},${dif})`;
  res.json({ efectivo_esperado: esperado, diferencia: dif });
}));
app.get('/api/liquidaciones', auth, h(async (req, res) =>
  res.json((await sql`SELECT l.*, COALESCE(u.nombre,'—') AS vendedor FROM liquidaciones l LEFT JOIN usuarios u ON l.usuario_id=u.id ORDER BY l.id DESC LIMIT 30`).rows)));

module.exports = app;
