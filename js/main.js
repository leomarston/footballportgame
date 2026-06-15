/* GOALSTORM — main.js
 * Boot, menu flow, screen transitions, HUD hooks, the main loop.
 */
(function () {
  'use strict';
  const GS = window.GS, U = GS.U;
  const BUILD = 'v10';
  console.log('%cGOALSTORM build ' + BUILD, 'color:#27e07f;font-weight:bold');
  const buildEl = document.getElementById('build');
  if (buildEl) buildEl.textContent = 'BUILD ' + BUILD;

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const canvas = $('game-canvas');
  const fade = $('fade');
  const flash = $('flash');

  const screens = {
    title: $('screen-title'), mode: $('screen-mode'), diff: $('screen-diff'),
    team: $('screen-team'), pause: $('screen-pause'), ft: $('screen-ft'),
  };
  function show(name) {
    for (const k in screens) screens[k].classList.toggle('show', k === name);
    current = name;
  }
  function hideAll() { for (const k in screens) screens[k].classList.remove('show'); current = null; }
  let current = null;

  // ---------- engine ----------
  const gfx = new GS.Gfx(canvas);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.5, 1200);
  camera.position.set(0, 40, 60);
  camera.lookAt(0, 0, 0);
  const particles = new GS.Particles(scene);
  const audio = new GS.AudioEngine();
  const input = new GS.Input();

  let stadium = null, match = null;
  let menuTeam0 = 0, menuTeam1 = 1;
  let chosen = { mode: '1p', diff: 'pro', home: 0, away: 1 };

  // a slow idle camera orbit for the menus over an empty pitch
  let demoStadium = null;
  function buildDemoArena() {
    demoStadium = new GS.Stadium(scene, gfx, GS.TEAMS[0], GS.TEAMS[1]);
  }

  // ---------- HUD hooks ----------
  const hudEls = {
    s0: $('sb-s0'), s1: $('sb-s1'), clock: $('sb-clock'), half: $('sb-half'),
    home: $('sb-home'), away: $('sb-away'),
    bannerWrap: $('banner'), bannerBig: $('banner-big'), bannerSub: $('banner-sub'),
    powerWrap: $('powerwrap'), powerBar: $('powerbar'),
    toast: $('toast'), boost0: $('boost-p1'), boost1: $('boost-p2'),
    hud: $('hud'), ctlHint: $('ctl-hint'),
  };
  let toastTimer = 0;
  const hud = {
    score(a, b) { hudEls.s0.textContent = a; hudEls.s1.textContent = b; },
    clock(t, half) { hudEls.clock.textContent = t; hudEls.half.textContent = half; },
    banner(big, sub) {
      hudEls.bannerBig.textContent = big;
      hudEls.bannerSub.textContent = sub || '';
      hudEls.bannerWrap.classList.remove('show');
      void hudEls.bannerWrap.offsetWidth;
      hudEls.bannerWrap.classList.add('show');
    },
    bannerHide() { hudEls.bannerWrap.classList.remove('show'); },
    power(frac) {
      if (frac == null) { hudEls.powerWrap.classList.remove('show'); return; }
      hudEls.powerWrap.classList.add('show');
      hudEls.powerBar.style.width = (frac * 100).toFixed(0) + '%';
    },
    toast(text) {
      hudEls.toast.textContent = text;
      hudEls.toast.classList.add('show');
      toastTimer = 2.2;
    },
    boost(teamId, label) {
      const el = teamId === 0 ? hudEls.boost0 : hudEls.boost1;
      if (!label) { el.classList.remove('show'); return; }
      el.textContent = label;
      el.style.borderColor = teamId === 0 ? '#27e07f' : '#ff4d6d';
      el.classList.add('show');
    },
    fulltime(d) { showFullTime(d); },
  };

  // ---------- screen transitions ----------
  function fadeOut(cb) {
    fade.style.opacity = '1';
    setTimeout(cb, 520);
  }
  function fadeIn() { requestAnimationFrame(() => { fade.style.opacity = '0'; }); }

  function flashScreen() {
    flash.style.transition = 'none'; flash.style.opacity = '0.85';
    requestAnimationFrame(() => { flash.style.transition = 'opacity .5s ease'; flash.style.opacity = '0'; });
  }

  // ---------- team select UI ----------
  function buildTeamGrid() {
    const grid = $('team-grid');
    grid.innerHTML = '';
    GS.TEAMS.forEach((t, i) => {
      const card = document.createElement('div');
      card.className = 'tcard';
      card.innerHTML =
        '<div class="kit">' +
          '<div class="sl" style="background:' + t.c1 + '"></div>' +
          '<div class="sr" style="background:' + t.c1 + '"></div>' +
          '<div class="body" style="background:' + t.c1 + '"></div>' +
          '<div class="stripe" style="background:' + t.c2 + '"></div>' +
        '</div>' +
        '<div class="tname">' + t.name + '</div>' +
        '<div class="ttag">' + t.abbr + '</div>';
      card.addEventListener('click', () => onPickTeam(i));
      grid.appendChild(card);
    });
  }

  let pickStage = 0; // 0 -> choose home (P1), 1 -> choose away (P2/CPU)
  function startTeamSelect() {
    pickStage = 0;
    updatePickLabel();
    refreshTeamCards();
    show('team');
  }
  function updatePickLabel() {
    const lbl = $('pick-label');
    if (pickStage === 0) lbl.innerHTML = '<span class="p1c">PLAYER 1</span> — pick your team';
    else lbl.innerHTML = (chosen.mode === '2p' ? '<span class="p2c">PLAYER 2</span>' : '<span class="p2c">OPPONENT</span>') + ' — pick a team';
  }
  function refreshTeamCards() {
    const cards = document.querySelectorAll('.tcard');
    cards.forEach((c, i) => {
      c.classList.remove('p1', 'p2', 'dis');
      if (pickStage === 1 && i === chosen.home) { c.classList.add('p1', 'dis'); }
      else if (pickStage === 0 && false) {}
    });
  }
  function onPickTeam(i) {
    audio.ui();
    if (pickStage === 0) {
      chosen.home = i;
      pickStage = 1;
      updatePickLabel();
      refreshTeamCards();
    } else {
      if (i === chosen.home) return;
      chosen.away = i;
      launchMatch();
    }
  }

  // ---------- launch / quit ----------
  function launchMatch() {
    audio.uiBig();
    fadeOut(() => {
      hideAll();
      // tear down demo arena & rebuild a fresh stadium for chosen teams
      teardownScene();
      stadium = new GS.Stadium(scene, gfx, GS.TEAMS[chosen.home], GS.TEAMS[chosen.away]);
      match = new GS.Match({
        scene, gfx, particles, stadium, camera, input, audio, hud,
        mode: chosen.mode, difficulty: chosen.diff,
        home: GS.TEAMS[chosen.home], away: GS.TEAMS[chosen.away],
      });
      // scoreboard chips
      $('sb-home').querySelector('.dot').style.background = GS.TEAMS[chosen.home].c1;
      $('sb-away').querySelector('.dot').style.background = GS.TEAMS[chosen.away].c1;
      $('sb-home').querySelector('.ab').textContent = GS.TEAMS[chosen.home].abbr;
      $('sb-away').querySelector('.ab').textContent = GS.TEAMS[chosen.away].abbr;
      $('sb-home').style.background = U.shade(GS.TEAMS[chosen.home].c1, 0.7);
      $('sb-away').style.background = U.shade(GS.TEAMS[chosen.away].c1, 0.7);
      hud.score(0, 0);
      hud.clock('00:00', '1st half');
      hudEls.ctlHint.innerHTML = controlHintText();
      hudEls.hud.classList.add('show');
      audio.whistle(1);
      hud.banner('KICK OFF', GS.TEAMS[chosen.home].name + ' vs ' + GS.TEAMS[chosen.away].name);
      appState = 'match';
      fadeIn();
      flashScreen();
    });
  }

  function controlHintText() {
    if (chosen.mode === '2p')
      return 'P1 WASD move · C pass · V shoot · B sprint<br>P2 ARROWS · K pass · L shoot · ⇧ sprint · ESC pause';
    if (chosen.mode === 'watch')
      return 'CPU demo · ESC menu';
    return 'WASD / ARROWS move · J pass · K / SPACE shoot (hold) · SHIFT sprint · ESC pause';
  }

  function teardownScene() {
    if (match) { match.dispose(); match = null; }
    if (stadium) { /* stadium objects remain in scene; clear scene fully */ }
    // wipe everything from scene and rebuild persistent helpers
    for (let i = scene.children.length - 1; i >= 0; i--) scene.remove(scene.children[i]);
    // re-add particle pools (they were removed)
    scene.add(particles.add.mesh);
    scene.add(particles.std.mesh);
    stadium = null; demoStadium = null;
  }

  function quitToMenu() {
    fadeOut(() => {
      hudEls.hud.classList.remove('show');
      teardownScene();
      buildDemoArena();
      appState = 'menu';
      show('title');
      fadeIn();
    });
  }

  // ---------- full time ----------
  function showFullTime(d) {
    $('ft-score').textContent = d.a + ' – ' + d.b;
    $('ft-result').textContent = d.result;
    const stats = $('ft-stats');
    stats.innerHTML =
      row(d.a, 'Goals', d.b) +
      row(d.shotsA, 'Shots', d.shotsB) +
      row(d.possA + '%', 'Possession', d.possB + '%');
    function row(l, m, r) { return '<div class="l">' + l + '</div><div class="m">' + m + '</div><div class="r">' + r + '</div>'; }
    setTimeout(() => { hudEls.hud.classList.remove('show'); show('ft'); appState = 'menu'; }, 1400);
  }

  // ---------- menu buttons ----------
  $('btn-1p').addEventListener('click', () => { audio.init(); audio.uiBig(); chosen.mode = '1p'; show('diff'); });
  $('btn-2p').addEventListener('click', () => { audio.init(); audio.uiBig(); chosen.mode = '2p'; chosen.diff = 'pro'; startTeamSelect(); });
  $('btn-watch').addEventListener('click', () => { audio.init(); audio.ui(); chosen.mode = 'watch'; chosen.diff = 'pro'; chosen.home = (Math.random() * 8) | 0; do { chosen.away = (Math.random() * 8) | 0; } while (chosen.away === chosen.home); launchMatch(); });
  document.querySelectorAll('#screen-diff [data-diff]').forEach(b => {
    b.addEventListener('click', () => { audio.uiBig(); chosen.diff = b.dataset.diff; startTeamSelect(); });
  });

  // pause controls
  $('btn-resume').addEventListener('click', resumeMatch);
  $('btn-quit').addEventListener('click', () => { audio.ui(); quitToMenu(); });
  $('btn-rematch').addEventListener('click', () => { audio.uiBig(); launchMatch(); });
  $('btn-menu').addEventListener('click', () => { audio.ui(); quitToMenu(); });

  document.querySelectorAll('#seg-quality button').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#seg-quality button').forEach(x => x.classList.remove('on'));
      b.classList.add('on'); gfx.setQuality(b.dataset.q); audio.ui();
    });
  });
  document.querySelectorAll('#seg-sound button').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#seg-sound button').forEach(x => x.classList.remove('on'));
      b.classList.add('on'); audio.setMuted(b.dataset.s === 'off'); audio.ui();
    });
  });

  function pauseMatch() {
    if (appState !== 'match' || !match || match.state === 'fulltime') return;
    match.setPaused(true);
    show('pause');
    appState = 'paused';
  }
  function resumeMatch() {
    audio.ui();
    if (!match) return;
    match.setPaused(false);
    hideAll();
    appState = 'match';
  }

  // ---------- global keys ----------
  let appState = 'menu';
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape') {
      if (appState === 'match') pauseMatch();
      else if (appState === 'paused') resumeMatch();
      else if (current === 'diff') show('mode');
      else if (current === 'team') { if (pickStage === 1) { pickStage = 0; updatePickLabel(); refreshTeamCards(); } else show(chosen.mode === '1p' ? 'diff' : 'mode'); }
      else if (current === 'mode') show('title');
      else if (current === 'ft') quitToMenu();
    }
    if (current === 'title' && (e.code === 'Enter' || e.code === 'Space')) startFromTitle();
  });
  $('screen-title').addEventListener('click', startFromTitle);
  function startFromTitle() {
    if (current !== 'title') return;
    audio.init(); audio.uiBig();
    show('mode');
  }

  // ---------- main loop ----------
  let last = performance.now();
  let acc = 0; const FIXED = 1 / 60;
  function loop(now) {
    requestAnimationFrame(loop);
    let dt = (now - last) / 1000;
    last = now;
    if (dt > 0.1) dt = 0.1;

    if (appState === 'match' && match) {
      // fixed-step simulation for stable physics; poll inside each step so
      // input edges are latched until a sim step consumes them
      acc += dt;
      let steps = 0;
      while (acc >= FIXED && steps < 4) {
        input.poll(now / 1000);
        match.update(FIXED);   // calls input.endFrame() at the end of each step
        acc -= FIXED; steps++;
      }
    } else {
      input.poll(now / 1000);
      // menu idle: gently orbit camera around the arena
      if (demoStadium) {
        demoStadium.update(dt);
        const t = now / 1000;
        const r = 70;
        camera.position.set(Math.cos(t * 0.08) * r, 30 + Math.sin(t * 0.05) * 6, Math.sin(t * 0.08) * r);
        camera.lookAt(0, 2, 0);
        audio.update(dt);
        if (demoStadium.setExcitement) demoStadium.setExcitement(0.2);
      }
      input.endFrame();
    }

    // toast fade
    if (toastTimer > 0) { toastTimer -= dt; if (toastTimer <= 0) hudEls.toast.classList.remove('show'); }

    particles.update(dt);
    gfx.render(scene, camera, dt);
  }

  // ---------- boot ----------
  buildTeamGrid();
  buildDemoArena();
  show('title');
  fadeIn();
  requestAnimationFrame(loop);

  // expose for debugging
  window.__GS = { gfx, scene, camera, get match() { return match; } };
})();
