// Servidor de desarrollo local.
// Ejecuta la misma aplicación Express que se publica en Vercel, pero contra una
// base PostgreSQL embebida (PGlite) para poder probar sin instalar Postgres.
//
//   npm run dev
//
// La información se guarda en .data/pglite (puede borrarse para reiniciar).
// Para usar un Postgres real, basta con definir POSTGRES_URL y ejecutar
// `node dev/server.js --pg` (se usará @vercel/postgres normal).
const path = require('path');
const fs = require('fs');
const Module = require('module');
const express = require('express');

const usarPostgresReal = process.argv.includes('--pg') || !!process.env.POSTGRES_URL;
const PORT = Number(process.env.PORT) || 3000;

let db = null;
if (!usarPostgresReal) {
  const { PGlite } = require('@electric-sql/pglite');
  const pedido = process.env.PGLITE_DIR || path.join(__dirname, '..', '.data', 'pglite');
  const enMemoria = pedido === 'memory' || process.argv.includes('--mem');
  if (!enMemoria) fs.mkdirSync(path.dirname(pedido), { recursive: true });
  db = new PGlite(enMemoria ? undefined : pedido);

  // Adaptador mínimo de la etiqueta `sql` de @vercel/postgres sobre PGlite.
  const adaptar = v => {
    if (v === undefined) return null;
    if (v instanceof Date) return v.toISOString();
    return v;
  };
  const sql = (strings, ...values) => {
    let text = strings[0];
    for (let i = 0; i < values.length; i++) text += `$${i + 1}${strings[i + 1]}`;
    return db.query(text, values.map(adaptar));
  };
  sql.query = (text, params = []) => db.query(text, params.map(adaptar));

  const load = Module._load;
  Module._load = function (request, ...rest) {
    if (request === '@vercel/postgres') return { sql };
    return load.call(this, request, ...rest);
  };
}

const api = require('../api/index.js');

const app = express();
app.use(api);
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

const server = app.listen(PORT, () => {
  console.log(`Rutix local: http://localhost:${PORT}`);
  console.log(`Base de datos: ${usarPostgresReal ? 'Postgres (POSTGRES_URL)' : 'PGlite embebido'}`);
});

// Cierre ordenado para no corromper la base embebida.
let cerrando = false;
async function cerrar() {
  if (cerrando) return;
  cerrando = true;
  server.close();
  if (db) { try { await db.close(); } catch (e) { console.warn('No se pudo cerrar la base:', e.message); } }
  process.exit(0);
}
process.on('SIGINT', cerrar);
process.on('SIGTERM', cerrar);
process.on('SIGHUP', cerrar);
