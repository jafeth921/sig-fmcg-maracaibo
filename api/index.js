const express = require('express');
const crypto = require('crypto');
const { sql } = require('@vercel/postgres');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const JWT_SECRET = process.env.JWT_SECRET || 'sig-fmcg-maracaibo-2026';
const ALMACEN = { nombre: 'Almacén Central', lat: 10.6540, lng: -71.6300 };
const BCV_URL = 'https://ve.dolarapi.com/v1/dolares/oficial';
const VEL_KMH = 25, SERVICIO_MIN = 10, FACTOR_VIA = 1.3;   // estimaciones de ruteo
const SCHEMA_V = '9';

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
const ROLES = ['Gerente', 'Supervisor', 'Preventista'];
const CANALES = ['Abasto/Bodega', 'Supermercado', 'Panadería', 'Mayorista'];
const CAUSAS = ['Rotura', 'Vencimiento', 'Falla de empaque', 'Daño en transporte'];
const PERIODOS = ['Diario', 'Semanal', 'Mensual'];
const ALICUOTAS = ['G', 'R', 'E'];   // General, Reducida, Exento
const CLAVE_OK = /^(?=.*[A-Za-z])(?=.*\d).{8,72}$/;
const CLAVE_MSG = 'La contraseña debe tener entre 8 y 72 caracteres, con letras y números';

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin', 'Cache-Control': 'no-store' });
  next();
});
app.use(express.json({ limit: '2mb' }));

// ---------- Utilidades ----------
const fail = (status, msg) => Object.assign(new Error(msg), { status });
const h = fn => (req, res) =>
  Promise.resolve(fn(req, res)).catch(e => {
    if (!e.status) console.error(e);
    res.status(e.status || 500).json({ error: e.message });
  });
