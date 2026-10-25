const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const app = express();
const JWT_SECRET = 'sig-fmcg-maracaibo-2026';

const pool = new Pool({
  connectionString: process.env.POSTGRES_URL || process.env.POSTGRES_URL_NON_POOLING || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(express.json({ limit: '20mb' }));

// ==================== CREACIÓN DE TABLAS Y DATOS ====================
async function initDB() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS usuarios (id SERIAL PRIMARY KEY, nombre TEXT, cedula TEXT, usuario TEXT UNIQUE, password_hash TEXT, rol TEXT, zona_id INTEGER, activo INTEGER DEFAULT 1);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS zonas (id SERIAL PRIMARY KEY, nombre TEXT UNIQUE, color TEXT);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS pdvs (id SERIAL PRIMARY KEY, codigo TEXT UNIQUE, razon_social TEXT, nombre TEXT, direccion TEXT, zona_id INTEGER, lat NUMERIC, lng NUMERIC, geofence_radio_m INTEGER DEFAULT 50, saldo_cestas INTEGER DEFAULT 0, saldo_botellas INTEGER DEFAULT 0, limite_cestas INTEGER DEFAULT 10, limite_botellas INTEGER DEFAULT 20, canal TEXT DEFAULT 'Abasto');`);
    await pool.query(`CREATE TABLE IF NOT EXISTS productos (id SERIAL PRIMARY KEY, codigo TEXT UNIQUE, nombre TEXT, precio NUMERIC, retornable INTEGER DEFAULT 0, tipo_envase TEXT, fecha_vencimiento TEXT);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS promociones (id SERIAL PRIMARY KEY, nombre TEXT, producto_id INTEGER, tipo TEXT, min_cantidad INTEGER, descuento_pct NUMERIC, activa INTEGER DEFAULT 1);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS pedidos (id SERIAL PRIMARY KEY, pdv_id INTEGER, usuario_id INTEGER, fecha TEXT, subtotal NUMERIC DEFAULT 0, descuento NUMERIC DEFAULT 0, total NUMERIC, metodo_pago TEXT DEFAULT 'Efectivo');`);
    await pool.query(`CREATE TABLE IF NOT EXISTS pedido_items (id SERIAL PRIMARY KEY, pedido_id INTEGER, producto_id INTEGER, cantidad INTEGER, precio_unitario NUMERIC, descuento_pct NUMERIC DEFAULT 0, subtotal NUMERIC);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS visitas (id SERIAL PRIMARY KEY, pdv_id INTEGER, usuario_id INTEGER, fecha_checkin TEXT, lat NUMERIC, lng NUMERIC, distancia_m NUMERIC, estado TEXT DEFAULT 'Efectiva');`);
    await pool.query(`CREATE TABLE IF NOT EXISTS control_retornables (id SERIAL PRIMARY KEY, pdv_id INTEGER, pedido_id INTEGER, tipo TEXT, entregados INTEGER DEFAULT 0, recibidos INTEGER DEFAULT 0, fecha TEXT);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS activos_comodato (id SERIAL PRIMARY KEY, pdv_id INTEGER, codigo_qr TEXT UNIQUE, tipo TEXT, marca TEXT, temperatura_actual NUMERIC, temp_min NUMERIC DEFAULT 2, temp_max NUMERIC DEFAULT 8);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS cadena_frio (id SERIAL PRIMARY KEY, camion TEXT, temperatura NUMERIC, alerta INTEGER DEFAULT 0, fecha TEXT);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS red_auditorias (id SERIAL PRIMARY KEY, pdv_id INTEGER, usuario_id INTEGER, cumplimiento_pct NUMERIC, marca_propia_pct NUMERIC, competencia_pct NUMERIC, fecha TEXT);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS mermas (id SERIAL PRIMARY KEY, pdv_id INTEGER, producto_id INTEGER, cantidad INTEGER, causa TEXT, responsable TEXT, fecha TEXT);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS liquidaciones (id SERIAL PRIMARY KEY, usuario_id INTEGER, fecha TEXT, efectivo_esperado NUMERIC, efectivo_entregado NUMERIC, diferencia NUMERIC);`);

    const res = await pool.query('SELECT COUNT(*) FROM usuarios');
    if (parseInt(res.rows[0].count) === 0) {
      const pass = bcrypt.hashSync('admin123', 10);
      const passP = bcrypt.hashSync('pedro123', 10);
      
      await pool.query(`INSERT INTO usuarios (nombre,cedula,usuario,password_hash,rol,zona_id) VALUES ('Gerente General','V-111','admin',$1,'Gerente',null)`, [pass]);
      await pool.query(`INSERT INTO usuarios (nombre,cedula,usuario,password_hash,rol,zona_id) VALUES ('Pedro Preventista','V-333','pedro',$1,'Preventista',1)`, [passP]);
      
      await pool.query(`INSERT INTO zonas (nombre,color) VALUES ('Centro','#0B6E4F'),('Bella Vista','#F4A261'),('Las Pulgas','#E63946')`);
      
      await pool.query(`INSERT INTO pdvs (codigo,razon_social,nombre,direccion,zona_id,lat,lng,saldo_cestas,saldo_botellas) VALUES ('PDV-001','Bodega Esperanza','Bodega Esperanza','Calle 77',1,10.6427,-71.6125,2,0),('PDV-002','Panadería Trigal','Panadería Trigal','Av. Bella Vista',1,10.6450,-71.6150,0,0),('PDV-007','Mayorista Pulgas','Mayorista Pulgas','Pasillo 3',3,10.6472,-71.6565,15,25)`);
      
      await pool.query(`INSERT INTO productos (codigo,nombre,precio,retornable,tipo_envase,fecha_vencimiento) VALUES ('REF-2L','Refresco 2L',35,1,'Botella',null),('AGU-C12','Agua Cesta',120,1,'Cesta',null),('YOG-1L','Yogurt 1L',60,0,null,'2026-11-05')`);
      
      await pool.query(`INSERT INTO promociones (nombre,producto_id,tipo,min_cantidad,descuento_pct) VALUES ('Volumen Refresco',1,'Volumen',10,10)`);
      await pool.query(`INSERT INTO activos_comodato (pdv_id,codigo_qr,tipo,marca,temperatura_actual) VALUES (1,'QR-001','Nevera','Propia',4.5)`);
    }
  } catch (e) { console.error("Error initDB:", e); }
}
initDB();

// ==================== MIDDLEWARES ====================
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

// ==================== RUTAS ====================
app.post('/api/login', async (req, res) => {
  const { usuario, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM usuarios WHERE usuario = $1 AND activo = 1', [usuario]);
    const u = result.rows[0];
    if (!u || !bcrypt.compareSync(password, u.password_hash)) return res.status(401).json({ error: 'Credenciales incorrectas' });
    const token = jwt.sign({ id: u.id, nombre: u.nombre, rol: u.rol, zona_id: u.zona_id }, JWT_SECRET, { expiresIn: '8h' });
    res.json({ token, user: { id: u.id, nombre: u.nombre, rol: u.rol, zona_id: u.zona_id } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/zonas', auth, async (req, res) => res.json((await pool.query('SELECT * FROM zonas')).rows));
app.get('/api/productos', auth, async (req, res) => res.json((await pool.query('SELECT * FROM productos')).rows));
app.get('/api/promociones', auth, async (req, res) => res.json((await pool.query('SELECT pr.*, p.nombre as producto FROM promociones pr JOIN productos p ON pr.producto_id=p.id WHERE pr.activa=1')).rows));

app.get('/api/pdvs', auth, async (req, res) => {
  const result = await pool.query('SELECT p.*, z.nombre as zona_nombre, z.color as zona_color FROM pdvs p JOIN zonas z ON p.zona_id = z.id');
  res.json(result.rows);
});

app.post('/api/pdvs', auth, async (req, res) => {
  const d = req.body;
  try {
    const r = await pool.query(`INSERT INTO pdvs (codigo,razon_social,nombre,direccion,zona_id,lat,lng,geofence_radio_m,saldo_cestas,saldo_botellas,limite_cestas,limite_botellas,canal) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`, [d.codigo,d.razon_social,d.nombre,d.direccion,d.zona_id,d.lat,d.lng,d.geofence_radio_m||50,d.saldo_cestas||0,d.saldo_botellas||0,d.limite_cestas||10,d.limite_botellas||20,d.canal||'Abasto']);
    res.json({ id: r.rows[0].id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/pdvs/:id', auth, async (req, res) => {
  const d = req.body;
  try {
    await pool.query(`UPDATE pdvs SET codigo=$1,razon_social=$2,nombre=$3,direccion=$4,zona_id=$5,lat=$6,lng=$7,geofence_radio_m=$8,saldo_cestas=$9,saldo_botellas=$10,limite_cestas=$11,limite_botellas=$12,canal=$13 WHERE id=$14`, [d.codigo,d.razon_social,d.nombre,d.direccion,d.zona_id,d.lat,d.lng,d.geofence_radio_m||50,d.saldo_cestas||0,d.saldo_botellas||0,d.limite_cestas||10,d.limite_botellas||20,d.canal||'Abasto', req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/pdvs/:id', auth, async (req, res) => {
  await pool.query('DELETE FROM pdvs WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

app.post('/api/visitas/checkin', auth, async (req, res) => {
  const { pdv_id, lat, lng } = req.body;
  const pdv = (await pool.query('SELECT * FROM pdvs WHERE id = $1', [pdv_id])).rows[0];
  if (!pdv) return res.status(404).json({ error: 'PDV no encontrado' });
  const dist = hav(lat, lng, pdv.lat, pdv.lng);
  if (dist > pdv.geofence_radio_m) return res.status(400).json({ error: 'FUERA DE GEOFENCE', mensaje: `Estás a ${Math.round(dist)}m.` });
  const r = await pool.query('INSERT INTO visitas (pdv_id,usuario_id,fecha_checkin,lat,lng,distancia_m) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [pdv_id, req.user.id, new Date().toISOString(), lat, lng, dist]);
  res.json({ id: r.rows[0].id, distancia_m: Math.round(dist) });
});

app.get('/api/visitas', auth, async (req, res) => {
  res.json((await pool.query('SELECT v.*, p.nombre as pdv_nombre FROM visitas v JOIN pdvs p ON v.pdv_id=p.id ORDER BY v.id DESC LIMIT 50')).rows);
});

app.post('/api/pedidos', auth, async (req, res) => {
  const { pdv_id, items, metodo_pago } = req.body;
  const pdv = (await pool.query('SELECT * FROM pdvs WHERE id = $1', [pdv_id])).rows[0];
  if (pdv.saldo_cestas > pdv.limite_cestas || pdv.saldo_botellas > pdv.limite_botellas) return res.status(400).json({ error: 'BLOQUEADO', mensaje: 'Cliente excede límite de retornables.' });
  
  let subtotal = 0;
  const itemsCalculados = [];
  for (const it of items) {
    const p = (await pool.query('SELECT * FROM productos WHERE id = $1', [it.producto_id])).rows[0];
    const sub = p.precio * it.cantidad;
    subtotal += sub;
    itemsCalculados.push({ ...it, precio_unitario: p.precio, subtotal: sub, retornable: p.retornable, tipo_envase: p.tipo_envase });
  }

  const pid = (await pool.query('INSERT INTO pedidos (pdv_id,usuario_id,fecha,subtotal,total,metodo_pago) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [pdv_id, req.user.id, new Date().toISOString(), subtotal, subtotal, metodo_pago||'Efectivo'])).rows[0].id;
  
  let cestas = 0, botellas = 0;
  for (const i of itemsCalculados) {
    await pool.query('INSERT INTO pedido_items (pedido_id,producto_id,cantidad,precio_unitario,subtotal) VALUES ($1,$2,$3,$4,$5)', [pid, i.producto_id, i.cantidad, i.precio_unitario, i.subtotal]);
    if (i.retornable) {
      if (i.tipo_envase === 'Cesta') cestas += i.cantidad;
      if (i.tipo_envase === 'Botella') botellas += i.cantidad;
    }
  }
  
  if (cestas > 0) await pool.query('UPDATE pdvs SET saldo_cestas = saldo_cestas + $1 WHERE id = $2', [cestas, pdv_id]);
  if (botellas > 0) await pool.query('UPDATE pdvs SET saldo_botellas = saldo_botellas + $1 WHERE id = $2', [botellas, pdv_id]);
  if (cestas > 0 || botellas > 0) await pool.query('INSERT INTO control_retornables (pdv_id,pedido_id,tipo,entregados,recibidos,fecha) VALUES ($1,$2,$3,$4,$5,$6)', [pdv_id, pid, 'Mixto', cestas+botellas, 0, new Date().toISOString()]);

  res.json({ id: pid, subtotal, total: subtotal });
});

app.get('/api/pedidos', auth, async (req, res) => {
  const pedidos = (await pool.query('SELECT pe.*, p.nombre as pdv_nombre FROM pedidos pe JOIN pdvs p ON pe.pdv_id=p.id ORDER BY pe.id DESC LIMIT 100')).rows;
  for (let pe of pedidos) {
    pe.items = (await pool.query('SELECT pi.*, pr.nombre FROM pedido_items pi JOIN productos pr ON pi.producto_id=pr.id WHERE pi.pedido_id=$1', [pe.id])).rows;
  }
  res.json(pedidos);
});

app.get('/api/smart-order/:pdv_id', auth, async (req, res) => {
  const hist = (await pool.query('SELECT pi.producto_id, pi.cantidad FROM pedido_items pi JOIN pedidos pe ON pi.pedido_id=pe.id WHERE pe.pdv_id=$1 ORDER BY pe.id DESC LIMIT 30', [req.params.pdv_id])).rows;
  const prods = (await pool.query('SELECT * FROM productos')).rows;
  const sugerencias = [];
  
  if (hist.length > 0) {
    const grouped = {};
    hist.forEach(h => {
      if (!grouped[h.producto_id]) grouped[h.producto_id] = { total: 0, count: 0 };
      grouped[h.producto_id].total += h.cantidad;
      grouped[h.producto_id].count += 1;
    });
    Object.keys(grouped).forEach(pid => {
      const p = prods.find(x => x.id == pid);
      if (p) sugerencias.push({ producto_id: p.id, nombre: p.nombre, precio: p.precio, cantidad_sugerida: Math.ceil(grouped[pid].total / grouped[pid].count) });
    });
  }
  if (sugerencias.length === 0) {
    prods.slice(0, 4).forEach(p => sugerencias.push({ producto_id: p.id, nombre: p.nombre, precio: p.precio, cantidad_sugerida: 5 }));
  }
  res.json(sugerencias);
});

app.post('/api/retornables/devolucion', auth, async (req, res) => {
  const { pdv_id, tipo, cantidad } = req.body;
  const campo = tipo === 'Cesta' ? 'saldo_cestas' : 'saldo_botellas';
  const pdv = (await pool.query('SELECT * FROM pdvs WHERE id = $1', [pdv_id])).rows[0];
  const nuevo = Math.max(0, pdv[campo] - cantidad);
  await pool.query(`UPDATE pdvs SET ${campo} = $1 WHERE id = $2`, [nuevo, pdv_id]);
  await pool.query('INSERT INTO control_retornables (pdv_id,tipo,entregados,recibidos,fecha) VALUES ($1,$2,$3,$4,$5)', [pdv_id, tipo, 0, cantidad, new Date().toISOString()]);
  res.json({ ok: true, nuevo_saldo: nuevo });
});

app.get('/api/retornables', auth, async (req, res) => {
  res.json((await pool.query('SELECT id, codigo, nombre, saldo_cestas, saldo_botellas, limite_cestas, limite_botellas FROM pdvs')).rows);
});

app.post('/api/frio', auth, async (req, res) => {
  const { camion, temperatura } = req.body;
  const alerta = (temperatura > 8 || temperatura < 2) ? 1 : 0;
  await pool.query('INSERT INTO cadena_frio (camion,temperatura,alerta,fecha) VALUES ($1,$2,$3,$4)', [camion||'MC-001', temperatura, alerta, new Date().toISOString()]);
  res.json({ alerta: !!alerta });
});

app.get('/api/frio', auth, async (req, res) => {
  res.json((await pool.query('SELECT * FROM cadena_frio ORDER BY id DESC LIMIT 50')).rows.reverse());
});

app.post('/api/red', auth, async (req, res) => {
  const { pdv_id, cumplimiento_pct } = req.body;
  const r = await pool.query('INSERT INTO red_auditorias (pdv_id,usuario_id,cumplimiento_pct,marca_propia_pct,competencia_pct,fecha) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [pdv_id, req.user.id, cumplimiento_pct, cumplimiento_pct, 100-cumplimiento_pct, new Date().toISOString()]);
  res.json({ id: r.rows[0].id });
});

app.get('/api/red', auth, async (req, res) => {
  res.json((await pool.query('SELECT r.*, p.nombre as pdv_nombre FROM red_auditorias r JOIN pdvs p ON r.pdv_id=p.id ORDER BY r.id DESC LIMIT 50')).rows);
});

app.get('/api/comodatos', auth, async (req, res) => {
  res.json((await pool.query('SELECT a.*, p.nombre as pdv_nombre FROM activos_comodato a JOIN pdvs p ON a.pdv_id=p.id')).rows);
});

app.post('/api/comodatos/:id/verificar', auth, async (req, res) => {
  const { temperatura_actual } = req.body;
  const a = (await pool.query('SELECT * FROM activos_comodato WHERE id = $1', [req.params.id])).rows[0];
  if (!a) return res.status(404).json({ error: 'No encontrado' });
  await pool.query('UPDATE activos_comodato SET temperatura_actual=$1 WHERE id=$2', [temperatura_actual, req.params.id]);
  const alerta = temperatura_actual > a.temp_max || temperatura_actual < a.temp_min;
  res.json({ ok: true, alerta });
});

app.post('/api/vrp', auth, async (req, res) => {
  const { pdv_ids, origen } = req.body;
  if (!pdv_ids.length) return res.json({ ruta: [], total_km: 0 });
  
  const pdvs = (await pool.query('SELECT * FROM pdvs WHERE id = ANY($1)', [pdv_ids])).rows;
  const almacen = origen || { lat: 10.6500, lng: -71.6400, nombre: 'Almacén Central Maracaibo' };
  const pendientes = [...pdvs];
  const ruta = [almacen];
  let actual = almacen, total_km = 0;
  
  while (pendientes.length > 0) {
    let minDist = Infinity, idxMin = 0;
    pendientes.forEach((p, i) => {
      const d = hav(actual.lat, actual.lng, p.lat, p.lng);
      if (d < minDist) { minDist = d; idxMin = i; }
    });
    const next = pendientes.splice(idxMin, 1)[0];
    ruta.push({ ...next, distancia_km: +(minDist/1000).toFixed(2), distancia_desde_anterior_m: Math.round(minDist) });
    total_km += minDist / 1000;
    actual = next;
  }
  res.json({ ruta, total_km: +total_km.toFixed(2) });
});

app.post('/api/mermas', auth, async (req, res) => {
  const { pdv_id, producto_id, cantidad, causa } = req.body;
  const r = await pool.query('INSERT INTO mermas (pdv_id,producto_id,cantidad,causa,responsable,fecha) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [pdv_id||null, producto_id||null, cantidad, causa, req.user.nombre, new Date().toISOString()]);
  res.json({ id: r.rows[0].id });
});

app.get('/api/mermas', auth, async (req, res) => {
  res.json((await pool.query('SELECT m.*, p.nombre as pdv_nombre, pr.nombre as producto FROM mermas m LEFT JOIN pdvs p ON m.pdv_id=p.id LEFT JOIN productos pr ON m.producto_id=pr.id ORDER BY m.id DESC LIMIT 100')).rows);
});

app.post('/api/liquidaciones', auth, async (req, res) => {
  const { efectivo_entregado, transferencias } = req.body;
  const hoy = new Date().toISOString().split('T')[0];
  const pedidos = (await pool.query('SELECT * FROM pedidos WHERE usuario_id=$1 AND fecha LIKE $2', [req.user.id, hoy + '%'])).rows;
  const efectivoEsperado = pedidos.filter(p => p.metodo_pago === 'Efectivo').reduce((s, p) => s + parseFloat(p.total), 0);
  const mermasHoy = (await pool.query('SELECT COALESCE(SUM(cantidad),0) as c FROM mermas WHERE fecha LIKE $1', [hoy + '%'])).rows[0].c;
  const diferencia = efectivo_entregado - efectivoEsperado;
  
  const r = await pool.query('INSERT INTO liquidaciones (usuario_id,fecha,efectivo_esperado,efectivo_entregado,diferencia) VALUES ($1,$2,$3,$4,$5) RETURNING id', [req.user.id, new Date().toISOString(), efectivoEsperado, efectivo_entregado, diferencia]);
  res.json({ id: r.rows[0].id, efectivo_esperado: efectivoEsperado, diferencia });
});

app.get('/api/liquidaciones', auth, async (req, res) => {
  res.json((await pool.query('SELECT l.*, u.nombre as vendedor FROM liquidaciones l JOIN usuarios u ON l.usuario_id=u.id ORDER BY l.id DESC LIMIT 50')).rows);
});

app.get('/api/kpis', auth, async (req, res) => {
  const hoy = new Date().toISOString().split('T')[0];
  const totalVisitas = parseInt((await pool.query('SELECT COUNT(*) as c FROM visitas WHERE fecha_checkin LIKE $1', [hoy + '%'])).rows[0].c);
  const pedidosHoy = parseInt((await pool.query('SELECT COUNT(*) as c FROM pedidos WHERE fecha LIKE $1', [hoy + '%'])).rows[0].c);
  const dropRate = totalVisitas > 0 ? Math.round((pedidosHoy / totalVisitas) * 100) : 0;

  const cumplimientoRED = Math.round(parseFloat((await pool.query('SELECT COALESCE(AVG(cumplimiento_pct),0) as a FROM red_auditorias')).rows[0].a));

  const frio = (await pool.query('SELECT COUNT(*) as total, SUM(alerta) as alertas FROM cadena_frio')).rows[0];
  const fTotal = parseInt(frio.total);
  const fAlertas = parseInt(frio.alertas || 0);
  const adherenciaTermica = fTotal > 0 ? Math.round(((fTotal - fAlertas) / fTotal) * 100) : 100;

  const ret = (await pool.query('SELECT COALESCE(SUM(entregados),0) as e, COALESCE(SUM(recibidos),0) as r FROM control_retornables')).rows[0];
  const retornabilidad = parseFloat(ret.e) > 0 ? Math.round((parseFloat(ret.r) / parseFloat(ret.e)) * 100) : 98;

  const pedidosAll = (await pool.query('SELECT * FROM pedidos WHERE fecha LIKE $1', [hoy + '%'])).rows;
  const otif = pedidosAll.length > 0 ? Math.round((pedidosAll.length / pedidosAll.length) * 100) : 92;

  const ventasHoy = parseFloat((await pool.query('SELECT COALESCE(SUM(total),0) as t FROM pedidos WHERE fecha LIKE $1', [hoy + '%'])).rows[0].t);
  const tempActual = (await pool.query('SELECT temperatura FROM cadena_frio ORDER BY id DESC LIMIT 1')).rows[0]?.temperatura || 4.0;
  const bloqueados = parseInt((await pool.query('SELECT COUNT(*) as c FROM pdvs WHERE saldo_cestas > limite_cestas OR saldo_botellas > limite_botellas')).rows[0].c);
  
  res.json({ dropRate, cumplimientoRED, adherenciaTermica, retornabilidad, otif, ventasHoy, tempActual, bloqueados, totalVisitas, pedidosHoy });
});

app.get('/api/ventas-zona', auth, async (req, res) => {
  res.json((await pool.query('SELECT z.nombre, z.color, COALESCE(SUM(pe.total),0) as total FROM zonas z LEFT JOIN pdvs p ON p.zona_id=z.id LEFT JOIN pedidos pe ON pe.pdv_id=p.id GROUP BY z.id, z.nombre, z.color')).rows);
});

module.exports = app;
