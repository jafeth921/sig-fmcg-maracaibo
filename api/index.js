// Compatibilidad: aceptar DATABASE_URL (Neon, Supabase, Railway, etc.) cuando no
// exista POSTGRES_URL, que es la variable que lee @vercel/postgres.
if (!process.env.POSTGRES_URL) {
  const url = process.env.POSTGRES_URL_NON_POOLING || process.env.DATABASE_URL;
  if (url) process.env.POSTGRES_URL = url;
}

const express = require('express');
const crypto = require('crypto');
const { sql } = require('@vercel/postgres');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
// El secreto de sesión se toma de JWT_SECRET. Si no está definido, initDB genera uno
// aleatorio y lo guarda en la base de datos (nunca se usa una clave fija conocida).
let JWT_SECRET = process.env.JWT_SECRET || null;
const ALMACEN = { nombre: 'Almacén Central', lat: 10.6540, lng: -71.6300 };
const BCV_URL = 'https://ve.dolarapi.com/v1/dolares/oficial';
const VEL_KMH = 25, SERVICIO_MIN = 10, FACTOR_VIA = 1.3;   // estimaciones de ruteo
const SCHEMA_V = '11';

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
const MET = new Map(METODOS.map(m => [m.nombre, m]));
const ROLES = ['Gerente', 'Supervisor', 'Preventista'];
const CANALES = ['Abasto/Bodega', 'Supermercado', 'Panadería', 'Mayorista'];
const NIVELES_CLIENTE = [
  { nombre: 'Detalle', max: 500 },
  { nombre: 'Mini mayorista', max: 2000 },
  { nombre: 'Mayorista', max: 8000 },
  { nombre: 'Supermercado / súper mayorista', max: 25000 }
];
const NIVEL_POR_CANAL = { 'Abasto/Bodega': 'Detalle', 'Panadería': 'Detalle', 'Mayorista': 'Mayorista', 'Supermercado': 'Supermercado / súper mayorista' };
const CREDITO_MAX = 100000;
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
    if (e.status) return res.status(e.status).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: 'Error interno del servidor' });
  });