const r2 = x => Math.round((+x || 0) * 100) / 100;
const diaDe = d => d.toLocaleDateString('en-CA', { timeZone: 'America/Caracas' });   // AAAA-MM-DD en hora de Venezuela
const hoy = () => diaDe(new Date());
const addDias = (d, n) => { const t = new Date(d + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const esFecha = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s)) && !isNaN(new Date(s + 'T12:00:00Z'));
const isInt = (v, min, max) => v != null && String(v).trim() !== '' && Number.isInteger(+v) && +v >= min && +v <= max;
const isNum = (v, min, max) => v != null && String(v).trim() !== '' && Number.isFinite(+v) && +v >= min && +v <= max;
const rol = (...r) => (req, res, next) => r.includes(req.user.rol) ? next() : res.status(403).json({ error: 'Permiso insuficiente' });
// Fecha del cliente (operaciones registradas sin conexión): se acepta si es de los últimos 3 días
function fechaCliente(v) {
  const t = v ? new Date(v) : null, now = Date.now();
  return (t && !isNaN(t) && t.getTime() <= now + 5 * 60000 && t.getTime() >= now - 3 * 86400000) ? t : new Date();
}
// Tasa usada en una operación: la del cliente solo si vino de la cola sin conexión y difiere menos de 10%
function tasaOp(body, t) {
  const c = parseFloat(body.tasa_cliente);
  return (body.offline === true && c > 0 && t > 0 && Math.abs(c - t) / t <= 0.10) ? c : t;
}
function hav(lat1, lon1, lat2, lon2) {
  const R = 6371000, r = x => x * Math.PI / 180;
  const dLat = r(lat2 - lat1), dLon = r(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---------- RIF (SENIAT): formato J-12345678-9 con dígito verificador (módulo 11) ----------
const RIF_LETRA = { V: 1, E: 2, J: 3, P: 4, G: 5 };
const RIF_PESOS = [4, 3, 2, 7, 6, 5, 4, 3, 2];
function normalizarRIF(s) {
  const t = String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const m = /^([VEJPG])(\d{8})(\d)$/.exec(t);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
function digitoRIF(letra, cuerpo) {
  const d = [RIF_LETRA[letra], ...String(cuerpo).split('').map(Number)];
  return ((11 - d.reduce((a, x, i) => a + x * RIF_PESOS[i], 0) % 11) % 11) % 10;
}
function rifValido(s) {
  const n = normalizarRIF(s); if (!n) return false;
  const [l, c, dv] = n.split('-'); return digitoRIF(l, c) === +dv;
}
const rifDe = (l, c8) => `${l}-${c8}-${digitoRIF(l, c8)}`;

function validarPDV(d) {
  if (!rifValido(d.rif)) return 'RIF inválido. Use el formato J-12345678-9 (letra V, E, J, P o G, 8 dígitos y dígito verificador correcto)';
  const n = String(d.nombre || '').trim();
  if (n.length < 2 || n.length > 120) return 'El nombre debe tener entre 2 y 120 caracteres';
  if (!isInt(d.zona_id, 1, 1e9)) return 'Seleccione una zona';
  if (!CANALES.includes(d.canal)) return 'Canal no válido';
  if (!isNum(d.lat, -90, 90) || !isNum(d.lng, -180, 180)) return 'Ubique el local en el mapa o use su ubicación actual';
  if (!isInt(d.geofence_radio_m, 10, 1000)) return 'El radio de geofence debe estar entre 10 y 1000 m';
  if (!isNum(d.limite_credito == null ? 0 : d.limite_credito, 0, 1e7)) return 'Límite de crédito inválido';
  if (!isInt(d.limite_pedidos, 1, 500)) return 'El límite de pedidos debe estar entre 1 y 500';
  if (!PERIODOS.includes(d.periodo_limite)) return 'Período del límite no válido';
  return null;
}

// ---------- Configuración fiscal y datos de la empresa (editable; los valores por defecto son referenciales) ----------
const FISC_DEF = { iva_general: 16, iva_reducida: 8, igtf_pct: 3, igtf_activo: 1, emp_razon: '', emp_rif: '', emp_dir: '', emp_tel: '', comp_prefijo: 'CMP' };
let _fisc = { t: 0, v: null };
async function fiscal() {
  if (_fisc.v && Date.now() - _fisc.t < 30000) return _fisc.v;
  const rows = (await sql`SELECT clave, valor FROM config WHERE LEFT(clave,5)='fisc_'`).rows, v = { ...FISC_DEF };
  for (const r of rows) {
    const k = r.clave.slice(5); if (!(k in FISC_DEF)) continue;
    v[k] = typeof FISC_DEF[k] === 'number' ? (parseFloat(r.valor) || 0) : r.valor;
  }
  _fisc = { t: Date.now(), v }; return v;
}
const pctIva = (f, tipo) => tipo === 'E' ? 0 : tipo === 'R' ? f.iva_reducida : f.iva_general;
const igtfRate = f => f.igtf_activo ? f.igtf_pct / 100 : 0;
// Período vigente de un límite de pedidos
function periodoDesde(dia, periodo) {
  if (periodo === 'Diario') return dia;
  if (periodo === 'Mensual') return dia.slice(0, 8) + '01';
  return addDias(dia, -((new Date(dia + 'T12:00:00Z').getUTCDay() + 6) % 7));   // lunes de la semana
}
async function usoPedidos(pdvId, dia, periodo) {
  const desde = periodoDesde(dia, periodo);
  const n = (await sql`SELECT COUNT(*)::int AS n FROM pedidos WHERE pdv_id=${pdvId} AND dia>=${desde} AND dia<=${dia} AND estado<>'Rechazado'`).rows[0].n;
  return { usados: n, desde };
}

// ---------- Bitácora ----------
async function log(user, accion, detalle = '') {
  try {
    await sql`INSERT INTO bitacora (fecha,usuario_id,usuario,accion,detalle) VALUES (${new Date().toISOString()},${(user && user.id) || null},${(user && user.nombre) || '-'},${accion},${String(detalle).slice(0, 300)})`;
  } catch (e) { console.warn('bitacora:', e.message); }
}

// ---------- Límite de intentos de login (memoria de la instancia) ----------
const intentos = new Map();
const lockKey = (req, u) => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '') + '|' + String(u || '').toLowerCase();
const estaBloqueado = k => { const e = intentos.get(k); return !!(e && e.hasta > Date.now()); };
function registrarFallo(k) {
  const e = intentos.get(k) || { n: 0, hasta: 0 };
  e.n++; if (e.n >= 5) { e.hasta = Date.now() + 10 * 60 * 1000; e.n = 0; }
  intentos.set(k, e);
}

// ---------- Tasa BCV ----------
async function getConfig(k) { const r = (await sql`SELECT valor FROM config WHERE clave=${k}`).rows[0]; return r ? r.valor : null; }
async function setConfig(k, v) { await sql`INSERT INTO config (clave,valor) VALUES (${k},${String(v)}) ON CONFLICT (clave) DO UPDATE SET valor=EXCLUDED.valor`; }
async function leerTasa() {
  return { tasa: parseFloat(await getConfig('tasa_bcv')) || 0, fecha: await getConfig('tasa_fecha'), fuente: (await getConfig('tasa_fuente')) || 'Pendiente' };
}
async function traerTasaBCV() {
  const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 6000);
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
  await setConfig('tasa_bcv', r.tasa); await setConfig('tasa_fecha', r.fecha); await setConfig('tasa_fuente', 'BCV');
  return leerTasa();
}
async function tasaVigente() {
  let t = await leerTasa();
  if (t.fuente === 'Manual') return t;
  const chk = await getConfig('tasa_chequeo');
  if (!chk || (Date.now() - new Date(chk).getTime()) > 3 * 3600 * 1000 || !(t.tasa > 0)) {
    try { t = await actualizarTasa(); } catch (e) { console.warn('BCV:', e.message); }
  }
  return t;
}

// ---------- Base de datos ----------
async function initDB() {
  await sql`CREATE TABLE IF NOT EXISTS config (clave TEXT PRIMARY KEY, valor TEXT)`;
  await sql`CREATE TABLE IF NOT EXISTS usuarios (id SERIAL PRIMARY KEY, nombre TEXT, cedula TEXT, usuario TEXT UNIQUE, password_hash TEXT, rol TEXT, zona_id INTEGER, activo INTEGER DEFAULT 1)`;
  await sql`CREATE TABLE IF NOT EXISTS zonas (id SERIAL PRIMARY KEY, nombre TEXT UNIQUE, color TEXT)`;
  await sql`CREATE TABLE IF NOT EXISTS pdvs (id SERIAL PRIMARY KEY, codigo TEXT UNIQUE, rif TEXT, razon_social TEXT, nombre TEXT, direccion TEXT, zona_id INTEGER, lat DOUBLE PRECISION, lng DOUBLE PRECISION, geofence_radio_m INTEGER DEFAULT 50, limite_credito DOUBLE PRECISION DEFAULT 0, limite_pedidos INTEGER DEFAULT 5, periodo_limite TEXT DEFAULT 'Semanal', canal TEXT DEFAULT 'Abasto/Bodega')`;
  await sql`CREATE TABLE IF NOT EXISTS productos (id SERIAL PRIMARY KEY, codigo TEXT UNIQUE, nombre TEXT, precio DOUBLE PRECISION, retornable INTEGER DEFAULT 0, tipo_envase TEXT, fecha_vencimiento TEXT, peso_kg DOUBLE PRECISION DEFAULT 1, stock_minimo INTEGER DEFAULT 0, activo INTEGER DEFAULT 1, alicuota TEXT DEFAULT 'G')`;
  await sql`CREATE TABLE IF NOT EXISTS promociones (id SERIAL PRIMARY KEY, nombre TEXT, producto_id INTEGER, tipo TEXT, min_cantidad INTEGER, descuento_pct DOUBLE PRECISION, activa INTEGER DEFAULT 1)`;
  await sql`CREATE TABLE IF NOT EXISTS pedidos (id SERIAL PRIMARY KEY, pdv_id INTEGER, usuario_id INTEGER, fecha TEXT, dia TEXT, subtotal DOUBLE PRECISION DEFAULT 0, descuento DOUBLE PRECISION DEFAULT 0, base_usd DOUBLE PRECISION, iva_usd DOUBLE PRECISION, igtf_usd DOUBLE PRECISION DEFAULT 0, total DOUBLE PRECISION, total_bs DOUBLE PRECISION, tasa DOUBLE PRECISION, estado TEXT DEFAULT 'Confirmado', metodo_pago TEXT, fecha_prometida TEXT, fecha_entrega TEXT, a_tiempo INTEGER, completo INTEGER, faltante_usd DOUBLE PRECISION DEFAULT 0, idem TEXT)`;
  await sql`CREATE TABLE IF NOT EXISTS pedido_items (id SERIAL PRIMARY KEY, pedido_id INTEGER, producto_id INTEGER, cantidad INTEGER, precio_unitario DOUBLE PRECISION, descuento_pct DOUBLE PRECISION DEFAULT 0, subtotal DOUBLE PRECISION, iva_pct DOUBLE PRECISION DEFAULT 0, iva_usd DOUBLE PRECISION DEFAULT 0, cantidad_entregada INTEGER)`;
  await sql`CREATE TABLE IF NOT EXISTS pedido_pagos (id SERIAL PRIMARY KEY, pedido_id INTEGER, metodo TEXT, moneda TEXT, monto DOUBLE PRECISION, monto_usd DOUBLE PRECISION, igtf_usd DOUBLE PRECISION DEFAULT 0, referencia TEXT)`;
  await sql`CREATE TABLE IF NOT EXISTS cobranzas (id SERIAL PRIMARY KEY, pdv_id INTEGER, usuario_id INTEGER, fecha TEXT, dia TEXT, metodo TEXT, moneda TEXT, monto DOUBLE PRECISION, monto_usd DOUBLE PRECISION, igtf_usd DOUBLE PRECISION DEFAULT 0, tasa DOUBLE PRECISION, referencia TEXT, idem TEXT)`;
  await sql`CREATE TABLE IF NOT EXISTS visitas (id SERIAL PRIMARY KEY, pdv_id INTEGER, usuario_id INTEGER, fecha_checkin TEXT, dia TEXT, lat DOUBLE PRECISION, lng DOUBLE PRECISION, distancia_m DOUBLE PRECISION, estado TEXT DEFAULT 'Efectiva', idem TEXT)`;
  await sql`CREATE TABLE IF NOT EXISTS activos_comodato (id SERIAL PRIMARY KEY, pdv_id INTEGER, codigo_qr TEXT UNIQUE, tipo TEXT, marca TEXT, fecha_instalacion TEXT, ultimo_mantenimiento TEXT)`;
  await sql`CREATE TABLE IF NOT EXISTS red_auditorias (id SERIAL PRIMARY KEY, pdv_id INTEGER, usuario_id INTEGER, cumplimiento_pct DOUBLE PRECISION, marca_propia_pct DOUBLE PRECISION, competencia_pct DOUBLE PRECISION, fecha TEXT, asignados INTEGER, propios INTEGER, competencia INTEGER, share_pct DOUBLE PRECISION, foto TEXT, observaciones TEXT)`;
  await sql`CREATE TABLE IF NOT EXISTS mermas (id SERIAL PRIMARY KEY, pdv_id INTEGER, producto_id INTEGER, cantidad INTEGER, causa TEXT, responsable TEXT, fecha TEXT, dia TEXT, descontar_stock INTEGER DEFAULT 0, idem TEXT)`;
  await sql`CREATE TABLE IF NOT EXISTS liquidaciones (id SERIAL PRIMARY KEY, usuario_id INTEGER, fecha TEXT, dia TEXT, tasa DOUBLE PRECISION, esperado_usd DOUBLE PRECISION, entregado_usd DOUBLE PRECISION, esperado_bs DOUBLE PRECISION, entregado_bs DOUBLE PRECISION, digital_usd DOUBLE PRECISION, credito_usd DOUBLE PRECISION, diferencia_usd DOUBLE PRECISION, observaciones TEXT, detalle TEXT)`;
  await sql`CREATE TABLE IF NOT EXISTS bitacora (id SERIAL PRIMARY KEY, fecha TEXT, usuario_id INTEGER, usuario TEXT, accion TEXT, detalle TEXT)`;
  await sql`CREATE TABLE IF NOT EXISTS proveedores (id SERIAL PRIMARY KEY, rif TEXT UNIQUE, nombre TEXT, razon_social TEXT, contacto TEXT, telefono TEXT, email TEXT, direccion TEXT, activo INTEGER DEFAULT 1, fecha_alta TEXT)`;
  await sql`CREATE TABLE IF NOT EXISTS lotes (id SERIAL PRIMARY KEY, producto_id INTEGER, codigo_lote TEXT, fecha_vencimiento TEXT, cantidad_inicial INTEGER, cantidad_actual INTEGER, fecha_ingreso TEXT, usuario_id INTEGER, proveedor_id INTEGER, costo_usd DOUBLE PRECISION, documento TEXT)`;
  await sql`CREATE TABLE IF NOT EXISTS movimientos_stock (id SERIAL PRIMARY KEY, producto_id INTEGER, lote_id INTEGER, tipo TEXT, cantidad INTEGER, referencia TEXT, usuario_id INTEGER, fecha TEXT)`;
  await sql`CREATE TABLE IF NOT EXISTS control_retornables (id SERIAL PRIMARY KEY, pdv_id INTEGER, pedido_id INTEGER, tipo TEXT, entregados INTEGER DEFAULT 0, recibidos INTEGER DEFAULT 0, fecha TEXT, dia TEXT, usuario_id INTEGER, idem TEXT)`;

  // Migración de bases creadas con versiones anteriores (conserva los datos)
  if ((await getConfig('schema_v')) !== SCHEMA_V) {
    const stmts = [
      sql`ALTER TABLE productos ADD COLUMN IF NOT EXISTS peso_kg DOUBLE PRECISION DEFAULT 1`, sql`ALTER TABLE productos ADD COLUMN IF NOT EXISTS stock_minimo INTEGER DEFAULT 0`,
      sql`ALTER TABLE productos ADD COLUMN IF NOT EXISTS activo INTEGER DEFAULT 1`, sql`ALTER TABLE productos ADD COLUMN IF NOT EXISTS alicuota TEXT DEFAULT 'G'`,
      sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS fecha_prometida TEXT`, sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS fecha_entrega TEXT`, sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS a_tiempo INTEGER`,
      sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS completo INTEGER`, sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS faltante_usd DOUBLE PRECISION DEFAULT 0`, sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS idem TEXT`,
      sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS base_usd DOUBLE PRECISION`, sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS iva_usd DOUBLE PRECISION`, sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS igtf_usd DOUBLE PRECISION DEFAULT 0`,
      sql`ALTER TABLE pedido_items ADD COLUMN IF NOT EXISTS cantidad_entregada INTEGER`, sql`ALTER TABLE pedido_items ADD COLUMN IF NOT EXISTS iva_pct DOUBLE PRECISION DEFAULT 0`, sql`ALTER TABLE pedido_items ADD COLUMN IF NOT EXISTS iva_usd DOUBLE PRECISION DEFAULT 0`,
      sql`ALTER TABLE pedido_pagos ADD COLUMN IF NOT EXISTS igtf_usd DOUBLE PRECISION DEFAULT 0`, sql`ALTER TABLE cobranzas ADD COLUMN IF NOT EXISTS igtf_usd DOUBLE PRECISION DEFAULT 0`,
      sql`ALTER TABLE cobranzas ADD COLUMN IF NOT EXISTS idem TEXT`, sql`ALTER TABLE visitas ADD COLUMN IF NOT EXISTS idem TEXT`,
      sql`ALTER TABLE mermas ADD COLUMN IF NOT EXISTS idem TEXT`, sql`ALTER TABLE mermas ADD COLUMN IF NOT EXISTS dia TEXT`, sql`ALTER TABLE mermas ADD COLUMN IF NOT EXISTS descontar_stock INTEGER DEFAULT 0`,
      sql`ALTER TABLE red_auditorias ADD COLUMN IF NOT EXISTS asignados INTEGER`, sql`ALTER TABLE red_auditorias ADD COLUMN IF NOT EXISTS propios INTEGER`, sql`ALTER TABLE red_auditorias ADD COLUMN IF NOT EXISTS competencia INTEGER`,
      sql`ALTER TABLE red_auditorias ADD COLUMN IF NOT EXISTS share_pct DOUBLE PRECISION`, sql`ALTER TABLE red_auditorias ADD COLUMN IF NOT EXISTS foto TEXT`, sql`ALTER TABLE red_auditorias ADD COLUMN IF NOT EXISTS observaciones TEXT`,
      sql`ALTER TABLE control_retornables ADD COLUMN IF NOT EXISTS dia TEXT`, sql`ALTER TABLE control_retornables ADD COLUMN IF NOT EXISTS usuario_id INTEGER`, sql`ALTER TABLE control_retornables ADD COLUMN IF NOT EXISTS idem TEXT`,
      sql`ALTER TABLE liquidaciones ADD COLUMN IF NOT EXISTS observaciones TEXT`, sql`ALTER TABLE liquidaciones ADD COLUMN IF NOT EXISTS detalle TEXT`,
      sql`ALTER TABLE pdvs ADD COLUMN IF NOT EXISTS rif TEXT`, sql`ALTER TABLE pdvs ADD COLUMN IF NOT EXISTS limite_pedidos INTEGER DEFAULT 5`, sql`ALTER TABLE pdvs ADD COLUMN IF NOT EXISTS periodo_limite TEXT DEFAULT 'Semanal'`,
      // Variables eliminadas del modelo: saldos y límites de envases, y todo lo relativo a cadena de frío
      sql`ALTER TABLE pdvs DROP COLUMN IF EXISTS saldo_cestas`, sql`ALTER TABLE pdvs DROP COLUMN IF EXISTS saldo_botellas`,
      sql`ALTER TABLE pdvs DROP COLUMN IF EXISTS limite_cestas`, sql`ALTER TABLE pdvs DROP COLUMN IF EXISTS limite_botellas`,
      sql`ALTER TABLE activos_comodato DROP COLUMN IF EXISTS temperatura_actual`, sql`ALTER TABLE activos_comodato DROP COLUMN IF EXISTS temp_min`, sql`ALTER TABLE activos_comodato DROP COLUMN IF EXISTS temp_max`,
      sql`DROP TABLE IF EXISTS cadena_frio`,
      sql`ALTER TABLE lotes ADD COLUMN IF NOT EXISTS proveedor_id INTEGER`, sql`ALTER TABLE lotes ADD COLUMN IF NOT EXISTS costo_usd DOUBLE PRECISION`, sql`ALTER TABLE lotes ADD COLUMN IF NOT EXISTS documento TEXT`
    ];
    for (const q of stmts) await q;
    await setConfig('schema_v', SCHEMA_V);
  }

  const check = await sql`SELECT COUNT(*) AS c FROM usuarios`;
  if (parseInt(check.rows[0].c) === 0) {
    const a = bcrypt.hashSync('admin123', 10), m = bcrypt.hashSync('maria123', 10), p = bcrypt.hashSync('pedro123', 10);
    await sql`INSERT INTO usuarios (nombre,usuario,password_hash,rol) VALUES ('Gerente','admin',${a},'Gerente'),('María','maria',${m},'Supervisor'),('Pedro','pedro',${p},'Preventista')`;
    await sql`INSERT INTO zonas (nombre,color) VALUES ('Centro','#0F766E'),('Bella Vista','#B45309'),('Las Pulgas','#B91C1C')`;
    await sql`INSERT INTO pdvs (codigo,rif,nombre,zona_id,lat,lng,limite_credito,limite_pedidos,periodo_limite,canal) VALUES
      ('PDV-0001',${rifDe('J', '30112233')},'Bodega Esperanza',1,10.6427,-71.6125,150,5,'Semanal','Abasto/Bodega'),
      ('PDV-0002',${rifDe('J', '29876543')},'Panadería Trigal',1,10.6450,-71.6150,100,3,'Semanal','Panadería'),
      ('PDV-0003',${rifDe('J', '31456789')},'Mayorista Pulgas',3,10.6472,-71.6565,500,10,'Semanal','Mayorista')`;
    await sql`INSERT INTO productos (codigo,nombre,precio,retornable,tipo_envase,peso_kg,stock_minimo,alicuota) VALUES
      ('REF-2L','Refresco 2L',1.80,1,'Botella',2.2,100,'G'),
      ('AGU-C12','Agua Cesta x12',6.50,1,'Cesta',14,50,'G'),
      ('JUG-1L','Jugo 1L',1.50,0,NULL,1.1,80,'G')`;
    await sql`INSERT INTO promociones (nombre,producto_id,tipo,min_cantidad,descuento_pct) VALUES
      ('Agua: 5 o más cestas, 10% de descuento',2,'Volumen',5,10),
      ('Refresco por vencer, 15% de descuento',1,'ShortDate',0,15)`;
    await sql`INSERT INTO activos_comodato (pdv_id,codigo_qr,tipo,marca,fecha_instalacion,ultimo_mantenimiento) VALUES
      (1,'QR-NEV-001','Nevera','Frigilux','2025-03-10','2026-08-15'),
      (2,'QR-EXH-002','Exhibidor','Imbera','2025-06-22','2026-07-01')`;
    await sql`INSERT INTO proveedores (rif,nombre,razon_social,contacto,telefono,email,direccion,fecha_alta) VALUES
      (${rifDe('J', '30445566')},'Embotelladora del Zulia','Embotelladora del Zulia, C.A.','Carlos Medina','0261-7000001','ventas@embotelladora.example','Zona Industrial, Maracaibo',${new Date().toISOString()}),
      (${rifDe('J', '29112233')},'Jugos Occidente','Distribuidora de Jugos Occidente, C.A.','Laura Pérez','0261-7000002','pedidos@jugos.example','Av. 5 de Julio, Maracaibo',${new Date().toISOString()})`;
    for (const [k, v] of Object.entries({ emp_razon: 'Distribuidora Maracaibo, C.A.', emp_rif: rifDe('J', '40123456'), emp_dir: 'Zona Industrial, Maracaibo, Estado Zulia', emp_tel: '0261-0000000', iva_general: 16, iva_reducida: 8, igtf_pct: 3, igtf_activo: 1, comp_prefijo: 'CMP' }))
      await setConfig('fisc_' + k, v);
    try { await actualizarTasa(); }
    catch (e) { console.warn('No se pudo obtener la tasa BCV inicial:', e.message); await setConfig('tasa_bcv', 0); await setConfig('tasa_fuente', 'Pendiente'); }
  }
  // Inventario de demostración si aún no hay lotes
  if (parseInt((await sql`SELECT COUNT(*) AS c FROM lotes`).rows[0].c) === 0) {
    const d = hoy(), now = new Date().toISOString();
    const provs = (await sql`SELECT id FROM proveedores ORDER BY id`).rows, costos = { 'REF-2L': 1.10, 'AGU-C12': 4.0, 'JUG-1L': 0.85 };
    for (const p of (await sql`SELECT id, codigo FROM productos ORDER BY id`).rows) {
      const prov = provs.length ? provs[p.codigo === 'JUG-1L' ? Math.min(1, provs.length - 1) : 0].id : null;
      const def = p.codigo === 'REF-2L' ? [['L-REF-01', addDias(d, 20), 200], ['L-REF-02', addDias(d, 120), 400]]
        : p.codigo === 'AGU-C12' ? [['L-AGU-01', addDias(d, 90), 150]] : [['L-JUG-01', addDias(d, 60), 300]];
      for (const [cod, venc, q] of def) {
        const l = (await sql`INSERT INTO lotes (producto_id,codigo_lote,fecha_vencimiento,cantidad_inicial,cantidad_actual,fecha_ingreso,proveedor_id,costo_usd) VALUES (${p.id},${cod},${venc},${q},${q},${now},${prov},${costos[p.codigo] || null}) RETURNING id`).rows[0];
        await sql`INSERT INTO movimientos_stock (producto_id,lote_id,tipo,cantidad,referencia,fecha) VALUES (${p.id},${l.id},'Entrada',${q},'Inventario inicial',${now})`;
      }
    }
  }
}

let ready = null;
app.use('/api', (req, res, next) => {
  if (!ready) ready = initDB();
  ready.then(() => next()).catch(e => {
    ready = null; console.error('initDB:', e);
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
  if (!usuario || !password || typeof usuario !== 'string' || typeof password !== 'string') throw fail(400, 'Ingrese usuario y contraseña');
  const k = lockKey(req, usuario);
  if (estaBloqueado(k)) throw fail(429, 'Demasiados intentos fallidos. Intente de nuevo en 10 minutos.');
  const u = (await sql`SELECT * FROM usuarios WHERE usuario = ${usuario.trim()} AND activo = 1`).rows[0];
  if (!u || !bcrypt.compareSync(password, u.password_hash)) {
    registrarFallo(k); await log({ id: u && u.id, nombre: usuario.trim() }, 'Inicio de sesión fallido');
    throw fail(401, 'Credenciales incorrectas');
  }
  intentos.delete(k);
  const token = jwt.sign({ id: u.id, nombre: u.nombre, rol: u.rol }, JWT_SECRET, { expiresIn: '8h' });
  await log(u, 'Inicio de sesión');
  res.json({ token, user: { id: u.id, nombre: u.nombre, rol: u.rol } });
}));

// ---------- Configuración y tasa ----------
app.get('/api/config', auth, h(async (req, res) => res.json({ metodos: METODOS, tasa: await tasaVigente(), fiscal: await fiscal() })));
app.get('/api/tasa', auth, h(async (req, res) => res.json(await tasaVigente())));
app.post('/api/tasa/actualizar', auth, rol('Gerente', 'Supervisor'), h(async (req, res) => {
  try { const t = await actualizarTasa(); await log(req.user, 'Tasa BCV actualizada', t.tasa); res.json(t); }
  catch (e) { throw fail(502, 'No se pudo consultar la tasa BCV: ' + e.message + '. Puede fijarla manualmente.'); }
}));
app.put('/api/tasa', auth, rol('Gerente', 'Supervisor'), h(async (req, res) => {
  const t = parseFloat(req.body.tasa);
  if (!(t > 0 && t < 1e7)) throw fail(400, 'Tasa inválida (debe ser mayor que 0)');
  await setConfig('tasa_bcv', t); await setConfig('tasa_fecha', new Date().toISOString()); await setConfig('tasa_fuente', 'Manual');
  await log(req.user, 'Tasa fijada manualmente', t);
  res.json(await leerTasa());
}));

// ---------- Empresa y parámetros fiscales ----------
app.get('/api/empresa', auth, rol('Gerente', 'Supervisor'), h(async (req, res) => res.json(await fiscal())));
app.put('/api/empresa', auth, rol('Gerente'), h(async (req, res) => {
  const d = req.body || {}, razon = String(d.emp_razon || '').trim(), prefijo = String(d.comp_prefijo || '').trim().toUpperCase();
  if (razon.length < 3 || razon.length > 120) throw fail(400, 'La razón social debe tener entre 3 y 120 caracteres');
  if (!rifValido(d.emp_rif)) throw fail(400, 'El RIF de la empresa no es válido (formato J-12345678-9 con dígito verificador correcto)');
  if (String(d.emp_dir || '').length > 200 || String(d.emp_tel || '').length > 30) throw fail(400, 'Dirección o teléfono demasiado largos');
  if (!/^[A-Z0-9]{2,6}$/.test(prefijo)) throw fail(400, 'El prefijo del comprobante debe tener de 2 a 6 letras o números');
  if (!isNum(d.iva_general, 0, 30) || !isNum(d.iva_reducida, 0, 30)) throw fail(400, 'Las alícuotas de IVA deben estar entre 0% y 30%');
  if (!isNum(d.igtf_pct, 0, 10)) throw fail(400, 'El IGTF debe estar entre 0% y 10%');
  const v = { emp_razon: razon, emp_rif: normalizarRIF(d.emp_rif), emp_dir: String(d.emp_dir || '').trim(), emp_tel: String(d.emp_tel || '').trim(), comp_prefijo: prefijo,
    iva_general: +d.iva_general, iva_reducida: +d.iva_reducida, igtf_pct: +d.igtf_pct, igtf_activo: d.igtf_activo ? 1 : 0 };
  for (const [k, val] of Object.entries(v)) await setConfig('fisc_' + k, val);
  _fisc = { t: 0, v: null };
  await log(req.user, 'Parámetros fiscales actualizados', `IVA ${v.iva_general}% / IGTF ${v.igtf_activo ? v.igtf_pct + '%' : 'inactivo'}`);
  res.json(await fiscal());
}));

// ---------- Zonas, productos y promociones ----------
app.get('/api/zonas', auth, h(async (req, res) =>
  res.json((await sql`SELECT z.*, (SELECT COUNT(*)::int FROM pdvs p WHERE p.zona_id=z.id) AS pdvs FROM zonas z ORDER BY z.id`).rows)));
function validarZona(d) {
  const n = String(d.nombre || '').trim();
  if (n.length < 2 || n.length > 40) return 'El nombre de la zona debe tener entre 2 y 40 caracteres';
  if (!/^#[0-9A-Fa-f]{6}$/.test(String(d.color || ''))) return 'Color inválido (formato #RRGGBB)';
  return null;
}
app.post('/api/zonas', auth, rol('Gerente', 'Supervisor'), h(async (req, res) => {
  const d = req.body || {}, err = validarZona(d); if (err) throw fail(400, err);
  try { const r = await sql`INSERT INTO zonas (nombre,color) VALUES (${String(d.nombre).trim()},${d.color}) RETURNING id`; await log(req.user, 'Zona creada', d.nombre); res.json({ id: r.rows[0].id }); }
  catch (e) { if (String(e.message).includes('duplicate')) throw fail(400, 'Ya existe una zona con ese nombre'); throw e; }
}));
app.put('/api/zonas/:id', auth, rol('Gerente', 'Supervisor'), h(async (req, res) => {
  const d = req.body || {}, err = validarZona(d); if (err) throw fail(400, err);
  try { await sql`UPDATE zonas SET nombre=${String(d.nombre).trim()}, color=${d.color} WHERE id=${+req.params.id}`; await log(req.user, 'Zona modificada', d.nombre); res.json({ ok: true }); }
  catch (e) { if (String(e.message).includes('duplicate')) throw fail(400, 'Ya existe una zona con ese nombre'); throw e; }
}));
app.delete('/api/zonas/:id', auth, rol('Gerente', 'Supervisor'), h(async (req, res) => {
  const id = +req.params.id;
  if ((await sql`SELECT COUNT(*)::int AS n FROM pdvs WHERE zona_id=${id}`).rows[0].n) throw fail(409, 'La zona tiene puntos de venta asignados; muévalos antes de eliminarla');
  await sql`DELETE FROM zonas WHERE id=${id}`; await log(req.user, 'Zona eliminada', 'id ' + id); res.json({ ok: true });
}));

async function listarProductos(todos) {
  const d = hoy(), lim = addDias(d, 30);
  return (await sql`SELECT p.*, COALESCE(s.stock,0)::int AS stock, COALESCE(s.corto,0)::int AS qty_corto, COALESCE(s.vencido,0)::int AS vencido, s.prox_venc
    FROM productos p LEFT JOIN (
      SELECT producto_id,
        SUM(CASE WHEN fecha_vencimiento IS NULL OR fecha_vencimiento >= ${d} THEN cantidad_actual ELSE 0 END) AS stock,
        SUM(CASE WHEN fecha_vencimiento IS NOT NULL AND fecha_vencimiento >= ${d} AND fecha_vencimiento <= ${lim} THEN cantidad_actual ELSE 0 END) AS corto,
        SUM(CASE WHEN fecha_vencimiento IS NOT NULL AND fecha_vencimiento < ${d} THEN cantidad_actual ELSE 0 END) AS vencido,
        MIN(CASE WHEN cantidad_actual > 0 AND (fecha_vencimiento IS NULL OR fecha_vencimiento >= ${d}) THEN fecha_vencimiento END) AS prox_venc
      FROM lotes GROUP BY producto_id) s ON s.producto_id = p.id
    WHERE (${todos} OR p.activo = 1) ORDER BY p.id`).rows;
}
app.get('/api/productos', auth, h(async (req, res) => res.json(await listarProductos(req.query.todos === '1' && ['Gerente', 'Supervisor'].includes(req.user.rol)))));

function validarProducto(d) {
  if (!/^[A-Za-z0-9._-]{2,20}$/.test(String(d.codigo || '').trim())) return 'Código inválido (2 a 20 caracteres: letras, números, punto o guion)';
  const n = String(d.nombre || '').trim(); if (n.length < 2 || n.length > 120) return 'El nombre debe tener entre 2 y 120 caracteres';
  if (!isNum(d.precio, 0.01, 1e6)) return 'El precio en USD (sin IVA) debe ser mayor que 0';
  if (!ALICUOTAS.includes(d.alicuota)) return 'Seleccione la alícuota de IVA (General, Reducida o Exento)';
  if (d.retornable && !['Cesta', 'Botella'].includes(d.tipo_envase)) return 'Indique el tipo de envase retornable (Cesta o Botella)';
  if (!isNum(d.peso_kg, 0.01, 10000)) return 'Peso inválido (kg)';
  if (!isInt(d.stock_minimo == null ? 0 : d.stock_minimo, 0, 1e6)) return 'Stock mínimo inválido';
  return null;
}
app.post('/api/productos', auth, rol('Gerente', 'Supervisor'), h(async (req, res) => {
  const d = req.body || {}, err = validarProducto(d); if (err) throw fail(400, err);
  try {
    const r = await sql`INSERT INTO productos (codigo,nombre,precio,retornable,tipo_envase,peso_kg,stock_minimo,alicuota) VALUES (${String(d.codigo).trim().toUpperCase()},${String(d.nombre).trim()},${+d.precio},${d.retornable ? 1 : 0},${d.retornable ? d.tipo_envase : null},${+d.peso_kg},${+d.stock_minimo || 0},${d.alicuota}) RETURNING id`;
    await log(req.user, 'Producto creado', d.codigo + ' ' + d.nombre); res.json({ id: r.rows[0].id });
  } catch (e) { if (String(e.message).includes('duplicate')) throw fail(400, 'Ya existe un producto con ese código'); throw e; }
}));
app.put('/api/productos/:id', auth, rol('Gerente', 'Supervisor'), h(async (req, res) => {
  const d = req.body || {}, id = +req.params.id, err = validarProducto(d); if (err) throw fail(400, err);
  if (!(await sql`SELECT 1 FROM productos WHERE id=${id}`).rows.length) throw fail(404, 'Producto no encontrado');
  try {
    await sql`UPDATE productos SET codigo=${String(d.codigo).trim().toUpperCase()}, nombre=${String(d.nombre).trim()}, precio=${+d.precio}, retornable=${d.retornable ? 1 : 0}, tipo_envase=${d.retornable ? d.tipo_envase : null}, peso_kg=${+d.peso_kg}, stock_minimo=${+d.stock_minimo || 0}, alicuota=${d.alicuota}, activo=${d.activo === false || d.activo === 0 ? 0 : 1} WHERE id=${id}`;
  } catch (e) { if (String(e.message).includes('duplicate')) throw fail(400, 'Ya existe otro producto con ese código'); throw e; }
  await log(req.user, 'Producto modificado', d.codigo + ' ' + d.nombre + ' ' + d.precio + ' USD'); res.json({ ok: true });
}));

app.get('/api/promociones', auth, h(async (req, res) => {
  const todas = req.query.todas === '1' && ['Gerente', 'Supervisor'].includes(req.user.rol);
  res.json((await sql`SELECT pr.*, p.nombre AS producto FROM promociones pr JOIN productos p ON pr.producto_id=p.id WHERE (${todas} OR pr.activa=1) ORDER BY pr.id`).rows);
}));
function validarPromo(d) {
  const n = String(d.nombre || '').trim(); if (n.length < 3 || n.length > 120) return 'El nombre debe tener entre 3 y 120 caracteres';
  if (!isInt(d.producto_id, 1, 1e9)) return 'Seleccione un producto';
  if (!['Volumen', 'ShortDate'].includes(d.tipo)) return 'Tipo de promoción no válido';
  if (d.tipo === 'Volumen' && !isInt(d.min_cantidad, 1, 9999)) return 'La cantidad mínima debe estar entre 1 y 9999';
  if (!isNum(d.descuento_pct, 1, 90)) return 'El descuento debe estar entre 1% y 90%';
  return null;
}
app.post('/api/promociones', auth, rol('Gerente', 'Supervisor'), h(async (req, res) => {
  const d = req.body || {}, err = validarPromo(d); if (err) throw fail(400, err);
  const r = await sql`INSERT INTO promociones (nombre,producto_id,tipo,min_cantidad,descuento_pct,activa) VALUES (${String(d.nombre).trim()},${+d.producto_id},${d.tipo},${d.tipo === 'Volumen' ? +d.min_cantidad : 0},${+d.descuento_pct},${d.activa === false ? 0 : 1}) RETURNING id`;
  await log(req.user, 'Promoción creada', d.nombre); res.json({ id: r.rows[0].id });
}));
app.put('/api/promociones/:id', auth, rol('Gerente', 'Supervisor'), h(async (req, res) => {
  const d = req.body || {}, id = +req.params.id, err = validarPromo(d); if (err) throw fail(400, err);
  await sql`UPDATE promociones SET nombre=${String(d.nombre).trim()}, producto_id=${+d.producto_id}, tipo=${d.tipo}, min_cantidad=${d.tipo === 'Volumen' ? +d.min_cantidad : 0}, descuento_pct=${+d.descuento_pct}, activa=${d.activa === false ? 0 : 1} WHERE id=${id}`;
  await log(req.user, 'Promoción modificada', d.nombre); res.json({ ok: true });
}));
app.delete('/api/promociones/:id', auth, rol('Gerente', 'Supervisor'), h(async (req, res) => {
  await sql`DELETE FROM promociones WHERE id=${+req.params.id}`; await log(req.user, 'Promoción eliminada', 'id ' + req.params.id); res.json({ ok: true });
}));

// ---------- PDVs ----------
app.get('/api/pdvs', auth, h(async (req, res) => {
  const zona = isInt(req.query.zona_id, 1, 1e9) ? +req.query.zona_id : null;
  res.json((await sql`SELECT p.*, z.nombre AS zona_nombre, COALESCE(z.color,'#64748B') AS zona_color FROM pdvs p LEFT JOIN zonas z ON p.zona_id = z.id
    WHERE (${zona}::int IS NULL OR p.zona_id=${zona}::int) ORDER BY p.id`).rows);
}));
app.get('/api/pdvs/:id/uso-pedidos', auth, h(async (req, res) => {
  const p = (await sql`SELECT limite_pedidos, periodo_limite FROM pdvs WHERE id=${+req.params.id}`).rows[0]; if (!p) throw fail(404, 'PDV no encontrado');
  const u = await usoPedidos(+req.params.id, hoy(), p.periodo_limite);
  res.json({ usados: u.usados, limite: p.limite_pedidos, periodo: p.periodo_limite, desde: u.desde });
}));
const datosPDV = d => ({ rif: normalizarRIF(d.rif), nombre: String(d.nombre).trim(), razon: String(d.razon_social || '').trim().slice(0, 150) || null, dir: String(d.direccion || '').trim().slice(0, 200) || null });
app.post('/api/pdvs', auth, h(async (req, res) => {
  const d = req.body || {}, err = validarPDV(d); if (err) throw fail(400, err);
  const x = datosPDV(d);
  const r = await sql`INSERT INTO pdvs (codigo,rif,razon_social,nombre,direccion,zona_id,lat,lng,geofence_radio_m,limite_credito,limite_pedidos,periodo_limite,canal)
    VALUES (${'TMP-' + crypto.randomBytes(4).toString('hex')},${x.rif},${x.razon},${x.nombre},${x.dir},${+d.zona_id},${+d.lat},${+d.lng},${+d.geofence_radio_m},${+d.limite_credito || 0},${+d.limite_pedidos},${d.periodo_limite},${d.canal}) RETURNING id`;
  const id = r.rows[0].id;
  await sql`UPDATE pdvs SET codigo=${'PDV-' + String(id).padStart(4, '0')} WHERE id=${id}`;   // código interno automático (la interfaz muestra el RIF)
  await log(req.user, 'PDV creado', x.rif + ' ' + x.nombre); res.json({ id });
}));
app.put('/api/pdvs/:id', auth, h(async (req, res) => {
  const d = req.body || {}, id = +req.params.id, err = validarPDV(d); if (err) throw fail(400, err);
  if (!(await sql`SELECT 1 FROM pdvs WHERE id=${id}`).rows.length) throw fail(404, 'PDV no encontrado');
  const x = datosPDV(d);
  await sql`UPDATE pdvs SET rif=${x.rif}, razon_social=${x.razon}, nombre=${x.nombre}, direccion=${x.dir}, zona_id=${+d.zona_id}, lat=${+d.lat}, lng=${+d.lng}, geofence_radio_m=${+d.geofence_radio_m},
    limite_credito=${+d.limite_credito || 0}, limite_pedidos=${+d.limite_pedidos}, periodo_limite=${d.periodo_limite}, canal=${d.canal} WHERE id=${id}`;
  await log(req.user, 'PDV modificado', x.rif + ' ' + x.nombre); res.json({ ok: true });
}));
app.delete('/api/pdvs/:id', auth, rol('Gerente', 'Supervisor'), h(async (req, res) => {
  const id = +req.params.id;
  const u = (await sql`SELECT (SELECT COUNT(*) FROM pedidos WHERE pdv_id=${id}) AS p, (SELECT COUNT(*) FROM visitas WHERE pdv_id=${id}) AS v, (SELECT COUNT(*) FROM cobranzas WHERE pdv_id=${id}) AS c`).rows[0];
  if (+u.p || +u.v || +u.c) throw fail(409, 'El PDV tiene historial (pedidos, visitas o cobranzas) y no puede eliminarse');
  await sql`DELETE FROM activos_comodato WHERE pdv_id=${id}`; await sql`DELETE FROM pdvs WHERE id=${id}`;
  await log(req.user, 'PDV eliminado', 'id ' + id); res.json({ ok: true });
}));

// ---------- Visitas / Geofencing ----------
app.post('/api/visitas/checkin', auth, h(async (req, res) => {
  const { pdv_id, lat, lng, idem } = req.body || {};
  if (idem) { const ex = (await sql`SELECT id, distancia_m FROM visitas WHERE idem=${String(idem)}`).rows[0]; if (ex) return res.json({ id: ex.id, distancia_m: Math.round(ex.distancia_m), duplicado: true }); }
  const pdv = (await sql`SELECT * FROM pdvs WHERE id = ${pdv_id}`).rows[0];
  if (!pdv) throw fail(404, 'PDV no encontrado');
  if (!isNum(lat, -90, 90) || !isNum(lng, -180, 180)) throw fail(400, 'Coordenadas inválidas');
  const dist = hav(lat, lng, pdv.lat, pdv.lng);
  if (dist > pdv.geofence_radio_m) throw fail(400, `Está a ${Math.round(dist)} m (máximo ${pdv.geofence_radio_m} m).`);
  const f = fechaCliente(req.body.fecha_cliente);
  const r = await sql`INSERT INTO visitas (pdv_id,usuario_id,fecha_checkin,dia,lat,lng,distancia_m,idem) VALUES (${pdv_id},${req.user.id},${f.toISOString()},${diaDe(f)},${lat},${lng},${dist},${idem ? String(idem) : null}) RETURNING id`;
  res.json({ id: r.rows[0].id, distancia_m: Math.round(dist) });
}));
app.get('/api/visitas', auth, h(async (req, res) =>
  res.json((await sql`SELECT v.*, p.nombre AS pdv_nombre, COALESCE(u.nombre,'-') AS vendedor FROM visitas v JOIN pdvs p ON v.pdv_id=p.id LEFT JOIN usuarios u ON v.usuario_id=u.id ORDER BY v.id DESC LIMIT 50`).rows)));

// ---------- Inventario: lotes, FIFO y vencimientos ----------
// Descuenta del stock por FIFO (primero lo que vence antes). Si no alcanza, revierte y falla.
async function consumirFIFO(prodId, cant, d, incluirVencidos) {
  const lotes = (incluirVencidos
    ? await sql`SELECT id, cantidad_actual, fecha_vencimiento FROM lotes WHERE producto_id=${prodId} AND cantidad_actual>0 ORDER BY fecha_vencimiento ASC NULLS LAST, id`
    : await sql`SELECT id, cantidad_actual, fecha_vencimiento FROM lotes WHERE producto_id=${prodId} AND cantidad_actual>0 AND (fecha_vencimiento IS NULL OR fecha_vencimiento>=${d}) ORDER BY fecha_vencimiento ASC NULLS LAST, id`).rows;
  let falta = cant; const usados = [];
  for (const l of lotes) {
    if (falta <= 0) break;
    const q = Math.min(l.cantidad_actual, falta);
    const r = await sql`UPDATE lotes SET cantidad_actual = cantidad_actual - ${q} WHERE id=${l.id} AND cantidad_actual >= ${q} RETURNING id`;
    if (!r.rows.length) continue;           // otro proceso tomó ese lote: se intenta con el siguiente
    usados.push({ lote_id: l.id, cantidad: q }); falta -= q;
  }
  if (falta > 0) { await devolverLotes(usados); throw fail(409, 'Stock insuficiente'); }
  return usados;
}
const devolverLotes = async us => { for (const u of us) await sql`UPDATE lotes SET cantidad_actual = cantidad_actual + ${u.cantidad} WHERE id=${u.lote_id}`; };
const movStock = (prodId, loteId, tipo, cant, ref, uid) =>
  sql`INSERT INTO movimientos_stock (producto_id,lote_id,tipo,cantidad,referencia,usuario_id,fecha) VALUES (${prodId},${loteId},${tipo},${cant},${String(ref || '').slice(0, 120)},${uid || null},${new Date().toISOString()})`;

app.get('/api/inventario', auth, h(async (req, res) => {
  const productos = await listarProductos(true);
  const lotes = (await sql`SELECT l.*, p.nombre AS producto, pv.nombre AS proveedor, pv.rif AS proveedor_rif FROM lotes l JOIN productos p ON p.id=l.producto_id LEFT JOIN proveedores pv ON pv.id=l.proveedor_id WHERE l.cantidad_actual>0 ORDER BY l.fecha_vencimiento ASC NULLS LAST, l.id LIMIT 300`).rows;
  res.json({ productos, lotes, hoy: hoy(), limite: addDias(hoy(), 30) });
}));
app.get('/api/inventario/movimientos', auth, rol('Gerente', 'Supervisor'), h(async (req, res) =>
  res.json((await sql`SELECT m.*, p.nombre AS producto, l.codigo_lote, COALESCE(u.nombre,'-') AS usuario FROM movimientos_stock m JOIN productos p ON p.id=m.producto_id LEFT JOIN lotes l ON l.id=m.lote_id LEFT JOIN usuarios u ON u.id=m.usuario_id ORDER BY m.id DESC LIMIT 100`).rows)));
app.post('/api/inventario/entrada', auth, rol('Gerente', 'Supervisor'), h(async (req, res) => {
  const { producto_id, proveedor_id, codigo_lote, fecha_vencimiento, cantidad, costo_usd, documento } = req.body || {};
  if (!isInt(producto_id, 1, 1e9)) throw fail(400, 'Seleccione un producto');
  if (!isInt(cantidad, 1, 1e6)) throw fail(400, 'Cantidad inválida (entero entre 1 y 1.000.000)');
  const cod = String(codigo_lote || '').trim(); if (cod.length < 1 || cod.length > 30) throw fail(400, 'Código de lote obligatorio (máximo 30 caracteres)');
  let venc = null;
  if (fecha_vencimiento) { if (!esFecha(fecha_vencimiento)) throw fail(400, 'Fecha de vencimiento inválida'); if (fecha_vencimiento < hoy()) throw fail(400, 'La fecha de vencimiento ya pasó'); venc = fecha_vencimiento; }
  const p = (await sql`SELECT nombre FROM productos WHERE id=${+producto_id}`).rows[0]; if (!p) throw fail(404, 'Producto no encontrado');
  let prov = null;
  if (proveedor_id != null && proveedor_id !== '') {
    if (!isInt(proveedor_id, 1, 1e9)) throw fail(400, 'Proveedor inválido');
    prov = (await sql`SELECT id, nombre, activo FROM proveedores WHERE id=${+proveedor_id}`).rows[0];
    if (!prov) throw fail(404, 'Proveedor no encontrado'); if (!prov.activo) throw fail(400, 'El proveedor está inactivo');
  } else if ((await sql`SELECT COUNT(*)::int AS n FROM proveedores WHERE activo=1`).rows[0].n > 0) throw fail(400, 'Seleccione el proveedor de la mercancía');
  let costo = null;
  if (costo_usd != null && costo_usd !== '') { if (!isNum(costo_usd, 0, 1e6)) throw fail(400, 'Costo unitario inválido (USD)'); costo = +costo_usd; }
  const doc = String(documento || '').trim().slice(0, 30) || null;
  const l = (await sql`INSERT INTO lotes (producto_id,codigo_lote,fecha_vencimiento,cantidad_inicial,cantidad_actual,fecha_ingreso,usuario_id,proveedor_id,costo_usd,documento)
    VALUES (${+producto_id},${cod},${venc},${+cantidad},${+cantidad},${new Date().toISOString()},${req.user.id},${prov ? prov.id : null},${costo},${doc}) RETURNING id`).rows[0];
  await movStock(+producto_id, l.id, 'Entrada', +cantidad, 'Lote ' + cod + (prov ? ' · ' + prov.nombre : ''), req.user.id);
  await log(req.user, 'Entrada de inventario', `${p.nombre} lote ${cod} x${cantidad}${prov ? ' (' + prov.nombre + ')' : ''}`); res.json({ id: l.id });
}));
app.post('/api/inventario/ajuste', auth, rol('Gerente', 'Supervisor'), h(async (req, res) => {
  const { lote_id, cantidad_nueva, motivo } = req.body || {};
  if (!isInt(lote_id, 1, 1e9) || !isInt(cantidad_nueva, 0, 1e6)) throw fail(400, 'Datos de ajuste inválidos');
  if (String(motivo || '').trim().length < 3) throw fail(400, 'Indique el motivo del ajuste');
  const l = (await sql`SELECT * FROM lotes WHERE id=${+lote_id}`).rows[0]; if (!l) throw fail(404, 'Lote no encontrado');
  const delta = +cantidad_nueva - l.cantidad_actual; if (delta === 0) throw fail(400, 'La cantidad no cambia');
  await sql`UPDATE lotes SET cantidad_actual=${+cantidad_nueva} WHERE id=${l.id}`;
  await movStock(l.producto_id, l.id, 'Ajuste', delta, String(motivo).trim(), req.user.id);
  await log(req.user, 'Ajuste de inventario', `lote ${l.codigo_lote}: ${l.cantidad_actual} a ${cantidad_nueva} (${String(motivo).trim()})`); res.json({ ok: true });
}));

// ---------- Proveedores ----------
const reEmail = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function validarProveedor(d) {
  if (!rifValido(d.rif)) return 'RIF inválido. Use el formato J-12345678-9 (letra V, E, J, P o G, 8 dígitos y dígito verificador correcto)';
  const n = String(d.nombre || '').trim(); if (n.length < 2 || n.length > 120) return 'El nombre debe tener entre 2 y 120 caracteres';
  if (String(d.razon_social || '').length > 150) return 'La razón social es demasiado larga (máximo 150 caracteres)';
  if (String(d.contacto || '').length > 80) return 'El contacto es demasiado largo (máximo 80 caracteres)';
  if (!/^[0-9+()\-\s]{0,30}$/.test(String(d.telefono || ''))) return 'Teléfono inválido (solo números, espacios, +, guion y paréntesis)';
  if (d.email && !reEmail.test(String(d.email).trim())) return 'Correo electrónico inválido';
  if (String(d.direccion || '').length > 200) return 'La dirección es demasiado larga (máximo 200 caracteres)';
  return null;
}
const datosProv = d => [normalizarRIF(d.rif), String(d.nombre).trim(), String(d.razon_social || '').trim() || null, String(d.contacto || '').trim() || null, String(d.telefono || '').trim() || null, String(d.email || '').trim().toLowerCase() || null, String(d.direccion || '').trim() || null];
app.get('/api/proveedores', auth, rol('Gerente', 'Supervisor'), h(async (req, res) =>
  res.json((await sql`SELECT pv.*, COALESCE(s.lotes,0)::int AS lotes, COALESCE(s.unidades,0)::int AS unidades, COALESCE(s.compras,0)::float AS compras_usd, s.ultima
    FROM proveedores pv LEFT JOIN (SELECT proveedor_id, COUNT(*) AS lotes, SUM(cantidad_inicial) AS unidades, SUM(cantidad_inicial * COALESCE(costo_usd,0)) AS compras, MAX(fecha_ingreso) AS ultima
      FROM lotes WHERE proveedor_id IS NOT NULL GROUP BY proveedor_id) s ON s.proveedor_id = pv.id ORDER BY pv.nombre`).rows)));
app.post('/api/proveedores', auth, rol('Gerente', 'Supervisor'), h(async (req, res) => {
  const d = req.body || {}, err = validarProveedor(d); if (err) throw fail(400, err);
  const [rif, nombre, razon, contacto, tel, email, dir] = datosProv(d);
  try {
    const r = await sql`INSERT INTO proveedores (rif,nombre,razon_social,contacto,telefono,email,direccion,fecha_alta) VALUES (${rif},${nombre},${razon},${contacto},${tel},${email},${dir},${new Date().toISOString()}) RETURNING id`;
    await log(req.user, 'Proveedor creado', rif + ' ' + nombre); res.json({ id: r.rows[0].id });
  } catch (e) { if (String(e.message).includes('duplicate')) throw fail(400, 'Ya existe un proveedor con ese RIF'); throw e; }
}));
app.put('/api/proveedores/:id', auth, rol('Gerente', 'Supervisor'), h(async (req, res) => {
  const id = +req.params.id, d = req.body || {}, err = validarProveedor(d); if (err) throw fail(400, err);
  if (!(await sql`SELECT 1 FROM proveedores WHERE id=${id}`).rows.length) throw fail(404, 'Proveedor no encontrado');
  const [rif, nombre, razon, contacto, tel, email, dir] = datosProv(d);
  try {
    await sql`UPDATE proveedores SET rif=${rif}, nombre=${nombre}, razon_social=${razon}, contacto=${contacto}, telefono=${tel}, email=${email}, direccion=${dir}, activo=${d.activo === false || d.activo === 0 ? 0 : 1} WHERE id=${id}`;
  } catch (e) { if (String(e.message).includes('duplicate')) throw fail(400, 'Ya existe otro proveedor con ese RIF'); throw e; }
  await log(req.user, 'Proveedor modificado', rif + ' ' + nombre); res.json({ ok: true });
}));
app.delete('/api/proveedores/:id', auth, rol('Gerente', 'Supervisor'), h(async (req, res) => {
  const id = +req.params.id;
  if ((await sql`SELECT COUNT(*)::int AS n FROM lotes WHERE proveedor_id=${id}`).rows[0].n) throw fail(409, 'El proveedor tiene entradas de mercancía registradas. Desactívelo en lugar de eliminarlo.');
  await sql`DELETE FROM proveedores WHERE id=${id}`; await log(req.user, 'Proveedor eliminado', 'id ' + id); res.json({ ok: true });
}));
app.get('/api/proveedores/:id/entradas', auth, rol('Gerente', 'Supervisor'), h(async (req, res) =>
  res.json((await sql`SELECT l.id, l.codigo_lote, l.fecha_vencimiento, l.cantidad_inicial, l.cantidad_actual, l.costo_usd, l.documento, l.fecha_ingreso, p.nombre AS producto
    FROM lotes l JOIN productos p ON p.id=l.producto_id WHERE l.proveedor_id=${+req.params.id} ORDER BY l.id DESC LIMIT 100`).rows)));

// ---------- Venta sugerida ----------
app.get('/api/smart-order/:id', auth, h(async (req, res) => {
  const id = +req.params.id, prods = await listarProductos(false), byId = Object.fromEntries(prods.map(p => [p.id, p]));
  const hist = (await sql`SELECT pi.producto_id, pi.cantidad, pe.id AS pedido FROM pedido_items pi JOIN pedidos pe ON pe.id=pi.pedido_id WHERE pe.pdv_id=${id} ORDER BY pe.id DESC LIMIT 80`).rows;
  const orden = [...new Set(hist.map(x => x.pedido))], acc = {};
  for (const x of hist) { const w = 1 / (1 + orden.indexOf(x.pedido)); const a = acc[x.producto_id] || (acc[x.producto_id] = { sw: 0, sq: 0, n: 0 }); a.sw += w; a.sq += w * x.cantidad; a.n++; }
  const out = [];
  for (const [pid, a] of Object.entries(acc)) { const p = byId[pid]; if (p && p.stock > 0) out.push({ producto_id: +pid, nombre: p.nombre, cantidad_sugerida: Math.min(p.stock, Math.max(1, Math.round(a.sq / a.sw))), origen: 'historial', frecuencia: a.n, por_vencer: p.qty_corto > 0, stock: p.stock }); }
  const canal = (await sql`SELECT pi.producto_id, ROUND(AVG(pi.cantidad))::int AS q, COUNT(*)::int AS n FROM pedido_items pi JOIN pedidos pe ON pe.id=pi.pedido_id JOIN pdvs pd ON pd.id=pe.pdv_id
    WHERE pd.canal=(SELECT canal FROM pdvs WHERE id=${id}) AND pe.pdv_id<>${id} GROUP BY pi.producto_id ORDER BY n DESC LIMIT 5`).rows;
  for (const c of canal) { const p = byId[c.producto_id]; if (p && p.stock > 0 && !acc[c.producto_id]) out.push({ producto_id: c.producto_id, nombre: p.nombre, cantidad_sugerida: Math.min(p.stock, Math.max(1, c.q)), origen: 'canal', frecuencia: c.n, por_vencer: p.qty_corto > 0, stock: p.stock }); }
  out.sort((a, b) => (b.por_vencer - a.por_vencer) || (b.frecuencia - a.frecuencia));
  res.json(out.slice(0, 6));
}));

// ---------- Cuentas por cobrar y pagos ----------
async function saldoCxC(pdvId) {
  const r = await sql`SELECT
    COALESCE((SELECT SUM(pg.monto_usd) FROM pedido_pagos pg JOIN pedidos pe ON pg.pedido_id=pe.id WHERE pe.pdv_id=${pdvId} AND pg.metodo='Crédito'),0)
    - COALESCE((SELECT SUM(c.monto_usd) FROM cobranzas c WHERE c.pdv_id=${pdvId}),0) AS s`;
  return parseFloat(r.rows[0].s) || 0;
}
// El monto que ingresa el cajero es lo recibido. En divisas incluye el IGTF:
// aplicado a la factura = monto / (1 + IGTF); IGTF = monto - aplicado.
function normalizarPagos(pagos, tasa, f) {
  if (!Array.isArray(pagos) || !pagos.length) throw fail(400, 'Debe registrar al menos un pago');
  const g = igtfRate(f);
  return pagos.map(p => {
    const m = MET[p.metodo]; if (!m) throw fail(400, 'Método de pago no válido: ' + p.metodo);
    const monto = parseFloat(p.monto); if (!(monto > 0)) throw fail(400, 'Monto inválido en ' + p.metodo);
    const ref = String(p.referencia || '').trim().slice(0, 30);
    if (m.ref && ref.length < 4) throw fail(400, 'El método ' + p.metodo + ' requiere referencia (mínimo 4 caracteres)');
    const divisa = m.moneda === 'USD' && m.nombre !== 'Crédito';
    const aplicado = m.moneda === 'USD' ? (divisa ? monto / (1 + g) : monto) : monto / tasa;
    return { metodo: m.nombre, moneda: m.moneda, monto, monto_usd: aplicado, igtf_usd: divisa ? monto - aplicado : 0, referencia: ref || null };
  });
}

// ---------- Pedidos ----------
app.post('/api/pedidos', auth, h(async (req, res) => {
  const body = req.body || {}, { pdv_id, items, pagos, idem } = body;
  if (idem) {
    const ex = (await sql`SELECT id, subtotal, descuento, base_usd, iva_usd, igtf_usd, total, total_bs, tasa FROM pedidos WHERE idem=${String(idem)}`).rows[0];
    if (ex) return res.json({ ...ex, pagos: [], duplicado: true });
  }
  if (!Array.isArray(items) || !items.length) throw fail(400, 'Pedido vacío');
  const agg = new Map();
  for (const it of items) {
    if (!isInt(it.producto_id, 1, 1e9) || !isInt(it.cantidad, 1, 9999)) throw fail(400, 'Cantidad inválida (entero entre 1 y 9999)');
    agg.set(+it.producto_id, (agg.get(+it.producto_id) || 0) + +it.cantidad);
  }
  for (const q of agg.values()) if (q > 9999) throw fail(400, 'La cantidad total por producto no puede superar 9999');
  const tServ = (await tasaVigente()).tasa;
  if (!(tServ > 0)) throw fail(400, 'No hay tasa BCV configurada. Actualícela o fíjela manualmente.');
  const tasa = tasaOp(body, tServ), f = await fiscal();
  const pdv = (await sql`SELECT * FROM pdvs WHERE id = ${pdv_id}`).rows[0];
  if (!pdv) throw fail(404, 'PDV no encontrado');

  const fcli = fechaCliente(body.fecha_cliente), dia = diaDe(fcli), hoyD = hoy(), lim = addDias(hoyD, 30);
  // Límite de pedidos por cliente y período
  const uso = await usoPedidos(pdv.id, dia, pdv.periodo_limite);
  if (uso.usados >= pdv.limite_pedidos)
    throw fail(429, `LÍMITE DE PEDIDOS: ${pdv.nombre} ya registró ${uso.usados} de ${pdv.limite_pedidos} pedidos permitidos (${pdv.periodo_limite.toLowerCase()}, desde ${uso.desde}).`);

  const promos = (await sql`SELECT * FROM promociones WHERE activa=1`).rows;
  let subtotal = 0, descuento = 0, base = 0, iva = 0; const lineas = [];
  for (const [pid, cant] of agg) {
    const p = (await sql`SELECT * FROM productos WHERE id=${pid} AND activo=1`).rows[0]; if (!p) throw fail(400, 'Producto no disponible');
    const st = (await sql`SELECT COALESCE(SUM(cantidad_actual),0)::int AS stock,
      COALESCE(SUM(CASE WHEN fecha_vencimiento IS NOT NULL AND fecha_vencimiento<=${lim} THEN cantidad_actual ELSE 0 END),0)::int AS corto
      FROM lotes WHERE producto_id=${pid} AND cantidad_actual>0 AND (fecha_vencimiento IS NULL OR fecha_vencimiento>=${hoyD})`).rows[0];
    if (cant > st.stock) throw fail(409, `Stock insuficiente de ${p.nombre}: disponible ${st.stock}, solicitado ${cant}`);
    const sub = r2(p.precio * cant);
    const pv = promos.find(x => x.producto_id === p.id && x.tipo === 'Volumen' && cant >= x.min_cantidad);
    const ps = promos.find(x => x.producto_id === p.id && x.tipo === 'ShortDate');
    const desc = r2(Math.min(sub, sub * (pv ? pv.descuento_pct : 0) / 100 + (ps ? Math.min(cant, st.corto) * p.precio * ps.descuento_pct / 100 : 0)));
    const lineBase = r2(sub - desc), pct = pctIva(f, p.alicuota), lineIva = r2(lineBase * pct / 100);
    lineas.push({ p, cant, sub, desc, lineBase, pct, lineIva, dpct: sub ? desc / sub * 100 : 0 });
    subtotal += sub; descuento += desc; base += lineBase; iva += lineIva;
  }
  subtotal = r2(subtotal); descuento = r2(descuento); base = r2(base); iva = r2(iva);
  const total = r2(base + iva), totalBs = r2(total * tasa);

  const lista = normalizarPagos(pagos, tasa, f);
  const pagado = lista.reduce((s, x) => s + x.monto_usd, 0), igtf = r2(lista.reduce((s, x) => s + x.igtf_usd, 0));
  if (Math.abs(pagado - total) > 0.02) throw fail(400, `Los pagos aplicados (${r2(pagado)} USD) no coinciden con el total del pedido (${total} USD)`);
  const credito = lista.filter(x => x.metodo === 'Crédito').reduce((s, x) => s + x.monto_usd, 0);
  if (credito > 0) {
    const saldo = await saldoCxC(pdv_id), disp = r2((pdv.limite_credito || 0) - saldo);
    if (credito > disp + 0.001) throw fail(400, `Crédito solicitado ${r2(credito)} USD; disponible ${Math.max(0, disp)} USD (saldo pendiente ${r2(saldo)} USD, límite ${pdv.limite_credito || 0} USD)`);
  }

  const resumen = [...new Set(lista.map(x => x.metodo))].join(' + ');
  const pid = (await sql`INSERT INTO pedidos (pdv_id,usuario_id,fecha,dia,subtotal,descuento,base_usd,iva_usd,igtf_usd,total,total_bs,tasa,metodo_pago,fecha_prometida,idem)
    VALUES (${pdv_id},${req.user.id},${fcli.toISOString()},${dia},${subtotal},${descuento},${base},${iva},${igtf},${total},${totalBs},${tasa},${resumen},${addDias(dia, 1)},${idem ? String(idem) : null}) RETURNING id`).rows[0].id;

  const asign = [];
  try { for (const l of lineas) asign.push({ l, us: await consumirFIFO(l.p.id, l.cant, hoyD, false) }); }
  catch (e) {
    for (const a of asign) await devolverLotes(a.us);
    await sql`DELETE FROM pedidos WHERE id=${pid}`;
    throw fail(409, 'No se pudo reservar el stock (otro pedido lo tomó). Intente de nuevo.');
  }
  for (const { l, us } of asign) {
    await sql`INSERT INTO pedido_items (pedido_id,producto_id,cantidad,precio_unitario,descuento_pct,subtotal,iva_pct,iva_usd) VALUES (${pid},${l.p.id},${l.cant},${l.p.precio},${r2(l.dpct)},${l.lineBase},${l.pct},${l.lineIva})`;
    for (const u of us) await movStock(l.p.id, u.lote_id, 'Venta', -u.cantidad, 'Pedido ' + pid, req.user.id);
    if (l.p.retornable && ['Cesta', 'Botella'].includes(l.p.tipo_envase))
      await sql`INSERT INTO control_retornables (pdv_id,pedido_id,tipo,entregados,recibidos,fecha,dia,usuario_id) VALUES (${pdv_id},${pid},${l.p.tipo_envase},${l.cant},0,${fcli.toISOString()},${dia},${req.user.id})`;
  }
  for (const g of lista) await sql`INSERT INTO pedido_pagos (pedido_id,metodo,moneda,monto,monto_usd,igtf_usd,referencia) VALUES (${pid},${g.metodo},${g.moneda},${g.monto},${r2(g.monto_usd)},${r2(g.igtf_usd)},${g.referencia})`;
  await log(req.user, 'Pedido registrado', `#${pid} ${pdv.nombre} ${total} USD (${resumen})`);
  res.json({ id: pid, subtotal, descuento, base_usd: base, iva_usd: iva, igtf_usd: igtf, total, total_bs: totalBs, tasa, pagos: lista });
}));

app.get('/api/pedidos', auth, h(async (req, res) => {
  const solo = req.user.rol === 'Preventista' ? req.user.id : null;
  const pedidos = (await sql`SELECT pe.*, p.nombre AS pdv_nombre, p.rif, COALESCE(u.nombre,'-') AS vendedor FROM pedidos pe JOIN pdvs p ON pe.pdv_id=p.id LEFT JOIN usuarios u ON pe.usuario_id=u.id
    WHERE pe.dia = ${hoy()} AND (${solo}::int IS NULL OR pe.usuario_id=${solo}::int) ORDER BY pe.id DESC LIMIT 100`).rows;
  for (const pe of pedidos) {
    pe.items = (await sql`SELECT pi.*, pr.nombre FROM pedido_items pi JOIN productos pr ON pi.producto_id=pr.id WHERE pi.pedido_id=${pe.id}`).rows;
    pe.pagos = (await sql`SELECT metodo, moneda, monto, monto_usd, referencia FROM pedido_pagos WHERE pedido_id=${pe.id}`).rows;
  }
  res.json(pedidos);
}));

// ---------- Comprobante de pedido (datos validados para el PDF) ----------
app.get('/api/pedidos/:id/comprobante', auth, h(async (req, res) => {
  const id = +req.params.id, f = await fiscal();
  const pe = (await sql`SELECT * FROM pedidos WHERE id=${id}`).rows[0]; if (!pe) throw fail(404, 'Pedido no encontrado');
  const pdv = (await sql`SELECT * FROM pdvs WHERE id=${pe.pdv_id}`).rows[0];
  const items = (await sql`SELECT pi.*, pr.nombre, pr.codigo FROM pedido_items pi JOIN productos pr ON pr.id=pi.producto_id WHERE pi.pedido_id=${id} ORDER BY pi.id`).rows;
  const pagos = (await sql`SELECT metodo, moneda, monto, monto_usd, igtf_usd, referencia FROM pedido_pagos WHERE pedido_id=${id} ORDER BY id`).rows;
  const fallos = [], ok = (c, m) => { if (!c) fallos.push(m); }, cerca = (a, b, t = 0.011) => Math.abs(a - b) <= t;
  ok(rifValido(f.emp_rif) && f.emp_razon, 'Los datos fiscales de la empresa (razón social y RIF) no están completos o el RIF es inválido. Configúrelos en "Empresa y fiscal".');
  ok(pdv && rifValido(pdv.rif), 'El cliente no tiene un RIF válido. Corrija el RIF del punto de venta.');
  ok(pe.base_usd != null && pe.iva_usd != null, 'El pedido es anterior a la configuración fiscal y no tiene desglose de impuestos.');
  ok(items.length > 0, 'El pedido no tiene líneas.');
  if (pe.base_usd != null) {
    const sBase = items.reduce((s, i) => s + i.subtotal, 0), sIva = items.reduce((s, i) => s + i.iva_usd, 0);
    ok(cerca(sBase, pe.base_usd), `La suma de las líneas (${r2(sBase)}) no coincide con la base imponible (${pe.base_usd}).`);
    ok(cerca(sIva, pe.iva_usd), `La suma del IVA por línea (${r2(sIva)}) no coincide con el IVA total (${pe.iva_usd}).`);
    ok(cerca(pe.base_usd + pe.iva_usd, pe.total), `Base más IVA (${r2(pe.base_usd + pe.iva_usd)}) no coincide con el total (${pe.total}).`);
    for (const i of items) ok(cerca(r2(i.subtotal * i.iva_pct / 100), i.iva_usd), `El IVA de la línea "${i.nombre}" está mal calculado.`);
    ok(cerca(pe.subtotal - pe.descuento, pe.base_usd), 'Subtotal menos descuento no coincide con la base imponible.');
  }
  ok(cerca(pagos.reduce((s, p) => s + p.monto_usd, 0), pe.total, 0.021), 'Los pagos aplicados no coinciden con el total del pedido.');
  ok(cerca(pagos.reduce((s, p) => s + (p.igtf_usd || 0), 0), pe.igtf_usd || 0), 'El IGTF de los pagos no coincide con el IGTF del pedido.');
  ok(pe.tasa > 0 && cerca(r2(pe.total * pe.tasa), pe.total_bs, 0.011), 'El total en bolívares no coincide con el total en USD por la tasa del pedido.');
  if (fallos.length) return res.status(422).json({ error: 'El comprobante no pasó la validación', fallos });
  const numero = `${f.comp_prefijo}-${String(id).padStart(8, '0')}`;
  const idTx = crypto.createHash('sha256').update([id, normalizarRIF(pdv.rif), pe.total, pe.fecha].join('|')).digest('hex').slice(0, 16).toUpperCase();
  res.json({
    numero, id_transaccion: idTx, fecha: pe.fecha, estado: pe.estado, tasa: pe.tasa,
    emisor: { razon: f.emp_razon, rif: normalizarRIF(f.emp_rif), direccion: f.emp_dir, telefono: f.emp_tel },
    cliente: { nombre: pdv.nombre, razon: pdv.razon_social || pdv.nombre, rif: normalizarRIF(pdv.rif), direccion: pdv.direccion || '' },
    items: items.map(i => ({ codigo: i.codigo, nombre: i.nombre, cantidad: i.cantidad, precio: i.precio_unitario, descuento_pct: i.descuento_pct, base: i.subtotal, iva_pct: i.iva_pct, iva: i.iva_usd })),
    totales: { subtotal: pe.subtotal, descuento: pe.descuento, base: pe.base_usd, iva: pe.iva_usd, total: pe.total, igtf: pe.igtf_usd || 0, total_cobrado: r2(pe.total + (pe.igtf_usd || 0)), total_bs: pe.total_bs },
    pagos, validacion: { ok: true, verificaciones: 10 + items.length }
  });
}));

// ---------- Entregas y OTIF ----------
app.get('/api/entregas', auth, h(async (req, res) => {
  const cols = async rows => { for (const pe of rows) pe.items = (await sql`SELECT pi.*, pr.nombre, pr.peso_kg FROM pedido_items pi JOIN productos pr ON pi.producto_id=pr.id WHERE pi.pedido_id=${pe.id} ORDER BY pi.id`).rows; return rows; };
  const pendientes = await cols((await sql`SELECT pe.id, pe.pdv_id, pe.fecha, pe.dia, pe.total, pe.estado, pe.fecha_prometida, p.nombre AS pdv_nombre, p.rif FROM pedidos pe JOIN pdvs p ON p.id=pe.pdv_id WHERE pe.estado IN ('Confirmado','En ruta') ORDER BY pe.fecha_prometida, pe.id LIMIT 100`).rows);
  const recientes = (await sql`SELECT pe.id, pe.total, pe.estado, pe.fecha_entrega, pe.a_tiempo, pe.completo, pe.faltante_usd, p.nombre AS pdv_nombre FROM pedidos pe JOIN pdvs p ON p.id=pe.pdv_id WHERE pe.estado IN ('Entregado','Entregado parcial','Rechazado') ORDER BY pe.fecha_entrega DESC LIMIT 25`).rows;
  res.json({ pendientes, recientes, hoy: hoy() });
}));

app.post('/api/pedidos/:id/entrega', auth, h(async (req, res) => {
  const id = +req.params.id, body = req.body || {};
  const pe = (await sql`SELECT * FROM pedidos WHERE id=${id}`).rows[0];
  if (!pe) throw fail(404, 'Pedido no encontrado');
  if (!['Confirmado', 'En ruta'].includes(pe.estado)) throw fail(409, 'El pedido ya fue entregado o cerrado');
  const items = (await sql`SELECT pi.*, pr.retornable, pr.tipo_envase FROM pedido_items pi JOIN productos pr ON pr.id=pi.producto_id WHERE pi.pedido_id=${id}`).rows;
  const recibidos = new Map((Array.isArray(body.items) ? body.items : []).map(x => [+x.id, x.cantidad_entregada]));
  const f = fechaCliente(body.fecha_cliente), diaE = diaDe(f);
  let faltanteUsd = 0, entregadoTotal = 0, pedidoTotal = 0;
  for (const it of items) {
    const q = recibidos.has(it.id) ? recibidos.get(it.id) : it.cantidad;
    if (!isInt(q, 0, it.cantidad)) throw fail(400, `Cantidad entregada inválida (0 a ${it.cantidad})`);
    it._q = +q; entregadoTotal += +q; pedidoTotal += it.cantidad;
  }
  for (const it of items) {
    const falta = it.cantidad - it._q;
    await sql`UPDATE pedido_items SET cantidad_entregada=${it._q} WHERE id=${it.id}`;
    if (falta <= 0) continue;
    faltanteUsd += falta * it.precio_unitario * (1 - (it.descuento_pct || 0) / 100) * (1 + (it.iva_pct || 0) / 100);
    let resta = falta;   // el faltante vuelve al stock, a los mismos lotes de los que salió
    const movs = (await sql`SELECT lote_id, -cantidad AS q FROM movimientos_stock WHERE tipo='Venta' AND referencia=${'Pedido ' + id} AND producto_id=${it.producto_id} ORDER BY id`).rows;
    for (const m of movs) { if (resta <= 0) break; const q = Math.min(m.q, resta); await sql`UPDATE lotes SET cantidad_actual=cantidad_actual+${q} WHERE id=${m.lote_id}`; await movStock(it.producto_id, m.lote_id, 'Devolución', q, 'Faltante pedido ' + id, req.user.id); resta -= q; }
    if (it.retornable && ['Cesta', 'Botella'].includes(it.tipo_envase))
      await sql`INSERT INTO control_retornables (pdv_id,pedido_id,tipo,entregados,recibidos,fecha,dia,usuario_id) VALUES (${pe.pdv_id},${id},${it.tipo_envase},${-falta},0,${f.toISOString()},${diaE},${req.user.id})`;
  }
  const estado = entregadoTotal === 0 ? 'Rechazado' : entregadoTotal === pedidoTotal ? 'Entregado' : 'Entregado parcial';
  const aTiempo = diaE <= (pe.fecha_prometida || diaE) ? 1 : 0;
  await sql`UPDATE pedidos SET estado=${estado}, fecha_entrega=${f.toISOString()}, a_tiempo=${aTiempo}, completo=${estado === 'Entregado' ? 1 : 0}, faltante_usd=${r2(faltanteUsd)} WHERE id=${id}`;
  await log(req.user, 'Entrega registrada', `#${id} ${estado}${aTiempo ? '' : ' (tarde)'}${faltanteUsd > 0 ? ' faltante ' + r2(faltanteUsd) + ' USD' : ''}`);
  res.json({ ok: true, estado, a_tiempo: !!aTiempo, faltante_usd: r2(faltanteUsd) });
}));

// ---------- Cobranza ----------
app.get('/api/cobranza', auth, h(async (req, res) =>
  res.json((await sql`SELECT p.id, p.rif, p.nombre, p.limite_credito,
    COALESCE((SELECT SUM(pg.monto_usd) FROM pedido_pagos pg JOIN pedidos pe ON pg.pedido_id=pe.id WHERE pe.pdv_id=p.id AND pg.metodo='Crédito'),0)
    - COALESCE((SELECT SUM(c.monto_usd) FROM cobranzas c WHERE c.pdv_id=p.id),0) AS saldo
    FROM pdvs p ORDER BY p.id`).rows)));

app.post('/api/cobranza', auth, h(async (req, res) => {
  const body = req.body || {}, { pdv_id, metodo, monto, referencia, idem } = body;
  if (idem) { const ex = (await sql`SELECT id FROM cobranzas WHERE idem=${String(idem)}`).rows[0]; if (ex) return res.json({ ok: true, duplicado: true }); }
  if (!isInt(pdv_id, 1, 1e9)) throw fail(400, 'Seleccione un cliente');
  if (metodo === 'Crédito') throw fail(400, 'Seleccione un método de cobro válido');
  const tServ = (await tasaVigente()).tasa; if (!(tServ > 0)) throw fail(400, 'No hay tasa BCV configurada');
  const tasa = tasaOp(body, tServ), f = await fiscal(), g = normalizarPagos([{ metodo, monto, referencia }], tasa, f)[0];
  const saldo = await saldoCxC(pdv_id);
  if (g.monto_usd > saldo + 0.02) throw fail(400, `El abono aplicado (${r2(g.monto_usd)} USD) excede el saldo pendiente (${r2(saldo)} USD)`);
  const fe = fechaCliente(body.fecha_cliente);
  await sql`INSERT INTO cobranzas (pdv_id,usuario_id,fecha,dia,metodo,moneda,monto,monto_usd,igtf_usd,tasa,referencia,idem) VALUES (${pdv_id},${req.user.id},${fe.toISOString()},${diaDe(fe)},${g.metodo},${g.moneda},${g.monto},${r2(g.monto_usd)},${r2(g.igtf_usd)},${tasa},${g.referencia},${idem ? String(idem) : null})`;
  await log(req.user, 'Abono registrado', `PDV ${pdv_id} ${r2(g.monto_usd)} USD aplicados (${g.metodo})`);
  res.json({ ok: true, saldo: r2(saldo - g.monto_usd), igtf_usd: r2(g.igtf_usd) });
}));

// ---------- KPIs ----------
app.get('/api/kpis', auth, h(async (req, res) => {
  const d = hoy(), d30 = addDias(d, -30), lim = addDias(d, 30);
  const v = (await sql`SELECT COALESCE(SUM(total),0) AS usd, COALESCE(SUM(total_bs),0) AS bs FROM pedidos WHERE dia=${d}`).rows[0];
  const red = (await sql`SELECT AVG(cumplimiento_pct) AS a FROM red_auditorias`).rows[0].a;
  const cxc = (await sql`SELECT COALESCE((SELECT SUM(monto_usd) FROM pedido_pagos WHERE metodo='Crédito'),0) - COALESCE((SELECT SUM(monto_usd) FROM cobranzas),0) AS s`).rows[0].s;
  const ret = (await sql`SELECT COALESCE(SUM(entregados),0)::int AS e, COALESCE(SUM(recibidos),0)::int AS r FROM control_retornables WHERE dia >= ${d30}`).rows[0];
  const ot = (await sql`SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE a_tiempo=1 AND completo=1)::int AS ok FROM pedidos WHERE estado IN ('Entregado','Entregado parcial','Rechazado') AND LEFT(fecha_entrega,10) >= ${d30}`).rows[0];
  const pend = (await sql`SELECT COUNT(*)::int AS c FROM pedidos WHERE estado IN ('Confirmado','En ruta')`).rows[0].c;
  const bajo = (await sql`SELECT COUNT(*)::int AS c FROM productos p WHERE p.activo=1 AND p.stock_minimo>0 AND COALESCE((SELECT SUM(cantidad_actual) FROM lotes l WHERE l.producto_id=p.id AND (l.fecha_vencimiento IS NULL OR l.fecha_vencimiento>=${d})),0) < p.stock_minimo`).rows[0].c;
  const pv = (await sql`SELECT COALESCE(SUM(cantidad_actual),0)::int AS u FROM lotes WHERE cantidad_actual>0 AND fecha_vencimiento IS NOT NULL AND fecha_vencimiento>=${d} AND fecha_vencimiento<=${lim}`).rows[0].u;
  const venc = (await sql`SELECT COALESCE(SUM(cantidad_actual),0)::int AS u FROM lotes WHERE cantidad_actual>0 AND fecha_vencimiento IS NOT NULL AND fecha_vencimiento<${d}`).rows[0].u;
  res.json({
    cumplimientoRED: red == null ? null : Math.round(red),
    retornabilidad: ret.e > 0 ? Math.min(100, Math.round(ret.r / ret.e * 100)) : null,
    otif: ot.n > 0 ? Math.round(ot.ok / ot.n * 100) : null, entregasMedidas: ot.n,
    ventasUsd: parseFloat(v.usd), ventasBs: parseFloat(v.bs), cxcUsd: parseFloat(cxc) || 0,
    pendientesEntrega: pend, stockBajo: bajo, porVencer: pv, vencidos: venc
  });
}));

app.get('/api/ventas-zona', auth, h(async (req, res) =>
  res.json((await sql`SELECT z.nombre, z.color, COALESCE(SUM(pe.total),0) AS total FROM zonas z LEFT JOIN pdvs p ON p.zona_id=z.id LEFT JOIN pedidos pe ON pe.pdv_id=p.id GROUP BY z.id, z.nombre, z.color ORDER BY z.id`).rows)));

// Cantidades vendidas por escala temporal (datos reales; los períodos sin ventas aparecen en cero)
function inicioPeriodo(escala, dia) {
  if (escala === 'semanal') return periodoDesde(dia, 'Semanal');
  if (escala === 'trimestral') { const [y, m] = dia.split('-').map(Number); return `${y}-${String(Math.floor((m - 1) / 3) * 3 + 1).padStart(2, '0')}-01`; }
  if (escala === 'anual') return dia.slice(0, 4) + '-01-01';
  return dia;
}
function periodoAnterior(escala, ini) {
  if (escala === 'diario') return addDias(ini, -1);
  if (escala === 'semanal') return addDias(ini, -7);
  const [y, m] = ini.split('-').map(Number);
  if (escala === 'anual') return `${y - 1}-01-01`;
  const t = new Date(Date.UTC(y, m - 1 - 3, 1)); return t.toISOString().slice(0, 10);
}
app.get('/api/ventas-serie', auth, h(async (req, res) => {
  const escala = ['diario', 'semanal', 'trimestral', 'anual'].includes(req.query.escala) ? req.query.escala : 'diario';
  const zona = isInt(req.query.zona_id, 1, 1e9) ? +req.query.zona_id : null;
  const cuantos = { diario: 30, semanal: 12, trimestral: 8, anual: 5 }[escala], trunc = { diario: 'day', semanal: 'week', trimestral: 'quarter', anual: 'year' }[escala];
  const periodos = []; let cur = inicioPeriodo(escala, hoy());
  for (let i = 0; i < cuantos; i++) { periodos.unshift(cur); cur = periodoAnterior(escala, cur); }
  const rows = (await sql`SELECT to_char(date_trunc(${trunc}, pe.dia::date), 'YYYY-MM-DD') AS periodo, SUM(pi.cantidad)::int AS unidades, SUM(pi.subtotal)::float AS usd, COUNT(DISTINCT pe.id)::int AS pedidos
    FROM pedido_items pi JOIN pedidos pe ON pe.id=pi.pedido_id JOIN pdvs p ON p.id=pe.pdv_id
    WHERE pe.dia >= ${periodos[0]} AND pe.estado<>'Rechazado' AND (${zona}::int IS NULL OR p.zona_id=${zona}::int) GROUP BY 1 ORDER BY 1`).rows;
  const m = Object.fromEntries(rows.map(r => [r.periodo, r]));
  res.json({ escala, zona_id: zona, periodos, unidades: periodos.map(p => (m[p] || {}).unidades || 0), usd: periodos.map(p => r2((m[p] || {}).usd || 0)), pedidos: periodos.map(p => (m[p] || {}).pedidos || 0) });
}));

// ---------- Retornables (movimientos de envases entregados y recibidos) ----------
app.get('/api/retornables', auth, h(async (req, res) => {
  const desde = addDias(hoy(), -90);
  res.json((await sql`SELECT p.id, p.rif, p.nombre, COALESCE(SUM(c.entregados),0)::int AS entregados, COALESCE(SUM(c.recibidos),0)::int AS recibidos
    FROM pdvs p LEFT JOIN control_retornables c ON c.pdv_id=p.id AND c.dia>=${desde} GROUP BY p.id, p.rif, p.nombre ORDER BY p.id`).rows);
}));
app.post('/api/retornables/devolucion', auth, h(async (req, res) => {
  const { pdv_id, tipo, cantidad, idem } = req.body || {};
  if (idem) { const ex = (await sql`SELECT id FROM control_retornables WHERE idem=${String(idem)}`).rows[0]; if (ex) return res.json({ ok: true, duplicado: true }); }
  if (!['Cesta', 'Botella'].includes(tipo)) throw fail(400, 'Tipo de envase inválido');
  if (!isInt(cantidad, 1, 100000)) throw fail(400, 'Cantidad inválida');
  const pdv = (await sql`SELECT id, nombre FROM pdvs WHERE id = ${pdv_id}`).rows[0]; if (!pdv) throw fail(404, 'PDV no encontrado');
  const t = (await sql`SELECT COALESCE(SUM(entregados),0)::int AS e, COALESCE(SUM(recibidos),0)::int AS r FROM control_retornables WHERE pdv_id=${pdv.id} AND tipo=${tipo}`).rows[0];
  if (+cantidad > t.e - t.r) throw fail(400, `No se pueden recibir ${cantidad} ${tipo.toLowerCase()}(s): a este cliente solo se le han entregado ${t.e} y ya devolvió ${t.r}.`);
  const f = fechaCliente(req.body.fecha_cliente);
  await sql`INSERT INTO control_retornables (pdv_id,pedido_id,tipo,entregados,recibidos,fecha,dia,usuario_id,idem) VALUES (${pdv.id},NULL,${tipo},0,${+cantidad},${f.toISOString()},${diaDe(f)},${req.user.id},${idem ? String(idem) : null})`;
  await log(req.user, 'Devolución de envases', `${pdv.nombre}: ${cantidad} ${tipo.toLowerCase()}(s)`);
  res.json({ ok: true });
}));

// ---------- Auditoría RED (conteo de frentes + fotografía) ----------
app.post('/api/red', auth, h(async (req, res) => {
  const { pdv_id, asignados, propios, competencia, foto, observaciones } = req.body || {};
  if (!isInt(pdv_id, 1, 1e9)) throw fail(400, 'Seleccione un PDV');
  if (!isInt(asignados, 1, 10000) || !isInt(propios, 0, 10000) || !isInt(competencia, 0, 10000)) throw fail(400, 'Los frentes deben ser enteros (asignados al menos 1)');
  if (foto && (!/^data:image\/(jpeg|png|webp);base64,/.test(foto) || foto.length > 450000)) throw fail(400, 'La fotografía no es válida o es demasiado pesada');
  const cumpl = Math.min(100, r2(+propios / +asignados * 100)), tot = +propios + +competencia, share = tot ? r2(+propios / tot * 100) : 0;
  const r = await sql`INSERT INTO red_auditorias (pdv_id,usuario_id,cumplimiento_pct,marca_propia_pct,competencia_pct,fecha,asignados,propios,competencia,share_pct,foto,observaciones)
    VALUES (${pdv_id},${req.user.id},${cumpl},${share},${r2(100 - share)},${new Date().toISOString()},${+asignados},${+propios},${+competencia},${share},${foto || null},${String(observaciones || '').trim().slice(0, 300) || null}) RETURNING id`;
  await log(req.user, 'Auditoría RED', `PDV ${pdv_id}: cumplimiento ${cumpl}%, share ${share}%`);
  res.json({ id: r.rows[0].id, cumplimiento_pct: cumpl, share_pct: share });
}));
app.get('/api/red', auth, h(async (req, res) =>
  res.json((await sql`SELECT r.id, r.pdv_id, r.cumplimiento_pct, r.share_pct, r.asignados, r.propios, r.competencia, r.fecha, r.observaciones, (r.foto IS NOT NULL) AS tiene_foto, p.nombre AS pdv_nombre FROM red_auditorias r JOIN pdvs p ON r.pdv_id=p.id ORDER BY r.id DESC LIMIT 50`).rows)));
app.get('/api/red/:id/foto', auth, h(async (req, res) => {
  const r = (await sql`SELECT foto FROM red_auditorias WHERE id=${+req.params.id}`).rows[0];
  if (!r || !r.foto) throw fail(404, 'Sin fotografía'); res.json({ foto: r.foto });
}));

// ---------- Activos en comodato ----------
app.get('/api/comodatos', auth, h(async (req, res) =>
  res.json((await sql`SELECT a.*, p.nombre AS pdv_nombre, p.rif FROM activos_comodato a JOIN pdvs p ON a.pdv_id=p.id ORDER BY a.id`).rows)));
app.post('/api/comodatos/:id/mantenimiento', auth, h(async (req, res) => {
  const a = (await sql`SELECT * FROM activos_comodato WHERE id=${+req.params.id}`).rows[0]; if (!a) throw fail(404, 'Activo no encontrado');
  await sql`UPDATE activos_comodato SET ultimo_mantenimiento=${hoy()} WHERE id=${a.id}`;
  await log(req.user, 'Mantenimiento de activo', a.codigo_qr); res.json({ ok: true, fecha: hoy() });
}));

// ---------- Ruteo (vecino más cercano + mejora 2-opt, capacidad y tiempos) ----------
function dosOpt(path, dist) {
  let mejora = true, guard = 0;
  while (mejora && guard++ < 200) {
    mejora = false;
    for (let i = 1; i < path.length - 2; i++) for (let j = i + 1; j < path.length - 1; j++) {
      const antes = dist(path[i - 1], path[i]) + dist(path[j], path[j + 1]), desp = dist(path[i - 1], path[j]) + dist(path[i], path[j + 1]);
      if (desp + 1e-6 < antes) { path = [...path.slice(0, i), ...path.slice(i, j + 1).reverse(), ...path.slice(j + 1)]; mejora = true; }
    }
  }
  return path;
}
app.post('/api/vrp', auth, h(async (req, res) => {
  const ids = [...new Set((req.body.pdv_ids || []).map(Number))].filter(n => Number.isInteger(n));
  const cap = isNum(req.body.capacidad_kg, 1, 100000) ? +req.body.capacidad_kg : 1500;
  const todos = (await sql`SELECT id, nombre, lat, lng FROM pdvs`).rows, sel = todos.filter(p => ids.includes(p.id));
  if (!sel.length) throw fail(400, 'Sin PDVs seleccionados');
  const kg = Object.fromEntries((await sql`SELECT pe.pdv_id, SUM(pi.cantidad * COALESCE(pr.peso_kg,1))::float AS kg, COUNT(DISTINCT pe.id)::int AS pedidos
    FROM pedidos pe JOIN pedido_items pi ON pi.pedido_id=pe.id JOIN productos pr ON pr.id=pi.producto_id WHERE pe.estado IN ('Confirmado','En ruta') GROUP BY pe.pdv_id`).rows.map(r => [r.pdv_id, r]));
  const dist = (a, b) => hav(a.lat, a.lng, b.lat, b.lng) * FACTOR_VIA;
  let pend = [...sel], actual = ALMACEN, path = [ALMACEN];
  while (pend.length) { let mj = 0, md = Infinity; pend.forEach((p, i) => { const d = dist(actual, p); if (d < md) { md = d; mj = i; } }); actual = pend.splice(mj, 1)[0]; path.push(actual); }
  path.push(ALMACEN);
  const nn = path.reduce((s, p, i) => i ? s + dist(path[i - 1], p) : 0, 0);
  path = dosOpt(path, dist);
  const ruta = [{ nombre: ALMACEN.nombre, distancia_desde_anterior_m: 0, eta_min: 0, kg: 0, pedidos: 0, tipo: 'Salida' }];
  let acum = 0, minutos = 0, total = 0;
  for (let i = 1; i < path.length; i++) {
    const d = dist(path[i - 1], path[i]); total += d; minutos += d / 1000 / VEL_KMH * 60;
    const esFin = i === path.length - 1;
    if (!esFin) { minutos += SERVICIO_MIN; acum += (kg[path[i].id] || {}).kg || 0; }
    ruta.push({ nombre: esFin ? ALMACEN.nombre + ' (regreso)' : path[i].nombre, distancia_desde_anterior_m: Math.round(d), eta_min: Math.round(minutos - (esFin ? 0 : SERVICIO_MIN)), kg: r2((kg[path[i].id] || {}).kg || 0), pedidos: (kg[path[i].id] || {}).pedidos || 0, tipo: esFin ? 'Regreso' : 'Parada' });
  }
  res.json({ ruta, total_km: r2(total / 1000), mejora_km: r2((nn - total) / 1000), total_kg: r2(acum), capacidad_kg: cap, excede: acum > cap, duracion_min: Math.round(minutos), supuestos: { velocidad_kmh: VEL_KMH, servicio_min: SERVICIO_MIN, factor_via: FACTOR_VIA } });
}));
app.post('/api/despachos', auth, h(async (req, res) => {
  const ids = [...new Set((req.body.pdv_ids || []).map(Number))].filter(n => Number.isInteger(n)); let n = 0;
  for (const id of ids) n += (await sql`UPDATE pedidos SET estado='En ruta' WHERE pdv_id=${id} AND estado='Confirmado' RETURNING id`).rows.length;
  if (!n) throw fail(400, 'No hay pedidos confirmados pendientes de despacho en esos PDV');
  await log(req.user, 'Ruta despachada', n + ' pedido(s) en ruta'); res.json({ ok: true, pedidos: n });
}));

// ---------- Mermas ----------
app.post('/api/mermas', auth, h(async (req, res) => {
  const { pdv_id, producto_id, cantidad, causa, idem } = req.body || {};
  if (idem) { const ex = (await sql`SELECT id FROM mermas WHERE idem=${String(idem)}`).rows[0]; if (ex) return res.json({ ok: true, duplicado: true }); }
  if (!isInt(cantidad, 1, 100000)) throw fail(400, 'Cantidad inválida');
  if (!CAUSAS.includes(causa)) throw fail(400, 'Causa no válida');
  const f = fechaCliente(req.body.fecha_cliente), descontar = !!producto_id && !pdv_id;   // merma de almacén o transporte descuenta stock; la del cliente no
  if (descontar) {
    let us; try { us = await consumirFIFO(+producto_id, +cantidad, hoy(), true); } catch (e) { throw fail(409, 'La cantidad supera el stock registrado de ese producto'); }
    for (const u of us) await movStock(+producto_id, u.lote_id, 'Merma', -u.cantidad, causa, req.user.id);
  }
  await sql`INSERT INTO mermas (pdv_id,producto_id,cantidad,causa,responsable,fecha,dia,descontar_stock,idem) VALUES (${pdv_id || null},${producto_id || null},${+cantidad},${causa},${req.user.nombre},${f.toISOString()},${diaDe(f)},${descontar ? 1 : 0},${idem ? String(idem) : null})`;
  await log(req.user, 'Merma registrada', `${cantidad} u. (${causa})${descontar ? ' con descuento de stock' : ''}`);
  res.json({ ok: true, descontado: descontar });
}));
app.get('/api/mermas', auth, h(async (req, res) =>
  res.json((await sql`SELECT m.*, pr.nombre AS producto, p.nombre AS pdv_nombre FROM mermas m LEFT JOIN productos pr ON m.producto_id=pr.id LEFT JOIN pdvs p ON m.pdv_id=p.id ORDER BY m.id DESC LIMIT 50`).rows)));

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
    filas, esperado_usd: r2(g('Efectivo USD')), esperado_bs: r2(g('Efectivo Bs')),
    digital_usd: r2(filas.filter(f => !f.metodo.startsWith('Efectivo') && f.metodo !== 'Crédito').reduce((s, f) => s + f.monto_usd, 0)),
    credito_usd: r2((filas.find(f => f.metodo === 'Crédito') || {}).monto_usd || 0)
  };
}
app.get('/api/liquidaciones/resumen', auth, h(async (req, res) => {
  const ya = (await sql`SELECT id FROM liquidaciones WHERE usuario_id=${req.user.id} AND dia=${hoy()}`).rows[0];
  res.json({ ...(await resumenDia(req.user.id)), tasa: (await leerTasa()).tasa, liquidado: !!ya });
}));
app.post('/api/liquidaciones', auth, h(async (req, res) => {
  const entUsd = parseFloat(req.body.efectivo_usd) || 0, entBs = parseFloat(req.body.efectivo_bs) || 0, obs = String(req.body.observaciones || '').trim().slice(0, 300);
  if (!(entUsd >= 0 && entUsd <= 1e9 && entBs >= 0 && entBs <= 1e13)) throw fail(400, 'Los montos contados deben ser números positivos');
  const { tasa } = await tasaVigente(); if (!(tasa > 0)) throw fail(400, 'No hay tasa BCV configurada');
  if ((await sql`SELECT id FROM liquidaciones WHERE usuario_id=${req.user.id} AND dia=${hoy()}`).rows.length) throw fail(409, 'Ya cerró su caja hoy. Un supervisor puede anular el cierre si hubo un error.');
  const r = await resumenDia(req.user.id), difUsd = r2(entUsd - r.esperado_usd), difBs = r2(entBs - r.esperado_bs), difEq = r2(difUsd + difBs / tasa);
  if (Math.abs(difEq) >= 0.01 && obs.length < 5) throw fail(400, 'Hay diferencia en el cuadre: explique el motivo en observaciones (mínimo 5 caracteres).');
  const id = (await sql`INSERT INTO liquidaciones (usuario_id,fecha,dia,tasa,esperado_usd,entregado_usd,esperado_bs,entregado_bs,digital_usd,credito_usd,diferencia_usd,observaciones,detalle)
    VALUES (${req.user.id},${new Date().toISOString()},${hoy()},${tasa},${r.esperado_usd},${entUsd},${r.esperado_bs},${entBs},${r.digital_usd},${r.credito_usd},${difEq},${obs || null},${JSON.stringify(r.filas)}) RETURNING id`).rows[0].id;
  await log(req.user, 'Cierre de caja', `#${id} diferencia ${difEq} USD`);
  res.json({ id, esperado_usd: r.esperado_usd, esperado_bs: r.esperado_bs, dif_usd: difUsd, dif_bs: difBs, dif_equiv_usd: difEq, tasa });
}));
app.get('/api/liquidaciones', auth, h(async (req, res) =>
  res.json((await sql`SELECT l.*, COALESCE(u.nombre,'-') AS vendedor FROM liquidaciones l LEFT JOIN usuarios u ON l.usuario_id=u.id ORDER BY l.id DESC LIMIT 30`).rows)));
