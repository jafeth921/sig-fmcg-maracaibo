// Auditoría de interfaz: recorre todas las vistas y reporta errores de JavaScript,
// peticiones fallidas y diálogos de error. Guarda capturas en dev/screenshots.
// Uso: node dev/ui-audit.js [http://localhost:3000]
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = process.argv[2] || 'http://localhost:3000';
const OUT = path.join(__dirname, 'screenshots');
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const errores = [];
  const fallosRed = [];
  page.on('pageerror', e => errores.push('pageerror: ' + e.message));
  page.on('console', m => {
    if (m.type() === 'error') errores.push('console: ' + m.text());
  });
  page.on('requestfailed', r => {
    const u = r.url();
    if (!u.startsWith('data:')) fallosRed.push(`${r.method()} ${u} (${r.failure()?.errorText})`);
  });
  page.on('response', r => {
    if (r.status() >= 500 && r.url().includes('/api/')) fallosRed.push(`HTTP ${r.status()} ${r.url()}`);
  });

  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });
  await page.screenshot({ path: path.join(OUT, '00-landing.png'), fullPage: false });

  await page.getByRole('button', { name: 'Ingresar al sistema' }).first().click();
  await page.fill('#lu', 'admin');
  await page.fill('#lp', 'admin123');
  await page.click('#btnLogin');
  await page.waitForSelector('#app', { state: 'visible', timeout: 30000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(OUT, '01-dashboard.png') });

  const vistas = await page.$$eval('a[data-view]', as => as.map(a => ({ v: a.dataset.view, t: a.textContent.trim() })));
  let i = 2;
  for (const { v, t } of vistas) {
    const antes = errores.length;
    await page.click(`a[data-view="${v}"]`);
    await page.waitForTimeout(1400);
    const activa = await page.$eval(`#view-${v}`, el => el.classList.contains('active')).catch(() => false);
    const titulo = await page.textContent('#viewTitle');
    const nuevos = errores.slice(antes);
    const nombre = String(i++).padStart(2, '0') + '-' + v;
    await page.screenshot({ path: path.join(OUT, nombre + '.png'), fullPage: true });
    console.log(`${nuevos.length ? 'ERROR' : ' ok  '} ${v.padEnd(14)} "${titulo}"${activa ? '' : ' [NO ACTIVA]'}`);
    nuevos.forEach(e => console.log('        ' + e));
  }

  // Interacciones básicas
  console.log('\nInteracciones');
  await page.click('a[data-view="pdvs"]');
  await page.waitForTimeout(500);
  await page.click('text=Nuevo PDV');
  await page.waitForTimeout(400);
  const modalPDV = await page.isVisible('#modalPDV');
  await page.click('#modalPDV button:has-text("Cancelar")').catch(() => {});
  await page.waitForTimeout(300);
  console.log(`${modalPDV ? ' ok  ' : 'FALLO'} abrir modal Nuevo PDV`);

  await page.click('a[data-view="pedido"]');
  await page.waitForTimeout(1200);
  await page.selectOption('#selPDV', { index: 1 }).catch(() => {});
  await page.waitForTimeout(1200);
  const productos = await page.$$eval('#listaProds input[type=number]', els => els.length);
  console.log(`${productos > 0 ? ' ok  ' : 'FALLO'} catálogo de productos en Tomar pedido (${productos})`);
  if (productos > 0) {
    await page.fill('#listaProds input[type=number] >> nth=0', '1');
    await page.waitForTimeout(400);
    const total = await page.textContent('#totalesPedido');
    console.log(`      totales: ${total.replace(/\s+/g, ' ').slice(0, 160)}`);
    await page.screenshot({ path: path.join(OUT, '90-pedido-con-producto.png'), fullPage: true });
    // Agregar pago con el saldo
    await page.selectOption('#payMetodo', { index: 0 }).catch(() => {});
    await page.click('text=Cobrar el saldo con el método seleccionado').catch(() => {});
    await page.waitForTimeout(500);
    const pagos = await page.$$eval('#payList tbody tr', r => r.length);
    console.log(`${pagos > 0 ? ' ok  ' : 'FALLO'} agregar pago (${pagos})`);
    await page.screenshot({ path: path.join(OUT, '91-pedido-con-pago.png'), fullPage: true });

    const uso = (await page.textContent('#usoPedidos').catch(() => '')).replace(/\s+/g, ' ').trim();
    console.log(`${uso.includes('Pedidos') ? ' ok  ' : 'FALLO'} aviso de límite de pedidos: ${uso.slice(0, 90)}`);
    const smart = (await page.textContent('#smartOrder').catch(() => '')).replace(/\s+/g, ' ').trim();
    if (smart.length > 3) console.log(` ok   venta sugerida: ${smart.slice(0, 90)}`);
    else {
      // Sin historial de compras la sugerencia puede venir vacía: se valida la API.
      const r = await page.evaluate(async () => {
        const pdv = document.getElementById('selPDV').value;
        const res = await fetch('/api/smart-order/' + pdv, { headers: { Authorization: 'Bearer ' + sessionStorage.getItem('token') } });
        return { status: res.status, data: await res.json().catch(() => null) };
      });
      const ok = r.status === 200 && Array.isArray(r.data);
      console.log(`${ok ? ' ok  ' : 'FALLO'} venta sugerida: ${ok ? 'sin historial todavía (la API responde vacío)' : 'HTTP ' + r.status}`);
    }

    await page.click('#btnConfirmar');
    await page.waitForTimeout(2500);
    const msg = (await page.textContent('#pedidoMsg').catch(() => '')).replace(/\s+/g, ' ').trim();
    console.log(`${/confirmado/i.test(msg) ? ' ok  ' : 'FALLO'} confirmar pedido: ${msg.slice(0, 130)}`);
    await page.screenshot({ path: path.join(OUT, '92-pedido-confirmado.png'), fullPage: true });

    if (/confirmado/i.test(msg)) {
      const [descarga] = await Promise.all([
        page.waitForEvent('download', { timeout: 20000 }).catch(() => null),
        page.click('#pedidoMsg button')
      ]);
      if (descarga) {
        const archivo = path.join(OUT, 'comprobante.pdf');
        await descarga.saveAs(archivo);
        const kb = Math.round(fs.statSync(archivo).size / 1024);
        console.log(`${kb > 1 ? ' ok  ' : 'FALLO'} PDF del comprobante (${kb} KB)`);
      } else console.log('FALLO PDF del comprobante (no se descargó)');
    }
  }

  // PDF del comprobante (jsPDF)
  const pdf = await page.evaluate(async () => {
    try { return typeof window.jspdf === 'object' && typeof window.jspdf.jsPDF === 'function'; }
    catch { return false; }
  });
  console.log(`${pdf ? ' ok  ' : 'FALLO'} librería jsPDF cargada`);

  const chart = await page.evaluate(() => typeof window.Chart);
  console.log(`${chart === 'function' ? ' ok  ' : 'FALLO'} librería Chart.js cargada`);

  if (fallosRed.length) {
    console.log('\nPeticiones fallidas:');
    [...new Set(fallosRed)].forEach(f => console.log(' - ' + f));
  }
  if (errores.length) {
    console.log('\nErrores de JavaScript:');
    [...new Set(errores)].forEach(e => console.log(' - ' + e));
  }
  console.log(`\nCapturas en ${OUT}`);
  await browser.close();
  process.exit(errores.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
