const express = require('express');
const { sql } = require('@vercel/postgres');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const app = express();
const JWT_SECRET = 'sig-fmcg-maracaibo-2026';

app.use(express.json({ limit: '20mb' }));

async function initDB() {
  try {
    await sql`CREATE TABLE IF NOT EXISTS usuarios (id SERIAL PRIMARY KEY, nombre TEXT, cedula TEXT, usuario TEXT UNIQUE, password_hash TEXT, rol TEXT, zona_id INTEGER, activo INTEGER DEFAULT 1);`;
    await sql`CREATE TABLE IF NOT EXISTS zonas (id SERIAL PRIMARY KEY, nombre TEXT UNIQUE, color TEXT);`;
    await sql`CREATE TABLE IF NOT EXISTS pdvs (id SERIAL PRIMARY KEY, codigo TEXT UNIQUE, razon_social TEXT, nombre TEXT, direccion TEXT, zona_id INTEGER, lat NUMERIC, lng NUMERIC, geofence_radio_m INTEGER DEFAULT 50, saldo_cestas INTEGER DEFAULT 0, saldo_botellas INTEGER DEFAULT 0, limite_cestas INTEGER DEFAULT 10, limite_botellas INTEGER DEFAULT 20, canal TEXT DEFAULT 'Abasto');`;
    await sql`CREATE TABLE IF NOT EXISTS productos (id SERIAL PRIMARY KEY, codigo TEXT UNIQUE, nombre TEXT, precio NUMERIC, retornable INTEGER DEFAULT 0, tipo_envase TEXT, fecha_vencimiento TEXT);`;
    await sql`CREATE TABLE IF NOT EXISTS promociones (id SERIAL PRIMARY KEY, nombre TEXT, producto_id INTEGER, tipo TEXT, min_cantidad INTEGER, descuento_pct NUMERIC, activa INTEGER DEFAULT 1);`;
    await sql`CREATE TABLE IF NOT EXISTS pedidos (id SERIAL PRIMARY KEY, pdv_id INTEGER, usuario_id INTEGER, fecha TEXT, subtotal NUMERIC DEFAULT 0, descuento NUMERIC DEFAULT 0, total NUMERIC, estado TEXT DEFAULT 'Confirmado', metodo_pago TEXT DEFAULT 'Efectivo');`;
    await sql`CREATE TABLE IF NOT EXISTS pedido_items (id SERIAL PRIMARY KEY, pedido_id INTEGER, producto_id INTEGER, cantidad INTEGER, precio_unitario NUMERIC, descuento_pct NUMERIC DEFAULT 0, subtotal NUMERIC);`;
    await sql`CREATE TABLE IF NOT EXISTS visitas (id SERIAL PRIMARY KEY, pdv_id INTEGER, usuario_id INTEGER, fecha_checkin TEXT, lat NUMERIC, lng NUMERIC, distancia_m NUMERIC, estado TEXT DEFAULT 'Efectiva');`;
    await sql`CREATE TABLE IF NOT EXISTS control_retornables (id SERIAL PRIMARY KEY, pdv_id INTEGER, pedido_id INTEGER, tipo TEXT, entregados INTEGER DEFAULT 0, recibidos INTEGER DEFAULT 0, fecha TEXT);`;
    await sql`CREATE TABLE IF NOT EXISTS activos_comodato (id SERIAL PRIMARY KEY, pdv_id INTEGER, codigo_qr TEXT UNIQUE, tipo TEXT, marca TEXT, temperatura_actual NUMERIC, temp_min NUMERIC DEFAULT 2, temp_max NUMERIC DEFAULT 8);`;
    await sql`CREATE TABLE IF NOT EXISTS cadena_frio (id SERIAL PRIMARY KEY, camion TEXT, temperatura NUMERIC, alerta INTEGER DEFAULT 0, fecha TEXT);`;
    await sql`CREATE TABLE IF NOT EXISTS red_auditorias (id SERIAL PRIMARY KEY, pdv_id INTEGER, usuario_id INTEGER, cumplimiento_pct NUMERIC, marca_propia_pct NUMERIC, competencia_pct NUMERIC, fecha TEXT);`;
    await sql`CREATE TABLE IF NOT EXISTS mermas (id SERIAL PRIMARY KEY, pdv_id INTEGER, producto_id INTEGER, cantidad INTEGER, causa TEXT, responsable TEXT, fecha TEXT);`;
    await sql`CREATE TABLE IF NOT EXISTS liquidaciones (id SERIAL PRIMARY KEY, usuario_id INTEGER, fecha TEXT, efectivo_esperado NUMERIC, efectivo_entregado NUMERIC, diferencia NUMERIC);`;

    const check = await sql`SELECT COUNT(*) as c FROM usuarios`;
    if (parseInt(check.rows[0].c) === 0) {
      const pass = bcrypt.hashSync('admin123', 10);
      const passP = bcrypt.hashSync('pedro123', 10);
      await sql`INSERT INTO usuarios (nombre,usuario,password_hash,rol) VALUES ('Gerente','admin',${pass},'Gerente')`;
      await sql`INSERT INTO usuarios (nombre,usuario,password_hash,rol) VALUES ('Pedro','pedro',${passP},'Preventista')`;
      await sql`INSERT INTO zonas (nombre,color) VALUES ('Centro','#0B6E4F'),('Bella Vista','#F4A261'),('Las Pulgas','#E63946')`;
      await sql`INSERT INTO pdvs (codigo,nombre,zona_id,lat,lng,saldo_cestas,saldo_botellas) VALUES ('PDV-001','Bodega Esperanza',1,10.6427,-71.6125,2,0),('PDV-002','Panadería Trigal',1,10.6450,-71.6150,0,0),('PDV-007','Mayorista Pulgas',3,10.6472,-71.6565,15,25)`;
      await sql`INSERT INTO productos (codigo,nombre,precio,retornable,tipo_envase) VALUES ('REF-2L','Refresco 2L',35,1,'Botella'),('AGU-C12','Agua Cesta',120,1,'Cesta')`;
    }
  } catch (e) { console.error("Error initDB:", e); }
}
initDB();

