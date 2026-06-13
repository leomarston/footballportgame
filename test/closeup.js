const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');
(async () => {
  const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  const browser = await chromium.launch({ executablePath: exe,
    args: ['--use-gl=angle','--use-angle=swiftshader','--ignore-gpu-blocklist','--enable-unsafe-swiftshader','--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', e => console.log('ERR', e.message));
  await page.goto('http://127.0.0.1:8099/index.html', { waitUntil: 'load' });
  await page.waitForTimeout(800);
  await page.mouse.click(640, 360); await page.waitForTimeout(300);
  await page.click('#btn-1p'); await page.waitForTimeout(200);
  await page.click('#screen-diff [data-diff="pro"]'); await page.waitForTimeout(200);
  let c = await page.$$('.tcard'); await c[2].click(); await page.waitForTimeout(200);
  c = await page.$$('.tcard'); await c[4].click(); await page.waitForTimeout(2500);
  // override camera to a close third-person look at an attacker carrying the ball
  await page.evaluate(() => {
    const m = window.__GS.match; m.setPaused(true);
    const p = m.teams[0].players[5];
    p.pos.set(6, 0, 0); p.facing = 0.3; p.root.position.copy(p.pos);
    p.speedFrac = 0.9; p._animate(0.016);
    m.ball.controlledBy = null; m.ball.pos.set(7.4, m.ball.radius, 0.6); m.ball._sync();
    const cam = window.__GS.camera;
    cam.position.set(2.5, 2.2, 6.5); cam.lookAt(6.4, 1.1, 0.2);
  });
  await page.waitForTimeout(150);
  await page.evaluate(() => { window.__GS.gfx.render(window.__GS.scene, window.__GS.camera, 0.016); });
  await page.screenshot({ path: path.join(__dirname, 'shot_closeup.png') });

  // celebration pose + goal-mouth view
  await page.evaluate(() => {
    const m = window.__GS.match;
    const cam = window.__GS.camera;
    const t = m.teams[0];
    t.players.forEach((p,i)=>{ if(!p.isGK){ p.pos.set(20+ (i%3)*2, 0, -3+i*1.5); p.celebrate(i%3); p.celebrateTimer=2; p._animate(0.4);} });
    cam.position.set(12, 4, 12); cam.lookAt(22, 1.5, 0);
    window.__GS.gfx.render(window.__GS.scene, window.__GS.camera, 0.016);
  });
  await page.waitForTimeout(100);
  await page.evaluate(() => { window.__GS.gfx.render(window.__GS.scene, window.__GS.camera, 0.016); });
  await page.screenshot({ path: path.join(__dirname, 'shot_celebrate.png') });
  await browser.close();
})();
