const express = require('express');
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.POSTGRES_URL || process.env.DATABASE_URL || process.env.postgres_POSTGRES_URL);
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const JWT_SECRET = 'sig-fmcg-maracaibo-2026';

app.use(express.json({ limit: '20mb' }));

// ==================== INICIALIZAR BASE DE DATOS ====================
async function initDB() {
  try {
    await sql`CREATE TABLE IF NOT EXISTS usuarios (id SERIAL PRIMARY KEY, nombre TEXT, cedula TEXT, usuario TEXT UNIQUE, password_hash TEXT, rol TEXT, zona_id INTEGER, activo INTEGER DEFAULT 1);`;
    await sql`CREATE TABLE IF NOT EXISTS zonas (id SERIAL PRIMARY KEY, nombre TEXT UNIQUE, color TEXT);`;
    await sql`CREATE TABLE IF NOT EXISTS pdvs (id SERIAL PRIMARY KEY, codigo TEXT UNIQUE, razon_social TEXT, nombre TEXT, direccion TEXT, zona_id INTEGER, lat NUMERIC, lng NUMERIC, geofence_radio_m INTEGER DEFAULT 50, saldo_cestas INTEGER DEFAULT 0, saldo_botellas INTEGER DEFAULT 0, limite_cestas INTEGER DEFAULT 10, limite_botellas INTEGER DEFAULT 20, limite_credito NUMERIC DEFAULT 0, canal TEXT DEFAULT 'Abasto');`;
    await sql`CREATE TABLE IF NOT EXISTS productos (id SERIAL PRIMARY KEY, codigo TEXT UNIQUE, nombre TEXT, precio NUMERIC, costo NUMERIC, categoria TEXT, retornable INTEGER DEFAULT 0, tipo_envase TEXT, fecha_vencimiento TEXT);`;
    await sql`CREATE TABLE IF NOT EXISTS promociones (id SERIAL PRIMARY KEY, nombre TEXT, producto_id INTEGER, tipo TEXT, min_cantidad INTEGER, descuento_pct NUMERIC, activa INTEGER DEFAULT 1);`;
    await sql`CREATE TABLE IF NOT EXISTS pedidos (id SERIAL PRIMARY KEY, pdv_id INTEGER, usuario_id INTEGER, fecha TEXT, subtotal NUMERIC DEFAULT 0, descuento NUMERIC DEFAULT 0, total NUMERIC, estado TEXT DEFAULT 'Confirmado', metodo_pago TEXT DEFAULT 'Efectivo');`;
    await sql`CREATE TABLE IF NOT EXISTS pedido_items (id SERIAL PRIMARY KEY, pedido_id INTEGER, producto_id INTEGER, cantidad INTEGER, precio_unitario NUMERIC, descuento_pct NUMERIC DEFAULT 0, subtotal NUMERIC);`;
    await sql`CREATE TABLE IF NOT EXISTS visitas (id SERIAL PRIMARY KEY, pdv_id INTEGER, usuario_id INTEGER, fecha_checkin TEXT, fecha_checkout TEXT, lat NUMERIC, lng NUMERIC, distancia_m NUMERIC, cumple_geofence INTEGER DEFAULT 0, estado TEXT DEFAULT 'Efectiva');`;
    await sql`CREATE TABLE IF NOT EXISTS control_retornables (id SERIAL PRIMARY KEY, pdv_id INTEGER, pedido_id INTEGER, tipo TEXT, entregados INTEGER DEFAULT 0, recibidos INTEGER DEFAULT 0, fecha TEXT);`;
    await sql`CREATE TABLE IF NOT EXISTS activos_comodato (id SERIAL PRIMARY KEY, pdv_id INTEGER, codigo_qr TEXT UNIQUE, tipo TEXT, marca TEXT, fecha_instalacion TEXT, ultimo_mantenimiento TEXT, temperatura_actual NUMERIC, temp_min NUMERIC DEFAULT 2, temp_max NUMERIC DEFAULT 8, activo INTEGER DEFAULT 1);`;
    await sql`CREATE TABLE IF NOT EXISTS cadena_frio (id SERIAL PRIMARY KEY, camion TEXT, temperatura NUMERIC, alerta INTEGER DEFAULT 0, lat NUMERIC, lng NUMERIC, fecha TEXT);`;
    await sql`CREATE TABLE IF NOT EXISTS red_auditorias (id SERIAL PRIMARY KEY, pdv_id INTEGER, usuario_id INTEGER, foto_base64 TEXT, cumplimiento_pct NUMERIC, marca_propia_pct NUMERIC, competencia_pct NUMERIC, observaciones TEXT, fecha TEXT);`;
    await sql`CREATE TABLE IF NOT EXISTS mermas (id SERIAL PRIMARY KEY, pdv_id INTEGER, producto_id INTEGER, cantidad INTEGER, causa TEXT, responsable TEXT, fecha TEXT);`;
    await sql`CREATE TABLE IF NOT EXISTS liquidaciones (id SERIAL PRIMARY KEY, usuario_id INTEGER, fecha TEXT, efectivo_esperado NUMERIC, efectivo_entregado NUMERIC, transferencias NUMERIC, diferencia NUMERIC, mermas_total NUMERIC, estado TEXT DEFAULT 'Pendiente');`;
    await sql`CREATE TABLE IF NOT EXISTS auditoria_login (id SERIAL PRIMARY KEY, usuario TEXT, exito INTEGER, ip TEXT, fecha TEXT);`;

    // Datos iniciales
    const check = await sql`SELECT COUNT(*) as c FROM usuarios`;
    if (parseInt(check[0].c) === 0) {
      const pass = bcrypt.hashSync('admin123', 10);
      const passP = bcrypt.hashSync('pedro123', 10);
      await sql`INSERT INTO usuarios (nombre,cedula,usuario,password_hash,rol,zona_id) VALUES ('Gerente General','V-111','admin',${pass},'Gerente',null)`;
      await sql`INSERT INTO usuarios (nombre,cedula,usuario,password_hash,rol,zona_id) VALUES ('Pedro Preventista','V-333','pedro',${passP},'Preventista',1)`;

      await sql`INSERT INTO zonas (nombre,color) VALUES ('Centro','#0B6E4F'),('Bella Vista','#F4A261'),('Las Pulgas','#E63946')`;

      await sql`INSERT INTO pdvs (codigo,razon_social,nombre,direccion,zona_id,lat,lng,saldo_cestas,saldo_botellas) VALUES 
        ('PDV-001','Bodega La Esperanza','Bodega La Esperanza','Calle 77',1,10.6427,-71.6125,2,0),
        ('PDV-002','Panadería El Trigal','Panadería El Trigal','Av. Bella Vista',1,10.6450,-71.6150,0,0),
        ('PDV-007','Mayorista Las Pulgas A','Mayorista Las Pulgas A','Pasillo 3',3,10.6472,-71.6565,15,25)`;

      await sql`INSERT INTO productos (codigo,nombre,precio,retornable,tipo_envase,fecha_vencimiento) VALUES 
        ('REF-2L','Refresco Cola 2L',35,1,'Botella',null),
        ('AGU-C12','Agua 600ml cesta x12',120,1,'Cesta',null),
        ('YOG-1L','Yogurt 1L',60,0,null,'2026-11-05')`;

      await sql`INSERT INTO promociones (nombre,producto_id,tipo,min_cantidad,descuento_pct,activa) VALUES ('Volumen Refresco',1,'Volumen',10,10,1)`;
      await sql`INSERT INTO activos_comodato (pdv_id,codigo_qr,tipo,marca,fecha_instalacion,temperatura_actual) VALUES (1,'QR-001','Nevera','Propia','2024-01-01',4.5)`;
    }
  } catch (e) { console.error("Error initDB:", e); }
}
initDB();

