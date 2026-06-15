const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

async function enter(page, mode) {
  await page.goto('http://127.0.0.1:8099/index.html', { waitUntil: 'load' });
  await page.waitForTimeout(700);
  await page.mouse.click(550, 380); await page.waitForTimeout(250); // title -> mode
  if (mode === '1p') {
    await page.click('#btn-1p'); await page.waitForTimeout(250);
    await page.click('#screen-diff [data-diff="pro"]'); await page.waitForTimeout(250);
    let c = await page.$$('.tcard'); await c[0].click(); await page.waitForTimeout(200);
    c = await page.$$('.tcard'); await c[1].click();
  } else if (mode === '2p') {
    await page.click('#btn-2p'); await page.waitForTimeout(250);
    let c = await page.$$('.tcard'); await c[2].click(); await page.waitForTimeout(200);
    c = await page.$$('.tcard'); await c[3].click();
  } else {
    await page.click('#btn-watch');
  }
  await page.waitForTimeout(2500);
}

(async () => {
  const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  const browser = await chromium.launch({ executablePath: exe,
    args: ['--use-gl=angle','--use-angle=swiftshader','--ignore-gpu-blocklist','--enable-unsafe-swiftshader','--no-sandbox'] });

  for (const mode of ['1p', '2p', 'watch']) {
    const page = await browser.newPage({ viewport: { width: 1800, height: 620 } });
    page.on('pageerror', e => console.log(mode, 'ERR', e.message));
    await enter(page, mode);
    const st = await page.evaluate(() => ({ mode: window.__GS.match.mode, state: window.__GS.match.state }));
    console.log('ENTERED', mode, JSON.stringify(st));
    // frame like the user's screenshot: low, side, goal on left + midfield
    await page.evaluate(() => {
      const m = window.__GS.match; m.setPaused(true);
      // spread players across midfield so several are visible
      const c = window.__GS.camera;
      c.position.set(-6, 6.5, 24); c.lookAt(2, 1.2, 0);
      window.__GS.gfx.render(window.__GS.scene, window.__GS.camera, 0.016);
    });
    await page.waitForTimeout(80);
    await page.evaluate(() => window.__GS.gfx.render(window.__GS.scene, window.__GS.camera, 0.016));
    await page.screenshot({ path: path.join(__dirname, 'mode_' + mode + '.png') });
    await page.close();
  }
  console.log('done');
  await browser.close();
})();
