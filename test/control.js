const { chromium } = require('/opt/node22/lib/node_modules/playwright');
(async () => {
  const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  const browser = await chromium.launch({ executablePath: exe,
    args: ['--use-gl=angle','--use-angle=swiftshader','--ignore-gpu-blocklist','--enable-unsafe-swiftshader','--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
  page.on('pageerror', e => console.log('ERR', e.message));
  await page.goto('http://127.0.0.1:8099/index.html', { waitUntil: 'load' });
  await page.waitForTimeout(700);
  await page.mouse.click(500, 300); await page.waitForTimeout(250);
  await page.click('#btn-1p'); await page.waitForTimeout(200);
  await page.click('#screen-diff [data-diff="easy"]'); await page.waitForTimeout(200);
  let c = await page.$$('.tcard'); await c[0].click(); await page.waitForTimeout(150);
  c = await page.$$('.tcard'); await c[1].click(); await page.waitForTimeout(2500);

  // count how often the controlled (active) player changes while the human
  // gives no input (pure auto-switch behaviour) over ~6 seconds
  const res = await page.evaluate(async () => {
    const m = window.__GS.match;
    let last = null, switches = 0, samples = 0;
    const start = performance.now();
    return await new Promise(resolve => {
      const id = setInterval(() => {
        const a = m.control[0].active;
        if (a !== last) { switches++; last = a; }
        samples++;
        if (performance.now() - start > 6000) {
          clearInterval(id);
          resolve({ switches, samples, secs: (performance.now() - start) / 1000 });
        }
      }, 16);
    });
  });
  console.log('ACTIVE SWITCHES over', res.secs.toFixed(1) + 's:', res.switches, '(' + (res.switches / res.secs).toFixed(2) + '/s)');
  await browser.close();
})();
