// Prueba integral de la API contra el servidor local (npm run dev).
// Uso: node dev/smoke.js [http://localhost:3000]
const BASE = process.argv[2] || process.env.BASE_URL || 'http://localhost:3000';

let ok = 0, fail = 0;
const fallos = [];

async function req(method, path, body, token) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: r.status, data };
}

function check(nombre, r, esperado = 200, validar) {
  const bueno = r.status === esperado && (!validar || validar(r.data));
  if (bueno) { ok++; console.log(`  OK   ${nombre}`); }
  else {
    fail++; fallos.push(nombre);
    console.log(`  FALLO ${nombre} -> HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 400)}`);
  }
  return r.data;
}

(async () => {
  console.log(`\n== Prueba integral contra ${BASE} ==\n`);

  const login = async (u, p) => (await req('POST', '/api/login', { usuario: u, password: p })).data;
  const a = await login('admin', 'admin123');
  if (!a || !a.token) { console.error('No se pudo iniciar sesión como admin:', a); process.exit(1); }
  const T = a.token;
  const m = (await login('maria', 'maria123')).token;
  const p = (await login('pedro', 'pedro123')).token;

  console.log('Autenticación');
  check('login admin', { status: 200, data: a }, 200, d => d.user.rol === 'Gerente');
  check('token inválido rechazado', await req('GET', '/api/config', undefined, 'no-es-token'), 401);
  check('sin token rechazado', await req('GET', '/api/config'), 401);
  check('login incorrecto', await req('POST', '/api/login', { usuario: 'admin', password: 'mal' }), 401);

  console.log('\nLecturas');
  const cfg = check('GET /api/config', await req('GET', '/api/config', undefined, T));
  check('GET /api/tasa', await req('GET', '/api/tasa', undefined, T), 200, d => d.tasa > 0);
  check('GET /api/zonas', await req('GET', '/api/zonas', undefined, T), 200, d => d.length >= 3);
  const prods = check('GET /api/productos', await req('GET', '/api/productos', undefined, T), 200, d => d.length >= 3);
  check('GET /api/productos?todos=1', await req('GET', '/api/productos?todos=1', undefined, T), 200);
  check('GET /api/promociones', await req('GET', '/api/promociones', undefined, T), 200);
  const pdvs = check('GET /api/pdvs', await req('GET', '/api/pdvs', undefined, T), 200, d => d.length >= 3);
  check('GET /api/pdvs?zona_id=1', await req('GET', '/api/pdvs?zona_id=1', undefined, T), 200);
  check('GET /api/inventario', await req('GET', '/api/inventario', undefined, T), 200, d => d.lotes.length > 0);
  check('GET /api/inventario/movimientos', await req('GET', '/api/inventario/movimientos', undefined, T), 200);
  check('GET /api/proveedores', await req('GET', '/api/proveedores', undefined, T), 200, d => d.length >= 2);
  check('GET /api/entregas', await req('GET', '/api/entregas', undefined, T), 200);
  check('GET /api/cobranza', await req('GET', '/api/cobranza', undefined, T), 200);
  check('GET /api/kpis', await req('GET', '/api/kpis', undefined, T), 200, d => 'otif' in d);
  check('GET /api/ventas-zona', await req('GET', '/api/ventas-zona?periodo=mes', undefined, T), 200);
  check('GET /api/ventas-serie', await req('GET', '/api/ventas-serie?escala=semanal', undefined, T), 200, d => d.periodos.length === 12);
  check('GET /api/retornables', await req('GET', '/api/retornables', undefined, T), 200);
  check('GET /api/red', await req('GET', '/api/red', undefined, T), 200);
  check('GET /api/comodatos', await req('GET', '/api/comodatos', undefined, T), 200);
  check('GET /api/mermas', await req('GET', '/api/mermas', undefined, T), 200);
  check('GET /api/liquidaciones/resumen', await req('GET', '/api/liquidaciones/resumen', undefined, T), 200);
  check('GET /api/liquidaciones', await req('GET', '/api/liquidaciones', undefined, T), 200);
  check('GET /api/usuarios', await req('GET', '/api/usuarios', undefined, T), 200);
  check('GET /api/bitacora', await req('GET', '/api/bitacora', undefined, T), 200);
  check('GET /api/visitas', await req('GET', '/api/visitas', undefined, T), 200);
  check('GET /api/empresa', await req('GET', '/api/empresa', undefined, T), 200, d => d.emp_rif);

  console.log('\nPermisos por rol');
  check('Preventista no ve bitácora', await req('GET', '/api/bitacora', undefined, p), 403);
  check('Preventista no crea productos', await req('POST', '/api/productos', { codigo: 'X1', nombre: 'X', precio: 1, alicuota: 'G', peso_kg: 1 }, p), 403);
  check('Supervisor no gestiona usuarios', await req('GET', '/api/usuarios', undefined, m), 403);

  console.log('\nVisitas / geofencing');
  const pdv1 = pdvs[0];
  const idemVisita = 'smoke-visita-' + Date.now();
  const v1 = check('check-in dentro del radio', await req('POST', '/api/visitas/checkin', { pdv_id: pdv1.id, lat: pdv1.lat, lng: pdv1.lng, idem: idemVisita }, p), 200, d => d.id > 0);
  check('check-in idempotente', await req('POST', '/api/visitas/checkin', { pdv_id: pdv1.id, lat: pdv1.lat, lng: pdv1.lng, idem: idemVisita }, p), 200, d => d.duplicado === true);
  check('check-in fuera del radio', await req('POST', '/api/visitas/checkin', { pdv_id: pdv1.id, lat: pdv1.lat + 0.01, lng: pdv1.lng }, p), 400);

  console.log('\nPedidos');
  const prod = id => prods.find(x => x.id === id);
  const ref = prods.find(x => x.codigo === 'REF-2L'), agua = prods.find(x => x.codigo === 'AGU-C12');
  const pedidoBase = {
    pdv_id: pdv1.id,
    items: [{ producto_id: ref.id, cantidad: 2 }, { producto_id: agua.id, cantidad: 5 }],
    pagos: [{ metodo: 'Efectivo USD', monto: 999 }]
  };
  check('pedido vacío rechazado', await req('POST', '/api/pedidos', { pdv_id: pdv1.id, items: [] }, p), 400);
  check('pedido sin pago rechazado', await req('POST', '/api/pedidos', { pdv_id: pdv1.id, items: pedidoBase.items, pagos: [] }, p), 400);

  const f = cfg.fiscal, g = f.igtf_activo ? f.igtf_pct / 100 : 0;
  // El servidor calcula el total (promociones + IVA + IGTF). Para no duplicar esa
  // fórmula en la prueba, se usa el total que devuelve el propio error de cuadre.
  let idemPedido = 'smoke-pedido-' + Date.now();
  const intento = await req('POST', '/api/pedidos', { ...pedidoBase, idem: idemPedido }, p);
  const totalDetectado = Number((String(intento.data && intento.data.error || '').match(/pedido \(([\d.]+) USD\)/) || [])[1]);
  console.log(`  (total calculado por el servidor: ${totalDetectado} USD)`);

  const ped = check('crear pedido', await req('POST', '/api/pedidos', {
    ...pedidoBase, pagos: [{ metodo: 'Efectivo USD', monto: Math.round(totalDetectado * (1 + g) * 100) / 100 }], idem: idemPedido
  }, p), 200, d => d.id > 0 && Math.abs(d.total - totalDetectado) < 0.02);
  if (ped && ped.id) {
    check('pedido idempotente', await req('POST', '/api/pedidos', {
      ...pedidoBase, pagos: [{ metodo: 'Efectivo USD', monto: Math.round(totalDetectado * (1 + g) * 100) / 100 }], idem: idemPedido
    }, p), 200, d => d.duplicado === true);
    check('comprobante válido', await req('GET', `/api/pedidos/${ped.id}/comprobante`, undefined, T), 200, d => d.validacion.ok);
    check('GET /api/pedidos', await req('GET', '/api/pedidos', undefined, T), 200, d => d.some(x => x.id === ped.id));
  }

  // Pedido a crédito y cobranza
  const credIn = await req('POST', '/api/pedidos', { pdv_id: pdv1.id, items: [{ producto_id: ref.id, cantidad: 1 }], pagos: [{ metodo: 'Crédito', monto: 0.01 }] }, p);
  const totalCred = Number((String(credIn.data && credIn.data.error || '').match(/pedido \(([\d.]+) USD\)/) || [])[1]);
  const pedCred = check('pedido a crédito', await req('POST', '/api/pedidos', {
    pdv_id: pdv1.id,
    items: [{ producto_id: ref.id, cantidad: 1 }],
    pagos: [{ metodo: 'Crédito', monto: totalCred }]
  }, p), 200, d => d.id > 0);
  if (pedCred && pedCred.id) {
    check('abono de crédito', await req('POST', '/api/cobranza', { pdv_id: pdv1.id, metodo: 'Efectivo Bs', monto: 10, referencia: '' }, p), 200, d => d.saldo >= 0);
    check('abono excede saldo rechazado', await req('POST', '/api/cobranza', { pdv_id: pdv1.id, metodo: 'Efectivo USD', monto: 999999 }, p), 400);
  }

  console.log('\nEntregas');
  const ent = check('GET entregas con pendientes', await req('GET', '/api/entregas', undefined, p), 200);
  const pend = (ent.pendientes || [])[0];
  if (pend) {
    check('entrega parcial', await req('POST', `/api/pedidos/${pend.id}/entrega`, {
      items: pend.items.map((x, i) => ({ id: x.id, cantidad_entregada: i === 0 ? Math.max(0, x.cantidad - 1) : x.cantidad }))
    }, p), 200, d => ['Entregado', 'Entregado parcial'].includes(d.estado));
    check('entrega repetida rechazada', await req('POST', `/api/pedidos/${pend.id}/entrega`, {}, p), 409);
  }

  console.log('\nInventario y proveedores');
  const provs = (await req('GET', '/api/proveedores', undefined, T)).data || [];
  if (provs.length) {
    const entrada = check('entrada de mercancía', await req('POST', '/api/inventario/entrada', {
      producto_id: ref.id, proveedor_id: provs[0].id, codigo_lote: 'SMOKE-' + Date.now(), cantidad: 10, costo_usd: 1.2
    }, T), 200, d => d.id > 0);
    if (entrada && entrada.id) {
      check('ajuste de lote', await req('POST', '/api/inventario/ajuste', { lote_id: entrada.id, cantidad_nueva: 8, motivo: 'Prueba' }, T), 200);
    }
  }
  const inv = (await req('GET', '/api/inventario', undefined, T)).data;
  const lote = inv.lotes[0];
  const pid = lote ? lote.producto_id : ref.id;
  check('merma de almacén', await req('POST', '/api/mermas', { producto_id: pid, cantidad: 1, causa: 'Rotura' }, T), 200, d => d.descontado === true);
  check('merma sin datos rechazada', await req('POST', '/api/mermas', { cantidad: 1 }, T), 400);

  console.log('\nRED, retornables, comodato');
  check('auditoría RED', await req('POST', '/api/red', { pdv_id: pdv1.id, asignados: 10, propios: 7, competencia: 3 }, p), 200, d => d.cumplimiento_pct === 70);
  check('RED inválida', await req('POST', '/api/red', { pdv_id: pdv1.id, asignados: 0, propios: 0, competencia: 0 }, p), 400);
  const com = (await req('GET', '/api/comodatos', undefined, T)).data || [];
  if (com.length) check('mantenimiento de activo', await req('POST', `/api/comodatos/${com[0].id}/mantenimiento`, {}, p), 200);

  console.log('\nRuteo y despacho');
  const vrp = check('calcular ruta', await req('POST', '/api/vrp', { pdv_ids: pdvs.slice(0, 3).map(x => x.id), capacidad_kg: 2000 }, p), 200, d => d.ruta.length >= 3);
  if (vrp) check('ruta con supuestos', { status: 200, data: vrp }, 200, d => d.total_km >= 0 && d.duracion_min >= 0);
  check('despachar ruta', await req('POST', '/api/despachos', { pdv_ids: pdvs.slice(0, 3).map(x => x.id) }, p), 200);

  console.log('\nCierre de caja');
  const resumen = check('resumen de caja', await req('GET', '/api/liquidaciones/resumen', undefined, p), 200, d => Array.isArray(d.filas));
  if (resumen) {
    const r = await req('POST', '/api/liquidaciones', {
      efectivo_usd: resumen.esperado_usd, efectivo_bs: resumen.esperado_bs, observaciones: 'Prueba automatizada'
    }, p);
    check('cerrar caja', r, 200, d => d.id > 0);
    check('cierre duplicado rechazado', await req('POST', '/api/liquidaciones', { efectivo_usd: 0, efectivo_bs: 0 }, p), 409);
    if (r.data && r.data.id) check('anular cierre', await req('DELETE', `/api/liquidaciones/${r.data.id}`, undefined, T), 200);
  }
  console.log('\nCatálogos y administración');
  const zona = check('crear zona', await req('POST', '/api/zonas', { nombre: 'Prueba ' + Date.now(), color: '#123456' }, T), 200, d => d.id > 0);
  if (zona && zona.id) {
    check('editar zona', await req('PUT', `/api/zonas/${zona.id}`, { nombre: 'Prueba editada ' + Date.now(), color: '#654321' }, T), 200);
    check('eliminar zona vacía', await req('DELETE', `/api/zonas/${zona.id}`, undefined, T), 200);
  }
  check('zona con color inválido', await req('POST', '/api/zonas', { nombre: 'X', color: 'rojo' }, T), 400);

  const nuevoProd = check('crear producto', await req('POST', '/api/productos', {
    codigo: 'SMK' + Date.now().toString().slice(-6), nombre: 'Producto prueba', precio: 2.5, alicuota: 'G', peso_kg: 1, stock_minimo: 2, activo: true
  }, T), 200, d => d.id > 0);
  if (nuevoProd && nuevoProd.id) {
    check('editar producto', await req('PUT', `/api/productos/${nuevoProd.id}`, {
      codigo: 'SMK' + Date.now().toString().slice(-6), nombre: 'Producto prueba 2', precio: 3, alicuota: 'R', peso_kg: 1.5, stock_minimo: 1, activo: true
    }, T), 200);
  }
  check('producto con precio inválido', await req('POST', '/api/productos', { codigo: 'BAD1', nombre: 'Malo', precio: 0, alicuota: 'G', peso_kg: 1 }, T), 400);

  const promo = check('crear promoción', await req('POST', '/api/promociones', {
    nombre: 'Promo prueba', producto_id: ref.id, tipo: 'Volumen', min_cantidad: 3, descuento_pct: 5, activa: true
  }, T), 200, d => d.id > 0);
  if (promo && promo.id) check('eliminar promoción', await req('DELETE', `/api/promociones/${promo.id}`, undefined, T), 200);

  check('crear PDV', await req('POST', '/api/pdvs', {
    rif: 'J-30112233-0', nombre: 'PDV Prueba', zona_id: 1, canal: 'Abasto/Bodega',
    lat: 10.64, lng: -71.61, geofence_radio_m: 50, limite_credito: 0, limite_pedidos: 5, periodo_limite: 'Semanal'
  }, T), 200, d => d.id > 0);
  check('PDV con RIF inválido', await req('POST', '/api/pdvs', {
    rif: 'J-12345678-9', nombre: 'PDV Malo', zona_id: 1, canal: 'Abasto/Bodega',
    lat: 10.64, lng: -71.61, geofence_radio_m: 50, limite_pedidos: 5, periodo_limite: 'Semanal'
  }, T), 400);

  const usr = check('crear usuario', await req('POST', '/api/usuarios', {
    nombre: 'Usuario Prueba', usuario: 'prueba' + Date.now().toString().slice(-5), password: 'clave1234', rol: 'Preventista'
  }, T), 200, d => d.id > 0);
  if (usr && usr.id) check('editar usuario', await req('PUT', `/api/usuarios/${usr.id}`, { nombre: 'Usuario Prueba 2', activo: false }, T), 200);

  check('cambiar contraseña (actual incorrecta)', await req('POST', '/api/me/password', { actual: 'mal', nueva: 'nueva1234' }, p), 400);
  check('empresa (datos inválidos)', await req('PUT', '/api/empresa', { emp_razon: 'X', emp_rif: 'J-1', iva_general: 16, iva_reducida: 8, igtf_pct: 3, comp_prefijo: 'CMP' }, T), 400);
  const emp = (await req('GET', '/api/empresa', undefined, T)).data;
  check('empresa (datos válidos)', await req('PUT', '/api/empresa', { ...emp, emp_rif: emp.emp_rif }, T), 200);
  check('fijar tasa manual', await req('PUT', '/api/tasa', { tasa: cfg.tasa.tasa }, T), 200, d => d.tasa > 0);
  check('tasa inválida', await req('PUT', '/api/tasa', { tasa: 0 }, T), 400);

  console.log('\nRetornables');
  const ret = (await req('GET', '/api/retornables', undefined, p)).data || [];
  const conEnvases = ret.find(x => x.entregados > x.recibidos);
  if (conEnvases) {
    check('devolución de envases', await req('POST', '/api/retornables/devolucion', {
      pdv_id: conEnvases.id, tipo: 'Cesta', cantidad: 1
    }, p), 200);
  }
  check('devolución inválida', await req('POST', '/api/retornables/devolucion', { pdv_id: pdv1.id, tipo: 'Caja', cantidad: 1 }, p), 400);

  console.log(`\n== Resultado: ${ok} OK, ${fail} fallos ==`);
  if (fallos.length) { console.log('Fallos:'); fallos.forEach(f => console.log(' - ' + f)); }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
