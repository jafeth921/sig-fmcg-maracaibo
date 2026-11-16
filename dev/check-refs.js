// Verificación estática de la interfaz: elementos, funciones y endpoints.
// Uso: npm run check
// Extrae el JavaScript incrustado en public/index.html y comprueba que todo lo que
// usa exista: ids del HTML, funciones llamadas desde los manejadores inline y rutas
// de la API implementadas en api/index.js.
const fs = require('fs');
const path = require('path');

const raiz = path.join(__dirname, '..');
const h = fs.readFileSync(path.join(raiz, 'public', 'index.html'), 'utf8');
const api = fs.readFileSync(path.join(raiz, 'api', 'index.js'), 'utf8');

// El bloque de JavaScript propio es el último <script> sin src.
const bloques = [...h.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
if (!bloques.length) {
  console.error('No se encontró el JavaScript de la interfaz en public/index.html');
  process.exit(1);
}
const js = bloques[bloques.length - 1];

let fallos = 0;
const malo = (...args) => { fallos++; console.log(...args); };

const ids = new Set([...h.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
const usados = new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map(m => m[1]));
const faltan = [...usados].filter(x => !ids.has(x));
console.log(`IDs usados en JS que no existen en el HTML: ${faltan.length ? faltan.join(', ') : '(ninguno)'}`);
if (faltan.length) fallos++;

const defs = new Set([...js.matchAll(/function\s+([A-Za-z0-9_]+)/g)].map(m => m[1]));
for (const m of js.matchAll(/(?:const|let|var)\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z0-9_]+)\s*=>/g)) defs.add(m[1]);

const handlers = new Set([...h.matchAll(/on(?:click|change|input|keydown|focus|submit)="([^"]+)"/g)].map(m => m[1]));
const llamadas = new Set();
for (const code of handlers) for (const m of code.matchAll(/(?:^|[^.\w])([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) llamadas.add(m[1]);
const nativas = new Set(['if', 'lock', 'showView', 'event', 'this', 'window', 'setTimeout', 'alert', 'confirm', 'print', 'Number', 'String', 'parseInt', 'parseFloat']);
const rotas = [...llamadas].filter(f => !defs.has(f) && !nativas.has(f));
console.log(`Funciones llamadas desde el HTML que no existen: ${rotas.length ? rotas.join(', ') : '(ninguna)'}`);
if (rotas.length) fallos++;

const rutas = [...new Set([...js.matchAll(/api\([`']([^`'\s?]+)/g)].map(m => m[1]))].sort();
console.log('\nEndpoints usados por la interfaz:');
for (const r of rutas) {
  const base = '/api' + r.split('/${')[0].replace(/\/$/, '');
  const existe = api.includes(`'${base}`) || api.includes(`"${base}`) || api.includes('`' + base);
  if (existe) console.log(`  ok   ${r}`);
  else { malo(`  FALTA ${r}  (no se encontró ${base} en api/index.js)`); }
}

console.log(`\n${fallos ? `${fallos} problema(s) encontrado(s)` : 'Sin referencias rotas'}`);
process.exit(fallos ? 1 : 0);
