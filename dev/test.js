// Ejecuta el servidor local en un puerto temporal con base de datos en memoria,
// prepara una tasa de prueba y corre la batería de pruebas de la API.
// Uso: npm test
const { spawn } = require('child_process');
const path = require('path');

const PORT = 3300 + Math.floor(Math.random() * 400);
const BASE = `http://localhost:${PORT}`;

const server = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
  env: { ...process.env, PORT: String(PORT), PGLITE_DIR: 'memory' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let log = '';
server.stdout.on('data', d => { log += d; });
server.stderr.on('data', d => { log += d; });

const esperar = async (ms) => new Promise(r => setTimeout(r, ms));

async function listo() {
  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch(BASE + '/api/health');
      const d = await r.json();
      if (d.ok) return true;
    } catch {}
    await esperar(1000);
  }
  return false;
}

async function main() {
  if (!await listo()) {
    console.error('El servidor no arrancó. Salida:\n' + log);
    process.exit(1);
  }
  // Tasa manual para que la prueba no dependa de internet (BCV).
  const login = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario: 'admin', password: 'admin123' })
  }).then(r => r.json());
  await fetch(BASE + '/api/tasa', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + login.token },
    body: JSON.stringify({ tasa: 100 })
  });

  const prueba = spawn(process.execPath, [path.join(__dirname, 'smoke.js'), BASE], { stdio: 'inherit' });
  prueba.on('exit', code => {
    server.kill('SIGTERM');
    setTimeout(() => process.exit(code === 0 ? 0 : 1), 800);
  });
}

main().catch(e => { console.error(e); server.kill(); process.exit(2); });
