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
  function buildCrowd(scene, stands, homeColor, awayColor) {
    const positions = [], colors = [], heads = [], phases = [], amps = [];
    const homeC = new THREE.Color(homeColor), awayC = new THREE.Color(awayColor);
    const neutrals = ['#e8e8e8', '#d9c46a', '#7a8aa0', '#4a4a55', '#c46a6a', '#6ac4a0'].map(c => new THREE.Color(c));
    const skins = GS.SKINS.map(c => new THREE.Color(c));
    const tmp = new THREE.Color();

    for (const st of stands) {
      for (let step = 0; step < st.steps; step++) {
        const t = step / (st.steps - 1);
        const y = st.baseY + step * st.stepH + 0.95;
        const off = st.baseOff + step * st.stepD + st.stepD * 0.4;
        const n = Math.floor(st.len / 0.95);
        for (let i = 0; i < n; i++) {
          if (Math.random() < 0.12) continue; // empty seats
          const along = -st.len / 2 + (i + 0.5) * (st.len / n) + U.rand(-0.18, 0.18);
          let x, z;
          if (st.axis === 'z') { x = along; z = st.dir * off; }
          else { x = st.dir * off; z = along; }
          positions.push(x, y + U.rand(-0.05, 0.08), z);
          const r = Math.random();
          if (r < st.homeBias) tmp.copy(homeC).offsetHSL(U.rand(-0.02, 0.02), U.rand(-0.1, 0.1), U.rand(-0.14, 0.1));
          else if (r < st.homeBias + 0.18) tmp.copy(awayC).offsetHSL(0, 0, U.rand(-0.12, 0.08));
          else tmp.copy(U.choice(neutrals)).offsetHSL(0, 0, U.rand(-0.1, 0.1));
          colors.push(tmp.r, tmp.g, tmp.b);
          const sk = U.choice(skins);
          heads.push(sk.r, sk.g, sk.b);
          phases.push(U.rand(0, Math.PI * 2));
          amps.push(U.rand(0.4, 1));
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('aColor', new THREE.Float32BufferAttribute(colors, 3));
    geo.setAttribute('aHead', new THREE.Float32BufferAttribute(heads, 3));
    geo.setAttribute('aPhase', new THREE.Float32BufferAttribute(phases, 1));
    geo.setAttribute('aAmp', new THREE.Float32BufferAttribute(amps, 1));

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uExcite: { value: 0.15 },
        uScale: { value: 1 },
      },
      vertexShader: `
        attribute vec3 aColor;
        attribute vec3 aHead;
        attribute float aPhase;
        attribute float aAmp;
        uniform float uTime;
        uniform float uExcite;
        uniform float uScale;
        varying vec3 vColor;
        varying vec3 vHead;
        void main(){
          vColor = aColor;
          vHead = aHead;
          vec3 p = position;
          float speed = 2.2 + uExcite * 9.0;
          float bounce = max(0.0, sin(uTime * speed + aPhase));
          p.y += bounce * aAmp * (0.05 + uExcite * 0.55);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = uScale * 1100.0 / max(1.0, -mv.z);
        }`,
      fragmentShader: `
        varying vec3 vColor;
        varying vec3 vHead;
        void main(){
          vec2 q = gl_PointCoord;
          // head
          float dh = length((q - vec2(0.5, 0.24)) * vec2(1.0, 1.0));
          // body (rounded shoulders)
          float db = length((q - vec2(0.5, 0.72)) * vec2(1.15, 0.85));
          if (dh < 0.16) {
            gl_FragColor = vec4(vHead * (q.y < 0.20 ? 0.55 : 1.0), 1.0);
          } else if (db < 0.34 && q.y > 0.34) {
            float sh = 1.0 - (q.y - 0.34) * 0.5;
            gl_FragColor = vec4(vColor * sh, 1.0);
          } else discard;
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

      scene.fog = new THREE.Fog(0xcfe0ee, 170, 520);
      this.sky = GS.createSky(scene);
      this._lights();
      this._ground();
      this._goals();
      this._standsAndCrowd(homeTeam, awayTeam);
      this._adBoards();
      this._floodlights();
      this._blimp();
      this._scenery();
      this._flags();
    }

    _lights() {
      const sunDir = GS.SUN_DIR;
      const hemi = new THREE.HemisphereLight(0xbfd9ff, 0x3f7a3f, 0.62);
      this.scene.add(hemi);

      const sun = new THREE.DirectionalLight(0xfff1d2, 1.32);
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

      const fill = new THREE.DirectionalLight(0x8eb8e8, 0.28);
      fill.position.set(-sunDir.x * 100, 60, -sunDir.z * 100);
      this.scene.add(fill);

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
          const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 10), postMat);
          m.position.set(x, y, z);
          if (rotZ) m.rotation.z = rotZ;
          if (rotX) m.rotation.x = rotX;
          m.castShadow = true;
          g.add(m);
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
      if (!Stadium._toonTex) Stadium._toonTex = U.toonGradient([0.42, 0.66, 0.88, 1]);
      return Stadium._toonTex;
    }

    _standsAndCrowd(homeTeam, awayTeam) {
      const stands = [
        // long sides
        { axis: 'z', dir: -1, baseOff: 33, len: 86, steps: 11, stepD: 1.25, stepH: 0.6, baseY: 1.4, homeBias: 0.55 },
        { axis: 'z', dir: 1, baseOff: 33, len: 86, steps: 11, stepD: 1.25, stepH: 0.6, baseY: 1.4, homeBias: 0.55 },
        // behind goals
        { axis: 'x', dir: -1, baseOff: 47, len: 56, steps: 9, stepD: 1.25, stepH: 0.6, baseY: 1.4, homeBias: 0.75 },
        { axis: 'x', dir: 1, baseOff: 47, len: 56, steps: 9, stepD: 1.25, stepH: 0.6, baseY: 1.4, homeBias: 0.2 },
      ];
      const conMat = new THREE.MeshLambertMaterial({ color: 0x9aa6b5 });
      const conMatDark = new THREE.MeshLambertMaterial({ color: 0x77828f });
      const roofMat = new THREE.MeshLambertMaterial({ color: 0x3b4754 });

      for (const st of stands) {
        const group = new THREE.Group();
        const depth = st.steps * st.stepD;
        // stepped terraces as a few merged slabs for simplicity
        for (let i = 0; i < st.steps; i++) {
          const w = st.axis === 'z' ? st.len : st.stepD;
          const d = st.axis === 'z' ? st.stepD : st.len;
          const slab = new THREE.Mesh(new THREE.BoxGeometry(
            st.axis === 'z' ? st.len : st.stepD, st.stepH + i * st.stepH, st.axis === 'z' ? st.stepD : st.len
          ), i % 2 ? conMat : conMatDark);
          const off = st.baseOff + i * st.stepD + st.stepD / 2;
          const y = st.baseY + (st.stepH + i * st.stepH) / 2;
          if (st.axis === 'z') slab.position.set(0, y, st.dir * off);
          else slab.position.set(st.dir * off, y, 0);
          group.add(slab);
        }
        // back wall
        const wallH = st.baseY + st.steps * st.stepH + 2.5;
        const wall = new THREE.Mesh(new THREE.BoxGeometry(
          st.axis === 'z' ? st.len + 2 : 1.2, wallH, st.axis === 'z' ? 1.2 : st.len + 2
        ), conMatDark);
        const woff = st.baseOff + depth + 0.6;
        if (st.axis === 'z') wall.position.set(0, wallH / 2, st.dir * woff);
        else wall.position.set(st.dir * woff, wallH / 2, 0);
        group.add(wall);

        // roof
        const roofW = st.axis === 'z' ? st.len + 4 : depth + 5;
        const roofD = st.axis === 'z' ? depth + 5 : st.len + 4;
        const roof = new THREE.Mesh(new THREE.BoxGeometry(roofW, 0.5, roofD), roofMat);
        const roofOff = st.baseOff + depth / 2 + 1;
        const roofY = wallH + 2.2;
        if (st.axis === 'z') { roof.position.set(0, roofY, st.dir * roofOff); roof.rotation.x = st.dir * 0.1; }
        else { roof.position.set(st.dir * roofOff, roofY, 0); roof.rotation.z = -st.dir * 0.1; }
        group.add(roof);

        // roof support columns
        for (let i = -1; i <= 1; i++) {
          const col = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, roofY, 8), conMatDark);
          const along = i * ((st.axis === 'z' ? st.len : st.len) / 2 - 4);
          if (st.axis === 'z') col.position.set(along, roofY / 2, st.dir * (st.baseOff + depth + 1));
          else col.position.set(st.dir * (st.baseOff + depth + 1), roofY / 2, along);
          group.add(col);
        }
        this.scene.add(group);
      }

      this.crowd = buildCrowd(this.scene, stands, homeTeam.c1, awayTeam.c1);
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
