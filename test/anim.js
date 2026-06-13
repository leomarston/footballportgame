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

  // isolate one running player and frame him from the side
  await page.evaluate(() => {
    const m = window.__GS.match; m.setPaused(true);
    window.__solo = m.teams[0].players[5];
    // hide every other player and the ball so the solo read is clean
    m.teams.forEach(t => t.players.forEach(p => { if (p !== window.__solo) p.root.visible = false; }));
    m.ball.mesh.visible = false; m.ball.shadow.visible = false; if (m.ball.glow) m.ball.glow.visible = false;
  });

  // simulate a running player by stepping his animation directly at speed
  async function frame(name, phase, opts) {
    await page.evaluate((args) => {
      const m = window.__GS.match, p = window.__solo;
      const cam = window.__GS.camera;
      p.pos.set(0,0,0); p.vel.set(args.vx,0,0);
      p.facing = args.face; p.speedFrac = args.sf;
      p.runCycle = args.phase;
      p.kickTimer = args.kick ? p.kickDur*(1-args.kickT) : 0;
      p.slideTimer = args.slide ? p.slideMax*0.5 : 0;
      p.fallTimer = args.fall ? p.fallMax*args.fallT : 0;
      p.celebrateTimer = args.celeb!=null ? 1.5 : 0; p.celebrateType = args.celeb||0;
      p.root.position.set(0,0,0); p.root.rotation.set(0,-p.facing+Math.PI/2,0);
      p._animate(0.016);
      cam.position.set(args.cx, args.cy, args.cz); cam.lookAt(0,0.9,0);
      window.__GS.gfx.render(window.__GS.scene, window.__GS.camera, 0.016);
    }, Object.assign({phase, face:Math.PI/2, vx:0, sf:0, cx:0, cy:1.0, cz:4.2}, opts));
    await page.waitForTimeout(40);
    await page.evaluate(() => window.__GS.gfx.render(window.__GS.scene, window.__GS.camera, 0.016));
    await page.screenshot({ path: path.join(__dirname, name) });
  }

  // run cycle side-on (player faces +x, camera on +z side)
  for (let i = 0; i < 6; i++) {
    await frame('anim_run_'+i+'.png', i/6, { face:0, vx:8.5, sf:1.0, cx:0, cy:1.0, cz:4.4 });
  }
  // kick, slide, fall, idle, celebrate
  await frame('anim_kick.png', 0, { face:0, vx:2, sf:0.3, kick:true, kickT:0.7, cx:0, cy:1.0, cz:4.4 });
  await frame('anim_slide.png', 0, { face:0, vx:6, sf:0.7, slide:true, cx:0, cy:0.8, cz:4.4 });
  await frame('anim_fall.png', 0, { face:0, vx:0, sf:0, fall:true, fallT:0.55, cx:0, cy:0.9, cz:4.4 });
  await frame('anim_idle.png', 0.2, { face:0.6, vx:0, sf:0, cx:2.5, cy:1.1, cz:3.6 });
  await frame('anim_celeb.png', 0, { face:0.4, vx:0, sf:0, celeb:0, cx:2.5, cy:1.4, cz:4.2 });

  console.log('done');
  await browser.close();
})();
