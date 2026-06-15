const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');
(async () => {
  const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  const browser = await chromium.launch({ executablePath: exe,
    args: ['--use-gl=angle','--use-angle=swiftshader','--ignore-gpu-blocklist','--enable-unsafe-swiftshader','--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', e => console.log('ERR', e.message));
  await page.goto('http://127.0.0.1:8099/index.html', { waitUntil: 'load' });
  await page.waitForTimeout(700);
  await page.mouse.click(640, 360); await page.waitForTimeout(250);
  await page.click('#btn-watch'); await page.waitForTimeout(2500);

  async function settleAndShot(name, bx, bz) {
    await page.evaluate((a) => {
      const m = window.__GS.match;
      m.ball.controlledBy = null;
      m.ball.pos.set(a.bx, m.ball.radius, a.bz);
      m.ball.vel.set(0,0,0);
      // settle the camera onto this position
      for (let i = 0; i < 40; i++) m._updateCamera(0.05, i === 0);
      window.__GS.gfx.render(window.__GS.scene, window.__GS.camera, 0.016);
    }, { bx, bz });
    await page.waitForTimeout(60);
    await page.evaluate(() => window.__GS.gfx.render(window.__GS.scene, window.__GS.camera, 0.016));
    await page.screenshot({ path: path.join(__dirname, name) });
  }

  await settleAndShot('cam_near.png', 4, 17);    // ball near the +z (camera-side) touchline
  await settleAndShot('cam_mid.png', 0, 0);      // centre
  await settleAndShot('cam_far.png', -10, -17);  // far -z touchline
  await settleAndShot('cam_goal.png', 28, 2);    // near a goal
  console.log('done');
  await browser.close();
})();