// ==================== MIDDLEWARES Y UTILS ====================
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

// ==================== RUTAS: AUTH ====================
app.post('/api/login', async (req, res) => {
  const { usuario, password } = req.body;
  try {
    const result = await sql`SELECT * FROM usuarios WHERE usuario = ${usuario} AND activo = 1`;
    const u = result[0];
    if (!u || !bcrypt.compareSync(password, u.password_hash)) {
      await sql`INSERT INTO auditoria_login (usuario,exito,ip,fecha) VALUES (${usuario},0,'vercel',${new Date().toISOString()})`;
      return res.status(401).json({ error: 'Credenciales incorrectas' });
    }
    const token = jwt.sign({ id: u.id, nombre: u.nombre, rol: u.rol, zona_id: u.zona_id }, JWT_SECRET, { expiresIn: '8h' });
    res.json({ token, user: { id: u.id, nombre: u.nombre, rol: u.rol, zona_id: u.zona_id } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== RUTAS: MAESTROS ====================
app.get('/api/zonas', auth, async (req, res) => {
  const rows = await sql`SELECT * FROM zonas`;
  res.json(rows);
});

app.get('/api/productos', auth, async (req, res) => {
  const rows = await sql`SELECT * FROM productos`;
  res.json(rows);
});

app.get('/api/promociones', auth, async (req, res) => {
  const rows = await sql`SELECT pr.*, p.nombre as producto FROM promociones pr JOIN productos p ON pr.producto_id=p.id WHERE pr.activa=1`;
  res.json(rows);
});

// ==================== RUTAS: PDVS ====================
app.get('/api/pdvs', auth, async (req, res) => {
  const rows = await sql`SELECT p.*, z.nombre as zona_nombre, z.color as zona_color FROM pdvs p JOIN zonas z ON p.zona_id = z.id`;
  res.json(rows);
});

app.post('/api/pdvs', auth, async (req, res) => {
  const d = req.body;
  try {
    const result = await sql`INSERT INTO pdvs (codigo,razon_social,nombre,direccion,zona_id,lat,lng,geofence_radio_m,saldo_cestas,saldo_botellas,limite_cestas,limite_botellas,canal) VALUES (${d.codigo},${d.razon_social},${d.nombre},${d.direccion},${d.zona_id},${d.lat},${d.lng},${d.geofence_radio_m||50},${d.saldo_cestas||0},${d.saldo_botellas||0},${d.limite_cestas||10},${d.limite_botellas||20},${d.canal||'Abasto'}) RETURNING id`;
    res.json({ id: result[0].id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/pdvs/:id', auth, async (req, res) => {
  const d = req.body;
  try {
    await sql`UPDATE pdvs SET codigo=${d.codigo},razon_social=${d.razon_social},nombre=${d.nombre},direccion=${d.direccion},zona_id=${d.zona_id},lat=${d.lat},lng=${d.lng},geofence_radio_m=${d.geofence_radio_m||50},saldo_cestas=${d.saldo_cestas||0},saldo_botellas=${d.saldo_botellas||0},limite_cestas=${d.limite_cestas||10},limite_botellas=${d.limite_botellas||20},canal=${d.canal||'Abasto'} WHERE id=${req.params.id}`;
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/pdvs/:id', auth, async (req, res) => {
  await sql`DELETE FROM pdvs WHERE id = ${req.params.id}`;
  res.json({ ok: true });
});

// ==================== RUTAS: VISITAS & GEOFENCING ====================
app.post('/api/visitas/checkin', auth, async (req, res) => {
  const { pdv_id, lat, lng } = req.body;
  const pResult = await sql`SELECT * FROM pdvs WHERE id = ${pdv_id}`;
  const pdv = pResult[0];
  if (!pdv) return res.status(404).json({ error: 'PDV no encontrado' });
  
  const dist = hav(lat, lng, pdv.lat, pdv.lng);
  const cumple = dist <= pdv.geofence_radio_m;
  if (!cumple) return res.status(400).json({ error: 'FUERA DE GEOFENCE', mensaje: `Estás a ${Math.round(dist)}m. Límite: ${pdv.geofence_radio_m}m.` });
  
  const r = await sql`INSERT INTO visitas (pdv_id,usuario_id,fecha_checkin,lat,lng,distancia_m,cumple_geofence,estado) VALUES (${pdv_id},${req.user.id},${new Date().toISOString()},${lat},${lng},${dist},1,'Efectiva') RETURNING id`;
  res.json({ id: r[0].id, distancia_m: Math.round(dist) });
});

app.get('/api/visitas', auth, async (req, res) => {
  const rows = await sql`SELECT v.*, p.nombre as pdv_nombre, u.nombre as vendedor FROM visitas v JOIN pdvs p ON v.pdv_id=p.id JOIN usuarios u ON v.usuario_id=u.id ORDER BY v.id DESC LIMIT 100`;
  res.json(rows);
});

// ==================== RUTAS: PEDIDOS & SMART ORDER ====================
app.post('/api/pedidos', auth, async (req, res) => {
  const { pdv_id, items, metodo_pago } = req.body;
  const pResult = await sql`SELECT * FROM pdvs WHERE id = ${pdv_id}`;
  const pdv = pResult[0];
  if (!pdv) return res.status(404).json({ error: 'PDV no encontrado' });
  if (pdv.saldo_cestas > pdv.limite_cestas || pdv.saldo_botellas > pdv.limite_botellas) {
    return res.status(400).json({ error: 'BLOQUEADO', mensaje: `Cliente excede límite de retornables.` });
  }
  if (!items || !items.length) return res.status(400).json({ error: 'Sin productos' });

  const prods = await sql`SELECT * FROM productos`;
  const promos = await sql`SELECT * FROM promociones WHERE activa=1`;
  
  let subtotal = 0, descuentoTotal = 0;
  const itemsCalculados = [];
  for (const it of items) {
    const p = prods.find(x => x.id == it.producto_id);
    if (!p) continue;
    let descPct = 0;
    const promoVol = promos.find(pr => pr.producto_id == p.id && pr.tipo === 'Volumen' && it.cantidad >= pr.min_cantidad);
    if (promoVol) descPct = Math.max(descPct, promoVol.descuento_pct);
    
    const sub = p.precio * it.cantidad;
    const desc = sub * (descPct / 100);
    subtotal += sub; descuentoTotal += desc;
    itemsCalculados.push({ ...it, precio_unitario: p.precio, descuento_pct: descPct, subtotal: sub - desc, retornable: p.retornable, tipo_envase: p.tipo_envase });
  }
  const total = subtotal - descuentoTotal;

  const orderResult = await sql`INSERT INTO pedidos (pdv_id,usuario_id,fecha,subtotal,descuento,total,metodo_pago) VALUES (${pdv_id},${req.user.id},${new Date().toISOString()},${subtotal},${descuentoTotal},${total},${metodo_pago||'Efectivo'}) RETURNING id`;
  const pid = orderResult[0].id;
  
  let cestas = 0, botellas = 0;
  for (const i of itemsCalculados) {
    await sql`INSERT INTO pedido_items (pedido_id,producto_id,cantidad,precio_unitario,descuento_pct,subtotal) VALUES (${pid},${i.producto_id},${i.cantidad},${i.precio_unitario},${i.descuento_pct},${i.subtotal})`;
    if (i.retornable) {
      if (i.tipo_envase === 'Cesta') cestas += i.cantidad;
      if (i.tipo_envase === 'Botella') botellas += i.cantidad;
    }
  }
  
  if (cestas > 0) await sql`UPDATE pdvs SET saldo_cestas = saldo_cestas + ${cestas} WHERE id = ${pdv_id}`;
  if (botellas > 0) await sql`UPDATE pdvs SET saldo_botellas = saldo_botellas + ${botellas} WHERE id = ${pdv_id}`;
  if (cestas > 0 || botellas > 0) await sql`INSERT INTO control_retornables (pdv_id,pedido_id,tipo,entregados,recibidos,fecha) VALUES (${pdv_id},${pid},'Mixto',${cestas+botellas},0,${new Date().toISOString()})`;

  res.json({ id: pid, subtotal, descuento: descuentoTotal, total });
});

app.get('/api/pedidos', auth, async (req, res) => {
  const pedidos = await sql`SELECT pe.*, p.nombre as pdv_nombre, p.codigo as pdv_codigo, u.nombre as vendedor FROM pedidos pe JOIN pdvs p ON pe.pdv_id=p.id JOIN usuarios u ON pe.usuario_id=u.id ORDER BY pe.id DESC LIMIT 100`;
  for (let pe of pedidos) {
    pe.items = await sql`SELECT pi.*, pr.nombre FROM pedido_items pi JOIN productos pr ON pi.producto_id=pr.id WHERE pi.pedido_id=${pe.id}`;
  }
  res.json(pedidos);
});

app.get('/api/smart-order/:pdv_id', auth, async (req, res) => {
  const pdv_id = req.params.pdv_id;
  const hist = await sql`SELECT pi.producto_id, pi.cantidad FROM pedido_items pi JOIN pedidos pe ON pi.pedido_id=pe.id WHERE pe.pdv_id=${pdv_id} ORDER BY pe.id DESC LIMIT 30`;
  const prods = await sql`SELECT * FROM productos`;
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

// ==================== RUTAS: RETORNABLES ====================
app.post('/api/retornables/devolucion', auth, async (req, res) => {
  const { pdv_id, tipo, cantidad } = req.body;
  const pResult = await sql`SELECT * FROM pdvs WHERE id = ${pdv_id}`;
  const pdv = pResult[0];
  if (!pdv) return res.status(404).json({ error: 'PDV no encontrado' });
  const campo = tipo === 'Cesta' ? 'saldo_cestas' : 'saldo_botellas';
  const nuevo = Math.max(0, pdv[campo] - cantidad);
  await sql.unsafe(`UPDATE pdvs SET ${campo} = ${nuevo} WHERE id = ${pdv_id}`);
  await sql`INSERT INTO control_retornables (pdv_id,tipo,entregados,recibidos,fecha) VALUES (${pdv_id},${tipo},0,${cantidad},${new Date().toISOString()})`;
  res.json({ ok: true, nuevo_saldo: nuevo });
});

app.get('/api/retornables', auth, async (req, res) => {
  const rows = await sql`SELECT id, codigo, nombre, saldo_cestas, saldo_botellas, limite_cestas, limite_botellas FROM pdvs`;
  res.json(rows);
});

// ==================== RUTAS: CADENA DE FRIO ====================
app.post('/api/frio', auth, async (req, res) => {
  const { camion, temperatura, lat, lng } = req.body;
  const alerta = (temperatura > 8 || temperatura < 2) ? 1 : 0;
  await sql`INSERT INTO cadena_frio (camion,temperatura,alerta,lat,lng,fecha) VALUES (${camion||'MC-001'},${temperatura},${alerta},${lat||null},${lng||null},${new Date().toISOString()})`;
  res.json({ alerta: !!alerta });
});

app.get('/api/frio', auth, async (req, res) => {
  const rows = await sql`SELECT * FROM cadena_frio ORDER BY id DESC LIMIT 50`;
  res.json(rows.reverse());
});

// ==================== RUTAS: RED ====================
app.post('/api/red', auth, async (req, res) => {
  const { pdv_id, foto_base64, cumplimiento_pct, observaciones } = req.body;
  const marca = cumplimiento_pct;
  const comp = 100 - cumplimiento_pct;
  const r = await sql`INSERT INTO red_auditorias (pdv_id,usuario_id,foto_base64,cumplimiento_pct,marca_propia_pct,competencia_pct,observaciones,fecha) VALUES (${pdv_id},${req.user.id},${foto_base64||null},${cumplimiento_pct},${marca},${comp},${observaciones||null},${new Date().toISOString()}) RETURNING id`;
  res.json({ id: r[0].id });
});

app.get('/api/red', auth, async (req, res) => {
  const rows = await sql`SELECT r.*, p.nombre as pdv_nombre FROM red_auditorias r JOIN pdvs p ON r.pdv_id=p.id ORDER BY r.id DESC LIMIT 50`;
  res.json(rows);
});

// ==================== RUTAS: COMODATO ====================
app.get('/api/comodatos', auth, async (req, res) => {
  const rows = await sql`SELECT a.*, p.nombre as pdv_nombre FROM activos_comodato a JOIN pdvs p ON a.pdv_id=p.id WHERE a.activo=1`;
  res.json(rows);
});

app.post('/api/comodatos/:id/verificar', auth, async (req, res) => {
  const { temperatura_actual } = req.body;
  const aResult = await sql`SELECT * FROM activos_comodato WHERE id = ${req.params.id}`;
  const a = aResult[0];
  if (!a) return res.status(404).json({ error: 'No encontrado' });
  await sql`UPDATE activos_comodato SET temperatura_actual=${temperatura_actual}, ultimo_mantenimiento=${new Date().toISOString().split('T')[0]} WHERE id=${req.params.id}`;
  const alerta = temperatura_actual !== null && (temperatura_actual > a.temp_max || temperatura_actual < a.temp_min);
  res.json({ ok: true, alerta });
});

// ==================== RUTAS: VRP ====================
app.post('/api/vrp', auth, async (req, res) => {
  const { pdv_ids, origen } = req.body;
  if (!pdv_ids || !pdv_ids.length) return res.json({ ruta: [], total_km: 0 });
  
  const pdvs = await sql`SELECT * FROM pdvs WHERE id = ANY(${pdv_ids})`;
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

// ==================== RUTAS: MERMAS & LIQUIDACIONES ====================
app.post('/api/mermas', auth, async (req, res) => {
  const { pdv_id, producto_id, cantidad, causa } = req.body;
  const r = await sql`INSERT INTO mermas (pdv_id,producto_id,cantidad,causa,responsable,fecha) VALUES (${pdv_id||null},${producto_id||null},${cantidad},${causa},${req.user.nombre},${new Date().toISOString()}) RETURNING id`;
  res.json({ id: r[0].id });
});

app.get('/api/mermas', auth, async (req, res) => {
  const rows = await sql`SELECT m.*, p.nombre as pdv_nombre, pr.nombre as producto FROM mermas m LEFT JOIN pdvs p ON m.pdv_id=p.id LEFT JOIN productos pr ON m.producto_id=pr.id ORDER BY m.id DESC LIMIT 100`;
  res.json(rows);
});

app.post('/api/liquidaciones', auth, async (req, res) => {
  const { efectivo_entregado, transferencias } = req.body;
  const hoy = new Date().toISOString().split('T')[0];
  const pedidos = await sql`SELECT * FROM pedidos WHERE usuario_id=${req.user.id} AND fecha LIKE ${hoy + '%'}`;
  const efectivoEsperado = pedidos.filter(p => p.metodo_pago === 'Efectivo').reduce((s, p) => s + parseFloat(p.total), 0);
  const mermasRes = await sql`SELECT COALESCE(SUM(cantidad),0) as c FROM mermas WHERE fecha LIKE ${hoy + '%'}`;
  const mermasHoy = mermasRes[0].c;
  const diferencia = efectivo_entregado - efectivoEsperado;
  const r = await sql`INSERT INTO liquidaciones (usuario_id,fecha,efectivo_esperado,efectivo_entregado,transferencias,diferencia,mermas_total,estado) VALUES (${req.user.id},${new Date().toISOString()},${efectivoEsperado},${efectivo_entregado},${transferencias||0},${diferencia},${mermasHoy},${Math.abs(diferencia) < 1 ? 'Cerrada' : 'Con diferencia'}) RETURNING id`;
  res.json({ id: r[0].id, efectivo_esperado: efectivoEsperado, diferencia });
});

app.get('/api/liquidaciones', auth, async (req, res) => {
  const rows = await sql`SELECT l.*, u.nombre as vendedor FROM liquidaciones l JOIN usuarios u ON l.usuario_id=u.id ORDER BY l.id DESC LIMIT 50`;
  res.json(rows);
});

// ==================== RUTAS: KPIS & VENTAS ====================
app.get('/api/kpis', auth, async (req, res) => {
  const hoy = new Date().toISOString().split('T')[0];
  const vRes = await sql`SELECT COUNT(*) as c FROM visitas WHERE fecha_checkin LIKE ${hoy + '%'}`;
  const totalVisitas = parseInt(vRes[0].c);
  
  const pRes = await sql`SELECT COUNT(*) as c FROM pedidos WHERE fecha LIKE ${hoy + '%'}`;
  const pedidosHoy = parseInt(pRes[0].c);
  const dropRate = totalVisitas > 0 ? Math.round((pedidosHoy / totalVisitas) * 100) : 0;

  const redRes = await sql`SELECT COALESCE(AVG(cumplimiento_pct),0) as a FROM red_auditorias`;
  const cumplimientoRED = Math.round(parseFloat(redRes[0].a));

  const frioRes = await sql`SELECT COUNT(*) as total, SUM(alerta) as alertas FROM cadena_frio`;
  const fTotal = parseInt(frioRes[0].total);
  const fAlertas = parseInt(frioRes[0].alertas || 0);
  const adherenciaTermica = fTotal > 0 ? Math.round(((fTotal - fAlertas) / fTotal) * 100) : 100;

  const retRes = await sql`SELECT COALESCE(SUM(entregados),0) as e, COALESCE(SUM(recibidos),0) as r FROM control_retornables`;
  const rE = parseFloat(retRes[0].e);
  const rR = parseFloat(retRes[0].r);
  const retornabilidad = rE > 0 ? Math.round((rR / rE) * 100) : 98;

  const pedidosAll = await sql`SELECT * FROM pedidos WHERE fecha LIKE ${hoy + '%'}`;
  const otif = pedidosAll.length > 0 ? Math.round((pedidosAll.filter(p => p.estado === 'Confirmado').length / pedidosAll.length) * 100) : 92;

  const ventasRes = await sql`SELECT COALESCE(SUM(total),0) as t FROM pedidos WHERE fecha LIKE ${hoy + '%'}`;
  const ventasHoy = parseFloat(ventasRes[0].t);
  
  const tempRes = await sql`SELECT temperatura FROM cadena_frio ORDER BY id DESC LIMIT 1`;
  const tempActual = tempRes.length ? parseFloat(tempRes[0].temperatura) : 4.0;

  const bloqRes = await sql`SELECT COUNT(*) as c FROM pdvs WHERE saldo_cestas > limite_cestas OR saldo_botellas > limite_botellas`;
  const bloqueados = parseInt(bloqRes[0].c);
  
  res.json({ dropRate, cumplimientoRED, adherenciaTermica, retornabilidad, otif, ventasHoy, tempActual, bloqueados, totalVisitas, pedidosHoy });
});

app.get('/api/ventas-zona', auth, async (req, res) => {
  const rows = await sql`SELECT z.nombre, z.color, COALESCE(SUM(pe.total),0) as total FROM zonas z LEFT JOIN pdvs p ON p.zona_id=z.id LEFT JOIN pedidos pe ON pe.pdv_id=p.id GROUP BY z.id, z.nombre, z.color`;
  res.json(rows);
});

module.exports = app;
