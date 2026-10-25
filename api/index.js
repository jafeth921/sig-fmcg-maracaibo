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

async function initDB() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS usuarios (id SERIAL PRIMARY KEY, nombre TEXT, usuario TEXT UNIQUE, password_hash TEXT, rol TEXT, activo INTEGER DEFAULT 1);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS zonas (id SERIAL PRIMARY KEY, nombre TEXT UNIQUE, color TEXT);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS pdvs (id SERIAL PRIMARY KEY, codigo TEXT UNIQUE, nombre TEXT, zona_id INTEGER, lat NUMERIC, lng NUMERIC, saldo_cestas INTEGER DEFAULT 0, saldo_botellas INTEGER DEFAULT 0, limite_cestas INTEGER DEFAULT 10, limite_botellas INTEGER DEFAULT 20);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS productos (id SERIAL PRIMARY KEY, nombre TEXT, precio NUMERIC, retornable INTEGER DEFAULT 0, tipo_envase TEXT);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS pedidos (id SERIAL PRIMARY KEY, pdv_id INTEGER, usuario_id INTEGER, fecha TEXT, subtotal NUMERIC DEFAULT 0, total NUMERIC, metodo_pago TEXT);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS pedido_items (id SERIAL PRIMARY KEY, pedido_id INTEGER, producto_id INTEGER, cantidad INTEGER, precio_unitario NUMERIC, subtotal NUMERIC);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS visitas (id SERIAL PRIMARY KEY, pdv_id INTEGER, usuario_id INTEGER, fecha_checkin TEXT, lat NUMERIC, lng NUMERIC, distancia_m NUMERIC);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS cadena_frio (id SERIAL PRIMARY KEY, temperatura NUMERIC, fecha TEXT);`);

    const res = await pool.query('SELECT COUNT(*) FROM usuarios');
    if (parseInt(res.rows[0].count) === 0) {
      const pass = bcrypt.hashSync('admin123', 10);
      await pool.query(`INSERT INTO usuarios (nombre,usuario,password_hash,rol) VALUES ('Gerente','admin','${pass}','Gerente')`);
      await pool.query(`INSERT INTO zonas (nombre,color) VALUES ('Centro','#0B6E4F'),('Bella Vista','#F4A261'),('Las Pulgas','#E63946')`);
      await pool.query(`INSERT INTO pdvs (codigo,nombre,zona_id,lat,lng,saldo_cestas,saldo_botellas) VALUES ('PDV-001','Bodega Esperanza',1,10.6427,-71.6125,2,0),('PDV-002','Panadería Trigal',1,10.6450,-71.6150,0,0),('PDV-007','Mayorista Pulgas',3,10.6472,-71.6565,15,25)`);
      await pool.query(`INSERT INTO productos (nombre,precio,retornable,tipo_envase) VALUES ('Refresco 2L',35,1,'Botella'),('Agua Cesta',120,1,'Cesta')`);
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

app.post('/api/login', async (req, res) => {
  const { usuario, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM usuarios WHERE usuario = $1', [usuario]);
    const u = result.rows[0];
    if (!u || !bcrypt.compareSync(password, u.password_hash)) return res.status(401).json({ error: 'Credenciales incorrectas' });
    const token = jwt.sign({ id: u.id, nombre: u.nombre, rol: u.rol }, JWT_SECRET, { expiresIn: '8h' });
    res.json({ token, user: { id: u.id, nombre: u.nombre, rol: u.rol } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/zonas', auth, async (req, res) => {
  const result = await pool.query('SELECT * FROM zonas');
  res.json(result.rows);
});

app.get('/api/productos', auth, async (req, res) => {
  const result = await pool.query('SELECT * FROM productos');
  res.json(result.rows);
});

app.get('/api/pdvs', auth, async (req, res) => {
  const result = await pool.query('SELECT p.*, z.nombre as zona_nombre, z.color as zona_color FROM pdvs p JOIN zonas z ON p.zona_id = z.id');
  res.json(result.rows);
});

app.post('/api/pedidos', auth, async (req, res) => {
  const { pdv_id, items, metodo_pago } = req.body;
  let subtotal = 0;
  for (const it of items) {
    const p = await pool.query('SELECT * FROM productos WHERE id = $1', [it.producto_id]);
    subtotal += p.rows[0].precio * it.cantidad;
  }
  const r = await pool.query('INSERT INTO pedidos (pdv_id,usuario_id,fecha,subtotal,total,metodo_pago) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [pdv_id, req.user.id, new Date().toISOString(), subtotal, subtotal, metodo_pago]);
  res.json({ id: r.rows[0].id, total: subtotal });
});

app.get('/api/pedidos', auth, async (req, res) => {
  const r = await pool.query('SELECT pe.*, p.nombre as pdv_nombre FROM pedidos pe JOIN pdvs p ON pe.pdv_id = p.id ORDER BY pe.id DESC');
  res.json(r.rows);
});

app.get('/api/kpis', auth, async (req, res) => {
  const ventas = await pool.query('SELECT COALESCE(SUM(total),0) as t FROM pedidos');
  res.json({ dropRate: 85, cumplimientoRED: 90, adherenciaTermica: 100, retornabilidad: 98, otif: 95, ventasHoy: parseFloat(ventas.rows[0].t), tempActual: 4.0, bloqueados: 0 });
});

module.exports = app;
