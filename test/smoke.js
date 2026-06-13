const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

(async () => {
  const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  const browser = await chromium.launch({
    executablePath: exe,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist',
           '--enable-unsafe-swiftshader', '--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  const logs = [];
  page.on('console', m => { logs.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', e => { errors.push('PAGEERROR: ' + e.message + '\n' + (e.stack || '')); });

  await page.goto('http://127.0.0.1:8099/index.html', { waitUntil: 'load' });
  await page.waitForTimeout(1200);

  // diagnostic: confirm engine objects exist
  const boot = await page.evaluate(() => ({
    hasGS: !!window.GS, hasThree: !!window.THREE,
    hasGfx: !!(window.__GS && window.__GS.gfx),
    children: window.__GS ? window.__GS.scene.children.length : -1,
  }));
  console.log('BOOT', JSON.stringify(boot));

  await page.screenshot({ path: path.join(__dirname, 'shot_title.png') });

  // start -> mode -> 1P -> difficulty Pro -> team select P1 -> P2
  await page.mouse.click(640, 360);            // title -> mode
  await page.waitForTimeout(400);
  await page.click('#btn-1p');
  await page.waitForTimeout(300);
  await page.click('#screen-diff [data-diff="pro"]');
  await page.waitForTimeout(300);
  // team cards
  const cards = await page.$$('.tcard');
  console.log('CARDS', cards.length);
  await cards[0].click();   // P1 picks team 0
  await page.waitForTimeout(300);
  const cards2 = await page.$$('.tcard');
  await cards2[1].click();  // opponent team 1
  await page.waitForTimeout(2000);            // match launches

  const inMatch = await page.evaluate(() => {
    const m = window.__GS.match;
    return m ? { state: m.state, players: m.teams[0].players.length + m.teams[1].players.length,
                 ballY: +m.ball.pos.y.toFixed(2) } : null;
  });
  console.log('MATCH', JSON.stringify(inMatch));
  await page.screenshot({ path: path.join(__dirname, 'shot_kickoff.png') });

  // drive: press shoot to start, move around, shoot
  await page.keyboard.press('Space');
  for (let i = 0; i < 60; i++) {
    await page.keyboard.down('KeyD');
    await page.waitForTimeout(60);
  }
  await page.keyboard.up('KeyD');
  await page.keyboard.down('Space');
  await page.waitForTimeout(500);
  await page.keyboard.up('Space');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(__dirname, 'shot_play.png') });

  // let the sim run a while to surface physics/AI errors
  await page.waitForTimeout(4000);
  const after = await page.evaluate(() => {
    const m = window.__GS.match;
    return { state: m.state, score: [m.teams[0].score, m.teams[1].score],
             ballPos: [m.ball.pos.x, m.ball.pos.y, m.ball.pos.z].map(v => +v.toFixed(1)) };
  });
  console.log('AFTER', JSON.stringify(after));
  await page.screenshot({ path: path.join(__dirname, 'shot_late.png') });

  console.log('--- ERRORS (' + errors.length + ') ---');
  errors.slice(0, 20).forEach(e => console.log(e));
  console.log('--- WARN/ERR LOGS ---');
  logs.filter(l => /error|warn|undefined|NaN/i.test(l)).slice(0, 25).forEach(l => console.log(l));

  await browser.close();
  process.exit(errors.length ? 1 : 0);
})();
