const express = require('express');
const { sql } = require('@vercel/postgres');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const JWT_SECRET = process.env.JWT_SECRET || 'sig-fmcg-maracaibo-2026';
const ALMACEN = { nombre: 'Almacén Central', lat: 10.6540, lng: -71.6300 };
const BCV_URL = 'https://ve.dolarapi.com/v1/dolares/oficial';

// Métodos de pago: moneda en la que se registra el monto y si exige referencia
const METODOS = [
  { nombre: 'Efectivo USD',     moneda: 'USD', ref: false },
  { nombre: 'Efectivo Bs',      moneda: 'VES', ref: false },
  { nombre: 'Zelle',            moneda: 'USD', ref: true  },
  { nombre: 'Transferencia Bs', moneda: 'VES', ref: true  },
  { nombre: 'Pago Móvil',       moneda: 'VES', ref: true  },
  { nombre: 'Punto de Venta',   moneda: 'VES', ref: true  },
  { nombre: 'Crédito',          moneda: 'USD', ref: false }
];
const MET = Object.fromEntries(METODOS.map(m => [m.nombre, m]));

app.use(express.json({ limit: '2mb' }));

// ---------- Utilidades ----------
const h = fn => (req, res) =>
  Promise.resolve(fn(req, res)).catch(e => {
    console.error(e);
    res.status(500).json({ error: e.message });
  });
const r2 = x => Math.round((+x || 0) * 100) / 100;
// Fecha comercial en hora de Venezuela (UTC-4), formato AAAA-MM-DD
const hoy = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Caracas' });
const rol = (...r) => (req, res, next) => r.includes(req.user.rol) ? next() : res.status(403).json({ error: 'Permiso insuficiente' });

