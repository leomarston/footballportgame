const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');
(async () => {
  const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  const browser = await chromium.launch({ executablePath: exe,
    args: ['--use-gl=angle','--use-angle=swiftshader','--ignore-gpu-blocklist','--enable-unsafe-swiftshader','--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
  page.on('pageerror', e => console.log('ERR', e.message));
  await page.goto('http://127.0.0.1:8099/index.html', { waitUntil: 'load' });
  await page.waitForTimeout(800);
  await page.mouse.click(550, 380); await page.waitForTimeout(250);
  await page.click('#btn-watch'); await page.waitForTimeout(2500);
  const render = () => page.evaluate(() => window.__GS.gfx.render(window.__GS.scene, window.__GS.camera, 0.016));
  await page.evaluate(() => {
    window.__GS.match.setPaused(true);
    const c = window.__GS.camera;
    c.position.set(20, 5, 14); c.lookAt(32, 1.4, 0);  // look at +x goal
  });
  await render(); await page.waitForTimeout(60); await render();
  await page.screenshot({ path: path.join(__dirname, 'goal_check.png') });
  console.log('done');
  await browser.close();
})();