app.delete('/api/liquidaciones/:id', auth, rol('Gerente', 'Supervisor'), h(async (req, res) => {
  const l = (await sql`SELECT * FROM liquidaciones WHERE id=${+req.params.id}`).rows[0]; if (!l) throw fail(404, 'Liquidación no encontrada');
  await sql`DELETE FROM liquidaciones WHERE id=${l.id}`; await log(req.user, 'Liquidación anulada', `id ${l.id} del ${l.dia}`); res.json({ ok: true });
}));

// ---------- Perfil y usuarios ----------
app.post('/api/me/password', auth, h(async (req, res) => {
  const { actual, nueva } = req.body || {};
  const u = (await sql`SELECT * FROM usuarios WHERE id=${req.user.id}`).rows[0];
  if (!u || !bcrypt.compareSync(String(actual || ''), u.password_hash)) throw fail(400, 'La contraseña actual es incorrecta');
  if (!CLAVE_OK.test(String(nueva || ''))) throw fail(400, CLAVE_MSG);
  if (nueva === actual) throw fail(400, 'La nueva contraseña debe ser distinta de la actual');
  await sql`UPDATE usuarios SET password_hash=${bcrypt.hashSync(nueva, 10)} WHERE id=${u.id}`; await log(req.user, 'Cambio de contraseña'); res.json({ ok: true });
}));
app.get('/api/usuarios', auth, rol('Gerente'), h(async (req, res) => res.json((await sql`SELECT id, nombre, usuario, rol, activo FROM usuarios ORDER BY id`).rows)));
app.post('/api/usuarios', auth, rol('Gerente'), h(async (req, res) => {
  const { nombre, usuario, password, rol: rolNuevo } = req.body || {};
  if (String(nombre || '').trim().length < 2) throw fail(400, 'Ingrese el nombre completo');
  if (!/^[a-z0-9._-]{3,30}$/i.test(String(usuario || ''))) throw fail(400, 'Usuario inválido (3 a 30 caracteres: letras, números, punto, guion)');
  if (!ROLES.includes(rolNuevo)) throw fail(400, 'Rol no válido');
  if (!CLAVE_OK.test(String(password || ''))) throw fail(400, CLAVE_MSG);
  try {
    const r = await sql`INSERT INTO usuarios (nombre,usuario,password_hash,rol) VALUES (${nombre.trim()},${usuario.trim().toLowerCase()},${bcrypt.hashSync(password, 10)},${rolNuevo}) RETURNING id`;
    await log(req.user, 'Usuario creado', usuario + ' (' + rolNuevo + ')'); res.json({ id: r.rows[0].id });
  } catch (e) { if (String(e.message).includes('duplicate')) throw fail(400, 'Ya existe un usuario con ese nombre de acceso'); throw e; }
}));
app.put('/api/usuarios/:id', auth, rol('Gerente'), h(async (req, res) => {
  const id = +req.params.id, { nombre, rol: rolNuevo, activo, password } = req.body || {};
  const u = (await sql`SELECT * FROM usuarios WHERE id=${id}`).rows[0]; if (!u) throw fail(404, 'Usuario no encontrado');
  const nom = nombre != null ? String(nombre).trim() : u.nombre, rol2 = rolNuevo || u.rol, act = activo == null ? u.activo : (activo ? 1 : 0);
  if (nom.length < 2) throw fail(400, 'Ingrese el nombre completo');
  if (!ROLES.includes(rol2)) throw fail(400, 'Rol no válido');
  if (id === req.user.id && (rol2 !== u.rol || act !== 1)) throw fail(400, 'No puede cambiar su propio rol ni desactivarse');
  if (password && !CLAVE_OK.test(String(password))) throw fail(400, CLAVE_MSG);
  await sql`UPDATE usuarios SET nombre=${nom}, rol=${rol2}, activo=${act} WHERE id=${id}`;
  if (password) await sql`UPDATE usuarios SET password_hash=${bcrypt.hashSync(password, 10)} WHERE id=${id}`;
  await log(req.user, 'Usuario modificado', u.usuario + (password ? ' (clave restablecida)' : '')); res.json({ ok: true });
}));
app.get('/api/bitacora', auth, rol('Gerente', 'Supervisor'), h(async (req, res) => res.json((await sql`SELECT * FROM bitacora ORDER BY id DESC LIMIT 200`).rows)));

module.exports = app;
