/* GOALSTORM — gfx.js
 * Renderer + hand-rolled post pipeline (bloom, vignette, color grade,
 * film grain, FXAA), instanced particle pools, procedural sky.
 */
window.GS = window.GS || {};
(function () {
  'use strict';
  const U = GS.U;

  // ----------------------------------------------------------------------
  // fullscreen pass helpers
  // ----------------------------------------------------------------------
  const FS_VERT = `
    varying vec2 vUv;
    void main(){
      vUv = position.xy * 0.5 + 0.5;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }`;

  const BRIGHT_FRAG = `
    uniform sampler2D tInput;
    uniform float uThreshold;
    varying vec2 vUv;
    void main(){
      vec3 c = texture2D(tInput, vUv).rgb;
      float l = dot(c, vec3(0.299, 0.587, 0.114));
      float k = smoothstep(uThreshold, uThreshold + 0.35, l);
      gl_FragColor = vec4(c * k, 1.0);
    }`;

  const BLUR_FRAG = `
    uniform sampler2D tInput;
    uniform vec2 uDir; // texel-space direction
    varying vec2 vUv;
    void main(){
      vec3 acc = texture2D(tInput, vUv).rgb * 0.227027;
      vec2 o1 = uDir * 1.3846153;
      vec2 o2 = uDir * 3.2307692;
      acc += texture2D(tInput, vUv + o1).rgb * 0.3162162;
      acc += texture2D(tInput, vUv - o1).rgb * 0.3162162;
      acc += texture2D(tInput, vUv + o2).rgb * 0.0702702;
      acc += texture2D(tInput, vUv - o2).rgb * 0.0702702;
      gl_FragColor = vec4(acc, 1.0);
    }`;

  const COMP_FRAG = `
    uniform sampler2D tScene;
    uniform sampler2D tBloom;
    uniform float uBloom;
    uniform float uTime;
    uniform float uVignette;
    uniform float uSat;
    varying vec2 vUv;

    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

    void main(){
      vec2 d = vUv - 0.5;
      float r2 = dot(d, d);

      // chromatic aberration that grows toward the edges (lens feel)
      vec2 ca = d * r2 * 0.020;
      vec3 c;
      c.r = texture2D(tScene, vUv - ca).r;
      c.g = texture2D(tScene, vUv).g;
      c.b = texture2D(tScene, vUv + ca).b;

      vec3 b = texture2D(tBloom, vUv).rgb;
      c += b * uBloom;

      // punchy contrast S-curve + gain
      c = clamp(c, 0.0, 1.0);
      c = mix(c, c * c * (3.0 - 2.0 * c), 0.45);
      c = (c - 0.5) * 1.14 + 0.5 + 0.006;

      // saturation
      float l = dot(c, vec3(0.299, 0.587, 0.114));
      c = mix(vec3(l), c, uSat);

      // warm highlights / cool shadows split tone (sunny stadium pop)
      c += vec3(0.022, 0.009, -0.020) * (1.0 - l);
      c += vec3(-0.010, 0.0, 0.020) * l * 0.4;

      // strong rounded vignette
      float vig = smoothstep(1.05, 0.18, r2 * uVignette);
      c *= mix(0.5, 1.0, vig);

      // faint scanline + film grain for a clean retro-broadcast finish
      c *= 1.0 - 0.025 * (0.5 + 0.5 * sin(vUv.y * 1400.0));
      float g = hash(vUv * vec2(1920.0, 1080.0) + fract(uTime) * 7.13) - 0.5;
      c += g * 0.020;

      // linear -> sRGB
      c = clamp(c, 0.0, 1.0);
      c = pow(c, vec3(1.0 / 2.2));
      gl_FragColor = vec4(c, 1.0);
    }`;

  const FXAA_FRAG = `
    uniform sampler2D tInput;
    uniform vec2 uTexel;
    varying vec2 vUv;
    void main(){
      vec3 rgbNW = texture2D(tInput, vUv + vec2(-1.0, -1.0) * uTexel).rgb;
      vec3 rgbNE = texture2D(tInput, vUv + vec2( 1.0, -1.0) * uTexel).rgb;
      vec3 rgbSW = texture2D(tInput, vUv + vec2(-1.0,  1.0) * uTexel).rgb;
      vec3 rgbSE = texture2D(tInput, vUv + vec2( 1.0,  1.0) * uTexel).rgb;
      vec3 rgbM  = texture2D(tInput, vUv).rgb;
      vec3 luma = vec3(0.299, 0.587, 0.114);
      float lNW = dot(rgbNW, luma), lNE = dot(rgbNE, luma);
      float lSW = dot(rgbSW, luma), lSE = dot(rgbSE, luma);
      float lM = dot(rgbM, luma);
      float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
      float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
      vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), ((lNW + lSW) - (lNE + lSE)));
      float dirReduce = max((lNW + lNE + lSW + lSE) * 0.03125, 1.0 / 128.0);
      float rcp = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
      dir = clamp(dir * rcp, vec2(-8.0), vec2(8.0)) * uTexel;
      vec3 rgbA = 0.5 * (
        texture2D(tInput, vUv + dir * (1.0 / 3.0 - 0.5)).rgb +
        texture2D(tInput, vUv + dir * (2.0 / 3.0 - 0.5)).rgb);
      vec3 rgbB = rgbA * 0.5 + 0.25 * (
        texture2D(tInput, vUv + dir * -0.5).rgb +
        texture2D(tInput, vUv + dir *  0.5).rgb);
      float lB = dot(rgbB, luma);
      gl_FragColor = vec4((lB < lMin || lB > lMax) ? rgbA : rgbB, 1.0);
    }`;

  // ----------------------------------------------------------------------
  // Particle pools (instanced)
  // ----------------------------------------------------------------------
  class ParticlePool {
    constructor(scene, count, geo, mat) {
      this.count = count;
      this.mesh = new THREE.InstancedMesh(geo, mat, count);
      this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.mesh.frustumCulled = false;
      const c = new THREE.Color(0, 0, 0);
      for (let i = 0; i < count; i++) this.mesh.setColorAt(i, c);
      this.p = [];
      for (let i = 0; i < count; i++) {
        this.p.push({
          alive: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
          life: 0, maxLife: 1, s0: 1, s1: 0, grav: 0, drag: 0,
          rx: 0, ry: 0, rz: 0, srx: 0, sry: 0, srz: 0,
          r: 1, g: 1, b: 1, fadePow: 1, ground: false,
        });
      }
      this.cursor = 0;
      this._m = new THREE.Matrix4();
      this._q = new THREE.Quaternion();
      this._e = new THREE.Euler();
      this._v = new THREE.Vector3();
      this._s = new THREE.Vector3();
      this._c = new THREE.Color();
      scene.add(this.mesh);
      // park everything at zero scale
      this._s.set(0, 0, 0); this._v.set(0, -999, 0); this._q.identity();
      this._m.compose(this._v, this._q, this._s);
      for (let i = 0; i < count; i++) this.mesh.setMatrixAt(i, this._m);
      this.mesh.instanceMatrix.needsUpdate = true;
    }

    emit(o) {
      const n = o.count || 1;
      const col = new THREE.Color();
      for (let i = 0; i < n; i++) {
        const idx = this.cursor;
        this.cursor = (this.cursor + 1) % this.count;
        const pt = this.p[idx];
        pt.alive = true;
        const sp = o.spread || 0;
        pt.x = o.pos.x + U.rand(-sp, sp);
        pt.y = o.pos.y + U.rand(-sp, sp) * 0.6;
        pt.z = o.pos.z + U.rand(-sp, sp);
        const vs = o.velSpread || 0;
        pt.vx = (o.vel ? o.vel.x : 0) + U.rand(-vs, vs);
        pt.vy = (o.vel ? o.vel.y : 0) + U.rand(-vs, vs) * (o.velSpreadY != null ? o.velSpreadY : 1);
        pt.vz = (o.vel ? o.vel.z : 0) + U.rand(-vs, vs);
        pt.maxLife = U.rand(o.life[0], o.life[1]);
        pt.life = pt.maxLife;
        pt.s0 = o.size[0] * U.rand(0.7, 1.3);
        pt.s1 = o.size[1];
        pt.grav = o.gravity || 0;
        pt.drag = o.drag || 0;
        pt.fadePow = o.fadePow || 1;
        pt.ground = !!o.ground;
        pt.rx = U.rand(0, 6.283); pt.ry = U.rand(0, 6.283); pt.rz = U.rand(0, 6.283);
        const spin = o.spin || 0;
        pt.srx = U.rand(-spin, spin); pt.sry = U.rand(-spin, spin); pt.srz = U.rand(-spin, spin);
        col.set(o.colors[Math.floor(Math.random() * o.colors.length)]);
        pt.r = col.r; pt.g = col.g; pt.b = col.b;
      }
    }

    update(dt, fadeColor) {
      const m = this._m, q = this._q, e = this._e, v = this._v, s = this._s, c = this._c;
      let any = false;
      for (let i = 0; i < this.count; i++) {
        const pt = this.p[i];
        if (!pt.alive) continue;
        any = true;
        pt.life -= dt;
        if (pt.life <= 0) {
          pt.alive = false;
          s.set(0, 0, 0); v.set(0, -999, 0); q.identity();
          m.compose(v, q, s);
          this.mesh.setMatrixAt(i, m);
          continue;
        }
        pt.vy -= pt.grav * dt;
        if (pt.drag) {
          const d = Math.exp(-pt.drag * dt);
          pt.vx *= d; pt.vy *= d; pt.vz *= d;
        }
        pt.x += pt.vx * dt; pt.y += pt.vy * dt; pt.z += pt.vz * dt;
        if (pt.ground && pt.y < 0.03) { pt.y = 0.03; pt.vy = Math.abs(pt.vy) * 0.3; pt.vx *= 0.7; pt.vz *= 0.7; }
        pt.rx += pt.srx * dt; pt.ry += pt.sry * dt; pt.rz += pt.srz * dt;

        const t = 1 - pt.life / pt.maxLife;           // 0..1 age
        const fade = Math.pow(1 - t, pt.fadePow);
        const size = U.lerp(pt.s0, pt.s1, t);
        v.set(pt.x, pt.y, pt.z);
        e.set(pt.rx, pt.ry, pt.rz);
        q.setFromEuler(e);
        s.set(size, size, size);
        m.compose(v, q, s);
        this.mesh.setMatrixAt(i, m);
        if (fadeColor) c.setRGB(pt.r * fade, pt.g * fade, pt.b * fade);
        else c.setRGB(pt.r, pt.g, pt.b);
        this.mesh.setColorAt(i, c);
      }
      if (any) {
        this.mesh.instanceMatrix.needsUpdate = true;
        if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
      }
      this.mesh.visible = any;
    }
  }

  class Particles {
    constructor(scene) {
      // additive pool: sparks, flames, trails, glows
      this.add = new ParticlePool(scene, 900,
        new THREE.OctahedronGeometry(0.5, 0),
        new THREE.MeshBasicMaterial({
          blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
          toneMapped: true,
        }));
      // standard pool: confetti, grass, debris
      this.std = new ParticlePool(scene, 900,
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
      this.std.mesh.castShadow = false;
    }
    emitAdd(o) { this.add.emit(o); }
    emitStd(o) { this.std.emit(o); }
    update(dt) {
      this.add.update(dt, true);
      this.std.update(dt, false);
    }

    // ---- canned effects ----
    grassKick(pos, vel) {
      this.emitStd({
        pos: { x: pos.x, y: 0.1, z: pos.z }, spread: 0.2,
        vel: { x: (vel ? vel.x * 0.18 : 0), y: 2.4, z: (vel ? vel.z * 0.18 : 0) },
        velSpread: 1.6, count: 7, life: [0.3, 0.65], size: [0.13, 0.02],
        gravity: 22, spin: 9, ground: true,
        colors: ['#2f8f3e', '#3da34c', '#62b54a', '#6b4f2a'],
      });
    }
    slideDust(pos) {
      this.emitStd({
        pos: { x: pos.x, y: 0.12, z: pos.z }, spread: 0.3,
        vel: { x: 0, y: 1.4, z: 0 }, velSpread: 1.1,
        count: 3, life: [0.4, 0.8], size: [0.3, 0.65],
        gravity: 1.2, spin: 2, fadePow: 1,
        colors: ['#7d9b6a', '#94ad7c', '#85a06f'],
      });
    }
    shotBlast(pos, dir) {
      this.emitAdd({
        pos: { x: pos.x, y: pos.y, z: pos.z }, spread: 0.1,
        vel: { x: dir.x * 4, y: 1.5, z: dir.z * 4 }, velSpread: 3.2,
        count: 14, life: [0.15, 0.4], size: [0.28, 0.02],
        drag: 4, colors: ['#fff6d8', '#ffd86b', '#ffffff'],
      });
    }
    flameTrail(pos) {
      this.emitAdd({
        pos: { x: pos.x, y: pos.y, z: pos.z }, spread: 0.12,
        vel: { x: 0, y: 1.2, z: 0 }, velSpread: 0.8,
        count: 3, life: [0.2, 0.45], size: [0.42, 0.04],
        drag: 2, colors: ['#ff9b1a', '#ff5e1a', '#ffd86b', '#ff3414'],
      });
    }
    ballTrail(pos, speed) {
      this.emitAdd({
        pos: { x: pos.x, y: pos.y, z: pos.z }, spread: 0.05,
        vel: { x: 0, y: 0, z: 0 }, velSpread: 0.25,
        count: 1, life: [0.12, 0.25], size: [0.22 + speed * 0.004, 0.02],
        colors: ['#cfe8ff', '#ffffff'],
      });
    }
    confettiBurst(pos, teamColors) {
      this.emitStd({
        pos: { x: pos.x, y: pos.y, z: pos.z }, spread: 1.4,
        vel: { x: 0, y: 9, z: 0 }, velSpread: 7,
        count: 90, life: [1.6, 3.2], size: [0.2, 0.16],
        gravity: 6, drag: 1.4, spin: 12, ground: true,
        colors: teamColors.concat(['#ffd23f', '#ffffff', '#27e07f']),
      });
    }
    sparkBurst(pos, color) {
      this.emitAdd({
        pos: { x: pos.x, y: pos.y, z: pos.z }, spread: 0.1,
        vel: { x: 0, y: 3, z: 0 }, velSpread: 5,
        count: 18, life: [0.25, 0.6], size: [0.22, 0.02],
        gravity: 8, colors: [color, '#ffffff'],
      });
    }
    pickupAura(pos, color) {
      this.emitAdd({
        pos: { x: pos.x, y: pos.y + 0.8, z: pos.z }, spread: 0.45,
        vel: { x: 0, y: 1.8, z: 0 }, velSpread: 0.35,
        count: 2, life: [0.3, 0.6], size: [0.2, 0.02],
        colors: [color],
      });
    }
    firework(pos, color) {
      this.emitAdd({
        pos, spread: 0.2, vel: { x: 0, y: 0, z: 0 }, velSpread: 11,
        count: 60, life: [0.6, 1.3], size: [0.3, 0.03],
        gravity: 5, drag: 1.2, colors: [color, '#ffffff', '#ffd23f'],
      });
    }
  }

  // ----------------------------------------------------------------------
  // Sky
  // ----------------------------------------------------------------------
  function createSky(scene) {
    const sunDir = new THREE.Vector3(-0.55, 0.42, 0.42).normalize();

    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uSun: { value: sunDir },
        uTop: { value: new THREE.Color(0x2a70d8) },
        uMid: { value: new THREE.Color(0x7db8ee) },
        uHor: { value: new THREE.Color(0xfae3bc) },
      },
      vertexShader: `
        varying vec3 vDir;
        void main(){
          vDir = normalize(position);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_Position.z = gl_Position.w; // push to far plane
        }`,
      fragmentShader: `
        uniform vec3 uSun;
        uniform vec3 uTop;
        uniform vec3 uMid;
        uniform vec3 uHor;
        varying vec3 vDir;
        void main(){
          vec3 d = normalize(vDir);
          float h = clamp(d.y, 0.0, 1.0);
          vec3 c = mix(uHor, uMid, smoothstep(0.0, 0.18, h));
          c = mix(c, uTop, smoothstep(0.12, 0.65, h));
          float s = clamp(dot(d, uSun), 0.0, 1.0);
          c += vec3(1.0, 0.82, 0.55) * pow(s, 90.0) * 1.1;   // sun disc-ish
          c += vec3(1.0, 0.74, 0.42) * pow(s, 7.0) * 0.22;   // warm haze
          if (d.y < 0.0) c = mix(c, uHor * 0.75, clamp(-d.y * 5.0, 0.0, 1.0));
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    const sky = new THREE.Mesh(new THREE.SphereGeometry(640, 32, 16), skyMat);
    sky.frustumCulled = false;
    scene.add(sky);

    // sun glow sprite
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: U.glowTexture('rgba(255,244,214,1)', 'rgba(255,196,120,.45)'),
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true,
      transparent: true, fog: false,
    }));
    glow.scale.set(220, 220, 1);
    glow.position.copy(sunDir).multiplyScalar(560);
    scene.add(glow);

    // procedural clouds
    const cloudTex = (function () {
      const { canvas, ctx } = U.makeCanvas(256, 128);
      ctx.clearRect(0, 0, 256, 128);
      for (let i = 0; i < 18; i++) {
        const x = U.rand(40, 216), y = U.rand(48, 96);
        const r = U.rand(14, 34);
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, 'rgba(255,255,255,0.85)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
      }
      const t = new THREE.CanvasTexture(canvas);
      t.encoding = THREE.sRGBEncoding;
      return t;
    })();
    const clouds = [];
    for (let i = 0; i < 9; i++) {
      const c = new THREE.Sprite(new THREE.SpriteMaterial({
        map: cloudTex, transparent: true, opacity: U.rand(0.45, 0.8),
        depthWrite: false, fog: false,
      }));
      const ang = U.rand(0, Math.PI * 2), rad = U.rand(260, 460);
      c.position.set(Math.cos(ang) * rad, U.rand(70, 170), Math.sin(ang) * rad);
      const s = U.rand(90, 200);
      c.scale.set(s, s * 0.45, 1);
      scene.add(c);
      clouds.push({ s: c, speed: U.rand(0.5, 1.6) });
    }

    GS.SUN_DIR = sunDir;
    return {
      sunDir,
      update(dt) {
        for (const c of clouds) {
          c.s.position.x += c.speed * dt;
          if (c.s.position.x > 520) c.s.position.x = -520;
        }
      },
    };
  }

  // ----------------------------------------------------------------------
  // Gfx — renderer + post chain
  // ----------------------------------------------------------------------
  class Gfx {
    constructor(canvas) {
      this.canvas = canvas;
      this.renderer = new THREE.WebGLRenderer({
        canvas, antialias: false, powerPreference: 'high-performance',
        stencil: false, alpha: false,
      });
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.12;
      this.renderer.outputEncoding = THREE.LinearEncoding; // gamma handled in post

      this.quality = 'high';
      this.bloomOn = true;
      this.pixelRatio = Math.min(window.devicePixelRatio || 1, 2);

      this._buildPost();
      this._resize();
      window.addEventListener('resize', () => this._resize());
      this.time = 0;
    }

    setQuality(q) {
      this.quality = q;
      if (q === 'high') {
        this.pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        this.bloomOn = true;
        this.renderer.shadowMap.enabled = true;
      } else if (q === 'med') {
        this.pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
        this.bloomOn = true;
        this.renderer.shadowMap.enabled = true;
      } else {
        this.pixelRatio = 1;
        this.bloomOn = false;
        this.renderer.shadowMap.enabled = true; // keep shadows; drop bloom + res
      }
      if (this.onShadowQuality) this.onShadowQuality(q);
      this._resize();
    }

    _buildPost() {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
        -1, -1, 0, 3, -1, 0, -1, 3, 0,
      ]), 3));
      this._fsScene = new THREE.Scene();
      this._fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      this._fsMesh = new THREE.Mesh(geo, null);
      this._fsMesh.frustumCulled = false;
      this._fsScene.add(this._fsMesh);

      const mk = (frag, uniforms) => new THREE.ShaderMaterial({
        vertexShader: FS_VERT, fragmentShader: frag, uniforms,
        depthTest: false, depthWrite: false,
      });

      this.matBright = mk(BRIGHT_FRAG, {
        tInput: { value: null }, uThreshold: { value: 0.58 },
      });
      this.matBlur = mk(BLUR_FRAG, {
        tInput: { value: null }, uDir: { value: new THREE.Vector2(0, 0) },
      });
      this.matComp = mk(COMP_FRAG, {
        tScene: { value: null }, tBloom: { value: null },
        uBloom: { value: 1.05 }, uTime: { value: 0 },
        uVignette: { value: 1.15 }, uSat: { value: 1.28 },
      });
      this.matFxaa = mk(FXAA_FRAG, {
        tInput: { value: null }, uTexel: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
      });
    }

    _rt(w, h) {
      return new THREE.WebGLRenderTarget(w, h, {
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
      });
    }

    _resize() {
      const w = window.innerWidth, h = window.innerHeight;
      this.renderer.setPixelRatio(this.pixelRatio);
      this.renderer.setSize(w, h, false);
      const pw = Math.floor(w * this.pixelRatio), ph = Math.floor(h * this.pixelRatio);
      if (this.rtScene) {
        this.rtScene.dispose(); this.rtBright.dispose();
        this.rtBlurA.dispose(); this.rtBlurB.dispose(); this.rtComp.dispose();
      }
      this.rtScene = new THREE.WebGLRenderTarget(pw, ph, {
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat, depthBuffer: true, stencilBuffer: false,
      });
      this.rtBright = this._rt(pw >> 1, ph >> 1);
      this.rtBlurA = this._rt(pw >> 2, ph >> 2);
      this.rtBlurB = this._rt(pw >> 2, ph >> 2);
      this.rtComp = this._rt(pw, ph);
      this.matFxaa.uniforms.uTexel.value.set(1 / pw, 1 / ph);
      this.w = w; this.h = h;
    }

    render(scene, camera, dt) {
      this.time += dt;
      const r = this.renderer;
      if (camera.aspect !== this.w / this.h) {
        camera.aspect = this.w / this.h;
        camera.updateProjectionMatrix();
      }

      // 1) scene -> rtScene
      r.setRenderTarget(this.rtScene);
      r.render(scene, camera);

      // 2) bloom chain
      if (this.bloomOn) {
        this._fsMesh.material = this.matBright;
        this.matBright.uniforms.tInput.value = this.rtScene.texture;
        r.setRenderTarget(this.rtBright);
        r.render(this._fsScene, this._fsCam);

        let src = this.rtBright;
        this._fsMesh.material = this.matBlur;
        for (let i = 0; i < 2; i++) {
          this.matBlur.uniforms.tInput.value = src.texture;
          this.matBlur.uniforms.uDir.value.set((1.0 + i) / this.rtBlurA.width, 0);
          r.setRenderTarget(this.rtBlurA);
          r.render(this._fsScene, this._fsCam);
          this.matBlur.uniforms.tInput.value = this.rtBlurA.texture;
          this.matBlur.uniforms.uDir.value.set(0, (1.0 + i) / this.rtBlurB.height);
          r.setRenderTarget(this.rtBlurB);
          r.render(this._fsScene, this._fsCam);
          src = this.rtBlurB;
        }
        this.matComp.uniforms.tBloom.value = src.texture;
        this.matComp.uniforms.uBloom.value = 0.85;
      } else {
        this.matComp.uniforms.tBloom.value = this.rtBright.texture;
        this.matComp.uniforms.uBloom.value = 0.0;
      }

      // 3) composite
      this._fsMesh.material = this.matComp;
      this.matComp.uniforms.tScene.value = this.rtScene.texture;
      this.matComp.uniforms.uTime.value = this.time;
      r.setRenderTarget(this.rtComp);
      r.render(this._fsScene, this._fsCam);

      // 4) FXAA to screen
      this._fsMesh.material = this.matFxaa;
      this.matFxaa.uniforms.tInput.value = this.rtComp.texture;
      r.setRenderTarget(null);
      r.render(this._fsScene, this._fsCam);
    }
  }

  // ----------------------------------------------------------------------
  // Toon outline (inverted hull) — the signature "cel-shaded Unity" edge.
  // Back-face shell expanded along normals by a fixed WORLD-space amount that
  // is proportional to the part's size, so the edge stays a clean, constant
  // fraction of each object at any camera distance (no fat black blobs when
  // the camera pulls back). Added as a child so it follows all animation.
  // ----------------------------------------------------------------------
  let OUTLINE_PROTO = null;
  function outlineProto() {
    if (OUTLINE_PROTO) return OUTLINE_PROTO;
    OUTLINE_PROTO = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      fog: false,
      uniforms: {
        uColor: { value: new THREE.Color(0x0b0f18) },
        uExpand: { value: 0.02 },   // world-space thickness, set per mesh
      },
      vertexShader: `
        uniform float uExpand;
        void main(){
          vec3 n = normalize(normalMatrix * normal);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          mv.xyz += n * uExpand;       // constant world-space offset
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform vec3 uColor;
        void main(){ gl_FragColor = vec4(uColor, 1.0); }`,
    });
    return OUTLINE_PROTO;
  }

  // k = outline thickness as a fraction of the part's CROSS-SECTION (not its
  // length). Using the bounding-sphere radius blew up for long thin cylinders
  // (goal posts/crossbar got a huge black shell). We instead take the median
  // bounding-box extent — the small cross-axis for a limb/post — so every
  // part gets a proportional, capped edge that never becomes a black bar.
  GS.addOutline = function (mesh, k) {
    if (!mesh || !mesh.geometry) return null;
    const geo = mesh.geometry;
    if (!geo.boundingBox) geo.computeBoundingBox();
    const bb = geo.boundingBox;
    const dims = [bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z].sort((a, b) => a - b);
    const cross = dims[1] * 0.5;                       // half the median extent
    const expand = U.clamp(cross * (k || 0.2), 0.006, 0.05);
    const mat = outlineProto().clone();
    mat.uniforms.uExpand.value = expand;
    const o = new THREE.Mesh(geo, mat);
    o.castShadow = false; o.receiveShadow = false;
    o.frustumCulled = mesh.frustumCulled;
    mesh.add(o);
    return o;
  };

  GS.Gfx = Gfx;
  GS.Particles = Particles;
  GS.createSky = createSky;
})();