function hav(lat1, lon1, lat2, lon2) {
  const R = 6371000, r = x => x * Math.PI / 180;
  const dLat = r(lat2 - lat1), dLon = r(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---------- Tasa BCV ----------
async function getConfig(k) {
  const r = (await sql`SELECT valor FROM config WHERE clave=${k}`).rows[0];
  return r ? r.valor : null;
}
async function setConfig(k, v) {
  await sql`INSERT INTO config (clave,valor) VALUES (${k},${String(v)}) ON CONFLICT (clave) DO UPDATE SET valor=EXCLUDED.valor`;
}
async function leerTasa() {
  return {
    tasa: parseFloat(await getConfig('tasa_bcv')) || 0,
    fecha: await getConfig('tasa_fecha'),
    fuente: (await getConfig('tasa_fuente')) || 'Pendiente'
  };
}
async function traerTasaBCV() {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 6000);
  try {
    const r = await fetch(BCV_URL, { signal: ctl.signal });
    if (!r.ok) throw new Error('El servicio de tasa respondió HTTP ' + r.status);
    const j = await r.json();
    const v = parseFloat(j.promedio ?? j.venta ?? j.compra);
    if (!(v > 0)) throw new Error('La respuesta no contiene una tasa válida');
    return { tasa: v, fecha: j.fechaActualizacion || new Date().toISOString() };
  } finally { clearTimeout(to); }
}
async function actualizarTasa() {
  await setConfig('tasa_chequeo', new Date().toISOString());
  const r = await traerTasaBCV();
  await setConfig('tasa_bcv', r.tasa);
  await setConfig('tasa_fecha', r.fecha);
  await setConfig('tasa_fuente', 'BCV');
  return leerTasa();
}
// Devuelve la tasa y la refresca sola si pasaron 3 horas (salvo que esté fijada manualmente)
async function tasaVigente() {
  let t = await leerTasa();
  if (t.fuente === 'Manual') return t;
  const chk = await getConfig('tasa_chequeo');
  const vencida = !chk || (Date.now() - new Date(chk).getTime()) > 3 * 3600 * 1000;
  if (vencida || !(t.tasa > 0)) {
    try { t = await actualizarTasa(); } catch (e) { console.warn('BCV:', e.message); }
  }
  return t;
}

// ---------- Base de datos ----------
async function initDB() {
  await sql`CREATE TABLE IF NOT EXISTS config (clave TEXT PRIMARY KEY, valor TEXT)`;
  await sql`CREATE TABLE IF NOT EXISTS usuarios (id SERIAL PRIMARY KEY, nombre TEXT, cedula TEXT, usuario TEXT UNIQUE, password_hash TEXT, rol TEXT, zona_id INTEGER, activo INTEGER DEFAULT 1)`;
  await sql`CREATE TABLE IF NOT EXISTS zonas (id SERIAL PRIMARY KEY, nombre TEXT UNIQUE, color TEXT)`;
  await sql`CREATE TABLE IF NOT EXISTS pdvs (id SERIAL PRIMARY KEY, codigo TEXT UNIQUE, razon_social TEXT, nombre TEXT, direccion TEXT, zona_id INTEGER, lat DOUBLE PRECISION, lng DOUBLE PRECISION, geofence_radio_m INTEGER DEFAULT 50, saldo_cestas INTEGER DEFAULT 0, saldo_botellas INTEGER DEFAULT 0, limite_cestas INTEGER DEFAULT 10, limite_botellas INTEGER DEFAULT 20, limite_credito DOUBLE PRECISION DEFAULT 0, canal TEXT DEFAULT 'Abasto/Bodega')`;
  await sql`CREATE TABLE IF NOT EXISTS productos (id SERIAL PRIMARY KEY, codigo TEXT UNIQUE, nombre TEXT, precio DOUBLE PRECISION, retornable INTEGER DEFAULT 0, tipo_envase TEXT, fecha_vencimiento TEXT)`;
  await sql`CREATE TABLE IF NOT EXISTS promociones (id SERIAL PRIMARY KEY, nombre TEXT, producto_id INTEGER, tipo TEXT, min_cantidad INTEGER, descuento_pct DOUBLE PRECISION, activa INTEGER DEFAULT 1)`;
  await sql`CREATE TABLE IF NOT EXISTS pedidos (id SERIAL PRIMARY KEY, pdv_id INTEGER, usuario_id INTEGER, fecha TEXT, dia TEXT, subtotal DOUBLE PRECISION DEFAULT 0, descuento DOUBLE PRECISION DEFAULT 0, total DOUBLE PRECISION, total_bs DOUBLE PRECISION, tasa DOUBLE PRECISION, estado TEXT DEFAULT 'Confirmado', metodo_pago TEXT)`;
  await sql`CREATE TABLE IF NOT EXISTS pedido_items (id SERIAL PRIMARY KEY, pedido_id INTEGER, producto_id INTEGER, cantidad INTEGER, precio_unitario DOUBLE PRECISION, descuento_pct DOUBLE PRECISION DEFAULT 0, subtotal DOUBLE PRECISION)`;
  await sql`CREATE TABLE IF NOT EXISTS pedido_pagos (id SERIAL PRIMARY KEY, pedido_id INTEGER, metodo TEXT, moneda TEXT, monto DOUBLE PRECISION, monto_usd DOUBLE PRECISION, referencia TEXT)`;
  await sql`CREATE TABLE IF NOT EXISTS cobranzas (id SERIAL PRIMARY KEY, pdv_id INTEGER, usuario_id INTEGER, fecha TEXT, dia TEXT, metodo TEXT, moneda TEXT, monto DOUBLE PRECISION, monto_usd DOUBLE PRECISION, tasa DOUBLE PRECISION, referencia TEXT)`;
  await sql`CREATE TABLE IF NOT EXISTS visitas (id SERIAL PRIMARY KEY, pdv_id INTEGER, usuario_id INTEGER, fecha_checkin TEXT, dia TEXT, lat DOUBLE PRECISION, lng DOUBLE PRECISION, distancia_m DOUBLE PRECISION, estado TEXT DEFAULT 'Efectiva')`;
  await sql`CREATE TABLE IF NOT EXISTS activos_comodato (id SERIAL PRIMARY KEY, pdv_id INTEGER, codigo_qr TEXT UNIQUE, tipo TEXT, marca TEXT, temperatura_actual DOUBLE PRECISION, temp_min DOUBLE PRECISION DEFAULT 2, temp_max DOUBLE PRECISION DEFAULT 8, fecha_instalacion TEXT, ultimo_mantenimiento TEXT)`;
  await sql`CREATE TABLE IF NOT EXISTS cadena_frio (id SERIAL PRIMARY KEY, camion TEXT, temperatura DOUBLE PRECISION, alerta INTEGER DEFAULT 0, fecha TEXT)`;
  await sql`CREATE TABLE IF NOT EXISTS red_auditorias (id SERIAL PRIMARY KEY, pdv_id INTEGER, usuario_id INTEGER, cumplimiento_pct DOUBLE PRECISION, marca_propia_pct DOUBLE PRECISION, competencia_pct DOUBLE PRECISION, fecha TEXT)`;
  await sql`CREATE TABLE IF NOT EXISTS mermas (id SERIAL PRIMARY KEY, pdv_id INTEGER, producto_id INTEGER, cantidad INTEGER, causa TEXT, responsable TEXT, fecha TEXT)`;
  await sql`CREATE TABLE IF NOT EXISTS liquidaciones (id SERIAL PRIMARY KEY, usuario_id INTEGER, fecha TEXT, dia TEXT, tasa DOUBLE PRECISION, esperado_usd DOUBLE PRECISION, entregado_usd DOUBLE PRECISION, esperado_bs DOUBLE PRECISION, entregado_bs DOUBLE PRECISION, digital_usd DOUBLE PRECISION, credito_usd DOUBLE PRECISION, diferencia_usd DOUBLE PRECISION)`;

  const check = await sql`SELECT COUNT(*) AS c FROM usuarios`;
  if (parseInt(check.rows[0].c) === 0) {
    const a = bcrypt.hashSync('admin123', 10);
    const m = bcrypt.hashSync('maria123', 10);
    const p = bcrypt.hashSync('pedro123', 10);
    await sql`INSERT INTO usuarios (nombre,usuario,password_hash,rol) VALUES ('Gerente','admin',${a},'Gerente'),('María','maria',${m},'Supervisor'),('Pedro','pedro',${p},'Preventista')`;
    await sql`INSERT INTO zonas (nombre,color) VALUES ('Centro','#0F766E'),('Bella Vista','#B45309'),('Las Pulgas','#B91C1C')`;
    await sql`INSERT INTO pdvs (codigo,nombre,zona_id,lat,lng,saldo_cestas,saldo_botellas,limite_credito,canal) VALUES
      ('PDV-001','Bodega Esperanza',1,10.6427,-71.6125,2,0,150,'Abasto/Bodega'),
      ('PDV-002','Panadería Trigal',1,10.6450,-71.6150,0,0,100,'Panadería'),
      ('PDV-007','Mayorista Pulgas',3,10.6472,-71.6565,15,25,500,'Mayorista')`;
    // Precios en USD
    await sql`INSERT INTO productos (codigo,nombre,precio,retornable,tipo_envase) VALUES
      ('REF-2L','Refresco 2L',1.80,1,'Botella'),
      ('AGU-C12','Agua Cesta x12',6.50,1,'Cesta'),
      ('JUG-1L','Jugo 1L',1.50,0,NULL)`;
    await sql`INSERT INTO promociones (nombre,producto_id,tipo,min_cantidad,descuento_pct) VALUES ('Agua: 5 o más cestas, 10% de descuento',2,'Volumen',5,10)`;
    await sql`INSERT INTO activos_comodato (pdv_id,codigo_qr,tipo,marca,temperatura_actual,fecha_instalacion,ultimo_mantenimiento) VALUES
      (1,'QR-NEV-001','Nevera','Frigilux',4.5,'2025-03-10','2026-08-15'),
      (2,'QR-EXH-002','Exhibidor','Imbera',NULL,'2025-06-22','2026-07-01')`;
    try { await actualizarTasa(); }
    catch (e) {
      console.warn('No se pudo obtener la tasa BCV inicial:', e.message);
      await setConfig('tasa_bcv', 0); await setConfig('tasa_fuente', 'Pendiente');
    }
  }
}

let ready = null;
app.use('/api', (req, res, next) => {
  if (!ready) ready = initDB();
  ready.then(() => next()).catch(e => {
    ready = null;
    console.error('initDB:', e);
    res.status(500).json({ error: 'Error de base de datos: ' + e.message + ' (¿conectaste Postgres en Vercel, Storage?)' });
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

// ---------- Configuración y tasa ----------
app.get('/api/config', auth, h(async (req, res) => res.json({ metodos: METODOS, tasa: await tasaVigente() })));
app.get('/api/tasa', auth, h(async (req, res) => res.json(await tasaVigente())));
app.post('/api/tasa/actualizar', auth, rol('Gerente', 'Supervisor'), h(async (req, res) => {
  try { res.json(await actualizarTasa()); }
  catch (e) { res.status(502).json({ error: 'No se pudo consultar la tasa BCV: ' + e.message + '. Puede fijarla manualmente.' }); }
}));
app.put('/api/tasa', auth, rol('Gerente', 'Supervisor'), h(async (req, res) => {
  const t = parseFloat(req.body.tasa);
  if (!(t > 0)) return res.status(400).json({ error: 'Tasa inválida' });
  await setConfig('tasa_bcv', t);
  await setConfig('tasa_fecha', new Date().toISOString());
  await setConfig('tasa_fuente', 'Manual');
  res.json(await leerTasa());
}));

// ---------- Catálogos ----------
app.get('/api/zonas', auth, h(async (req, res) => res.json((await sql`SELECT * FROM zonas ORDER BY id`).rows)));
app.get('/api/productos', auth, h(async (req, res) => res.json((await sql`SELECT * FROM productos ORDER BY id`).rows)));
app.get('/api/promociones', auth, h(async (req, res) =>
  res.json((await sql`SELECT pr.*, p.nombre AS producto FROM promociones pr JOIN productos p ON pr.producto_id=p.id WHERE pr.activa=1`).rows)));

// ---------- PDVs ----------
app.get('/api/pdvs', auth, h(async (req, res) => {
  const { rows } = await sql`SELECT p.*, z.nombre AS zona_nombre, COALESCE(z.color,'#64748B') AS zona_color
    FROM pdvs p LEFT JOIN zonas z ON p.zona_id = z.id ORDER BY p.id`;
  res.json(rows);
}));

app.post('/api/pdvs', auth, h(async (req, res) => {
  const d = req.body;
  if (!d.codigo || !d.nombre) return res.status(400).json({ error: 'Código y nombre son obligatorios' });
  try {
    const r = await sql`INSERT INTO pdvs (codigo,razon_social,nombre,direccion,zona_id,lat,lng,geofence_radio_m,saldo_cestas,saldo_botellas,limite_cestas,limite_botellas,limite_credito,canal)
      VALUES (${d.codigo},${d.razon_social},${d.nombre},${d.direccion},${d.zona_id},${d.lat},${d.lng},${d.geofence_radio_m},${d.saldo_cestas},${d.saldo_botellas},${d.limite_cestas},${d.limite_botellas},${d.limite_credito || 0},${d.canal}) RETURNING id`;
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
    limite_cestas=${d.limite_cestas}, limite_botellas=${d.limite_botellas}, limite_credito=${d.limite_credito || 0}, canal=${d.canal} WHERE id=${id}`;
  res.json({ ok: true });
}));

app.delete('/api/pdvs/:id', auth, rol('Gerente', 'Supervisor'), h(async (req, res) => {
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
    return res.status(400).json({ error: 'FUERA DE GEOFENCE', mensaje: `Está a ${Math.round(dist)} m (máximo ${pdv.geofence_radio_m} m).` });
  const r = await sql`INSERT INTO visitas (pdv_id,usuario_id,fecha_checkin,dia,lat,lng,distancia_m) VALUES (${pdv_id},${req.user.id},${new Date().toISOString()},${hoy()},${lat},${lng},${dist}) RETURNING id`;
  res.json({ id: r.rows[0].id, distancia_m: Math.round(dist) });
}));

app.get('/api/visitas', auth, h(async (req, res) =>
  res.json((await sql`SELECT v.*, p.nombre AS pdv_nombre, COALESCE(u.nombre,'-') AS vendedor
    FROM visitas v JOIN pdvs p ON v.pdv_id=p.id LEFT JOIN usuarios u ON v.usuario_id=u.id ORDER BY v.id DESC LIMIT 50`).rows)));

// ---------- Smart Order ----------
app.get('/api/smart-order/:id', auth, h(async (req, res) => {
  const { rows } = await sql`SELECT pr.nombre, ROUND(AVG(pi.cantidad))::int AS cantidad_sugerida, COUNT(*) AS veces
    FROM pedido_items pi JOIN pedidos pe ON pi.pedido_id=pe.id JOIN productos pr ON pi.producto_id=pr.id
    WHERE pe.pdv_id=${+req.params.id} GROUP BY pr.nombre ORDER BY veces DESC LIMIT 5`;
  res.json(rows);
}));

// ---------- Cuentas por cobrar ----------
async function saldoCxC(pdvId) {
  const r = await sql`SELECT
    COALESCE((SELECT SUM(pg.monto_usd) FROM pedido_pagos pg JOIN pedidos pe ON pg.pedido_id=pe.id WHERE pe.pdv_id=${pdvId} AND pg.metodo='Crédito'),0)
    - COALESCE((SELECT SUM(c.monto_usd) FROM cobranzas c WHERE c.pdv_id=${pdvId}),0) AS s`;
  return parseFloat(r.rows[0].s) || 0;
}

// Valida y normaliza una lista de pagos. Devuelve [{metodo,moneda,monto,monto_usd,referencia}]
function normalizarPagos(pagos, tasa) {
  if (!Array.isArray(pagos) || !pagos.length) throw new Error('Debe registrar al menos un pago');
  return pagos.map(p => {
    const m = MET[p.metodo];
    if (!m) throw new Error('Método de pago no válido: ' + p.metodo);
    const monto = parseFloat(p.monto);
    if (!(monto > 0)) throw new Error('Monto inválido en ' + p.metodo);
    const ref = String(p.referencia || '').trim();
    if (m.ref && !ref) throw new Error('El método ' + p.metodo + ' requiere número de referencia');
    return { metodo: m.nombre, moneda: m.moneda, monto, monto_usd: m.moneda === 'USD' ? monto : monto / tasa, referencia: ref || null };
  });
}

// ---------- Pedidos ----------
app.post('/api/pedidos', auth, h(async (req, res) => {
  const { pdv_id, items, pagos } = req.body;
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Pedido vacío' });
  const { tasa } = await tasaVigente();
  if (!(tasa > 0)) return res.status(400).json({ error: 'No hay tasa BCV configurada. Actualícela o fíjela manualmente.' });

  const pdv = (await sql`SELECT * FROM pdvs WHERE id = ${pdv_id}`).rows[0];
  if (!pdv) return res.status(404).json({ error: 'PDV no encontrado' });
  if (pdv.saldo_cestas > pdv.limite_cestas || pdv.saldo_botellas > pdv.limite_botellas)
    return res.status(400).json({ error: 'BLOQUEADO', mensaje: 'Cliente bloqueado: excede el límite de envases retornables' });

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
    subtotal += sub; descuento += sub * pct / 100;
    lineas.push({ p, cant, pct, sub });
  }
  if (!lineas.length) return res.status(400).json({ error: 'Sin productos válidos' });

  subtotal = r2(subtotal); descuento = r2(descuento);
  const total = r2(subtotal - descuento);
  const totalBs = r2(total * tasa);

  let lista;
  try { lista = normalizarPagos(pagos, tasa); } catch (e) { return res.status(400).json({ error: e.message }); }
  const pagado = lista.reduce((s, x) => s + x.monto_usd, 0);
  if (Math.abs(pagado - total) > 0.02)
    return res.status(400).json({ error: `Los pagos (${r2(pagado)} USD) no coinciden con el total del pedido (${total} USD)` });

  const credito = lista.filter(x => x.metodo === 'Crédito').reduce((s, x) => s + x.monto_usd, 0);
  if (credito > 0) {
    const saldo = await saldoCxC(pdv_id);
    const disp = r2((pdv.limite_credito || 0) - saldo);
    if (credito > disp + 0.001)
      return res.status(400).json({ error: 'LÍMITE DE CRÉDITO', mensaje: `Crédito solicitado ${r2(credito)} USD; disponible ${Math.max(0, disp)} USD (saldo pendiente ${r2(saldo)} USD, límite ${pdv.limite_credito || 0} USD)` });
  }

  const resumen = [...new Set(lista.map(x => x.metodo))].join(' + ');
  const pid = (await sql`INSERT INTO pedidos (pdv_id,usuario_id,fecha,dia,subtotal,descuento,total,total_bs,tasa,metodo_pago)
    VALUES (${pdv_id},${req.user.id},${new Date().toISOString()},${hoy()},${subtotal},${descuento},${total},${totalBs},${tasa},${resumen}) RETURNING id`).rows[0].id;

  for (const l of lineas) {
    await sql`INSERT INTO pedido_items (pedido_id,producto_id,cantidad,precio_unitario,descuento_pct,subtotal)
      VALUES (${pid},${l.p.id},${l.cant},${l.p.precio},${l.pct},${r2(l.sub * (1 - l.pct / 100))})`;
    if (l.p.retornable && l.p.tipo_envase === 'Cesta')
      await sql`UPDATE pdvs SET saldo_cestas = saldo_cestas + ${l.cant} WHERE id = ${pdv_id}`;
    if (l.p.retornable && l.p.tipo_envase === 'Botella')
      await sql`UPDATE pdvs SET saldo_botellas = saldo_botellas + ${l.cant} WHERE id = ${pdv_id}`;
  }
  for (const g of lista)
    await sql`INSERT INTO pedido_pagos (pedido_id,metodo,moneda,monto,monto_usd,referencia) VALUES (${pid},${g.metodo},${g.moneda},${g.monto},${r2(g.monto_usd)},${g.referencia})`;

  res.json({ id: pid, subtotal, descuento, total, total_bs: totalBs, tasa, pagos: lista });
}));

app.get('/api/pedidos', auth, h(async (req, res) => {
  const pedidos = (await sql`SELECT pe.*, p.nombre AS pdv_nombre, COALESCE(u.nombre,'-') AS vendedor
    FROM pedidos pe JOIN pdvs p ON pe.pdv_id=p.id LEFT JOIN usuarios u ON pe.usuario_id=u.id
    WHERE pe.dia = ${hoy()} ORDER BY pe.id DESC LIMIT 100`).rows;
  for (const pe of pedidos) {
    pe.items = (await sql`SELECT pi.*, pr.nombre FROM pedido_items pi JOIN productos pr ON pi.producto_id=pr.id WHERE pi.pedido_id=${pe.id}`).rows;
    pe.pagos = (await sql`SELECT metodo, moneda, monto, monto_usd, referencia FROM pedido_pagos WHERE pedido_id=${pe.id}`).rows;
  }
  res.json(pedidos);
}));

// ---------- Cobranza ----------
app.get('/api/cobranza', auth, h(async (req, res) =>
  res.json((await sql`SELECT p.id, p.codigo, p.nombre, p.limite_credito,
    COALESCE((SELECT SUM(pg.monto_usd) FROM pedido_pagos pg JOIN pedidos pe ON pg.pedido_id=pe.id WHERE pe.pdv_id=p.id AND pg.metodo='Crédito'),0)
    - COALESCE((SELECT SUM(c.monto_usd) FROM cobranzas c WHERE c.pdv_id=p.id),0) AS saldo
    FROM pdvs p ORDER BY p.id`).rows)));

app.post('/api/cobranza', auth, h(async (req, res) => {
  const { pdv_id, metodo, monto, referencia } = req.body;
  if (metodo === 'Crédito') return res.status(400).json({ error: 'Seleccione un método de cobro válido' });
  const { tasa } = await tasaVigente();
  if (!(tasa > 0)) return res.status(400).json({ error: 'No hay tasa BCV configurada' });
  let g;
  try { g = normalizarPagos([{ metodo, monto, referencia }], tasa)[0]; } catch (e) { return res.status(400).json({ error: e.message }); }
  const saldo = await saldoCxC(pdv_id);
  if (g.monto_usd > saldo + 0.02) return res.status(400).json({ error: `El abono (${r2(g.monto_usd)} USD) excede el saldo pendiente (${r2(saldo)} USD)` });
  await sql`INSERT INTO cobranzas (pdv_id,usuario_id,fecha,dia,metodo,moneda,monto,monto_usd,tasa,referencia)
    VALUES (${pdv_id},${req.user.id},${new Date().toISOString()},${hoy()},${g.metodo},${g.moneda},${g.monto},${r2(g.monto_usd)},${tasa},${g.referencia})`;
  res.json({ ok: true, saldo: r2(saldo - g.monto_usd) });
}));

// ---------- KPIs ----------
app.get('/api/kpis', auth, h(async (req, res) => {
  const d = hoy();
  const v = (await sql`SELECT COALESCE(SUM(total),0) AS usd, COALESCE(SUM(total_bs),0) AS bs FROM pedidos WHERE dia=${d}`).rows[0];
  const bloq = (await sql`SELECT COUNT(*) AS c FROM pdvs WHERE saldo_cestas>limite_cestas OR saldo_botellas>limite_botellas`).rows[0].c;
  const frio = (await sql`SELECT temperatura, alerta FROM cadena_frio ORDER BY id DESC LIMIT 50`).rows;
  const red = (await sql`SELECT AVG(cumplimiento_pct) AS a FROM red_auditorias`).rows[0].a;
  const dr = (await sql`SELECT COUNT(DISTINCT v.pdv_id) AS vis, COUNT(DISTINCT pe.pdv_id) AS ped
    FROM visitas v LEFT JOIN pedidos pe ON pe.pdv_id=v.pdv_id AND pe.dia=${d} WHERE v.dia=${d}`).rows[0];
  const cxc = (await sql`SELECT
    COALESCE((SELECT SUM(monto_usd) FROM pedido_pagos WHERE metodo='Crédito'),0) - COALESCE((SELECT SUM(monto_usd) FROM cobranzas),0) AS s`).rows[0].s;
  const vis = parseInt(dr.vis);
  res.json({
    dropRate: vis ? Math.round(parseInt(dr.ped) / vis * 100) : null,
    cumplimientoRED: red == null ? null : Math.round(red),
    adherenciaTermica: frio.length ? Math.round((1 - frio.filter(x => x.alerta).length / frio.length) * 100) : null,
    retornabilidad: null,   // requiere registrar entregas y recepciones de envases
    otif: null,             // requiere registrar entregas
    ventasUsd: parseFloat(v.usd), ventasBs: parseFloat(v.bs),
    cxcUsd: parseFloat(cxc) || 0,
    tempActual: frio.length ? frio[0].temperatura : null,
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
  const { pdv_id, cumplimiento_pct } = req.body;
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

// ---------- VRP ----------
app.post('/api/vrp', auth, h(async (req, res) => {
  const ids = (req.body.pdv_ids || []).map(Number);
  const todos = (await sql`SELECT id, nombre, lat, lng FROM pdvs`).rows;
  let pendientes = todos.filter(p => ids.includes(p.id));
  if (!pendientes.length) return res.status(400).json({ error: 'Sin PDVs seleccionados' });
  const ruta = [{ nombre: ALMACEN.nombre, distancia_desde_anterior_m: 0 }];
  let actual = ALMACEN, totalM = 0;
  while (pendientes.length) {
    let mejor = 0, mejorD = Infinity;
    pendientes.forEach((p, i) => { const d = hav(actual.lat, actual.lng, p.lat, p.lng); if (d < mejorD) { mejorD = d; mejor = i; } });
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

// ---------- Liquidación ----------
async function resumenDia(uid) {
  const d = hoy();
  const filas = (await sql`SELECT metodo, moneda, COUNT(*) AS n, SUM(monto) AS monto, SUM(monto_usd) AS monto_usd FROM (
      SELECT pg.metodo, pg.moneda, pg.monto, pg.monto_usd FROM pedido_pagos pg JOIN pedidos pe ON pg.pedido_id=pe.id WHERE pe.usuario_id=${uid} AND pe.dia=${d}
      UNION ALL
      SELECT metodo, moneda, monto, monto_usd FROM cobranzas WHERE usuario_id=${uid} AND dia=${d}
    ) x GROUP BY metodo, moneda ORDER BY metodo`).rows
    .map(f => ({ metodo: f.metodo, moneda: f.moneda, n: parseInt(f.n), monto: parseFloat(f.monto), monto_usd: parseFloat(f.monto_usd) }));
  const g = n => (filas.find(f => f.metodo === n) || {}).monto || 0;
  return {
    filas,
    esperado_usd: r2(g('Efectivo USD')),
    esperado_bs: r2(g('Efectivo Bs')),
    digital_usd: r2(filas.filter(f => !f.metodo.startsWith('Efectivo') && f.metodo !== 'Crédito').reduce((s, f) => s + f.monto_usd, 0)),
    credito_usd: r2((filas.find(f => f.metodo === 'Crédito') || {}).monto_usd || 0)
  };
}

app.get('/api/liquidaciones/resumen', auth, h(async (req, res) => {
  res.json({ ...(await resumenDia(req.user.id)), tasa: (await leerTasa()).tasa });
}));

app.post('/api/liquidaciones', auth, h(async (req, res) => {
  const entUsd = parseFloat(req.body.efectivo_usd) || 0;
  const entBs = parseFloat(req.body.efectivo_bs) || 0;
  const { tasa } = await tasaVigente();
  if (!(tasa > 0)) return res.status(400).json({ error: 'No hay tasa BCV configurada' });
  const r = await resumenDia(req.user.id);
  const difUsd = r2(entUsd - r.esperado_usd), difBs = r2(entBs - r.esperado_bs);
  const difEq = r2(difUsd + difBs / tasa);
  await sql`INSERT INTO liquidaciones (usuario_id,fecha,dia,tasa,esperado_usd,entregado_usd,esperado_bs,entregado_bs,digital_usd,credito_usd,diferencia_usd)
    VALUES (${req.user.id},${new Date().toISOString()},${hoy()},${tasa},${r.esperado_usd},${entUsd},${r.esperado_bs},${entBs},${r.digital_usd},${r.credito_usd},${difEq})`;
  res.json({ esperado_usd: r.esperado_usd, esperado_bs: r.esperado_bs, dif_usd: difUsd, dif_bs: difBs, dif_equiv_usd: difEq, tasa });
}));

app.get('/api/liquidaciones', auth, h(async (req, res) =>
  res.json((await sql`SELECT l.*, COALESCE(u.nombre,'-') AS vendedor FROM liquidaciones l LEFT JOIN usuarios u ON l.usuario_id=u.id ORDER BY l.id DESC LIMIT 30`).rows)));

module.exports = app;
