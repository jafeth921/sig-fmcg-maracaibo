// Verificación de roles y diseño móvil: abre el sistema con cada usuario (el principal
// entra automáticamente), comprueba que el menú muestre solo lo permitido, recorre
// las vistas y guarda capturas.
// Uso: node dev/ui-roles.js [http://localhost:3000]
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = process.argv[2] || 'http://localhost:3000';
const OUT = path.join(__dirname, 'screenshots');
fs.mkdirSync(OUT, { recursive: true });

const USUARIOS = [
  { usuario: 'admin', password: 'admin123', rol: 'Gerente', ancho: 1440, alto: 900 },
  { usuario: 'maria', password: 'maria123', rol: 'Supervisor', ancho: 1024, alto: 768 },
  { usuario: 'pedro', password: 'pedro123', rol: 'Preventista', ancho: 390, alto: 844, movil: true }
];

(async () => {
  const browser = await chromium.launch();
  let fallos = 0;
  const fallar = msg => { fallos++; console.log('FALLO ' + msg); };

  for (const u of USUARIOS) {
    const ctx = await browser.newContext({ viewport: { width: u.ancho, height: u.alto } });
    const page = await ctx.newPage();
    const errores = [];
    page.on('pageerror', e => errores.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errores.push('console: ' + m.text()); });

    console.log(`\n== ${u.usuario} (${u.rol}) · ${u.ancho}x${u.alto} ==`);
    if (u.usuario !== 'admin') await page.addInitScript(() => localStorage.setItem('rutix.noAuto', '1'));
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (u.usuario !== 'admin') {
      await page.waitForSelector('#login', { state: 'visible', timeout: 30000 });
      await page.fill('#lu', u.usuario);
      await page.fill('#lp', u.password);
      await page.click('#btnLogin');
    }
    await page.waitForSelector('#app', { state: 'visible', timeout: 30000 });
    await page.waitForTimeout(2500);

    // Menú visible para este rol (considerando display:none en el propio enlace o
    // en cualquiera de sus contenedores).
    const menu = await page.$$eval('.sidebar nav a[data-view]', as => {
      const visible = el => {
        let n = el;
        while (n && n !== document.body) {
          if (getComputedStyle(n).display === 'none') return false;
          n = n.parentElement;
        }
        return true;
      };
      return as.filter(visible).map(a => ({ v: a.dataset.view, t: a.textContent.trim(), roles: a.dataset.roles || '' }));
    });

    const permitidas = menu.filter(x => !x.roles || x.roles.split(',').includes(u.rol));
    const prohibidas = menu.filter(x => x.roles && !x.roles.split(',').includes(u.rol));
    console.log(`Vistas visibles: ${permitidas.length}${prohibidas.length ? ' · PROHIBIDAS VISIBLES: ' + prohibidas.map(x => x.v).join(', ') : ''}`);
    if (prohibidas.length) fallar('el menú muestra vistas no permitidas para ' + u.rol);

    for (const { v } of permitidas) {
      const antes = errores.length;
      await page.evaluate(() => { const t = document.querySelector('#toast'); if (t) t.innerHTML = ''; });
      if (u.movil) await page.evaluate(id => showView(id), v);
      else await page.click(`a[data-view="${v}"]`);
      await page.waitForTimeout(1000);
      const activa = await page.$eval(`#view-${v}`, el => el.classList.contains('active')).catch(() => false);
      if (!activa) fallar(`la vista ${v} no se activó`);
      const avisosError = await page.$$eval('#toast .toast.error', ts => ts.map(t => t.innerText.replace(/\n/g, ' · ')));
      avisosError.forEach(a => fallar(`${v}: aviso de error visible: ${a}`));
      errores.slice(antes).forEach(e => fallar(`${v}: ${e}`));
      if (v === 'dashboard' || (u.movil && v === 'pedido')) {
        await page.screenshot({ path: path.join(OUT, `rol-${u.usuario}-${v}.png`), fullPage: false });
      }
    }

    if (u.movil) {
      await page.evaluate(() => showView('pedido'));
      await page.waitForTimeout(1000);
      await page.selectOption('#selPDV', { index: 1 }).catch(() => {});
      await page.waitForTimeout(1500);
      const prods = await page.$$eval('#listaProds input[type=number]', els => els.length);
      if (!prods) fallar('el preventista no ve productos para tomar pedido en móvil');
      else {
        await page.fill('#listaProds input[type=number] >> nth=0', '1');
        await page.waitForTimeout(500);
        const total = (await page.textContent('#totalesPedido')).replace(/\s+/g, ' ');
        const m = total.match(/Total a pagar \(USD\)\s*\$?\s*([\d.,]+)/i);
        if (!m || !parseFloat(m[1].replace(',', '.'))) fallar('el total del pedido en móvil no se calcula');
        else console.log(`Pedido móvil: ${prods} productos · total ${m[1]} USD`);
        await page.screenshot({ path: path.join(OUT, 'rol-pedro-pedido-movil.png'), fullPage: true });
      }
    }

    // Controles restringidos por [data-roles] no deben quedar visibles.
    const visiblesNoPermitidas = await page.evaluate(rol => {
      const visible = el => {
        let n = el;
        while (n && n !== document.body) {
          if (getComputedStyle(n).display === 'none') return false;
          n = n.parentElement;
        }
        return true;
      };
      let n = 0;
      document.querySelectorAll('[data-roles]').forEach(el => {
        const roles = (el.getAttribute('data-roles') || '').split(',');
        if (!roles.includes(rol) && visible(el)) n++;
      });
      return n;
    }, u.rol);
    if (visiblesNoPermitidas) fallar(`${visiblesNoPermitidas} control(es) [data-roles] visibles sin permiso`);

    await ctx.close();
  }

  await browser.close();
  console.log(fallos ? `\n${fallos} problema(s) encontrado(s)` : '\nRoles y diseño móvil: sin problemas');
  process.exit(fallos ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
