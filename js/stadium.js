/* GOALSTORM — stadium.js
 * Builds the entire arena: striped pitch, goals with spring-sim nets,
 * tiered stands with an animated GPU crowd, ad boards, floodlights,
 * blimp, mountains and lighting. All textures procedural.
 */
window.GS = window.GS || {};
(function () {
  'use strict';
  const U = GS.U, C = GS.CFG;

  const BRANDS = [
    ['ZAPP COLA', '#d92332', '#ffffff'],
    ['AERO MAX', '#1f6df2', '#ffffff'],
    ['NIMBUS AIR', '#e8f4ff', '#16324a'],
    ['VOLT ENERGY', '#ffd23f', '#1b1b1f'],
    ['PIXEL BANK', '#23232b', '#27e07f'],
    ['GOALSTORM TV', '#27e07f', '#06121c'],
    ['LUNAR TYRES', '#8e3df2', '#ffffff'],
    ['TURBO FUEL', '#ff7a1a', '#1b1b1f'],
  ];

  // ------------------------------------------------------------------
  // pitch texture
  // ------------------------------------------------------------------
  function makePitchTexture() {
    const TW = 2048, TH = 1320;
    const FW = 68, FH = 44; // world units covered by the texture
    const px = TW / FW;     // pixels per unit
    const { canvas, ctx } = U.makeCanvas(TW, TH);

    const X = u => (u + FW / 2) * px;
    const Z = u => (u + FH / 2) * (TH / FH);

    // base + mowing stripes
    ctx.fillStyle = '#2c8a39';
    ctx.fillRect(0, 0, TW, TH);
    const stripes = 16, sw = TW / stripes;
    for (let i = 0; i < stripes; i++) {
      ctx.fillStyle = i % 2 ? '#2f9440' : '#2a8237';
      ctx.fillRect(i * sw, 0, sw + 1, TH);
    }
    // subtle grass noise
    for (let i = 0; i < 9000; i++) {
      const a = Math.random() * 0.05;
      ctx.fillStyle = Math.random() > 0.5
        ? 'rgba(255,255,230,' + a + ')' : 'rgba(0,40,0,' + a + ')';
      ctx.fillRect(Math.random() * TW, Math.random() * TH, 2, 2);
    }
    // worn patches in goal mouths / centre
    const wear = (cx, cz, r, alpha) => {
      const g = ctx.createRadialGradient(X(cx), Z(cz), 0, X(cx), Z(cz), r * px);
      g.addColorStop(0, 'rgba(150,140,80,' + alpha + ')');
      g.addColorStop(1, 'rgba(150,140,80,0)');
      ctx.fillStyle = g;
      ctx.fillRect(X(cx) - r * px, Z(cz) - r * px, r * px * 2, r * px * 2);
    };
    wear(0, 0, 5, 0.12);
    wear(-C.PITCH_W / 2 + 2.5, 0, 4, 0.16);
    wear(C.PITCH_W / 2 - 2.5, 0, 4, 0.16);

    // line work
    const lw = 0.14 * px;
    ctx.strokeStyle = 'rgba(255,255,255,0.92)';
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.lineWidth = lw;
    const W = C.PITCH_W, H = C.PITCH_H;

    ctx.strokeRect(X(-W / 2), Z(-H / 2), W * px, H * (TH / FH));
    // halfway + centre
    ctx.beginPath(); ctx.moveTo(X(0), Z(-H / 2)); ctx.lineTo(X(0), Z(H / 2)); ctx.stroke();
    ctx.beginPath(); ctx.arc(X(0), Z(0), 5.5 * px, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(X(0), Z(0), 0.28 * px, 0, Math.PI * 2); ctx.fill();

    for (const s of [-1, 1]) {
      const gx = s * W / 2;
      // penalty box
      const bx = gx - s * C.BOX_D;
      ctx.strokeRect(Math.min(X(gx), X(bx)), Z(-C.BOX_W / 2),
        Math.abs(X(bx) - X(gx)), C.BOX_W * (TH / FH));
      // goal area
      const gax = gx - s * 3.8;
      ctx.strokeRect(Math.min(X(gx), X(gax)), Z(-5.2),
        Math.abs(X(gax) - X(gx)), 10.4 * (TH / FH));
      // penalty spot + arc
      const psx = gx - s * 7;
      ctx.beginPath(); ctx.arc(X(psx), Z(0), 0.26 * px, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath();
      const a0 = s > 0 ? Math.PI * 0.66 : -Math.PI * 0.34;
      ctx.arc(X(psx), Z(0), 5.2 * px, a0, a0 + Math.PI * 0.68);
      ctx.stroke();
      // corner arcs
      for (const cz of [-H / 2, H / 2]) {
        ctx.beginPath();
        ctx.arc(X(gx), Z(cz), 0.9 * px, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // edge vignette baked in
    const vg = ctx.createRadialGradient(TW / 2, TH / 2, TH * 0.45, TW / 2, TH / 2, TW * 0.72);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,20,5,0.18)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, TW, TH);

    return U.canvasTexture(canvas);
  }

  // ------------------------------------------------------------------
  // goal net with spring ripple
  // ------------------------------------------------------------------
  class GoalNet {
    constructor(scene, side) {
      this.side = side; // +1 -> goal at +x, -1 -> at -x
      const W2 = C.PITCH_W / 2, GW = C.GOAL_W, GH = C.GOAL_H, GD = C.GOAL_D;
      const BH = 1.9; // back height

      this.nodes = []; // {rest:Vector3, pos:Vector3, vel:Vector3}
      const addNode = (x, y, z) => {
        const v = new THREE.Vector3(x, y, z);
        this.nodes.push({ rest: v.clone(), pos: v.clone(), vel: new THREE.Vector3() });
        return this.nodes.length - 1;
      };

      this.edges = [];
      const grid = (nx, ny, fn) => {
        const ids = [];
        for (let j = 0; j < ny; j++) {
          ids.push([]);
          for (let i = 0; i < nx; i++) {
            const p = fn(i / (nx - 1), j / (ny - 1));
            ids[j].push(addNode(p.x, p.y, p.z));
          }
        }
        for (let j = 0; j < ny; j++)
          for (let i = 0; i < nx; i++) {
            if (i + 1 < nx) this.edges.push(ids[j][i], ids[j][i + 1]);
            if (j + 1 < ny) this.edges.push(ids[j][i], ids[j + 1][i]);
          }
        return ids;
      };

      const bx = side * (W2 + GD);
      // back panel
      grid(11, 6, (u, v) => ({ x: bx, y: BH * (1 - v), z: -GW / 2 + GW * u }));
      // roof panel (slopes from crossbar to back top)
      grid(11, 4, (u, v) => ({
        x: side * (W2 + GD * v), y: U.lerp(GH, BH, v), z: -GW / 2 + GW * u,
      }));
      // side panels
      for (const sz of [-1, 1]) {
        grid(5, 6, (u, v) => ({
          x: side * (W2 + GD * u),
          y: U.lerp(GH, BH, u) * (1 - v),
          z: sz * GW / 2,
        }));
      }

      const pos = new Float32Array(this.edges.length * 3);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      this.geo = geo;
      this.mesh = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
        color: 0xf4f8ff, transparent: true, opacity: 0.55,
      }));
      this.mesh.frustumCulled = false;
      scene.add(this.mesh);
      this.energy = 1; // force first write
      this._write();
    }

    impulse(point, dir, power) {
      for (const n of this.nodes) {
        const d = n.rest.distanceTo(point);
        if (d < 2.2) {
          const f = Math.max(0, 1 - d / 2.2) * power;
          n.vel.x += dir.x * f;
          n.vel.y += dir.y * f * 0.5;
          n.vel.z += dir.z * f;
        }
      }
      this.energy = 1;
    }

    update(dt) {
      if (this.energy < 0.001) return;
      let e = 0;
      const k = 60, damp = 5.5;
      for (const n of this.nodes) {
        n.vel.x += (-(n.pos.x - n.rest.x) * k - n.vel.x * damp) * dt;
        n.vel.y += (-(n.pos.y - n.rest.y) * k - n.vel.y * damp) * dt;
        n.vel.z += (-(n.pos.z - n.rest.z) * k - n.vel.z * damp) * dt;
        n.pos.x += n.vel.x * dt; n.pos.y += n.vel.y * dt; n.pos.z += n.vel.z * dt;
        e += Math.abs(n.vel.x) + Math.abs(n.vel.y) + Math.abs(n.vel.z);
      }
      this.energy = e;
      this._write();
    }

    _write() {
      const arr = this.geo.attributes.position.array;
      for (let i = 0; i < this.edges.length; i++) {
        const p = this.nodes[this.edges[i]].pos;
        arr[i * 3] = p.x; arr[i * 3 + 1] = p.y; arr[i * 3 + 2] = p.z;
      }
      this.geo.attributes.position.needsUpdate = true;
    }
  }

  // ------------------------------------------------------------------
  // crowd (GPU points)
  // ------------------------------------------------------------------
  // Generic crowd builder. Each stand: { fx,fz, ang (inward-normal angle),
  // len, steps, stepBack, stepUp, baseY, homeBias }. Seats tier outward
  // (-normal) and up. ~6% of fans pop a white camera flash.
  function buildCrowd(scene, stands, homeColor, awayColor) {
    const positions = [], colors = [], heads = [], phases = [], amps = [], flashes = [];
    const homeC = new THREE.Color(homeColor), awayC = new THREE.Color(awayColor);
    const neutrals = ['#e8e8e8', '#d9c46a', '#7a8aa0', '#4a4a55', '#c46a6a', '#6ac4a0'].map(c => new THREE.Color(c));
    const skins = GS.SKINS.map(c => new THREE.Color(c));
    const tmp = new THREE.Color();
    const spacing = 0.92;

    for (const st of stands) {
      const nx = Math.cos(st.ang), nz = Math.sin(st.ang);   // inward normal
      const tx = -nz, tz = nx;                              // tangent
      const cols = Math.max(1, Math.floor(st.len / spacing));
      for (let step = 0; step < st.steps; step++) {
        const backDist = step * st.stepBack + st.stepBack * 0.4;
        const y = st.baseY + step * st.stepUp + 0.95;
        const rcx = st.fx - nx * backDist, rcz = st.fz - nz * backDist;
        for (let i = 0; i < cols; i++) {
          if (Math.random() < 0.1) continue; // empty seats
          const along = -st.len / 2 + (i + 0.5) * spacing + U.rand(-0.16, 0.16);
          positions.push(rcx + tx * along + U.rand(-0.1, 0.1),
                         y + U.rand(-0.05, 0.08),
                         rcz + tz * along + U.rand(-0.1, 0.1));
          const r = Math.random();
          if (r < st.homeBias) tmp.copy(homeC).offsetHSL(U.rand(-0.02, 0.02), U.rand(-0.1, 0.1), U.rand(-0.14, 0.1));
          else if (r < st.homeBias + 0.18) tmp.copy(awayC).offsetHSL(0, 0, U.rand(-0.12, 0.08));
          else tmp.copy(U.choice(neutrals)).offsetHSL(0, 0, U.rand(-0.1, 0.1));
          colors.push(tmp.r, tmp.g, tmp.b);
          const sk = U.choice(skins);
          heads.push(sk.r, sk.g, sk.b);
          phases.push(U.rand(0, Math.PI * 2));
          amps.push(U.rand(0.4, 1));
          flashes.push(Math.random() < 0.06 ? U.rand(0, 100) : -1);
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('aColor', new THREE.Float32BufferAttribute(colors, 3));
    geo.setAttribute('aHead', new THREE.Float32BufferAttribute(heads, 3));
    geo.setAttribute('aPhase', new THREE.Float32BufferAttribute(phases, 1));
    geo.setAttribute('aAmp', new THREE.Float32BufferAttribute(amps, 1));
    geo.setAttribute('aFlash', new THREE.Float32BufferAttribute(flashes, 1));

    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uExcite: { value: 0.15 }, uScale: { value: 1 } },
      vertexShader: `
        attribute vec3 aColor; attribute vec3 aHead;
        attribute float aPhase; attribute float aAmp; attribute float aFlash;
        uniform float uTime; uniform float uExcite; uniform float uScale;
        varying vec3 vColor; varying vec3 vHead; varying float vFlash;
        void main(){
          vColor = aColor; vHead = aHead;
          vec3 p = position;
          float speed = 2.2 + uExcite * 9.0;
          float bounce = max(0.0, sin(uTime * speed + aPhase));
          p.y += bounce * aAmp * (0.05 + uExcite * 0.55);
          // camera flash: brief spike, rarer when calm
          vFlash = 0.0;
          if (aFlash >= 0.0) {
            float ph = fract(uTime * (0.35 + uExcite * 0.5) + aFlash);
            vFlash = smoothstep(0.93, 1.0, ph) * (1.0 - smoothstep(1.0, 1.04, ph));
          }
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = uScale * 1100.0 / max(1.0, -mv.z);
        }`,
      fragmentShader: `
        varying vec3 vColor; varying vec3 vHead; varying float vFlash;
        void main(){
          vec2 q = gl_PointCoord;
          float dh = length((q - vec2(0.5, 0.24)));
          float db = length((q - vec2(0.5, 0.72)) * vec2(1.15, 0.85));
          vec3 col;
          if (dh < 0.16) col = vHead * (q.y < 0.20 ? 0.55 : 1.0);
          else if (db < 0.34 && q.y > 0.34) col = vColor * (1.0 - (q.y - 0.34) * 0.5);
          else discard;
          col = mix(col, vec3(2.4), vFlash);
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    scene.add(pts);
    return { mesh: pts, mat };
  }

  // ------------------------------------------------------------------
  // Stadium
  // ------------------------------------------------------------------
  class Stadium {
    constructor(scene, gfx, homeTeam, awayTeam) {
      this.scene = scene;
      this.gfx = gfx;
      this.t = 0;
      this.adTimer = 9;
      this.adOffset = 0;

      this.homeTeam = homeTeam; this.awayTeam = awayTeam;
      scene.fog = new THREE.Fog(0xcfe0ee, 190, 540);
      this.sky = GS.createSky(scene);
      this._lights();
      this._ground();
      this._goals();
      this._standsAndCrowd(homeTeam, awayTeam);
      this._jumbotron();
      this._tifo(homeTeam, awayTeam);
      this._dugouts(homeTeam, awayTeam);
      this._adBoards();
      this._floodlights();
      this._blimp();
      this._scenery();
      this._flags();
      this._drawJumbo(homeTeam.abbr, awayTeam.abbr, '0', '0', homeTeam.c1, awayTeam.c1, '00:00');
    }

    _lights() {
      const sunDir = GS.SUN_DIR;
      const hemi = new THREE.HemisphereLight(0xbfd9ff, 0x3f7a3f, 0.5);
      this.scene.add(hemi);

      const sun = new THREE.DirectionalLight(0xfff0cc, 1.7);
      sun.position.copy(sunDir).multiplyScalar(150);
      sun.castShadow = true;
      sun.shadow.mapSize.set(2048, 2048);
      sun.shadow.camera.left = -58; sun.shadow.camera.right = 58;
      sun.shadow.camera.top = 46; sun.shadow.camera.bottom = -46;
      sun.shadow.camera.near = 30; sun.shadow.camera.far = 300;
      sun.shadow.bias = -0.0004;
      sun.shadow.normalBias = 0.03;
      this.scene.add(sun);
      this.scene.add(sun.target);
      this.sun = sun;

      const fill = new THREE.DirectionalLight(0x8eb8e8, 0.22);
      fill.position.set(-sunDir.x * 100, 60, -sunDir.z * 100);
      this.scene.add(fill);

      // cool rim/back light so cel-shaded silhouettes pop off the pitch
      const rim = new THREE.DirectionalLight(0xbfe4ff, 0.6);
      rim.position.set(sunDir.x * -120, 70, -160);
      this.scene.add(rim);

      this.gfx.onShadowQuality = (q) => {
        const size = q === 'high' ? 2048 : 1024;
        if (sun.shadow.mapSize.x !== size) {
          sun.shadow.mapSize.set(size, size);
          if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
        }
      };
    }

    _ground() {
      // pitch
      const tex = makePitchTexture();
      const pitch = new THREE.Mesh(
        new THREE.PlaneGeometry(68, 44),
        new THREE.MeshLambertMaterial({ map: tex })
      );
      pitch.rotation.x = -Math.PI / 2;
      pitch.receiveShadow = true;
      this.scene.add(pitch);

      // teal apron / surround
      const apron = new THREE.Mesh(
        new THREE.PlaneGeometry(92, 64),
        new THREE.MeshLambertMaterial({ color: 0x115a50 })
      );
      apron.rotation.x = -Math.PI / 2;
      apron.position.y = -0.02;
      apron.receiveShadow = true;
      this.scene.add(apron);

      // outer world ground
      const outer = new THREE.Mesh(
        new THREE.CircleGeometry(640, 48),
        new THREE.MeshLambertMaterial({ color: 0x274e2a })
      );
      outer.rotation.x = -Math.PI / 2;
      outer.position.y = -0.05;
      this.scene.add(outer);
    }

    _goals() {
      const W2 = C.PITCH_W / 2, GW = C.GOAL_W, GH = C.GOAL_H, GD = C.GOAL_D;
      const postMat = new THREE.MeshToonMaterial({
        color: 0xf8fbff, gradientMap: Stadium.toon(),
      });
      const frameMat = new THREE.MeshLambertMaterial({ color: 0xcdd6e0 });
      this.nets = [];

      for (const s of [-1, 1]) {
        const g = new THREE.Group();
        const post = (x, y, z, h, r, rotZ, rotX) => {
          const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 12), postMat);
          m.position.set(x, y, z);
          if (rotZ) m.rotation.z = rotZ;
          if (rotX) m.rotation.x = rotX;
          m.castShadow = true;
          g.add(m);
          GS.addOutline(m);
          return m;
        };
        const gx = s * W2;
        post(gx, GH / 2, -GW / 2, GH + 0.1, C.POST_R);
        post(gx, GH / 2, GW / 2, GH + 0.1, C.POST_R);
        post(gx, GH, 0, GW + 0.2, C.POST_R, 0, Math.PI / 2); // crossbar

        // back frame (thinner)
        const bx = s * (W2 + GD);
        const bk = (x, y, z, h, rotZ, rotX) => {
          const m = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, h, 6), frameMat);
          m.position.set(x, y, z);
          if (rotZ) m.rotation.z = rotZ;
          if (rotX) m.rotation.x = rotX;
          g.add(m);
        };
        bk(bx, 0.95, -GW / 2, 1.9);
        bk(bx, 0.95, GW / 2, 1.9);
        bk(bx, 1.9, 0, GW, 0, Math.PI / 2);
        bk(bx, 0.03, 0, GW, 0, Math.PI / 2);
        // diagonal struts crossbar->back top
        for (const sz of [-1, 1]) {
          const m = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, Math.sqrt(GD * GD + (GH - 1.9) * (GH - 1.9)) + 0.05, 6), frameMat);
          m.position.set(s * (W2 + GD / 2), (GH + 1.9) / 2, sz * GW / 2);
          m.rotation.z = s * Math.atan2(GD, GH - 1.9) * -1;
          g.add(m);
        }
        this.scene.add(g);
        this.nets.push(new GoalNet(this.scene, s));
      }
    }

    static toon() {
      if (!Stadium._toonTex) Stadium._toonTex = U.toonGradient([0.4, 0.72, 1.0]);
      return Stadium._toonTex;
    }

    _standsAndCrowd(homeTeam, awayTeam) {
      const c = (x, z) => Math.atan2(-z, -x); // inward-normal angle toward centre
      const SB = 1.3, SU = 0.62, BY = 1.4;
      // continuous bowl: 2 long stands, 2 end stands, 4 corner fillers
      const stands = [
        { fx: 0, fz: 25, ang: c(0, 25), len: 58, steps: 14, homeBias: 0.55, kind: 'long' },
        { fx: 0, fz: -25, ang: c(0, -25), len: 58, steps: 14, homeBias: 0.55, kind: 'long' },
        { fx: 38, fz: 0, ang: c(38, 0), len: 46, steps: 12, homeBias: 0.78, kind: 'end' },
        { fx: -38, fz: 0, ang: c(-38, 0), len: 46, steps: 12, homeBias: 0.2, kind: 'end' },
      ];
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        const fx = sx * 31, fz = sz * 22;
        stands.push({ fx, fz, ang: c(fx, fz), len: 30, steps: 12, homeBias: 0.5, kind: 'corner' });
      }
      stands.forEach(s => { s.stepBack = SB; s.stepUp = SU; s.baseY = BY; });

      const mats = {
        a: new THREE.MeshLambertMaterial({ color: 0x9aa6b5 }),
        b: new THREE.MeshLambertMaterial({ color: 0x77828f }),
        roof: new THREE.MeshLambertMaterial({ color: 0x394452 }),
        dark: new THREE.MeshLambertMaterial({ color: 0x20262f }),
        edge: new THREE.MeshToonMaterial({ color: 0x27e07f, gradientMap: Stadium.toon() }),
      };
      this._standMats = mats;
      for (const st of stands) this._buildStand(st, mats);

      this.crowd = buildCrowd(this.scene, stands, homeTeam.c1, awayTeam.c1);
    }

    _buildStand(st, m) {
      const g = new THREE.Group();
      const { len, steps, stepBack, stepUp, baseY } = st;
      const depth = steps * stepBack;
      // tiered terraces (local +z = outward/up, front at z=0, seats face -z)
      for (let i = 0; i < steps; i++) {
        const h = stepUp + i * stepUp;
        const slab = new THREE.Mesh(new THREE.BoxGeometry(len, h, stepBack + 0.03), i % 2 ? m.a : m.b);
        slab.position.set(0, baseY + h / 2, i * stepBack + stepBack / 2);
        slab.receiveShadow = true;
        g.add(slab);
      }
      // front facade + accent rail
      const facade = new THREE.Mesh(new THREE.BoxGeometry(len, baseY + 0.4, 0.5), m.b);
      facade.position.set(0, (baseY + 0.4) / 2, -0.25); g.add(facade);
      const rail = new THREE.Mesh(new THREE.BoxGeometry(len, 0.18, 0.16), m.edge);
      rail.position.set(0, baseY + 0.45, -0.3); g.add(rail);
      // back wall + vomitory entrances
      const wallH = baseY + steps * stepUp + 3.2;
      const wall = new THREE.Mesh(new THREE.BoxGeometry(len + 2, wallH, 1.0), m.b);
      wall.position.set(0, wallH / 2, depth + 0.5); g.add(wall);
      for (let k = -1; k <= 1; k += 2) {
        const vom = new THREE.Mesh(new THREE.BoxGeometry(3.2, 3.4, 0.7), m.dark);
        vom.position.set(k * len * 0.26, 1.9, depth * 0.55); g.add(vom);
      }
      // cantilever roof + bright leading edge + columns
      const roof = new THREE.Mesh(new THREE.BoxGeometry(len + 4, 0.5, depth + 5.5), m.roof);
      roof.position.set(0, wallH + 2.0, depth / 2 - 0.5); roof.rotation.x = -0.1; g.add(roof);
      const redge = new THREE.Mesh(new THREE.BoxGeometry(len + 4, 0.45, 0.5), m.edge);
      redge.position.set(0, wallH + 1.45, -1.9); g.add(redge);
      const underside = new THREE.Mesh(new THREE.BoxGeometry(len + 3, 0.2, depth + 4), m.dark);
      underside.position.set(0, wallH + 1.7, depth / 2 - 0.5); underside.rotation.x = -0.1; g.add(underside);
      for (let cI = -1; cI <= 1; cI++) {
        const col = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.34, wallH + 2, 8), m.b);
        col.position.set(cI * (len / 2 - 2), (wallH + 2) / 2, depth + 0.3); g.add(col);
      }
      g.position.set(st.fx, 0, st.fz);
      g.rotation.y = -st.ang - Math.PI / 2;
      this.scene.add(g);
      return g;
    }

    _jumbotron() {
      this.jumbos = [];
      const { canvas, ctx } = U.makeCanvas(512, 320);
      this.jumboCanvas = canvas; this.jumboCtx = ctx;
      this.jumboTex = new THREE.CanvasTexture(canvas);
      this.jumboTex.encoding = THREE.sRGBEncoding;
      this._jumboKey = '';
      const screenMat = new THREE.MeshBasicMaterial({ map: this.jumboTex });
      const frameMat = new THREE.MeshLambertMaterial({ color: 0x14181f });
      const trussMat = new THREE.MeshLambertMaterial({ color: 0x2a3038 });
      for (const sx of [-1, 1]) {
        const g = new THREE.Group();
        const frame = new THREE.Mesh(new THREE.BoxGeometry(13, 8.4, 0.8), frameMat);
        frame.position.y = 0; g.add(frame);
        const screen = new THREE.Mesh(new THREE.PlaneGeometry(12, 7.5), screenMat);
        screen.position.z = 0.45; g.add(screen);
        const back = new THREE.Mesh(new THREE.PlaneGeometry(12, 7.5), screenMat);
        back.position.z = -0.45; back.rotation.y = Math.PI; g.add(back);
        // gantry truss
        for (const tx of [-5.5, 5.5]) {
          const leg = new THREE.Mesh(new THREE.BoxGeometry(0.5, 18, 0.5), trussMat);
          leg.position.set(tx, -13, -0.6); g.add(leg);
        }
        const beam = new THREE.Mesh(new THREE.BoxGeometry(12, 0.5, 0.5), trussMat);
        beam.position.set(0, -4.4, -0.6); g.add(beam);
        g.position.set(sx * 47, 19, 0);
        g.rotation.y = sx > 0 ? -Math.PI / 2 : Math.PI / 2;
        this.scene.add(g);
        this.jumbos.push(g);
      }
    }

    _drawJumbo(abbrA, abbrB, a, b, cA, cB, clock) {
      const ctx = this.jumboCtx;
      ctx.fillStyle = '#070b14'; ctx.fillRect(0, 0, 512, 320);
      // pixel-grid LED feel
      ctx.fillStyle = 'rgba(255,255,255,0.02)';
      for (let y = 0; y < 320; y += 4) ctx.fillRect(0, y, 512, 1);
      // header
      ctx.fillStyle = '#27e07f';
      ctx.font = 'italic 900 34px "Arial Black", Arial, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('GOALSTORM', 256, 36);
      // score row
      ctx.fillStyle = cA; ctx.fillRect(40, 90, 150, 150);
      ctx.fillStyle = cB; ctx.fillRect(322, 90, 150, 150);
      ctx.fillStyle = '#ffffff';
      ctx.font = '900 44px "Arial Black", Arial, sans-serif';
      ctx.fillText(abbrA, 115, 120);
      ctx.fillText(abbrB, 397, 120);
      ctx.font = '900 110px "Arial Black", Arial, sans-serif';
      ctx.fillText(a, 115, 185);
      ctx.fillText(b, 397, 185);
      ctx.fillStyle = '#ffd23f';
      ctx.font = '900 40px "Consolas", monospace';
      ctx.fillText(clock || '00:00', 256, 165);
      // live tag
      ctx.fillStyle = '#ff4d6d';
      ctx.beginPath(); ctx.arc(210, 285, 9, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = '900 26px "Arial Black", Arial, sans-serif';
      ctx.fillText('LIVE', 256, 286);
      this.jumboTex.needsUpdate = true;
    }

    _tifo(homeTeam, awayTeam) {
      this.tifos = [];
      const mk = (team, word) => {
        const { canvas, ctx } = U.makeCanvas(256, 64);
        ctx.fillStyle = team.c1; ctx.fillRect(0, 0, 256, 64);
        ctx.fillStyle = team.c2; ctx.fillRect(0, 0, 256, 8); ctx.fillRect(0, 56, 256, 8);
        ctx.fillStyle = team.c2;
        ctx.font = 'italic 900 38px "Arial Black", Arial, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(word, 128, 34);
        const t = U.canvasTexture(canvas);
        const mat = new THREE.MeshBasicMaterial({ map: t, side: THREE.DoubleSide });
        mat.color.setScalar(0.9);
        return mat;
      };
      const place = (team, word, x, z, ry, count) => {
        const mat = mk(team, word);
        for (let i = 0; i < count; i++) {
          const banner = new THREE.Mesh(new THREE.PlaneGeometry(7, 1.7), mat);
          banner.position.set(x + (i - (count - 1) / 2) * 8.5 * Math.cos(ry), 2.6,
                              z + (i - (count - 1) / 2) * 8.5 * -Math.sin(ry));
          banner.rotation.y = ry;
          this.scene.add(banner);
          this.tifos.push({ mesh: banner, base: banner.position.y, ph: U.rand(0, 6) });
        }
      };
      place(homeTeam, 'ULTRAS', 0, 24.2, 0, 3);
      place(awayTeam, 'AWAY END', 37.2, 0, Math.PI / 2, 2);
    }

    _dugouts(homeTeam, awayTeam) {
      const mk = (team, x) => {
        const g = new THREE.Group();
        const roof = new THREE.Mesh(new THREE.BoxGeometry(7, 0.25, 2.6),
          new THREE.MeshToonMaterial({ color: U.shade(team.c1, 0.7), gradientMap: Stadium.toon() }));
        roof.position.set(0, 2.05, 0); roof.castShadow = true; g.add(roof);
        const back = new THREE.Mesh(new THREE.BoxGeometry(7, 2.0, 0.2),
          new THREE.MeshLambertMaterial({ color: 0x2a3038 }));
        back.position.set(0, 1.0, 1.2); g.add(back);
        for (const px of [-2.6, 2.6]) {
          const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 2.0, 6),
            new THREE.MeshLambertMaterial({ color: 0x394452 }));
          post.position.set(px, 1.0, -1.1); g.add(post);
        }
        const bench = new THREE.Mesh(new THREE.BoxGeometry(6.4, 0.4, 0.5),
          new THREE.MeshLambertMaterial({ color: 0x1b2026 }));
        bench.position.set(0, 0.5, 0.2); g.add(bench);
        // seated substitutes
        const jersey = new THREE.MeshToonMaterial({ color: team.c1, gradientMap: Stadium.toon() });
        for (let i = 0; i < 4; i++) {
          const sub = new THREE.Group();
          const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 0.45, 8), jersey);
          torso.position.y = 0.95; torso.castShadow = true; sub.add(torso);
          const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8),
            new THREE.MeshToonMaterial({ color: new THREE.Color(U.choice(GS.SKINS)), gradientMap: Stadium.toon() }));
          head.position.y = 1.32; sub.add(head);
          const legs = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.22, 0.5),
            new THREE.MeshToonMaterial({ color: team.short, gradientMap: Stadium.toon() }));
          legs.position.set(0, 0.62, 0.22); sub.add(legs);
          sub.position.set(-2.4 + i * 1.6, 0, 0.2);
          g.add(sub);
        }
        g.position.set(x, 0, 23.5);
        g.rotation.y = Math.PI; // face the pitch (-z)
        this.scene.add(g);
      };
      mk(homeTeam, -8);
      mk(awayTeam, 8);
    }

    _adBoards() {
      this.adMats = [];
      const mkTex = (idx) => {
        const [name, bg, fg] = BRANDS[idx % BRANDS.length];
        const { canvas, ctx } = U.makeCanvas(512, 56);
        ctx.fillStyle = bg; ctx.fillRect(0, 0, 512, 56);
        ctx.fillStyle = fg;
        ctx.font = 'italic 900 34px "Arial Black", Arial, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(name, 256, 30);
        // edge ticks for style
        ctx.fillRect(0, 0, 10, 56); ctx.fillRect(502, 0, 10, 56);
        return U.canvasTexture(canvas);
      };
      this.adTextures = BRANDS.map((b, i) => mkTex(i));

      const geoLong = new THREE.PlaneGeometry(8.6, 0.85);
      let bi = 0;
      const addBoard = (x, z, rotY) => {
        const mat = new THREE.MeshBasicMaterial({ map: this.adTextures[bi % BRANDS.length] });
        mat.color.setScalar(0.82); // tame brightness under tone mapping
        const m = new THREE.Mesh(geoLong, mat);
        m.position.set(x, 0.46, z);
        m.rotation.y = rotY;
        this.scene.add(m);
        // backing
        const back = new THREE.Mesh(geoLong, new THREE.MeshLambertMaterial({ color: 0x222a33 }));
        back.position.set(x, 0.46, z);
        back.rotation.y = rotY + Math.PI;
        this.scene.add(back);
        this.adMats.push({ mat, idx: bi });
        bi++;
      };
      const H2 = C.PITCH_H / 2, W2 = C.PITCH_W / 2;
      for (let i = 0; i < 7; i++) {
        const x = -27 + i * 9;
        addBoard(x, -(H2 + 2.4), 0);
        addBoard(x, (H2 + 2.4), Math.PI);
      }
      for (let i = 0; i < 4; i++) {
        const z = -13.5 + i * 9;
        addBoard(-(W2 + 2.6), z, Math.PI / 2);
        addBoard((W2 + 2.6), z, -Math.PI / 2);
      }
    }

    _floodlights() {
      this.flGlows = [];
      const poleMat = new THREE.MeshLambertMaterial({ color: 0x8a95a3 });
      const headMat = new THREE.MeshLambertMaterial({ color: 0x39414c });
      const lampMat = new THREE.MeshBasicMaterial({ color: 0xfff8e0 });
      const glowTex = U.glowTexture('rgba(255,250,225,0.9)', 'rgba(255,236,170,0.32)');
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        const g = new THREE.Group();
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.7, 30, 8), poleMat);
        pole.position.y = 15;
        g.add(pole);
        const head = new THREE.Mesh(new THREE.BoxGeometry(5.4, 3.2, 0.8), headMat);
        head.position.y = 31;
        g.add(head);
        for (let i = 0; i < 8; i++) {
          const lamp = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), lampMat);
          lamp.position.set(-2 + (i % 4) * 1.34, 30.4 + Math.floor(i / 4) * 1.4, 0.45);
          g.add(lamp);
        }
        g.position.set(sx * 50, 0, sz * 36);
        g.lookAt(0, 14, 0);
        this.scene.add(g);

        const spr = new THREE.Sprite(new THREE.SpriteMaterial({
          map: glowTex, blending: THREE.AdditiveBlending, depthWrite: false,
          transparent: true, opacity: 0.8,
        }));
        spr.position.set(sx * 50 - sx * 1.2, 31, sz * 36 - sz * 1.2);
        spr.scale.set(9, 7, 1);
        this.scene.add(spr);
        this.flGlows.push(spr);
      }
    }

    _blimp() {
      const g = new THREE.Group();
      const body = new THREE.Mesh(
        new THREE.SphereGeometry(1, 20, 14),
        new THREE.MeshToonMaterial({ color: 0xe8edf4, gradientMap: Stadium.toon() })
      );
      body.scale.set(9, 2.6, 2.6);
      g.add(body);
      const finMat = new THREE.MeshLambertMaterial({ color: 0xd92332 });
      for (const rot of [0, Math.PI / 2]) {
        const fin = new THREE.Mesh(new THREE.BoxGeometry(2.6, 2.6, 0.18), finMat);
        fin.position.x = -8;
        fin.rotation.x = rot;
        g.add(fin);
      }
      const gond = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.9, 1), new THREE.MeshLambertMaterial({ color: 0x39414c }));
      gond.position.y = -2.7;
      g.add(gond);
      // banner
      const { canvas, ctx } = U.makeCanvas(512, 96);
      ctx.fillStyle = '#0d1a2a'; ctx.fillRect(0, 0, 512, 96);
      ctx.fillStyle = '#27e07f';
      ctx.font = 'italic 900 56px "Arial Black", Arial, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('GOALSTORM LIVE', 256, 50);
      const btex = U.canvasTexture(canvas);
      const banner = new THREE.Mesh(new THREE.PlaneGeometry(10, 1.9),
        new THREE.MeshBasicMaterial({ map: btex, side: THREE.DoubleSide }));
      banner.material.color.setScalar(0.85);
      banner.position.y = 0.2;
      g.add(banner);
      this.blimp = g;
      this.blimpAng = Math.random() * Math.PI * 2;
      this.scene.add(g);
    }

    _scenery() {
      // mountain ring
      const mats = [
        new THREE.MeshLambertMaterial({ color: 0x4d6b73 }),
        new THREE.MeshLambertMaterial({ color: 0x5d7a6b }),
        new THREE.MeshLambertMaterial({ color: 0x42596b }),
      ];
      for (let i = 0; i < 24; i++) {
        const ang = (i / 24) * Math.PI * 2 + U.rand(-0.1, 0.1);
        const r = U.rand(300, 430);
        const h = U.rand(34, 95);
        const m = new THREE.Mesh(new THREE.ConeGeometry(U.rand(40, 90), h, 5), U.choice(mats));
        m.position.set(Math.cos(ang) * r, h / 2 - 4, Math.sin(ang) * r);
        m.rotation.y = U.rand(0, Math.PI);
        this.scene.add(m);
      }
      // city blocks on one side
      const cityMat = new THREE.MeshLambertMaterial({ color: 0x5a6b80 });
      const cityMat2 = new THREE.MeshLambertMaterial({ color: 0x6e7f95 });
      for (let i = 0; i < 14; i++) {
        const w = U.rand(8, 18), h = U.rand(18, 52);
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, w), i % 2 ? cityMat : cityMat2);
        const ang = U.rand(-0.7, 0.7) + Math.PI * 0.5;
        const r = U.rand(200, 320);
        m.position.set(Math.cos(ang) * r, h / 2, Math.sin(ang) * r);
        this.scene.add(m);
      }
      // simple trees near the arena
      const trunkMat = new THREE.MeshLambertMaterial({ color: 0x5a3a1e });
      const leafMat = new THREE.MeshToonMaterial({ color: 0x2f7a35, gradientMap: Stadium.toon() });
      for (let i = 0; i < 14; i++) {
        const ang = U.rand(0, Math.PI * 2);
        const r = U.rand(85, 130);
        const g = new THREE.Group();
        const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.7, 5, 6), trunkMat);
        trunk.position.y = 2.5;
        g.add(trunk);
        const s = U.rand(2.6, 4.4);
        const leaf = new THREE.Mesh(new THREE.IcosahedronGeometry(s, 0), leafMat);
        leaf.position.y = 5 + s * 0.7;
        g.add(leaf);
        g.position.set(Math.cos(ang) * r, 0, Math.sin(ang) * r);
        this.scene.add(g);
      }
    }

    _flags() {
      const W2 = C.PITCH_W / 2, H2 = C.PITCH_H / 2;
      const poleMat = new THREE.MeshLambertMaterial({ color: 0xe8edf4 });
      const flagMat = new THREE.MeshBasicMaterial({ color: 0xffd23f, side: THREE.DoubleSide });
      this.flagMeshes = [];
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1.7, 6), poleMat);
        pole.position.set(sx * W2, 0.85, sz * H2);
        this.scene.add(pole);
        const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.38), flagMat);
        flag.position.set(sx * W2 + 0.3, 1.5, sz * H2);
        this.scene.add(flag);
        this.flagMeshes.push(flag);
      }
    }

    netImpulse(side, point, dir, power) {
      const net = this.nets[side > 0 ? 1 : 0];
      net.impulse(point, dir, power);
    }

    setExcitement(e) {
      this.crowd.mat.uniforms.uExcite.value = e;
    }

    update(dt) {
      this.t += dt;
      this.sky.update(dt);
      this.crowd.mat.uniforms.uTime.value = this.t;
      for (const n of this.nets) n.update(dt);

      // blimp orbit
      this.blimpAng += dt * 0.022;
      const ba = this.blimpAng;
      this.blimp.position.set(Math.cos(ba) * 120, 58 + Math.sin(this.t * 0.3) * 2, Math.sin(ba) * 120);
      this.blimp.rotation.y = -ba - Math.PI / 2;

      // flag flutter
      for (let i = 0; i < this.flagMeshes.length; i++) {
        this.flagMeshes[i].rotation.y = Math.sin(this.t * 5 + i * 1.7) * 0.4;
      }

      // tifo sway
      if (this.tifos) for (const tf of this.tifos) {
        tf.mesh.position.y = tf.base + Math.sin(this.t * 1.6 + tf.ph) * 0.12;
        tf.mesh.rotation.z = Math.sin(this.t * 1.2 + tf.ph) * 0.04;
      }

      // live jumbotron (only redraw when the displayed values change)
      if (this.jumboCtx && GS.MATCH) {
        const m = GS.MATCH;
        const clock = (document.getElementById('sb-clock') || {}).textContent || '00:00';
        const key = m.teams[0].score + '|' + m.teams[1].score + '|' + clock;
        if (key !== this._jumboKey) {
          this._jumboKey = key;
          this._drawJumbo(this.homeTeam.abbr, this.awayTeam.abbr,
            String(m.teams[0].score), String(m.teams[1].score),
            this.homeTeam.c1, this.awayTeam.c1, clock);
        }
      }

      // ad rotation
      this.adTimer -= dt;
      if (this.adTimer <= 0) {
        this.adTimer = 11;
        this.adOffset++;
        for (const a of this.adMats) {
          a.mat.map = this.adTextures[(a.idx + this.adOffset) % this.adTextures.length];
          a.mat.needsUpdate = true;
        }
      }
      // floodlight glow pulse
      for (let i = 0; i < this.flGlows.length; i++) {
        const s = 8.6 + Math.sin(this.t * 2.4 + i * 2.1) * 0.5;
        this.flGlows[i].scale.set(s, s * 0.78, 1);
      }
    }
  }

  GS.Stadium = Stadium;
})();
