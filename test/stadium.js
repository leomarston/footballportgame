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
  await page.mouse.click(640, 360); await page.waitForTimeout(250);
  await page.click('#btn-watch'); await page.waitForTimeout(2500);
  await page.evaluate(() => { window.__GS.match.teams[0].score = 2; window.__GS.match.teams[1].score = 1; });

  async function shot(name, cam, look) {
    await page.evaluate((a) => {
      window.__GS.match.setPaused(true);
      const c = window.__GS.camera;
      c.position.set(a.cam[0], a.cam[1], a.cam[2]);
      c.lookAt(a.look[0], a.look[1], a.look[2]);
      window.__GS.gfx.render(window.__GS.scene, window.__GS.camera, 0.016);
    }, { cam, look });
    await page.waitForTimeout(80);
    await page.evaluate(() => window.__GS.gfx.render(window.__GS.scene, window.__GS.camera, 0.016));
    await page.screenshot({ path: path.join(__dirname, name) });
  }

  await shot('stad_aerial.png', [0, 55, 78], [0, 0, 0]);
  await shot('stad_corner.png', [44, 26, 40], [0, 2, 0]);
  await shot('stad_jumbo.png', [20, 14, 30], [42, 16, 0]);
  await shot('stad_low.png', [10, 6, 34], [0, 3, 0]);
  console.log('done');
  await browser.close();
})();