const r2 = x => Math.round((+x || 0) * 100) / 100;
const diaDe = d => d.toLocaleDateString('en-CA', { timeZone: 'America/Caracas' });   // AAAA-MM-DD en hora de Venezuela
const hoy = () => diaDe(new Date());
const addDias = (d, n) => { const t = new Date(d + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const esFecha = s => {
  const t = String(s || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return false;
  const f = new Date(t + 'T12:00:00Z');
  return !isNaN(f) && f.toISOString().slice(0, 10) === t;
};
const isInt = (v, min, max) => v != null && String(v).trim() !== '' && Number.isInteger(+v) && +v >= min && +v <= max;
const isNum = (v, min, max) => v != null && String(v).trim() !== '' && Number.isFinite(+v) && +v >= min && +v <= max;
const rol = (...r) => (req, res, next) => r.includes(req.user.rol) ? next() : res.status(403).json({ error: 'Permiso insuficiente' });
// Clave de idempotencia acotada y siempre por usuario; nunca se devuelven datos de otra persona.
function claveIdem(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (!s || s.length > 128) throw fail(400, 'Clave de operación inválida');
  return s;
}
const esConflictoIdem = e => /duplicate key|unique constraint|UNIQUE constraint/i.test(String(e && e.message));
// Un Preventista solo trabaja sus propios pedidos, visitas, cierres y auditorías.
const esPropio = (req, usuarioId) => req.user.rol !== 'Preventista' || usuarioId === req.user.id;
function exigirPropio(req, usuarioId) { if (!esPropio(req, usuarioId)) throw fail(403, 'Esta operación pertenece a otro vendedor'); }
// Fecha del cliente (operaciones registradas sin conexión): se acepta si es de los últimos 3 días
function fechaCliente(v) {
  const t = v ? new Date(v) : null, now = Date.now();
  return (t && !isNaN(t) && t.getTime() <= now + 5 * 60000 && t.getTime() >= now - 3 * 86400000) ? t : new Date();
}
// La tasa siempre la decide el servidor: un cliente no puede inclinar la conversión
// enviando `offline:true` con una tasa propia.
function tasaOp(body, t) { return t; }
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
function rifError(s) {
  const t = String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!t) return 'Ingrese el RIF. Ejemplo: J-12345678-9';
  if (!/[VEJPG]/.test(t[0])) return 'El RIF debe empezar con V, E, J, P o G. Ejemplo: J-12345678-9';
  if (t.length < 10) return 'Faltan dígitos: use letra, 8 dígitos y verificador. Ejemplo: J-12345678-9';
  if (t.length > 10) return 'Sobran caracteres: use letra, 8 dígitos y verificador. Ejemplo: J-12345678-9';
  const m = /^([VEJPG])(\d{8})(\d)$/.exec(t);
  if (!m) return 'Formato inválido. Use J-12345678-9 (letra, 8 dígitos y verificador)';
  return digitoRIF(m[1], m[2]) === +m[3] ? null : 'El dígito verificador no coincide. Revise el último número.';
}
function rifValido(s) { return !rifError(s); }
const rifDe = (l, c8) => `${l}-${c8}-${digitoRIF(l, c8)}`;

function nivelPDV(d) {
  if (d.nivel_cliente) return NIVELES_CLIENTE.find(n => n.nombre === d.nivel_cliente)?.nombre || null;
  return NIVEL_POR_CANAL[d.canal] || null;
}
function validarPDV(d, user) {
  const errorRIF = rifError(d.rif); if (errorRIF) return errorRIF;
  const n = String(d.nombre || '').trim();
  if (n.length < 2 || n.length > 120) return 'El nombre debe tener entre 2 y 120 caracteres';
  if (!isInt(d.zona_id, 1, 1e9)) return 'Seleccione una zona';
  if (!CANALES.includes(d.canal)) return 'Canal no válido';
  const nivelNombre = nivelPDV(d); if (!nivelNombre) return 'Nivel comercial no válido';
  if (!isNum(d.lat, -90, 90) || !isNum(d.lng, -180, 180)) return 'Ubique el local en el mapa o use su ubicación actual';
  if (!isInt(d.geofence_radio_m, 10, 1000)) return 'El radio de check-in debe estar entre 10 y 1000 m';
  const credito = d.limite_credito == null ? 0 : d.limite_credito;
  if (!isNum(credito, 0, CREDITO_MAX)) return `Límite de crédito inválido (máximo ${CREDITO_MAX.toLocaleString('es-VE')} USD)`;
  const nivel = NIVELES_CLIENTE.find(x => x.nombre === nivelNombre);
  if (+credito > nivel.max) {
    if (!d.credito_fuera_rango) return `Para ${nivel.nombre} el rango sugerido llega a ${nivel.max} USD. Confirme la autorización o baje el monto.`;
    if (!user || user.rol !== 'Gerente') return 'Solo un Gerente puede autorizar un crédito fuera del rango sugerido.';
  }
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
// Solo se toma la primera IP de la cadena que envía el proxy y se valida el formato;
// así un cliente no puede evadir el bloqueo rotando el header x-forwarded-for.
function ipSolicitud(req) {
  const crudo = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const candidato = /^[0-9a-fA-F:.]{3,45}$/.test(crudo) ? crudo : String(req.socket.remoteAddress || 'local');
  return candidato.slice(0, 45);
}
const lockKey = (req, u) => ipSolicitud(req);
const estaBloqueado = k => { const e = intentos.get(k); return !!(e && e.hasta > Date.now()); };
function registrarFallo(k) {
  const e = intentos.get(k) || { n: 0, hasta: 0 };
  if (e.hasta && e.hasta <= Date.now()) { e.n = 0; e.hasta = 0; }
  e.n++; if (e.n >= 5) { e.hasta = Date.now() + 10 * 60 * 1000; e.n = 0; }
  intentos.set(k, e);
  for (const [clave, v] of intentos) if (v.hasta && v.hasta <= Date.now()) intentos.delete(clave);
}

// ---------- Tasa BCV ----------
async function getConfig(k) { const r = (await sql`SELECT valor FROM config WHERE clave=${k}`).rows[0]; return r ? r.valor : null; }
async function setConfig(k, v) { await sql`INSERT INTO config (clave,valor) VALUES (${k},${String(v)}) ON CONFLICT (clave) DO UPDATE SET valor=EXCLUDED.valor`; }
// "Toma" atómica de una tarea de inicialización: solo una instancia la ejecuta
// aunque varias funciones serverless arranquen al mismo tiempo con la base vacía.
async function reclamarTarea(clave) {
  const r = await sql`INSERT INTO config (clave,valor) VALUES (${clave},${new Date().toISOString()}) ON CONFLICT (clave) DO NOTHING RETURNING clave`;
  return r.rows.length > 0;
}
async function liberarTarea(clave) { await sql`DELETE FROM config WHERE clave=${clave}`; }
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
  await sql`CREATE TABLE IF NOT EXISTS usuarios (id SERIAL PRIMARY KEY, nombre TEXT, cedula TEXT, usuario TEXT UNIQUE, password_hash TEXT, rol TEXT, zona_id INTEGER, activo INTEGER DEFAULT 1, token_version INTEGER DEFAULT 0)`;
  await sql`CREATE TABLE IF NOT EXISTS zonas (id SERIAL PRIMARY KEY, nombre TEXT UNIQUE, color TEXT)`;
  await sql`CREATE TABLE IF NOT EXISTS pdvs (id SERIAL PRIMARY KEY, codigo TEXT UNIQUE, rif TEXT, razon_social TEXT, nombre TEXT, direccion TEXT, zona_id INTEGER, lat DOUBLE PRECISION, lng DOUBLE PRECISION, geofence_radio_m INTEGER DEFAULT 50, limite_credito DOUBLE PRECISION DEFAULT 0, credito_autorizado INTEGER DEFAULT 0, limite_pedidos INTEGER DEFAULT 5, periodo_limite TEXT DEFAULT 'Semanal', canal TEXT DEFAULT 'Abasto/Bodega')`;
  await sql`ALTER TABLE pdvs ADD COLUMN IF NOT EXISTS nivel_cliente TEXT`;
  await sql`UPDATE pdvs SET nivel_cliente = CASE WHEN canal='Mayorista' THEN 'Mayorista' WHEN canal='Supermercado' THEN 'Supermercado / súper mayorista' ELSE 'Detalle' END WHERE nivel_cliente IS NULL`;
  await sql`CREATE TABLE IF NOT EXISTS productos (id SERIAL PRIMARY KEY, codigo TEXT UNIQUE, nombre TEXT, precio DOUBLE PRECISION, retornable INTEGER DEFAULT 0, tipo_envase TEXT, fecha_vencimiento TEXT, peso_kg DOUBLE PRECISION DEFAULT 1, stock_minimo INTEGER DEFAULT 0, activo INTEGER DEFAULT 1, alicuota TEXT DEFAULT 'G')`;
  await sql`CREATE TABLE IF NOT EXISTS promociones (id SERIAL PRIMARY KEY, nombre TEXT, producto_id INTEGER, tipo TEXT, min_cantidad INTEGER, descuento_pct DOUBLE PRECISION, activa INTEGER DEFAULT 1)`;
  await sql`CREATE TABLE IF NOT EXISTS pedidos (id SERIAL PRIMARY KEY, pdv_id INTEGER, usuario_id INTEGER, fecha TEXT, dia TEXT, subtotal DOUBLE PRECISION DEFAULT 0, descuento DOUBLE PRECISION DEFAULT 0, base_usd DOUBLE PRECISION, iva_usd DOUBLE PRECISION, igtf_usd DOUBLE PRECISION DEFAULT 0, total DOUBLE PRECISION, total_bs DOUBLE PRECISION, tasa DOUBLE PRECISION, estado TEXT DEFAULT 'Confirmado', metodo_pago TEXT, fecha_prometida TEXT, fecha_entrega TEXT, a_tiempo INTEGER, completo INTEGER, faltante_usd DOUBLE PRECISION DEFAULT 0, idem TEXT, entrega_idem TEXT)`;
  await sql`CREATE TABLE IF NOT EXISTS pedido_items (id SERIAL PRIMARY KEY, pedido_id INTEGER, producto_id INTEGER, cantidad INTEGER, precio_unitario DOUBLE PRECISION, descuento_pct DOUBLE PRECISION DEFAULT 0, subtotal DOUBLE PRECISION, iva_pct DOUBLE PRECISION DEFAULT 0, iva_usd DOUBLE PRECISION DEFAULT 0, cantidad_entregada INTEGER)`;
  await sql`CREATE TABLE IF NOT EXISTS pedido_pagos (id SERIAL PRIMARY KEY, pedido_id INTEGER, metodo TEXT, moneda TEXT, monto DOUBLE PRECISION, monto_usd DOUBLE PRECISION, igtf_usd DOUBLE PRECISION DEFAULT 0, referencia TEXT)`;
  await sql`CREATE TABLE IF NOT EXISTS cobranzas (id SERIAL PRIMARY KEY, pdv_id INTEGER, usuario_id INTEGER, fecha TEXT, dia TEXT, metodo TEXT, moneda TEXT, monto DOUBLE PRECISION, monto_usd DOUBLE PRECISION, igtf_usd DOUBLE PRECISION DEFAULT 0, tasa DOUBLE PRECISION, referencia TEXT, idem TEXT)`;
  await sql`CREATE TABLE IF NOT EXISTS visitas (id SERIAL PRIMARY KEY, pdv_id INTEGER, usuario_id INTEGER, fecha_checkin TEXT, dia TEXT, lat DOUBLE PRECISION, lng DOUBLE PRECISION, distancia_m DOUBLE PRECISION, estado TEXT DEFAULT 'Efectiva', idem TEXT)`;
  await sql`CREATE TABLE IF NOT EXISTS activos_comodato (id SERIAL PRIMARY KEY, pdv_id INTEGER, codigo_qr TEXT UNIQUE, tipo TEXT, marca TEXT, fecha_instalacion TEXT, ultimo_mantenimiento TEXT)`;
  await sql`CREATE TABLE IF NOT EXISTS red_auditorias (id SERIAL PRIMARY KEY, pdv_id INTEGER, usuario_id INTEGER, cumplimiento_pct DOUBLE PRECISION, marca_propia_pct DOUBLE PRECISION, competencia_pct DOUBLE PRECISION, fecha TEXT, asignados INTEGER, propios INTEGER, competencia INTEGER, share_pct DOUBLE PRECISION, foto TEXT, observaciones TEXT)`;
  await sql`CREATE TABLE IF NOT EXISTS mermas (id SERIAL PRIMARY KEY, pdv_id INTEGER, producto_id INTEGER, cantidad INTEGER, causa TEXT, responsable TEXT, usuario_id INTEGER, fecha TEXT, dia TEXT, descontar_stock INTEGER DEFAULT 0, idem TEXT)`;
  await sql`CREATE TABLE IF NOT EXISTS liquidaciones (id SERIAL PRIMARY KEY, usuario_id INTEGER, fecha TEXT, dia TEXT, tasa DOUBLE PRECISION, esperado_usd DOUBLE PRECISION, entregado_usd DOUBLE PRECISION, esperado_bs DOUBLE PRECISION, entregado_bs DOUBLE PRECISION, digital_usd DOUBLE PRECISION, credito_usd DOUBLE PRECISION, diferencia_usd DOUBLE PRECISION, observaciones TEXT, detalle TEXT)`;
  await sql`CREATE TABLE IF NOT EXISTS bitacora (id SERIAL PRIMARY KEY, fecha TEXT, usuario_id INTEGER, usuario TEXT, accion TEXT, detalle TEXT)`;
  await sql`CREATE TABLE IF NOT EXISTS proveedores (id SERIAL PRIMARY KEY, rif TEXT UNIQUE, nombre TEXT, razon_social TEXT, contacto TEXT, telefono TEXT, email TEXT, direccion TEXT, activo INTEGER DEFAULT 1, fecha_alta TEXT)`;
  await sql`CREATE TABLE IF NOT EXISTS lotes (id SERIAL PRIMARY KEY, producto_id INTEGER, codigo_lote TEXT, fecha_vencimiento TEXT, cantidad_inicial INTEGER, cantidad_actual INTEGER, fecha_ingreso TEXT, usuario_id INTEGER, proveedor_id INTEGER, costo_usd DOUBLE PRECISION, documento TEXT)`;
  await sql`CREATE TABLE IF NOT EXISTS movimientos_stock (id SERIAL PRIMARY KEY, producto_id INTEGER, lote_id INTEGER, tipo TEXT, cantidad INTEGER, referencia TEXT, usuario_id INTEGER, fecha TEXT)`;
  await sql`CREATE TABLE IF NOT EXISTS control_retornables (id SERIAL PRIMARY KEY, pdv_id INTEGER, pedido_id INTEGER, tipo TEXT, entregados INTEGER DEFAULT 0, recibidos INTEGER DEFAULT 0, fecha TEXT, dia TEXT, usuario_id INTEGER, idem TEXT)`;

  // Secreto de sesión estable por base de datos cuando no se configuró JWT_SECRET.
  // Así las sesiones sobreviven a los reinicios sin usar una clave pública conocida.
  // El INSERT ... ON CONFLICT evita claves distintas si dos instancias arrancan a la vez.
  if (!JWT_SECRET) {
    let s = await getConfig('jwt_secret');
    if (!s) {
      await sql`INSERT INTO config (clave,valor) VALUES ('jwt_secret',${crypto.randomBytes(48).toString('hex')}) ON CONFLICT (clave) DO NOTHING`;
      s = await getConfig('jwt_secret');
    }
    JWT_SECRET = s;
  }

  // Migración de bases creadas con versiones anteriores (conserva los datos)
  if ((await getConfig('schema_v')) !== SCHEMA_V) {
    const stmts = [
      sql`ALTER TABLE productos ADD COLUMN IF NOT EXISTS peso_kg DOUBLE PRECISION DEFAULT 1`, sql`ALTER TABLE productos ADD COLUMN IF NOT EXISTS stock_minimo INTEGER DEFAULT 0`,
      sql`ALTER TABLE productos ADD COLUMN IF NOT EXISTS activo INTEGER DEFAULT 1`, sql`ALTER TABLE productos ADD COLUMN IF NOT EXISTS alicuota TEXT DEFAULT 'G'`,
      sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS fecha_prometida TEXT`, sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS fecha_entrega TEXT`, sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS a_tiempo INTEGER`,
      sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS completo INTEGER`, sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS faltante_usd DOUBLE PRECISION DEFAULT 0`, sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS idem TEXT`, sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS entrega_idem TEXT`,
      sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS base_usd DOUBLE PRECISION`, sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS iva_usd DOUBLE PRECISION`, sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS igtf_usd DOUBLE PRECISION DEFAULT 0`,
      sql`ALTER TABLE pedido_items ADD COLUMN IF NOT EXISTS cantidad_entregada INTEGER`, sql`ALTER TABLE pedido_items ADD COLUMN IF NOT EXISTS iva_pct DOUBLE PRECISION DEFAULT 0`, sql`ALTER TABLE pedido_items ADD COLUMN IF NOT EXISTS iva_usd DOUBLE PRECISION DEFAULT 0`,
      sql`ALTER TABLE pedido_pagos ADD COLUMN IF NOT EXISTS igtf_usd DOUBLE PRECISION DEFAULT 0`, sql`ALTER TABLE cobranzas ADD COLUMN IF NOT EXISTS igtf_usd DOUBLE PRECISION DEFAULT 0`,
      sql`ALTER TABLE cobranzas ADD COLUMN IF NOT EXISTS idem TEXT`, sql`ALTER TABLE visitas ADD COLUMN IF NOT EXISTS idem TEXT`,
      sql`ALTER TABLE mermas ADD COLUMN IF NOT EXISTS idem TEXT`, sql`ALTER TABLE mermas ADD COLUMN IF NOT EXISTS dia TEXT`, sql`ALTER TABLE mermas ADD COLUMN IF NOT EXISTS descontar_stock INTEGER DEFAULT 0`,
      sql`ALTER TABLE red_auditorias ADD COLUMN IF NOT EXISTS asignados INTEGER`, sql`ALTER TABLE red_auditorias ADD COLUMN IF NOT EXISTS propios INTEGER`, sql`ALTER TABLE red_auditorias ADD COLUMN IF NOT EXISTS competencia INTEGER`,
      sql`ALTER TABLE red_auditorias ADD COLUMN IF NOT EXISTS share_pct DOUBLE PRECISION`, sql`ALTER TABLE red_auditorias ADD COLUMN IF NOT EXISTS foto TEXT`, sql`ALTER TABLE red_auditorias ADD COLUMN IF NOT EXISTS observaciones TEXT`,
      sql`ALTER TABLE control_retornables ADD COLUMN IF NOT EXISTS dia TEXT`, sql`ALTER TABLE control_retornables ADD COLUMN IF NOT EXISTS usuario_id INTEGER`, sql`ALTER TABLE control_retornables ADD COLUMN IF NOT EXISTS idem TEXT`,
      sql`ALTER TABLE liquidaciones ADD COLUMN IF NOT EXISTS observaciones TEXT`, sql`ALTER TABLE liquidaciones ADD COLUMN IF NOT EXISTS detalle TEXT`,
      sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS token_version INTEGER DEFAULT 0`,
      sql`ALTER TABLE mermas ADD COLUMN IF NOT EXISTS usuario_id INTEGER`,
      sql`ALTER TABLE pdvs ADD COLUMN IF NOT EXISTS rif TEXT`, sql`ALTER TABLE pdvs ADD COLUMN IF NOT EXISTS limite_pedidos INTEGER DEFAULT 5`, sql`ALTER TABLE pdvs ADD COLUMN IF NOT EXISTS periodo_limite TEXT DEFAULT 'Semanal'`,
      sql`ALTER TABLE pdvs ADD COLUMN IF NOT EXISTS credito_autorizado INTEGER DEFAULT 0`,
      // Variables eliminadas del modelo: saldos y límites de envases, y todo lo relativo a cadena de frío
      sql`ALTER TABLE pdvs DROP COLUMN IF EXISTS saldo_cestas`, sql`ALTER TABLE pdvs DROP COLUMN IF EXISTS saldo_botellas`,
      sql`ALTER TABLE pdvs DROP COLUMN IF EXISTS limite_cestas`, sql`ALTER TABLE pdvs DROP COLUMN IF EXISTS limite_botellas`,
      sql`ALTER TABLE activos_comodato DROP COLUMN IF EXISTS temperatura_actual`, sql`ALTER TABLE activos_comodato DROP COLUMN IF EXISTS temp_min`, sql`ALTER TABLE activos_comodato DROP COLUMN IF EXISTS temp_max`,
      sql`DROP TABLE IF EXISTS cadena_frio`,
      sql`ALTER TABLE lotes ADD COLUMN IF NOT EXISTS proveedor_id INTEGER`, sql`ALTER TABLE lotes ADD COLUMN IF NOT EXISTS costo_usd DOUBLE PRECISION`, sql`ALTER TABLE lotes ADD COLUMN IF NOT EXISTS documento TEXT`,
      // Índices para las consultas más frecuentes (KPIs, cuentas por cobrar, inventario)
      sql`CREATE INDEX IF NOT EXISTS idx_pedidos_dia ON pedidos (dia)`,
      sql`CREATE INDEX IF NOT EXISTS idx_pedidos_pdv ON pedidos (pdv_id)`,
      sql`CREATE INDEX IF NOT EXISTS idx_pedidos_usuario ON pedidos (usuario_id)`,
      sql`CREATE INDEX IF NOT EXISTS idx_pedidos_estado ON pedidos (estado)`,
      sql`CREATE INDEX IF NOT EXISTS idx_pedido_items_pedido ON pedido_items (pedido_id)`,
      sql`CREATE INDEX IF NOT EXISTS idx_pedido_pagos_pedido ON pedido_pagos (pedido_id)`,
      sql`CREATE INDEX IF NOT EXISTS idx_cobranzas_pdv ON cobranzas (pdv_id)`,
      sql`CREATE INDEX IF NOT EXISTS idx_cobranzas_dia ON cobranzas (dia)`,
      sql`CREATE INDEX IF NOT EXISTS idx_visitas_pdv ON visitas (pdv_id)`,
      sql`CREATE INDEX IF NOT EXISTS idx_visitas_dia ON visitas (dia)`,
      sql`CREATE INDEX IF NOT EXISTS idx_lotes_producto ON lotes (producto_id)`,
      sql`CREATE INDEX IF NOT EXISTS idx_lotes_vencimiento ON lotes (fecha_vencimiento)`,
      sql`CREATE INDEX IF NOT EXISTS idx_mov_stock_producto ON movimientos_stock (producto_id)`,
      sql`CREATE INDEX IF NOT EXISTS idx_mov_stock_fecha ON movimientos_stock (fecha)`,
      sql`CREATE INDEX IF NOT EXISTS idx_red_pdv ON red_auditorias (pdv_id)`,
      sql`CREATE INDEX IF NOT EXISTS idx_retornables_pdv ON control_retornables (pdv_id)`,
      sql`CREATE INDEX IF NOT EXISTS idx_bitacora_fecha ON bitacora (fecha)`,
      sql`CREATE INDEX IF NOT EXISTS idx_mermas_dia ON mermas (dia)`,
      sql`CREATE INDEX IF NOT EXISTS idx_liquidaciones_dia ON liquidaciones (dia)`,
      // Claves de operación por usuario: evita que un reintento devuelva o duplique la operación de otra persona.
      sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_pedidos_usuario_idem ON pedidos (usuario_id, idem)`,
      sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_pedidos_usuario_entrega_idem ON pedidos (usuario_id, entrega_idem)`,
      sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_cobranzas_usuario_idem ON cobranzas (usuario_id, idem)`,
      sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_visitas_usuario_idem ON visitas (usuario_id, idem)`,
      sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_mermas_usuario_idem ON mermas (usuario_id, idem)`,
      sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_retornables_usuario_idem ON control_retornables (usuario_id, idem)`,
      sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_liquidaciones_usuario_dia ON liquidaciones (usuario_id, dia)`
    ];
    for (const q of stmts) await q;
    await setConfig('schema_v', SCHEMA_V);
  }

  const check = await sql`SELECT COUNT(*)::int AS c FROM usuarios`;
  // Solo una instancia siembra los datos de demostración (ver reclamarTarea).
  if (check.rows[0].c === 0 && await reclamarTarea('seed_demo')) {
    try {
    const a = bcrypt.hashSync('admin123', 10), m = bcrypt.hashSync('maria123', 10), p = bcrypt.hashSync('pedro123', 10);
    await sql`INSERT INTO usuarios (nombre,usuario,password_hash,rol) VALUES ('Gerente','admin',${a},'Gerente'),('María','maria',${m},'Supervisor'),('Pedro','pedro',${p},'Preventista')`;
    await sql`INSERT INTO zonas (nombre,color) VALUES ('Centro','#0F766E'),('Bella Vista','#B45309'),('Sur','#1D4ED8')`;
    await sql`INSERT INTO pdvs (codigo,rif,nombre,zona_id,lat,lng,limite_credito,limite_pedidos,periodo_limite,canal,nivel_cliente) VALUES
      ('PDV-0001',${rifDe('J', '30112233')},'Bodega Esperanza',1,10.6427,-71.6125,150,5,'Semanal','Abasto/Bodega','Detalle'),
      ('PDV-0002',${rifDe('J', '29876543')},'Panadería Trigal',1,10.6450,-71.6150,100,3,'Semanal','Panadería','Detalle'),
      ('PDV-0003',${rifDe('J', '31456789')},'Mayorista Los Haticos',3,10.6070,-71.6330,500,10,'Semanal','Mayorista','Mayorista')`;
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
    } catch (e) { await liberarTarea('seed_demo'); throw e; }
  }
  // Inventario de demostración si aún no hay lotes
  if ((await sql`SELECT COUNT(*)::int AS c FROM lotes`).rows[0].c === 0 && await reclamarTarea('seed_lotes')) {
    try {
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
    } catch (e) { await liberarTarea('seed_lotes'); throw e; }
  }
}

let ready = null;

// ---------- Diagnóstico (público, sin datos sensibles) ----------
app.get('/api/health', h(async (req, res) => {
  // Diagnóstico de solo lectura: nunca crea esquema ni siembra datos de demostración.
  await sql`SELECT 1`;
  let esquema = null;
  try { const version = (await sql`SELECT valor FROM config WHERE clave='schema_v'`).rows[0]; esquema = version ? version.valor : null; }
  catch { /* base recién creada: todavía no hay tabla de configuración */ }
  res.json({ ok: true, app: 'Rutix SIG-FMCG', hora: new Date().toISOString(), base_datos: { conectada: true, esquema } });
}));

app.use('/api', (req, res, next) => {
  if (!ready) ready = initDB();
  ready.then(() => next()).catch(e => {
    ready = null; console.error('initDB:', e);
    const falta = /POSTGRES_URL|connectionString|missing_connection_string/i.test(String(e.message));
    if (falta) return res.status(503).json({
      error: 'La base de datos no está conectada',
      detalle: 'Defina la variable POSTGRES_URL (o DATABASE_URL) con la cadena de conexión de PostgreSQL.',
      ayuda: 'En Vercel: Storage → Create Database → Postgres, conéctela a este proyecto y vuelva a desplegar. Consulte el README.'
    });
    res.status(500).json({ error: 'No se pudo inicializar la base de datos' });
  });
});

// ---------- Auth ----------
async function auth(req, res, next) {
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  if (!t) return res.status(401).json({ error: 'No autorizado' });
  try {
    const claims = jwt.verify(t, JWT_SECRET);
    // Revalidar en cada petición: una baja, cambio de rol o cambio de clave
    // debe surtir efecto de inmediato, no hasta que expire el token de 8 horas.
    const u = (await sql`SELECT id, nombre, rol, activo, token_version FROM usuarios WHERE id=${claims.id}`).rows[0];
    if (!u || !u.activo || u.rol !== claims.rol || (claims.tv || 0) !== (u.token_version || 0))
      return res.status(401).json({ error: 'La sesión ya no es válida. Ingrese de nuevo.' });
    req.user = { id: u.id, nombre: u.nombre, rol: u.rol };
    next();
  } catch { res.status(401).json({ error: 'Token inválido' }); }
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
  const token = jwt.sign({ id: u.id, nombre: u.nombre, rol: u.rol, tv: u.token_version || 0 }, JWT_SECRET, { expiresIn: '8h' });
  await log(u, 'Inicio de sesión');
  res.json({ token, user: { id: u.id, nombre: u.nombre, rol: u.rol } });
}));