function auth(req, res, next) {
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  if (!t) return res.status(401).json({ error: 'No autorizado' });
  try { req.user = jwt.verify(t, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Token inválido' }); }
}

function hav(lat1, lon1, lat2, lon2) {
  const R = 6371000, r = x => x * Math.PI / 180;
  const dLat = r(lat2 - lat1), dLon = r(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(r(lat1))*Math.cos(r(lat2))*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

app.post('/api/login', async (req, res) => {
  const { usuario, password } = req.body;
  try {
    const { rows } = await sql`SELECT * FROM usuarios WHERE usuario = ${usuario} AND activo = 1`;
    const u = rows[0];
    if (!u || !bcrypt.compareSync(password, u.password_hash)) return res.status(401).json({ error: 'Credenciales incorrectas' });
    const token = jwt.sign({ id: u.id, nombre: u.nombre, rol: u.rol }, JWT_SECRET, { expiresIn: '8h' });
    res.json({ token, user: { id: u.id, nombre: u.nombre, rol: u.rol } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/zonas', auth, async (req, res) => res.json((await sql`SELECT * FROM zonas`).rows));
app.get('/api/productos', auth, async (req, res) => res.json((await sql`SELECT * FROM productos`).rows));
app.get('/api/promociones', auth, async (req, res) => res.json((await sql`SELECT pr.*, p.nombre as producto FROM promociones pr JOIN productos p ON pr.producto_id=p.id WHERE pr.activa=1`).rows));

app.get('/api/pdvs', auth, async (req, res) => {
  const { rows } = await sql`SELECT p.*, z.nombre as zona_nombre, z.color as zona_color FROM pdvs p JOIN zonas z ON p.zona_id = z.id`;
  res.json(rows);
});

app.post('/api/visitas/checkin', auth, async (req, res) => {
  const { pdv_id, lat, lng } = req.body;
  const pdv = (await sql`SELECT * FROM pdvs WHERE id = ${pdv_id}`).rows[0];
  if (!pdv) return res.status(404).json({ error: 'PDV no encontrado' });
  const dist = hav(lat, lng, pdv.lat, pdv.lng);
  if (dist > pdv.geofence_radio_m) return res.status(400).json({ error: 'FUERA DE GEOFENCE', mensaje: `Estás a ${Math.round(dist)}m.` });
  const r = await sql`INSERT INTO visitas (pdv_id,usuario_id,fecha_checkin,lat,lng,distancia_m) VALUES (${pdv_id},${req.user.id},${new Date().toISOString()},${lat},${lng},${dist}) RETURNING id`;
  res.json({ id: r.rows[0].id, distancia_m: Math.round(dist) });
});
app.get('/api/visitas', auth, async (req, res) => res.json((await sql`SELECT v.*, p.nombre as pdv_nombre FROM visitas v JOIN pdvs p ON v.pdv_id=p.id ORDER BY v.id DESC LIMIT 50`).rows));

app.post('/api/pedidos', auth, async (req, res) => {
  const { pdv_id, items, metodo_pago } = req.body;
  const pdv = (await sql`SELECT * FROM pdvs WHERE id = ${pdv_id}`).rows[0];
  if (pdv.saldo_cestas > pdv.limite_cestas || pdv.saldo_botellas > pdv.limite_botellas) return res.status(400).json({ error: 'BLOQUEADO', mensaje: 'Excede límite de retornables' });
  
  let subtotal = 0;
  for (const it of items) {
    const p = (await sql`SELECT * FROM productos WHERE id = ${it.producto_id}`).rows[0];
    subtotal += p.precio * it.cantidad;
  }
  
  const pid = (await sql`INSERT INTO pedidos (pdv_id,usuario_id,fecha,subtotal,total,metodo_pago) VALUES (${pdv_id},${req.user.id},${new Date().toISOString()},${subtotal},${subtotal},${metodo_pago}) RETURNING id`).rows[0].id;
  
  for (const i of items) {
    const p = (await sql`SELECT * FROM productos WHERE id = ${i.producto_id}`).rows[0];
    await sql`INSERT INTO pedido_items (pedido_id,producto_id,cantidad,precio_unitario,subtotal) VALUES (${pid},${i.producto_id},${i.cantidad},${p.precio},${p.precio*i.cantidad})`;
    if (p.retornable && p.tipo_envase === 'Cesta') await sql`UPDATE pdvs SET saldo_cestas = saldo_cestas + ${i.cantidad} WHERE id = ${pdv_id}`;
    if (p.retornable && p.tipo_envase === 'Botella') await sql`UPDATE pdvs SET saldo_botellas = saldo_botellas + ${i.cantidad} WHERE id = ${pdv_id}`;
  }
  res.json({ id: pid, total: subtotal });
});

app.get('/api/pedidos', auth, async (req, res) => {
  const pedidos = (await sql`SELECT pe.*, p.nombre as pdv_nombre FROM pedidos pe JOIN pdvs p ON pe.pdv_id=p.id ORDER BY pe.id DESC LIMIT 50`).rows;
  for (let pe of pedidos) pe.items = (await sql`SELECT pi.*, pr.nombre FROM pedido_items pi JOIN productos pr ON pi.producto_id=pr.id WHERE pi.pedido_id=${pe.id}`).rows;
  res.json(pedidos);
});

app.get('/api/kpis', auth, async (req, res) => {
  const ventas = parseFloat((await sql`SELECT COALESCE(SUM(total),0) as t FROM pedidos`).rows[0].t);
  res.json({ dropRate: 85, cumplimientoRED: 90, adherenciaTermica: 100, retornabilidad: 98, otif: 95, ventasHoy: ventas, tempActual: 4.0, bloqueados: 1 });
});
app.get('/api/ventas-zona', auth, async (req, res) => res.json((await sql`SELECT z.nombre, z.color, COALESCE(SUM(pe.total),0) as total FROM zonas z LEFT JOIN pdvs p ON p.zona_id=z.id LEFT JOIN pedidos pe ON pe.pdv_id=p.id GROUP BY z.id, z.nombre, z.color`).rows));

app.post('/api/retornables/devolucion', auth, async (req, res) => {
  const { pdv_id, tipo, cantidad } = req.body;
  const campo = tipo === 'Cesta' ? 'saldo_cestas' : 'saldo_botellas';
  const pdv = (await sql`SELECT * FROM pdvs WHERE id = ${pdv_id}`).rows[0];
  const nuevo = Math.max(0, pdv[campo] - cantidad);
  await sql.query(`UPDATE pdvs SET ${campo} = ${nuevo} WHERE id = ${pdv_id}`);
  res.json({ ok: true, nuevo_saldo: nuevo });
});
app.get('/api/retornables', auth, async (req, res) => res.json((await sql`SELECT id, nombre, saldo_cestas, saldo_botellas, limite_cestas, limite_botellas FROM pdvs`).rows));

app.post('/api/frio', auth, async (req, res) => {
  await sql`INSERT INTO cadena_frio (camion,temperatura,fecha) VALUES ('MC-001',${req.body.temperatura},${new Date().toISOString()})`;
  res.json({ ok: true });
});
app.get('/api/frio', auth, async (req, res) => res.json((await sql`SELECT * FROM cadena_frio ORDER BY id DESC LIMIT 30`).rows.reverse()));

module.exports = app;