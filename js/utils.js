/* GOALSTORM — utils.js
 * Shared constants, math helpers, procedural texture helpers, team data.
 */
window.GS = window.GS || {};
(function () {
  'use strict';

  // ---------- core gameplay constants ----------
  GS.CFG = {
    PITCH_W: 64,        // length along x (goal to goal)
    PITCH_H: 40,        // width along z
    GOAL_W: 8,          // goal mouth width (z)
    GOAL_H: 2.62,       // crossbar height
    GOAL_D: 2.3,        // net depth behind line
    POST_R: 0.1,
    BALL_R: 0.36,
    GRAV: 24,           // arcade gravity
    PLAYER_R: 0.55,     // body collision radius
    CONTROL_R: 1.05,    // ball control pickup radius
    BOX_D: 9.5,         // penalty box depth
    BOX_W: 19,          // penalty box width
  };

  // ---------- math ----------
  const U = GS.U = {};
  U.clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
  U.lerp = (a, b, t) => a + (b - a) * t;
  U.damp = (a, b, lambda, dt) => U.lerp(a, b, 1 - Math.exp(-lambda * dt));
  U.rand = (a, b) => a + Math.random() * (b - a);
  U.randInt = (a, b) => Math.floor(U.rand(a, b + 1));
  U.choice = arr => arr[Math.floor(Math.random() * arr.length)];
  U.sign = v => v < 0 ? -1 : 1;
  U.len2 = (x, z) => Math.sqrt(x * x + z * z);
  U.angleOf = (x, z) => Math.atan2(z, x);
  U.angleDiff = (a, b) => {
    let d = (b - a) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  };
  U.angleLerp = (a, b, t) => a + U.angleDiff(a, b) * t;
  U.angleDamp = (a, b, lambda, dt) => a + U.angleDiff(a, b) * (1 - Math.exp(-lambda * dt));
  U.dist2D = (a, b) => { const dx = a.x - b.x, dz = a.z - b.z; return Math.sqrt(dx * dx + dz * dz); };
  U.smoothstep = (a, b, x) => { const t = U.clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

  // distance from point p to segment a-b in XZ plane
  U.distToSeg2D = function (px, pz, ax, az, bx, bz) {
    const abx = bx - ax, abz = bz - az;
    const t = U.clamp(((px - ax) * abx + (pz - az) * abz) / (abx * abx + abz * abz + 1e-9), 0, 1);
    const cx = ax + abx * t, cz = az + abz * t;
    return U.len2(px - cx, pz - cz);
  };

  // closest point on 3D segment, writes into out, returns out
  U.closestOnSeg = function (p, a, b, out) {
    const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
    const L2 = abx * abx + aby * aby + abz * abz + 1e-9;
    const t = U.clamp(((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / L2, 0, 1);
    out.set(a.x + abx * t, a.y + aby * t, a.z + abz * t);
    return out;
  };

  U.fmtClock = function (sec) {
    sec = Math.max(0, Math.floor(sec));
    const m = Math.floor(sec / 60), s = sec % 60;
    return (m < 10 ? '0' + m : m) + ':' + (s < 10 ? '0' + s : s);
  };

  // ---------- canvas / texture helpers ----------
  U.makeCanvas = function (w, h) {
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    return { canvas, ctx: canvas.getContext('2d') };
  };

  U.canvasTexture = function (canvas, opts) {
    opts = opts || {};
    const tex = new THREE.CanvasTexture(canvas);
    tex.encoding = THREE.sRGBEncoding;
    tex.anisotropy = 4;
    if (opts.repeat) {
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(opts.repeat[0], opts.repeat[1]);
    }
    return tex;
  };

  // toon shading gradient map (n hard steps)
  U.toonGradient = function (steps) {
    steps = steps || [0.35, 0.62, 0.85, 1.0];
    const { canvas, ctx } = U.makeCanvas(steps.length, 1);
    for (let i = 0; i < steps.length; i++) {
      const v = Math.round(steps[i] * 255);
      ctx.fillStyle = 'rgb(' + v + ',' + v + ',' + v + ')';
      ctx.fillRect(i, 0, 1, 1);
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    return tex;
  };

  // soft radial glow sprite texture
  U.glowTexture = function (inner, outer, size) {
    size = size || 128;
    const { canvas, ctx } = U.makeCanvas(size, size);
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, inner);
    g.addColorStop(0.4, outer);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(canvas);
    tex.encoding = THREE.sRGBEncoding;
    return tex;
  };

  U.shade = function (hex, f) {
    // hex '#rrggbb' multiplied by factor f, returns css string
    const c = parseInt(hex.slice(1), 16);
    let r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
    r = U.clamp(Math.round(r * f), 0, 255);
    g = U.clamp(Math.round(g * f), 0, 255);
    b = U.clamp(Math.round(b * f), 0, 255);
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  };

  // ---------- teams ----------
  GS.TEAMS = [
    { name: 'Crimson Comets', abbr: 'CCO', c1: '#d92332', c2: '#ffffff', gk: '#1ec8a5', short: '#3a0a10' },
    { name: 'Azure Wave',     abbr: 'AZW', c1: '#1f6df2', c2: '#aee2ff', gk: '#ffb13f', short: '#0a1c4a' },
    { name: 'Solar Kings',    abbr: 'SOL', c1: '#ffd23f', c2: '#1b1b1f', gk: '#c542ff', short: '#1b1b1f' },
    { name: 'Verdant XI',     abbr: 'VER', c1: '#1faf52', c2: '#ffd23f', gk: '#ff4d6d', short: '#0b3a1e' },
    { name: 'Violet Storm',   abbr: 'VIO', c1: '#8e3df2', c2: '#ffffff', gk: '#27e07f', short: '#2a1050' },
    { name: 'Ember United',   abbr: 'EMB', c1: '#ff7a1a', c2: '#173a5e', gk: '#48e0ff', short: '#173a5e' },
    { name: 'Arctic Wolves',  abbr: 'ARC', c1: '#e8f4ff', c2: '#2bb1d8', gk: '#ff8c1a', short: '#1d4257' },
    { name: 'Midnight FC',    abbr: 'MID', c1: '#23232b', c2: '#ff2bd6', gk: '#ffe066', short: '#101016' },
  ];

  GS.SKINS = ['#f2c79c', '#d9a06b', '#a96b3f', '#7c4a26', '#5d3318', '#ffd9b8'];
  GS.HAIRS = ['#1d1410', '#3a2415', '#7a4a1f', '#caa253', '#0f0f12', '#5a2e10', '#23120a', '#b8b8bd'];
  GS.NAMES = [
    'Vyper', 'Drago', 'Kanu', 'Riq', 'Bolt', 'Marek', 'Tito', 'Zhar', 'Onyx', 'Pico',
    'Falk', 'Jet', 'Ramo', 'Sable', 'Crow', 'Iggy', 'Nilo', 'Brax', 'Duke', 'Sumo',
    'Levi', 'Otto', 'Maza', 'Rook', 'Halo', 'Gattu', 'Ferro', 'Stitch', 'Koda', 'Rix',
  ];
})();