// ---------- Configuración y tasa ----------
app.get('/api/config', auth, h(async (req, res) => {
  const f = await fiscal();
  const privado = ['Gerente', 'Supervisor'].includes(req.user.rol);
  const fiscalPublico = privado ? f : {
    iva_general: f.iva_general, iva_reducida: f.iva_reducida, igtf_pct: f.igtf_pct, igtf_activo: f.igtf_activo,
    emp_razon: f.emp_razon, emp_rif: f.emp_rif, emp_dir: f.emp_dir, emp_tel: f.emp_tel
  };
  res.json({ metodos: METODOS, tasa: await tasaVigente(), fiscal: fiscalPublico });
}));
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
app.post('/api/zonas/:id/unir', auth, rol('Gerente', 'Supervisor'), h(async (req, res) => {
  const id = +req.params.id, dest = +(req.body || {}).destino_id;
  if (!isInt(dest, 1, 1e9) || dest === id) throw fail(400, 'Seleccione una zona de destino distinta de la actual');
  const z = (await sql`SELECT nombre FROM zonas WHERE id=${id}`).rows[0], d = (await sql`SELECT nombre FROM zonas WHERE id=${dest}`).rows[0];
  if (!z || !d) throw fail(404, 'Zona no encontrada');
  const n = (await sql`UPDATE pdvs SET zona_id=${dest} WHERE zona_id=${id} RETURNING id`).rows.length;
  await sql`DELETE FROM zonas WHERE id=${id}`;
  await log(req.user, 'Zonas unidas', `${z.nombre} pasó a ${d.nombre} (${n} punto(s) de venta)`); res.json({ ok: true, movidos: n });
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
const datosPDV = d => ({ rif: normalizarRIF(d.rif), nombre: String(d.nombre).trim(), razon: String(d.razon_social || '').trim().slice(0, 150) || null, dir: String(d.direccion || '').trim().slice(0, 200) || null, nivel: nivelPDV(d) || 'Detalle' });
app.post('/api/pdvs', auth, rol('Gerente', 'Supervisor'), h(async (req, res) => {
  const d = req.body || {}, err = validarPDV(d, req.user); if (err) throw fail(400, err);
  const x = datosPDV(d), autorizado = +d.limite_credito > NIVELES_CLIENTE.find(n => n.nombre === x.nivel).max ? 1 : 0;
  const r = await sql`INSERT INTO pdvs (codigo,rif,razon_social,nombre,direccion,zona_id,lat,lng,geofence_radio_m,limite_credito,credito_autorizado,limite_pedidos,periodo_limite,canal,nivel_cliente)
    VALUES (${'TMP-' + crypto.randomBytes(4).toString('hex')},${x.rif},${x.razon},${x.nombre},${x.dir},${+d.zona_id},${+d.lat},${+d.lng},${+d.geofence_radio_m},${+d.limite_credito || 0},${autorizado},${+d.limite_pedidos},${d.periodo_limite},${d.canal},${x.nivel}) RETURNING id`;
  const id = r.rows[0].id;
  await sql`UPDATE pdvs SET codigo=${'PDV-' + String(id).padStart(4, '0')} WHERE id=${id}`;   // código interno automático (la interfaz muestra el RIF)
  await log(req.user, 'PDV creado', `${x.rif} ${x.nombre} · ${x.nivel} · crédito ${+d.limite_credito || 0} USD${autorizado ? ' (autorizado fuera de rango)' : ''}`);
  res.json({ id });
}));
app.put('/api/pdvs/:id', auth, rol('Gerente', 'Supervisor'), h(async (req, res) => {
  const d = req.body || {}, id = +req.params.id, err = validarPDV(d, req.user); if (err) throw fail(400, err);
  if (!(await sql`SELECT 1 FROM pdvs WHERE id=${id}`).rows.length) throw fail(404, 'PDV no encontrado');
  const x = datosPDV(d), autorizado = +d.limite_credito > NIVELES_CLIENTE.find(n => n.nombre === x.nivel).max ? 1 : 0;
  await sql`UPDATE pdvs SET rif=${x.rif}, razon_social=${x.razon}, nombre=${x.nombre}, direccion=${x.dir}, zona_id=${+d.zona_id}, lat=${+d.lat}, lng=${+d.lng}, geofence_radio_m=${+d.geofence_radio_m},
    limite_credito=${+d.limite_credito || 0}, credito_autorizado=${autorizado}, limite_pedidos=${+d.limite_pedidos}, periodo_limite=${d.periodo_limite}, canal=${d.canal}, nivel_cliente=${x.nivel} WHERE id=${id}`;
  await log(req.user, 'PDV modificado', `${x.rif} ${x.nombre} · ${x.nivel} · crédito ${+d.limite_credito || 0} USD${autorizado ? ' (autorizado fuera de rango)' : ''}`);
  res.json({ ok: true });
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
  const { pdv_id, lat, lng } = req.body || {}, idem = claveIdem(req.body && req.body.idem);
  if (!isInt(pdv_id, 1, 1e9)) throw fail(400, 'Seleccione un punto de venta válido');
  if (!isNum(lat, -90, 90) || !isNum(lng, -180, 180)) throw fail(400, 'Coordenadas inválidas');
  const pdv = (await sql`SELECT * FROM pdvs WHERE id = ${+pdv_id}`).rows[0];
  if (!pdv) throw fail(404, 'PDV no encontrado');
  const dist = hav(lat, lng, pdv.lat, pdv.lng);
  if (dist > pdv.geofence_radio_m) throw fail(400, `Está a ${Math.round(dist)} m (máximo ${pdv.geofence_radio_m} m).`);
  if (idem) {
    const ex = (await sql`SELECT id, distancia_m FROM visitas WHERE usuario_id=${req.user.id} AND idem=${idem}`).rows[0];
    if (ex) throw fail(409, 'Este check-in ya fue registrado');
  }
  const f = fechaCliente(req.body.fecha_cliente);
  let r;
  try {
    r = await sql`INSERT INTO visitas (pdv_id,usuario_id,fecha_checkin,dia,lat,lng,distancia_m,idem) VALUES (${+pdv_id},${req.user.id},${f.toISOString()},${diaDe(f)},${lat},${lng},${dist},${idem}) RETURNING id`;
  } catch (e) { if (esConflictoIdem(e)) throw fail(409, 'Este check-in ya fue registrado'); throw e; }
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
  sql`INSERT INTO movimientos_stock (producto_id,lote_id,tipo,cantidad,referencia,usuario_id,fecha) VALUES (${prodId},${loteId},${tipo},${cant},${String(ref || '').slice(0, 120)},${uid || null},${new Date().toISOString()}) RETURNING id`;

app.get('/api/inventario', auth, h(async (req, res) => {
  const productos = await listarProductos(true);
  const privado = ['Gerente', 'Supervisor'].includes(req.user.rol);
  const lotes = (await sql`SELECT l.*, p.nombre AS producto, pv.nombre AS proveedor, pv.rif AS proveedor_rif FROM lotes l JOIN productos p ON p.id=l.producto_id LEFT JOIN proveedores pv ON pv.id=l.proveedor_id WHERE l.cantidad_actual>0 ORDER BY l.fecha_vencimiento ASC NULLS LAST, l.id LIMIT 300`).rows
    .map(l => privado ? l : { ...l, costo_usd: null, proveedor_rif: null });
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
  const errorRIF = rifError(d.rif); if (errorRIF) return errorRIF;
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
  const hoyISO = hoy();
  const diasA = f => f ? Math.round((new Date(String(f) + 'T12:00:00') - new Date(hoyISO + 'T12:00:00')) / 86400000) : null;
  const detalleMotivo = (p, origen, n) => {
    const dias = diasA(p.prox_venc), reposicion = p.stock_minimo > 0 && p.stock <= p.stock_minimo, m = [];
    if (p.qty_corto > 0) m.push(`Por vencer${dias != null ? ` en ${dias} día(s)` : ''}`);
    if (reposicion) m.push(`Reposición: hay ${p.stock} u.`);
    m.push(origen === 'historial' ? `Rotación: ${n} pedido(s)` : 'Típico del canal');
    return { motivo: m.join(' · '), motivos: m, dias_vencimiento: dias, reposicion };
  };
  const hist = (await sql`SELECT pi.producto_id, pi.cantidad, pe.id AS pedido FROM pedido_items pi JOIN pedidos pe ON pe.id=pi.pedido_id
    WHERE pe.pdv_id=${id} AND pe.estado<>'Rechazado' AND pe.dia>=${addDias(hoy(), -90)} ORDER BY pe.id DESC LIMIT 800`).rows;
  const orden = [...new Set(hist.map(x => x.pedido))], acc = {};
  for (const x of hist) { const w = 1 / (1 + orden.indexOf(x.pedido)); const a = acc[x.producto_id] || (acc[x.producto_id] = { sw: 0, sq: 0, n: 0 }); a.sw += w; a.sq += w * x.cantidad; a.n++; }
  const out = [];
  for (const [pid, a] of Object.entries(acc)) {
    const p = byId[pid]; if (p && p.stock > 0) out.push({ producto_id: +pid, nombre: p.nombre, cantidad_sugerida: Math.min(p.stock, Math.max(1, Math.round(a.sq / a.sw))), origen: 'historial', frecuencia: a.n, por_vencer: p.qty_corto > 0, stock: p.stock, ...detalleMotivo(p, 'historial', a.n) });
  }
  const canal = (await sql`SELECT pi.producto_id, ROUND(AVG(pi.cantidad))::int AS q, COUNT(*)::int AS n FROM pedido_items pi JOIN pedidos pe ON pe.id=pi.pedido_id JOIN pdvs pd ON pd.id=pe.pdv_id
    WHERE pd.canal=(SELECT canal FROM pdvs WHERE id=${id}) AND pe.pdv_id<>${id} GROUP BY pi.producto_id ORDER BY n DESC LIMIT 5`).rows;
  for (const c of canal) {
    const p = byId[c.producto_id]; if (p && p.stock > 0 && !acc[c.producto_id]) out.push({ producto_id: c.producto_id, nombre: p.nombre, cantidad_sugerida: Math.min(p.stock, Math.max(1, c.q)), origen: 'canal', frecuencia: c.n, por_vencer: p.qty_corto > 0, stock: p.stock, ...detalleMotivo(p, 'canal', c.n) });
  }
  out.sort((a, b) => (b.por_vencer - a.por_vencer) || (b.frecuencia - a.frecuencia));
  res.json(out.slice(0, 6));
}));

// ---------- Cuentas por cobrar y pagos ----------
async function saldoCxC(pdvId) {
  const r = await sql`SELECT
    COALESCE((SELECT SUM(pg.monto_usd) FROM pedido_pagos pg JOIN pedidos pe ON pg.pedido_id=pe.id
      WHERE pe.pdv_id=${pdvId} AND pe.estado<>'Rechazado' AND pg.metodo='Crédito'),0)
    - COALESCE((SELECT SUM(c.monto_usd) FROM cobranzas c WHERE c.pdv_id=${pdvId}),0) AS s`;
  return parseFloat(r.rows[0].s) || 0;
}
// El monto que ingresa el cajero es lo recibido. En divisas incluye el IGTF:
// aplicado a la factura = monto / (1 + IGTF); IGTF = monto - aplicado.
function normalizarPagos(pagos, tasa, f) {
  if (!Array.isArray(pagos) || !pagos.length || pagos.length > 20) throw fail(400, 'Debe registrar entre 1 y 20 pagos');
  const g = igtfRate(f);
  return pagos.map(p => {
    const m = MET.get(p.metodo); if (!m) throw fail(400, 'Método de pago no válido: ' + p.metodo);
    const monto = parseFloat(p.monto); if (!(monto > 0 && monto <= 1e9)) throw fail(400, 'Monto inválido en ' + p.metodo);
    const ref = String(p.referencia || '').trim().slice(0, 30);
    if (m.ref && ref.length < 4) throw fail(400, 'El método ' + p.metodo + ' requiere referencia (mínimo 4 caracteres)');
    const divisa = m.moneda === 'USD' && m.nombre !== 'Crédito';
    // Se redondea aquí —igual que al guardar— para que la suma de pagos y de IGTF
    // coincida siempre con el pedido, incluso con muchos pagos pequeños.
    const igtf = divisa ? r2(monto - monto / (1 + g)) : 0;
    const aplicado = divisa ? r2(monto - igtf) : r2(m.moneda === 'USD' ? monto : monto / tasa);
    return { metodo: m.nombre, moneda: m.moneda, monto, monto_usd: aplicado, igtf_usd: igtf, referencia: ref || null };
  });
}

// ---------- Pedidos ----------
app.post('/api/pedidos', auth, h(async (req, res) => {
  const body = req.body || {}, { pdv_id, items, pagos } = body, idem = claveIdem(body.idem);
  if (idem && (await sql`SELECT id FROM pedidos WHERE usuario_id=${req.user.id} AND idem=${idem}`).rows.length)
    throw fail(409, 'Este pedido ya fue registrado');
  if (!isInt(pdv_id, 1, 1e9)) throw fail(400, 'Seleccione un punto de venta válido');
  if (!Array.isArray(items) || !items.length || items.length > 200) throw fail(400, 'Pedido vacío o con demasiadas líneas');
  const agg = new Map();
  for (const it of items) {
    if (!isInt(it.producto_id, 1, 1e9) || !isInt(it.cantidad, 1, 9999)) throw fail(400, 'Cantidad inválida (entero entre 1 y 9999)');
    agg.set(+it.producto_id, (agg.get(+it.producto_id) || 0) + +it.cantidad);
  }
  for (const q of agg.values()) if (q > 9999) throw fail(400, 'La cantidad total por producto no puede superar 9999');
  const tServ = (await tasaVigente()).tasa;
  if (!(tServ > 0)) throw fail(400, 'No hay tasa BCV configurada. Actualícela o fíjela manualmente.');
  const tasa = tasaOp(body, tServ), f = await fiscal();
  const pdv = (await sql`SELECT * FROM pdvs WHERE id = ${+pdv_id}`).rows[0];
  if (!pdv) throw fail(404, 'PDV no encontrado');

  const fcli = fechaCliente(body.fecha_cliente), dia = diaDe(fcli), hoyD = hoy(), lim = addDias(hoyD, 30);
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
  const pagado = r2(lista.reduce((s, x) => s + x.monto_usd, 0)), igtf = r2(lista.reduce((s, x) => s + x.igtf_usd, 0));
  if (Math.abs(pagado - total) > 0.02) throw fail(400, `Los pagos aplicados (${r2(pagado)} USD) no coinciden con el total del pedido (${total} USD)`);
  const credito = lista.filter(x => x.metodo === 'Crédito').reduce((s, x) => s + x.monto_usd, 0);
  if (credito > 0) {
    const saldo = await saldoCxC(+pdv_id), disp = r2((pdv.limite_credito || 0) - saldo);
    if (credito > disp + 0.001) throw fail(400, `Crédito solicitado ${r2(credito)} USD; disponible ${Math.max(0, disp)} USD (saldo pendiente ${r2(saldo)} USD, límite ${pdv.limite_credito || 0} USD)`);
  }

  const resumen = [...new Set(lista.map(x => x.metodo))].join(' + ');
  let pid;
  try {
    const r = await sql`INSERT INTO pedidos (pdv_id,usuario_id,fecha,dia,subtotal,descuento,base_usd,iva_usd,igtf_usd,total,total_bs,tasa,metodo_pago,fecha_prometida,idem)
      VALUES (${+pdv_id},${req.user.id},${fcli.toISOString()},${dia},${subtotal},${descuento},${base},${iva},${igtf},${total},${totalBs},${tasa},${resumen},${addDias(dia, 1)},${idem}) ON CONFLICT (usuario_id, idem) DO NOTHING RETURNING id`;
    pid = r.rows[0] && r.rows[0].id;
  } catch (e) { if (esConflictoIdem(e)) throw fail(409, 'Este pedido ya fue registrado'); throw e; }
  if (!pid) throw fail(409, 'Este pedido ya fue registrado');

  const guardado = { asign: [], items: [], pagos: [], retornables: [], movs: [] };
  try {
    for (const l of lineas) guardado.asign.push({ l, us: await consumirFIFO(l.p.id, l.cant, hoyD, false) });
    for (const { l, us } of guardado.asign) {
      const it = (await sql`INSERT INTO pedido_items (pedido_id,producto_id,cantidad,precio_unitario,descuento_pct,subtotal,iva_pct,iva_usd) VALUES (${pid},${l.p.id},${l.cant},${l.p.precio},${r2(l.dpct)},${l.lineBase},${l.pct},${l.lineIva}) RETURNING id`).rows[0];
      guardado.items.push(it.id);
      for (const u of us) {
        const m = (await movStock(l.p.id, u.lote_id, 'Venta', -u.cantidad, 'Pedido ' + pid, req.user.id)).rows[0];
        if (m) guardado.movs.push(m.id);
      }
      if (l.p.retornable && ['Cesta', 'Botella'].includes(l.p.tipo_envase)) {
        const rt = (await sql`INSERT INTO control_retornables (pdv_id,pedido_id,tipo,entregados,recibidos,fecha,dia,usuario_id) VALUES (${+pdv_id},${pid},${l.p.tipo_envase},${l.cant},0,${fcli.toISOString()},${dia},${req.user.id}) RETURNING id`).rows[0];
        guardado.retornables.push(rt.id);
      }
    }
    for (const g of lista) {
      const pg = (await sql`INSERT INTO pedido_pagos (pedido_id,metodo,moneda,monto,monto_usd,igtf_usd,referencia) VALUES (${pid},${g.metodo},${g.moneda},${g.monto},${g.monto_usd},${g.igtf_usd},${g.referencia}) RETURNING id`).rows[0];
      guardado.pagos.push(pg.id);
    }
  } catch (e) {
    // Compensación completa: si falla cualquier paso, no queda pedido, pago ni stock descontado.
    for (const id of guardado.pagos) await sql`DELETE FROM pedido_pagos WHERE id=${id}`;
    for (const id of guardado.retornables) await sql`DELETE FROM control_retornables WHERE id=${id}`;
    for (const id of guardado.items) await sql`DELETE FROM pedido_items WHERE id=${id}`;
    for (const id of guardado.movs) await sql`DELETE FROM movimientos_stock WHERE id=${id}`;
    for (const a of guardado.asign) await devolverLotes(a.us);
    await sql`DELETE FROM pedidos WHERE id=${pid}`;
    throw fail(409, 'No se pudo registrar el pedido. Intente de nuevo.');
  }
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
  exigirPropio(req, pe.usuario_id);
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
    items: items.map(i => ({ codigo: i.codigo, nombre: i.nombre, cantidad: i.cantidad_entregada == null ? i.cantidad : i.cantidad_entregada, precio: i.precio_unitario, descuento_pct: i.descuento_pct, base: i.subtotal, iva_pct: i.iva_pct, iva: i.iva_usd })),
    totales: { subtotal: pe.subtotal, descuento: pe.descuento, base: pe.base_usd, iva: pe.iva_usd, total: pe.total, igtf: pe.igtf_usd || 0, total_cobrado: r2(pe.total + (pe.igtf_usd || 0)), total_bs: pe.total_bs },
    pagos, validacion: { ok: true, verificaciones: 10 + items.length }
  });
}));

// ---------- Entregas a tiempo ----------
app.get('/api/entregas', auth, h(async (req, res) => {
  const solo = req.user.rol === 'Preventista' ? req.user.id : null;
  const cols = async rows => { for (const pe of rows) pe.items = (await sql`SELECT pi.*, pr.nombre, pr.peso_kg FROM pedido_items pi JOIN productos pr ON pi.producto_id=pr.id WHERE pi.pedido_id=${pe.id} ORDER BY pi.id`).rows; return rows; };
  const pendientes = await cols((await sql`SELECT pe.id, pe.pdv_id, pe.fecha, pe.dia, pe.total, pe.estado, pe.fecha_prometida, p.nombre AS pdv_nombre, p.rif FROM pedidos pe JOIN pdvs p ON p.id=pe.pdv_id
    WHERE pe.estado IN ('Confirmado','En ruta') AND (${solo}::int IS NULL OR pe.usuario_id=${solo}::int) ORDER BY pe.fecha_prometida, pe.id LIMIT 100`).rows);
  const recientes = (await sql`SELECT pe.id, pe.total, pe.estado, pe.fecha_entrega, pe.a_tiempo, pe.completo, pe.faltante_usd, p.nombre AS pdv_nombre FROM pedidos pe JOIN pdvs p ON p.id=pe.pdv_id
    WHERE pe.estado IN ('Entregado','Entregado parcial','Rechazado') AND (${solo}::int IS NULL OR pe.usuario_id=${solo}::int) ORDER BY pe.fecha_entrega DESC LIMIT 25`).rows;
  res.json({ pendientes, recientes, hoy: hoy() });
}));

app.post('/api/pedidos/:id/entrega', auth, h(async (req, res) => {
  const id = +req.params.id, body = req.body || {}, idemEntrega = claveIdem(body.idem);
  if (!isInt(id, 1, 1e9)) throw fail(400, 'Pedido inválido');
  const pe = (await sql`SELECT * FROM pedidos WHERE id=${id}`).rows[0];
  if (!pe) throw fail(404, 'Pedido no encontrado');
  exigirPropio(req, pe.usuario_id);
  if (!['Confirmado', 'En ruta'].includes(pe.estado)) throw fail(409, 'El pedido ya fue entregado o cerrado');
  const items = (await sql`SELECT pi.*, pr.retornable, pr.tipo_envase FROM pedido_items pi JOIN productos pr ON pr.id=pi.producto_id WHERE pi.pedido_id=${id}`).rows;
  const recibidos = new Map();
  if (body.items != null) {
    if (!Array.isArray(body.items) || body.items.length > items.length) throw fail(400, 'Detalle de entrega inválido');
    for (const x of body.items) {
      const li = items.find(i => i.id === +x.id);
      if (!li || !isInt(x.cantidad_entregada, 0, li.cantidad) || recibidos.has(+x.id)) throw fail(400, 'Cantidad entregada inválida');
      recibidos.set(+x.id, +x.cantidad_entregada);
    }
  }
  if (idemEntrega && (await sql`SELECT id FROM pedidos WHERE usuario_id=${req.user.id} AND entrega_idem=${idemEntrega}`).rows.length)
    throw fail(409, 'Esta entrega ya fue registrada');

  const f = fechaCliente(body.fecha_cliente), diaE = diaDe(f);
  let faltanteUsd = 0, entregadoTotal = 0, pedidoTotal = 0;
  for (const it of items) {
    const q = recibidos.has(it.id) ? recibidos.get(it.id) : it.cantidad;
    it._q = +q; entregadoTotal += +q; pedidoTotal += it.cantidad;
    if (it.cantidad > it._q) faltanteUsd += r2((it.subtotal + it.iva_usd) * (it.cantidad - it._q) / it.cantidad);
  }
  faltanteUsd = r2(faltanteUsd);
  const entregadoUsd = r2(Math.max(0, (pe.total || 0) - faltanteUsd));
  const factor = pe.total > 0 ? entregadoUsd / pe.total : 0;
  const estado = entregadoTotal === 0 ? 'Rechazado' : entregadoTotal === pedidoTotal ? 'Entregado' : 'Entregado parcial';
  const aTiempo = diaE <= (pe.fecha_prometida || diaE) ? 1 : 0;

  // Ajustes de líneas: las cantidades y los importes reflejan solo lo entregado.
  const ajustes = items.map(it => ({ id: it.id, q: it._q, base: r2(it.subtotal * factor), iva: r2(it.iva_usd * factor) }));
  if (ajustes.length) {
    const baseObjetivo = r2(pe.base_usd * factor), ivaObjetivo = r2(pe.iva_usd * factor);
    const ult = ajustes[ajustes.length - 1];
    ult.base = r2(ult.base + baseObjetivo - r2(ajustes.reduce((s, a) => s + a.base, 0)));
    ult.iva = r2(ult.iva + ivaObjetivo - r2(ajustes.reduce((s, a) => s + a.iva, 0)));
  }
  const nuevaBase = r2(pe.base_usd * factor), nuevaIva = r2(pe.iva_usd * factor);
  const nuevoSubtotal = r2(pe.subtotal * factor), nuevoDescuento = r2(nuevoSubtotal - nuevaBase);
  const nuevoTotal = r2(nuevaBase + nuevaIva), nuevoTotalBs = r2(nuevoTotal * pe.tasa);

  // Reversión financiera: se agregan renglones negativos por lo no entregado.
  // Así el saldo por cobrar, la caja y el comprobante reflejan el mismo dinero.
  const originales = (await sql`SELECT * FROM pedido_pagos WHERE pedido_id=${id} AND monto_usd>0 ORDER BY id`).rows;
  const reversos = [];
  let netoUsd = r2(originales.reduce((s, p) => s + +p.monto_usd, 0));
  let netoIgtf = r2(originales.reduce((s, p) => s + (+p.igtf_usd || 0), 0));
  const nota = ('Ajuste entrega pedido #' + id).slice(0, 30);
  for (const p of originales) {
    const usd = r2(p.monto_usd - r2(p.monto_usd * factor));
    const ig = r2((p.igtf_usd || 0) - r2((p.igtf_usd || 0) * factor));
    const monto = r2(p.monto - r2(p.monto * factor));
    if (!usd && !ig && !monto) continue;
    reversos.push({ metodo: p.metodo, moneda: p.moneda, monto: -monto, monto_usd: -usd, igtf_usd: -ig, referencia: nota });
    netoUsd = r2(netoUsd - usd); netoIgtf = r2(netoIgtf - ig);
  }
  if (reversos.length) {
    const ult = reversos[reversos.length - 1];
    const difUsd = r2(entregadoUsd - netoUsd), difIgtf = r2(r2(pe.igtf_usd * factor) - netoIgtf);
    ult.monto_usd = r2(ult.monto_usd + difUsd);
    ult.igtf_usd = r2(ult.igtf_usd + difIgtf);
  }
  const nuevoIgtf = r2(pe.igtf_usd * factor);

  if (idemEntrega) {
    try {
      const claim = await sql`UPDATE pedidos SET entrega_idem=${idemEntrega} WHERE id=${id} AND entrega_idem IS NULL RETURNING id`;
      if (!claim.rows.length) throw fail(409, 'Esta entrega ya fue registrada');
    } catch (e) { if (esConflictoIdem(e)) throw fail(409, 'Esta entrega ya fue registrada'); throw e; }
  }

  for (const it of items) {
    const a = ajustes.find(x => x.id === it.id);
    await sql`UPDATE pedido_items SET cantidad_entregada=${it._q}, subtotal=${a.base}, iva_usd=${a.iva} WHERE id=${it.id}`;
    const falta = it.cantidad - it._q;
    if (falta <= 0) continue;
    let resta = falta;
    const movs = (await sql`SELECT lote_id, -cantidad AS q FROM movimientos_stock WHERE tipo='Venta' AND referencia=${'Pedido ' + id} AND producto_id=${it.producto_id} ORDER BY id`).rows;
    for (const m of movs) {
      if (resta <= 0) break;
      const q = Math.min(m.q, resta);
      await sql`UPDATE lotes SET cantidad_actual=cantidad_actual+${q} WHERE id=${m.lote_id}`;
      await movStock(it.producto_id, m.lote_id, 'Devolución', q, 'Faltante pedido ' + id, req.user.id);
      resta -= q;
    }
    if (it.retornable && ['Cesta', 'Botella'].includes(it.tipo_envase))
      await sql`INSERT INTO control_retornables (pdv_id,pedido_id,tipo,entregados,recibidos,fecha,dia,usuario_id) VALUES (${pe.pdv_id},${id},${it.tipo_envase},${-falta},0,${f.toISOString()},${diaE},${req.user.id})`;
  }
  for (const g of reversos) await sql`INSERT INTO pedido_pagos (pedido_id,metodo,moneda,monto,monto_usd,igtf_usd,referencia) VALUES (${id},${g.metodo},${g.moneda},${g.monto},${g.monto_usd},${g.igtf_usd},${g.referencia})`;
  await sql`UPDATE pedidos SET estado=${estado}, fecha_entrega=${f.toISOString()}, a_tiempo=${aTiempo}, completo=${estado === 'Entregado' ? 1 : 0}, faltante_usd=${faltanteUsd},
    subtotal=${nuevoSubtotal}, descuento=${nuevoDescuento}, base_usd=${nuevaBase}, iva_usd=${nuevaIva}, igtf_usd=${nuevoIgtf}, total=${nuevoTotal}, total_bs=${nuevoTotalBs} WHERE id=${id}`;
  await log(req.user, 'Entrega registrada', `#${id} ${estado}${aTiempo ? '' : ' (tarde)'}${faltanteUsd > 0 ? ` faltante ${faltanteUsd} USD con ajuste financiero` : ''}`);
  res.json({ ok: true, estado, a_tiempo: !!aTiempo, faltante_usd: faltanteUsd, entregado_usd: entregadoUsd, ajustado: reversos.length > 0 });
}));

// ---------- Cobranza ----------
app.get('/api/cobranza', auth, h(async (req, res) =>
  res.json((await sql`SELECT p.id, p.rif, p.nombre, p.limite_credito,
    COALESCE((SELECT SUM(pg.monto_usd) FROM pedido_pagos pg JOIN pedidos pe ON pg.pedido_id=pe.id WHERE pe.pdv_id=p.id AND pe.estado<>'Rechazado' AND pg.metodo='Crédito'),0)
    - COALESCE((SELECT SUM(c.monto_usd) FROM cobranzas c WHERE c.pdv_id=p.id),0) AS saldo
    FROM pdvs p ORDER BY p.id`).rows)));

app.post('/api/cobranza', auth, h(async (req, res) => {
  const body = req.body || {}, { pdv_id, metodo, monto, referencia } = body, idem = claveIdem(body.idem);
  if (idem && (await sql`SELECT id FROM cobranzas WHERE usuario_id=${req.user.id} AND idem=${idem}`).rows.length)
    throw fail(409, 'Este abono ya fue registrado');
  if (!isInt(pdv_id, 1, 1e9)) throw fail(400, 'Seleccione un cliente');
  if (metodo === 'Crédito') throw fail(400, 'Seleccione un método de cobro válido');
  const tServ = (await tasaVigente()).tasa; if (!(tServ > 0)) throw fail(400, 'No hay tasa BCV configurada');
  const tasa = tasaOp(body, tServ), f = await fiscal(), g = normalizarPagos([{ metodo, monto, referencia }], tasa, f)[0];
  const saldo = await saldoCxC(pdv_id);
  if (g.monto_usd > saldo + 0.02) throw fail(400, `El abono aplicado (${r2(g.monto_usd)} USD) excede el saldo pendiente (${r2(saldo)} USD)`);
  const fe = fechaCliente(body.fecha_cliente);
  let cobro;
  try {
    cobro = await sql`INSERT INTO cobranzas (pdv_id,usuario_id,fecha,dia,metodo,moneda,monto,monto_usd,igtf_usd,tasa,referencia,idem) VALUES (${+pdv_id},${req.user.id},${fe.toISOString()},${diaDe(fe)},${g.metodo},${g.moneda},${g.monto},${g.monto_usd},${g.igtf_usd},${tasa},${g.referencia},${idem}) ON CONFLICT (usuario_id, idem) DO NOTHING RETURNING id`;
  } catch (e) { if (esConflictoIdem(e)) throw fail(409, 'Este abono ya fue registrado'); throw e; }
  if (idem && !cobro.rows.length) throw fail(409, 'Este abono ya fue registrado');
  await log(req.user, 'Abono registrado', `PDV ${pdv_id} ${r2(g.monto_usd)} USD aplicados (${g.metodo})`);
  res.json({ ok: true, saldo: r2(saldo - g.monto_usd), igtf_usd: r2(g.igtf_usd) });
}));

// ---------- KPIs ----------
app.get('/api/kpis', auth, h(async (req, res) => {
  const d = hoy(), d30 = addDias(d, -30), lim = addDias(d, 30);
  const v = (await sql`SELECT COALESCE(SUM(total),0) AS usd, COALESCE(SUM(total_bs),0) AS bs FROM pedidos WHERE dia=${d} AND estado<>'Rechazado'`).rows[0];
  const red = (await sql`SELECT AVG(cumplimiento_pct) AS a FROM red_auditorias`).rows[0].a;
  const cxc = (await sql`SELECT COALESCE((SELECT SUM(pg.monto_usd) FROM pedido_pagos pg JOIN pedidos pe ON pg.pedido_id=pe.id WHERE pg.metodo='Crédito' AND pe.estado<>'Rechazado'),0) - COALESCE((SELECT SUM(monto_usd) FROM cobranzas),0) AS s`).rows[0].s;
  const ret = (await sql`SELECT COALESCE(SUM(entregados),0)::int AS e, COALESCE(SUM(recibidos),0)::int AS r FROM control_retornables WHERE dia >= ${d30}`).rows[0];
  const ot = (await sql`SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE a_tiempo=1 AND completo=1)::int AS ok FROM pedidos WHERE estado IN ('Entregado','Entregado parcial','Rechazado') AND LEFT(fecha_entrega,10) >= ${d30}`).rows[0];
  const pend = (await sql`SELECT COUNT(*)::int AS c FROM pedidos WHERE estado IN ('Confirmado','En ruta')`).rows[0].c;
  const bajo = (await sql`SELECT COUNT(*)::int AS c FROM productos p WHERE p.activo=1 AND p.stock_minimo>0 AND COALESCE((SELECT SUM(cantidad_actual) FROM lotes l WHERE l.producto_id=p.id AND (l.fecha_vencimiento IS NULL OR l.fecha_vencimiento>=${d})),0) < p.stock_minimo`).rows[0].c;
  const pv = (await sql`SELECT COALESCE(SUM(cantidad_actual),0)::int AS u FROM lotes WHERE cantidad_actual>0 AND fecha_vencimiento IS NOT NULL AND fecha_vencimiento>=${d} AND fecha_vencimiento<=${lim}`).rows[0].u;
  const venc = (await sql`SELECT COALESCE(SUM(cantidad_actual),0)::int AS u FROM lotes WHERE cantidad_actual>0 AND fecha_vencimiento IS NOT NULL AND fecha_vencimiento<${d}`).rows[0].u;
  const vv = (await sql`SELECT COUNT(DISTINCT v.pdv_id)::int AS vis, COUNT(DISTINCT pe.pdv_id)::int AS ped FROM visitas v LEFT JOIN pedidos pe ON pe.pdv_id=v.pdv_id AND pe.dia=${d} AND pe.estado<>'Rechazado' WHERE v.dia=${d}`).rows[0];
  res.json({
    visitasConVenta: vv.vis ? Math.round(vv.ped / vv.vis * 100) : null, visitasMedidas: vv.vis,
    cumplimientoRED: red == null ? null : Math.round(red),
    retornabilidad: ret.e > 0 ? Math.min(100, Math.round(ret.r / ret.e * 100)) : null,
    otif: ot.n > 0 ? Math.round(ot.ok / ot.n * 100) : null, entregasMedidas: ot.n,
    ventasUsd: parseFloat(v.usd), ventasBs: parseFloat(v.bs), cxcUsd: parseFloat(cxc) || 0,
    pendientesEntrega: pend, stockBajo: bajo, porVencer: pv, vencidos: venc
  });
}));

// Ventas por zona dentro de un período; las zonas sin ventas aparecen en cero
function rangoPeriodo(periodo) {
  const hasta = hoy(); let desde = hasta;
  if (periodo === 'semana') desde = periodoDesde(hasta, 'Semanal');
  else if (periodo === 'mes') desde = hasta.slice(0, 8) + '01';
  else if (periodo === 'trimestre') { const m = +hasta.slice(5, 7); desde = `${hasta.slice(0, 4)}-${String(Math.floor((m - 1) / 3) * 3 + 1).padStart(2, '0')}-01`; }
  else if (periodo === 'anio') desde = hasta.slice(0, 4) + '-01-01';
  return { desde, hasta };
}
app.get('/api/ventas-zona', auth, h(async (req, res) => {
  const periodo = ['hoy', 'semana', 'mes', 'trimestre', 'anio'].includes(req.query.periodo) ? req.query.periodo : 'mes', { desde, hasta } = rangoPeriodo(periodo);
  const zonas = (await sql`SELECT z.id, z.nombre, z.color, COALESCE(SUM(CASE WHEN pe.estado='Rechazado' THEN 0 ELSE pe.total END),0)::float AS total,
      COUNT(pe.id) FILTER (WHERE pe.estado<>'Rechazado')::int AS pedidos
    FROM zonas z LEFT JOIN pdvs p ON p.zona_id=z.id
    LEFT JOIN pedidos pe ON pe.pdv_id=p.id AND pe.dia>=${desde} AND pe.dia<=${hasta}
    GROUP BY z.id, z.nombre, z.color ORDER BY total DESC, z.nombre`).rows;
  res.json({ periodo, desde, hasta, zonas });
}));

// Cantidades vendidas por escala temporal (datos reales; los períodos sin ventas aparecen en cero)
function inicioPeriodo(escala, dia) {
  if (escala === 'semanal') return periodoDesde(dia, 'Semanal');
  if (escala === 'mensual') return dia.slice(0, 7) + '-01';
  if (escala === 'trimestral') { const [y, m] = dia.split('-').map(Number); return `${y}-${String(Math.floor((m - 1) / 3) * 3 + 1).padStart(2, '0')}-01`; }
  if (escala === 'anual') return dia.slice(0, 4) + '-01-01';
  return dia;
}
function periodoAnterior(escala, ini) {
  if (escala === 'diario') return addDias(ini, -1);
  if (escala === 'semanal') return addDias(ini, -7);
  const [y, m] = ini.split('-').map(Number);
  if (escala === 'anual') return `${y - 1}-01-01`;
  if (escala === 'mensual') return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10);
  const t = new Date(Date.UTC(y, m - 1 - 3, 1)); return t.toISOString().slice(0, 10);
}
app.get('/api/ventas-serie', auth, h(async (req, res) => {
  const escala = ['diario', 'semanal', 'mensual', 'trimestral', 'anual'].includes(req.query.escala) ? req.query.escala : 'diario';
  const zona = isInt(req.query.zona_id, 1, 1e9) ? +req.query.zona_id : null;
  const cuantos = { diario: 30, semanal: 12, mensual: 6, trimestral: 8, anual: 5 }[escala], trunc = { diario: 'day', semanal: 'week', mensual: 'month', trimestral: 'quarter', anual: 'year' }[escala];
  const periodos = []; let cur = inicioPeriodo(escala, hoy());
  for (let i = 0; i < cuantos; i++) { periodos.unshift(cur); cur = periodoAnterior(escala, cur); }
  const rows = (await sql`SELECT to_char(date_trunc(${trunc}, pe.dia::date), 'YYYY-MM-DD') AS periodo,
      COALESCE(SUM(u.unidades),0)::int AS unidades, SUM(pe.total)::float AS usd, COUNT(pe.id)::int AS pedidos
    FROM pedidos pe JOIN pdvs p ON p.id=pe.pdv_id
    LEFT JOIN (SELECT pedido_id, SUM(cantidad)::int AS unidades FROM pedido_items GROUP BY pedido_id) u ON u.pedido_id=pe.id
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
  const { pdv_id, tipo, cantidad } = req.body || {}, idem = claveIdem(req.body && req.body.idem);
  if (idem && (await sql`SELECT id FROM control_retornables WHERE usuario_id=${req.user.id} AND idem=${idem}`).rows.length)
    throw fail(409, 'Esta devolución ya fue registrada');
  if (!['Cesta', 'Botella'].includes(tipo)) throw fail(400, 'Tipo de envase inválido');
  if (!isInt(cantidad, 1, 100000)) throw fail(400, 'Cantidad inválida');
  if (!isInt(pdv_id, 1, 1e9)) throw fail(400, 'Seleccione un cliente válido');
  const pdv = (await sql`SELECT id, nombre FROM pdvs WHERE id = ${+pdv_id}`).rows[0]; if (!pdv) throw fail(404, 'PDV no encontrado');
  const t = (await sql`SELECT COALESCE(SUM(entregados),0)::int AS e, COALESCE(SUM(recibidos),0)::int AS r FROM control_retornables WHERE pdv_id=${pdv.id} AND tipo=${tipo}`).rows[0];
  if (+cantidad > t.e - t.r) throw fail(400, `No se pueden recibir ${cantidad} ${tipo.toLowerCase()}(s): a este cliente solo se le han entregado ${t.e} y ya devolvió ${t.r}.`);
  const f = fechaCliente(req.body.fecha_cliente);
  let dev;
  try {
    dev = await sql`INSERT INTO control_retornables (pdv_id,pedido_id,tipo,entregados,recibidos,fecha,dia,usuario_id,idem) VALUES (${pdv.id},NULL,${tipo},0,${+cantidad},${f.toISOString()},${diaDe(f)},${req.user.id},${idem}) ON CONFLICT (usuario_id, idem) DO NOTHING RETURNING id`;
  } catch (e) { if (esConflictoIdem(e)) throw fail(409, 'Esta devolución ya fue registrada'); throw e; }
  if (idem && !dev.rows.length) throw fail(409, 'Esta devolución ya fue registrada');
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
app.get('/api/red', auth, h(async (req, res) => {
  const solo = req.user.rol === 'Preventista' ? req.user.id : null;
  res.json((await sql`SELECT r.id, r.pdv_id, r.cumplimiento_pct, r.share_pct, r.asignados, r.propios, r.competencia, r.fecha, r.observaciones, (r.foto IS NOT NULL) AS tiene_foto, p.nombre AS pdv_nombre
    FROM red_auditorias r JOIN pdvs p ON r.pdv_id=p.id WHERE (${solo}::int IS NULL OR r.usuario_id=${solo}::int) ORDER BY r.id DESC LIMIT 50`).rows);
}));
app.get('/api/red/:id/foto', auth, h(async (req, res) => {
  const r = (await sql`SELECT usuario_id, foto FROM red_auditorias WHERE id=${+req.params.id}`).rows[0];
  if (!r || !r.foto) throw fail(404, 'Sin fotografía');
  exigirPropio(req, r.usuario_id);
  res.json({ foto: r.foto });
}));

// ---------- Activos en comodato ----------
app.get('/api/comodatos', auth, h(async (req, res) =>
  res.json((await sql`SELECT a.*, p.nombre AS pdv_nombre, p.rif FROM activos_comodato a JOIN pdvs p ON a.pdv_id=p.id ORDER BY a.id`).rows)));
app.post('/api/comodatos/:id/mantenimiento', auth, rol('Gerente', 'Supervisor'), h(async (req, res) => {
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
const idsSeleccionados = v => Array.isArray(v) ? [...new Set(v.slice(0, 500).map(Number))].filter(n => Number.isInteger(n) && n > 0) : [];
app.post('/api/vrp', auth, h(async (req, res) => {
  const ids = idsSeleccionados(req.body && req.body.pdv_ids);
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
app.post('/api/despachos', auth, rol('Gerente', 'Supervisor'), h(async (req, res) => {
  const ids = idsSeleccionados(req.body && req.body.pdv_ids); let n = 0;
  for (const id of ids) n += (await sql`UPDATE pedidos SET estado='En ruta' WHERE pdv_id=${id} AND estado='Confirmado' RETURNING id`).rows.length;
  if (!n) throw fail(400, 'No hay pedidos confirmados pendientes de despacho en esos PDV');
  await log(req.user, 'Ruta despachada', n + ' pedido(s) en ruta'); res.json({ ok: true, pedidos: n });
}));

// ---------- Mermas ----------
app.post('/api/mermas', auth, h(async (req, res) => {
  const { pdv_id, producto_id, cantidad, causa } = req.body || {}, idem = claveIdem(req.body && req.body.idem);
  if (idem && (await sql`SELECT id FROM mermas WHERE usuario_id=${req.user.id} AND idem=${idem}`).rows.length)
    throw fail(409, 'Esta merma ya fue registrada');
  if (!isInt(cantidad, 1, 100000)) throw fail(400, 'Cantidad inválida');
  if (!CAUSAS.includes(causa)) throw fail(400, 'Causa no válida');
  if (pdv_id != null && !isInt(pdv_id, 1, 1e9)) throw fail(400, 'Cliente inválido');
  if (producto_id != null && !isInt(producto_id, 1, 1e9)) throw fail(400, 'Producto inválido');
  const f = fechaCliente(req.body.fecha_cliente), descontar = !!producto_id && !pdv_id;   // merma de almacén o transporte descuenta stock; la del cliente no
  if (descontar && !['Gerente', 'Supervisor'].includes(req.user.rol)) throw fail(403, 'Solo Gerencia o Supervisoría pueden descontar stock por mermas');
  if (descontar) {
    let us; try { us = await consumirFIFO(+producto_id, +cantidad, hoy(), true); } catch (e) { throw fail(409, 'La cantidad supera el stock registrado de ese producto'); }
    for (const u of us) await movStock(+producto_id, u.lote_id, 'Merma', -u.cantidad, causa, req.user.id);
  }
  let merma;
  try {
    merma = await sql`INSERT INTO mermas (pdv_id,producto_id,cantidad,causa,responsable,usuario_id,fecha,dia,descontar_stock,idem) VALUES (${pdv_id || null},${producto_id || null},${+cantidad},${causa},${req.user.nombre},${req.user.id},${f.toISOString()},${diaDe(f)},${descontar ? 1 : 0},${idem}) ON CONFLICT (usuario_id, idem) DO NOTHING RETURNING id`;
  } catch (e) { if (esConflictoIdem(e)) throw fail(409, 'Esta merma ya fue registrada'); throw e; }
  if (idem && !merma.rows.length) throw fail(409, 'Esta merma ya fue registrada');
  await log(req.user, 'Merma registrada', `${cantidad} u. (${causa})${descontar ? ' con descuento de stock' : ''}`);
  res.json({ ok: true, descontado: descontar });
}));
app.get('/api/mermas', auth, h(async (req, res) =>
  res.json((await sql`SELECT m.*, pr.nombre AS producto, p.nombre AS pdv_nombre FROM mermas m LEFT JOIN productos pr ON m.producto_id=pr.id LEFT JOIN pdvs p ON m.pdv_id=p.id ORDER BY m.id DESC LIMIT 50`).rows)));

// ---------- Liquidación ----------
async function resumenDia(uid) {
  const d = hoy();
  const filas = (await sql`SELECT metodo, moneda, COUNT(*) AS n, SUM(monto) AS monto, SUM(monto_usd) AS monto_usd, SUM(igtf_usd) AS igtf_usd FROM (
      SELECT pg.metodo, pg.moneda, pg.monto, pg.monto_usd, pg.igtf_usd FROM pedido_pagos pg JOIN pedidos pe ON pg.pedido_id=pe.id WHERE pe.usuario_id=${uid} AND pe.dia=${d}
      UNION ALL
      SELECT c.metodo, c.moneda, c.monto, c.monto_usd, c.igtf_usd FROM cobranzas c WHERE c.usuario_id=${uid} AND c.dia=${d}
    ) x GROUP BY metodo, moneda ORDER BY metodo`).rows
    .map(f => ({ metodo: f.metodo, moneda: f.moneda, n: parseInt(f.n), monto: parseFloat(f.monto), monto_usd: parseFloat(f.monto_usd), igtf_usd: parseFloat(f.igtf_usd) || 0 }));
  const g = n => (filas.find(f => f.metodo === n) || {}).monto || 0;
  return {
    filas, esperado_usd: r2(g('Efectivo USD')), esperado_bs: r2(g('Efectivo Bs')),
    digital_usd: r2(filas.filter(f => !f.metodo.startsWith('Efectivo') && f.metodo !== 'Crédito').reduce((s, f) => s + f.monto_usd + f.igtf_usd, 0)),
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
  let id;
  try {
    id = (await sql`INSERT INTO liquidaciones (usuario_id,fecha,dia,tasa,esperado_usd,entregado_usd,esperado_bs,entregado_bs,digital_usd,credito_usd,diferencia_usd,observaciones,detalle)
      VALUES (${req.user.id},${new Date().toISOString()},${hoy()},${tasa},${r.esperado_usd},${entUsd},${r.esperado_bs},${entBs},${r.digital_usd},${r.credito_usd},${difEq},${obs || null},${JSON.stringify(r.filas)}) RETURNING id`).rows[0].id;
  } catch (e) { if (esConflictoIdem(e)) throw fail(409, 'Ya cerró su caja hoy'); throw e; }
  await log(req.user, 'Cierre de caja', `#${id} diferencia ${difEq} USD`);
  res.json({ id, esperado_usd: r.esperado_usd, esperado_bs: r.esperado_bs, dif_usd: difUsd, dif_bs: difBs, dif_equiv_usd: difEq, tasa });
}));
app.get('/api/liquidaciones', auth, h(async (req, res) => {
  const solo = req.user.rol === 'Preventista' ? req.user.id : null;
  res.json((await sql`SELECT l.*, COALESCE(u.nombre,'-') AS vendedor FROM liquidaciones l LEFT JOIN usuarios u ON l.usuario_id=u.id
    WHERE (${solo}::int IS NULL OR l.usuario_id=${solo}::int) ORDER BY l.id DESC LIMIT 30`).rows);
}));
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
  await sql`UPDATE usuarios SET password_hash=${bcrypt.hashSync(nueva, 10)}, token_version=COALESCE(token_version,0)+1 WHERE id=${u.id}`;
  await log(req.user, 'Cambio de contraseña'); res.json({ ok: true, sesiones_cerradas: true });
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
  await sql`UPDATE usuarios SET nombre=${nom}, rol=${rol2}, activo=${act}, token_version=COALESCE(token_version,0)+1 WHERE id=${id}`;
  if (password) await sql`UPDATE usuarios SET password_hash=${bcrypt.hashSync(password, 10)} WHERE id=${id}`;
  await log(req.user, 'Usuario modificado', u.usuario + (password ? ' (clave restablecida)' : '')); res.json({ ok: true });
}));
app.get('/api/bitacora', auth, rol('Gerente', 'Supervisor'), h(async (req, res) => res.json((await sql`SELECT * FROM bitacora ORDER BY id DESC LIMIT 200`).rows)));

// ---------- Respuestas JSON para rutas inexistentes y errores de solicitud ----------
app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'El cuerpo de la solicitud no es JSON válido' });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'La solicitud es demasiado grande' });
  console.error(err);
  res.status((err && err.status) || 500).json({ error: (err && err.status) ? err.message : 'Error interno del servidor' });
});

module.exports = app;
