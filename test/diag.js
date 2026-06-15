const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');
(async () => {
  const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  const browser = await chromium.launch({ executablePath: exe,
    args: ['--use-gl=angle','--use-angle=swiftshader','--ignore-gpu-blocklist','--enable-unsafe-swiftshader','--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  page.on('pageerror', e => console.log('ERR', e.message));
  await page.goto('http://127.0.0.1:8099/index.html', { waitUntil: 'load' });
  await page.waitForTimeout(800);
  await page.mouse.click(550, 450); await page.waitForTimeout(250);
  await page.click('#btn-watch'); await page.waitForTimeout(2500);

  // count outline meshes + report each part's expand value
  const info = await page.evaluate(() => {
    const out = [];
    let n = 0;
    window.__GS.scene.traverse(o => {
      if (o.isMesh && o.material && o.material.uniforms && o.material.uniforms.uExpand) {
        n++;
        if (out.length < 12) out.push(+o.material.uniforms.uExpand.value.toFixed(4));
      }
    });
    return { outlineCount: n, sampleExpand: out };
  });
  console.log('OUTLINES', JSON.stringify(info));

  // frame a single player + ball tightly
  await page.evaluate(() => {
    const m = window.__GS.match; m.setPaused(true);
    const p = m.teams[0].players[5];
    m.teams.forEach(t => t.players.forEach(q => { if (q !== p) q.root.visible = false; }));
    p.pos.set(0,0,0); p.facing = 0.6; p.speedFrac = 0; p.vel.set(0,0,0);
    p.root.position.set(0,0,0); p.root.rotation.set(0,-p.facing+Math.PI/2,0); p._animate(0.016);
    m.ball.controlledBy = null; m.ball.pos.set(1.1, m.ball.radius, 0.5); m.ball._sync();
    window.__p = p;
    const c = window.__GS.camera;
    c.position.set(1.2, 1.4, 4.4); c.lookAt(0.4, 0.9, 0);
  });
  const render = () => page.evaluate(() => window.__GS.gfx.render(window.__GS.scene, window.__GS.camera, 0.016));
  await render(); await page.waitForTimeout(60); await render();
  await page.screenshot({ path: path.join(__dirname, 'diag_a_normal.png') });

  // B: hide outline shells
  await page.evaluate(() => {
    window.__hidden = [];
    window.__GS.scene.traverse(o => {
      if (o.isMesh && o.material && o.material.uniforms && o.material.uniforms.uExpand && o.visible) {
        o.visible = false; window.__hidden.push(o);
      }
    });
  });
  await render(); await page.waitForTimeout(60); await render();
  await page.screenshot({ path: path.join(__dirname, 'diag_b_noOutline.png') });

  // C: also hide contact shadows + ball shadow
  await page.evaluate(() => {
    const m = window.__GS.match;
    if (window.__p.contactShadow) window.__p.contactShadow.visible = false;
    if (m.ball.shadow) m.ball.shadow.visible = false;
  });
  await render(); await page.waitForTimeout(60); await render();
  await page.screenshot({ path: path.join(__dirname, 'diag_c_noShadow.png') });

  console.log('done');
  await browser.close();
})();
