// Verificación de solo lectura contra un servidor publicado.
// Uso: node dev/prod-check.js https://tu-proyecto.vercel.app
const BASE = process.argv[2];
if (!BASE) { console.error('Indique la URL, por ejemplo: node dev/prod-check.js https://mi-sitio.vercel.app'); process.exit(2); }

let ok = 0, fail = 0;

async function req(method, path, body, token) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: r.status, data };
}

function check(nombre, r, esperado = 200, validar) {
  const bueno = r.status === esperado && (!validar || validar(r.data));
  if (bueno) { ok++; console.log(`  OK    ${nombre}`); }
  else { fail++; console.log(`  FALLO ${nombre} -> HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); }
}

(async () => {
  console.log(`\n== Verificación de producción: ${BASE} ==\n`);

  const salud = await req('GET', '/api/health');
  check('diagnóstico /api/health', salud, 200, d => d.ok === true && d.base_datos && d.base_datos.conectada === true);

  const a = (await req('POST', '/api/login', { usuario: 'admin', password: 'admin123' })).data;
  if (!a || !a.token) { console.error('No se pudo iniciar sesión como admin'); process.exit(1); }
  const T = a.token;
  const m = (await req('POST', '/api/login', { usuario: 'maria', password: 'maria123' })).data.token;
  const p = (await req('POST', '/api/login', { usuario: 'pedro', password: 'pedro123' })).data.token;

  check('login Gerente', { status: 200, data: a }, 200, d => d.user.rol === 'Gerente');
  check('token inválido rechazado', await req('GET', '/api/config', undefined, 'no-es-token'), 401);
  check('sin token rechazado', await req('GET', '/api/config'), 401);

  const lecturas = [
    '/api/config', '/api/tasa', '/api/zonas', '/api/productos', '/api/productos?todos=1',
    '/api/promociones', '/api/pdvs', '/api/inventario', '/api/inventario/movimientos',
    '/api/proveedores', '/api/entregas', '/api/cobranza', '/api/kpis',
    '/api/ventas-zona?periodo=mes', '/api/ventas-serie?escala=semanal', '/api/retornables',
    '/api/red', '/api/comodatos', '/api/mermas', '/api/liquidaciones/resumen',
    '/api/liquidaciones', '/api/usuarios', '/api/bitacora', '/api/visitas', '/api/empresa'
  ];
  for (const r of lecturas) check(`GET ${r}`, await req('GET', r, undefined, T));

  console.log('\nPermisos');
  check('Preventista no ve bitácora', await req('GET', '/api/bitacora', undefined, p), 403);
  check('Supervisor no gestiona usuarios', await req('GET', '/api/usuarios', undefined, m), 403);

  const pdvs = (await req('GET', '/api/pdvs', undefined, T)).data;
  check('hay puntos de venta cargados', { status: 200, data: pdvs }, 200, d => Array.isArray(d) && d.length > 0);

  console.log(`\n== Resultado: ${ok} OK, ${fail} fallos ==`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
