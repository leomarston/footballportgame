const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');
(async () => {
  const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  const browser = await chromium.launch({ executablePath: exe,
    args: ['--use-gl=angle','--use-angle=swiftshader','--ignore-gpu-blocklist','--enable-unsafe-swiftshader','--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('pageerror', e => console.log('ERR', e.message));
  await page.goto('http://127.0.0.1:8099/index.html', { waitUntil: 'load' });
  await page.waitForTimeout(700);
  await page.mouse.click(700, 450); await page.waitForTimeout(250);
  await page.click('#btn-watch'); await page.waitForTimeout(2500);
  await page.evaluate(() => {
    const m = window.__GS.match; m.setPaused(true);
    const p = m.teams[0].players[5];
    m.teams.forEach(t => t.players.forEach(q => { if (q !== p) q.root.visible = false; }));
    p.pos.set(0,0,0); p.facing = 0.5; p.speedFrac = 0; p.vel.set(0,0,0);
    p.root.position.set(0,0,0); p.root.rotation.set(0,-p.facing+Math.PI/2,0); p._animate(0.016);
    m.ball.controlledBy = null; m.ball.pos.set(1.0, m.ball.radius, 0.4); m.ball._sync();
    const c = window.__GS.camera; c.position.set(0.6, 1.5, 4.0); c.lookAt(0.3, 1.0, 0);
  });
  const render = () => page.evaluate(() => window.__GS.gfx.render(window.__GS.scene, window.__GS.camera, 0.016));
  const setOutline = (v) => page.evaluate((val) => { window.__GS.gfx.matComp.uniforms.uOutline.value = val; }, v);

  await setOutline(0.9); await render(); await page.waitForTimeout(50); await render();
  await page.screenshot({ path: path.join(__dirname, 'cmp_on.png') });
  await setOutline(0.0); await render(); await page.waitForTimeout(50); await render();
  await page.screenshot({ path: path.join(__dirname, 'cmp_off.png') });
  console.log('done');
  await browser.close();
})();
