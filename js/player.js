/* GOALSTORM — player.js
 * Articulated toon footballer with a hand-authored run cycle.
 *
 * Skeleton (every joint is a pivot Group so rotations happen at the joint):
 *   root(yaw=facing) -> hips(pelvis: bob/lean/roll/yaw)
 *     -> spine(chest: counter-yaw + forward lean)
 *          -> neck -> headPivot(head, hair, face)
 *          -> shoulderL/R -> elbowL/R -> hand
 *     -> hipL/R -> kneeL/R -> ankleL/R -> foot
 *
 * The run cycle is built from per-joint keyframe tables (contralateral arm/leg
 * swing, hip drop, pelvis + spine counter-rotation, knee flexion, ankle roll,
 * cadence locked to ground speed to kill foot-sliding). Also: idle breathing,
 * a wind-up/strike kick, slide tackle, fall + get-up, three celebrations.
 */
window.GS = window.GS || {};
(function () {
  'use strict';
  const U = GS.U, C = GS.CFG;
  const PI = Math.PI, TAU = PI * 2;

  let TOON = null;
  function toon() { if (!TOON) TOON = U.toonGradient([0.42, 0.74, 1.0]); return TOON; }

  // ---- per-team kit material cache ----
  const KIT_CACHE = {};
  function teamKit(team, isGK) {
    const key = team.abbr + (isGK ? '_gk' : '');
    if (KIT_CACHE[key]) return KIT_CACHE[key];
    const jc = isGK ? team.gk : team.c1;
    const mk = (col) => new THREE.MeshToonMaterial({ color: new THREE.Color(col), gradientMap: toon() });
    const kit = {
      jersey: mk(jc),
      jerseyTrim: mk(team.c2),
      shorts: mk(isGK ? U.shade(team.gk, 0.5) : team.short),
      shortsTrim: mk(team.c2),
      socks: mk(jc),
      sockTrim: mk(team.c2),
      shoe: mk('#181a20'),
    };
    KIT_CACHE[key] = kit;
    return kit;
  }

  function numberTexture(num, bg, fg) {
    const { canvas, ctx } = U.makeCanvas(64, 64);
    ctx.clearRect(0, 0, 64, 64);
    ctx.fillStyle = fg;
    ctx.font = '900 46px "Arial Black", Arial, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(num), 32, 34);
    const t = new THREE.CanvasTexture(canvas);
    t.encoding = THREE.sRGBEncoding;
    return t;
  }

  // ---- keyframe sampler (cyclic, smoothstep interpolation) ----
  function sampleKF(tbl, t) {
    t -= Math.floor(t);
    const n = tbl.length;
    let i0 = n - 1;
    for (let i = 0; i < n; i++) { if (t >= tbl[i][0]) i0 = i; else break; }
    const i1 = (i0 + 1) % n;
    let t0 = tbl[i0][0], t1 = tbl[i1][0];
    if (t1 <= t0) t1 += 1;
    let tt = t; if (tt < t0) tt += 1;
    let seg = (t1 - t0) ? (tt - t0) / (t1 - t0) : 0;
    seg = U.clamp(seg, 0, 1);
    const s = seg * seg * (3 - 2 * seg);
    return U.lerp(tbl[i0][1], tbl[i1][1], s);
  }

  // Run cycle keyframes. Convention: forward = local +z. For x-rotations,
  // forward tilt = NEGATIVE rotation.x, so tables are authored "forward
  // positive" and negated on apply. Knee flexion bends the shin back = +x.
  // lp = local phase, 0 = foot strike.
  const RUN = {
    hip:   [[0.00, 0.62], [0.16, 0.18], [0.32, -0.34], [0.46, -0.52], [0.62, 0.10], [0.78, 0.55], [0.92, 0.70]],
    knee:  [[0.00, 0.22], [0.12, 0.62], [0.30, 0.30], [0.45, 0.16], [0.55, 1.25], [0.70, 1.55], [0.84, 0.55], [0.95, 0.14]],
    ankle: [[0.00, 0.10], [0.22, -0.18], [0.44, 0.55], [0.60, -0.32], [0.85, -0.05]],
  };

  // ---- limb segment helper (tapered, rounded bottom) ----
  function limbMesh(parent, topR, botR, len, mat, outline) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(topR, botR, len, 10), mat);
    m.position.y = -len / 2; m.castShadow = true;
    parent.add(m);
    if (outline) GS.addOutline(m);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(botR * 1.02, 10, 7), mat);
    cap.position.y = -len; cap.castShadow = true;
    parent.add(cap);
    return m;
  }
  function joint(parent, x, y, z) {
    const g = new THREE.Group(); g.position.set(x, y, z); parent.add(g); return g;
  }

  class Player {
    constructor(scene, opts) {
      this.scene = scene;
      this.team = opts.team;
      this.teamId = opts.teamId;
      this.attackDir = opts.attackDir;
      this.isGK = !!opts.isGK;
      this.role = opts.role || 'MID';
      this.number = opts.number;
      this.name = opts.name;
      this.home = { x: opts.homeX, z: opts.homeZ };
      this.formation = { x: opts.homeX, z: opts.homeZ };

      this.pos = new THREE.Vector3(opts.homeX, 0, opts.homeZ);
      this.vel = new THREE.Vector3();
      this.facing = this.attackDir > 0 ? 0 : PI;
      this.input = { x: 0, z: 0, sprint: false };
      this.maxSpeed = (this.isGK ? 7.6 : 8.7) * (opts.speedMul || 1);
      this.accel = 62;          // m/s^2 toward desired velocity (snappy arcade)
      this.decel = 50;          // m/s^2 friction when no input
      this.speedFrac = 0;
      this.attr = opts.attr || { speed: 1, react: 0.12, shootAcc: 0.85, pass: 0.9 };

      // animation/action state
      this.runCycle = Math.random();
      this.idlePhase = Math.random() * TAU;
      this.kickTimer = 0; this.kickDur = 0.36; this.kickLeg = 1; this.kickPower = 0;
      this.slideTimer = 0; this.slideMax = 0.7; this.slideDir = new THREE.Vector3();
      this.celebrateTimer = 0; this.celebrateType = 0;
      this.stunTimer = 0;
      this.fallTimer = 0; this.fallMax = 1.6; this.fallDir = new THREE.Vector3(1, 0, 0);
      this.hasBall = false;
      this.boost = null; this.boostTimer = 0;

      // smoothed pose accumulators (for graceful blends)
      this._lean = 0;

      this._buildModel();
    }

    get _skin() { if (!this.__skin) this.__skin = U.choice(GS.SKINS); return this.__skin; }
    get _hair() { if (!this.__hair) this.__hair = U.choice(GS.HAIRS); return this.__hair; }

    _buildModel() {
      const kit = teamKit(this.team, this.isGK);
      this.kit = kit;
      const skinMat = new THREE.MeshToonMaterial({ color: new THREE.Color(this._skin), gradientMap: toon() });
      const hairMat = new THREE.MeshToonMaterial({ color: new THREE.Color(this._hair), gradientMap: toon() });
      this._skinMat = skinMat;

      const root = new THREE.Group();
      this.root = root;
      const J = this.J = {};

      // ---------- pelvis / hips ----------
      const hips = joint(root, 0, 0.92, 0);
      J.hips = hips;
      const pelvis = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.17, 0.2, 12), kit.shorts);
      pelvis.scale.set(1.25, 1, 0.85);
      pelvis.castShadow = true;
      hips.add(pelvis); GS.addOutline(pelvis);
      // shorts hem flares over thighs
      const hem = new THREE.Mesh(new THREE.CylinderGeometry(0.21, 0.27, 0.16, 12), kit.shorts);
      hem.scale.set(1.18, 1, 0.85); hem.position.y = -0.12; hem.castShadow = true;
      hips.add(hem); GS.addOutline(hem);
      const hemTrim = new THREE.Mesh(new THREE.CylinderGeometry(0.275, 0.265, 0.03, 12), kit.shortsTrim);
      hemTrim.scale.set(1.18, 1, 0.85); hemTrim.position.y = -0.19;
      hips.add(hemTrim);

      // ---------- spine / chest ----------
      const spine = joint(hips, 0, 0.16, 0);
      J.spine = spine;
      const chest = new THREE.Mesh(new THREE.CylinderGeometry(0.29, 0.21, 0.46, 14), kit.jersey);
      chest.scale.set(1.12, 1, 0.82);
      chest.position.y = 0.21; chest.castShadow = true;
      spine.add(chest); GS.addOutline(chest);
      // chest taper to shoulders (deltoid yoke)
      const yoke = new THREE.Mesh(new THREE.SphereGeometry(0.3, 14, 10, 0, TAU, 0, PI * 0.55), kit.jersey);
      yoke.scale.set(1.15, 0.7, 0.85); yoke.position.y = 0.4; yoke.castShadow = true;
      spine.add(yoke); GS.addOutline(yoke);
      // collar trim
      const collar = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.028, 8, 16), kit.jerseyTrim);
      collar.rotation.x = PI / 2; collar.position.y = 0.46; collar.scale.set(1, 0.8, 1);
      spine.add(collar);
      // chest stripe
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.46, 0.18), kit.jerseyTrim);
      stripe.position.set(0, 0.21, 0.16);
      spine.add(stripe);
      // back number
      const numTex = numberTexture(this.number, this.team.c1, this.team.c2);
      const numPlane = new THREE.Mesh(new THREE.PlaneGeometry(0.32, 0.32),
        new THREE.MeshBasicMaterial({ map: numTex, transparent: true }));
      numPlane.position.set(0, 0.26, -0.19); numPlane.rotation.y = PI;
      numPlane.scale.set(1, 1, 1);
      spine.add(numPlane);

      // ---------- neck + head ----------
      const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.09, 0.12, 10), skinMat);
      neck.position.y = 0.49; spine.add(neck);
      const headPivot = joint(spine, 0, 0.56, 0);
      J.head = headPivot;
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 18, 14), skinMat);
      head.scale.set(0.98, 1.12, 1.0); head.castShadow = true;
      headPivot.add(head); GS.addOutline(head);
      // jaw/chin
      const jaw = new THREE.Mesh(new THREE.SphereGeometry(0.14, 12, 9), skinMat);
      jaw.position.set(0, -0.1, 0.05); jaw.scale.set(0.9, 0.8, 0.95);
      headPivot.add(jaw);
      // hair
      const hair = new THREE.Mesh(new THREE.SphereGeometry(0.208, 16, 12, 0, TAU, 0, PI * 0.62), hairMat);
      hair.position.y = 0.03; hair.scale.set(1.06, 1.14, 1.08); hair.castShadow = true;
      headPivot.add(hair); GS.addOutline(hair);
      this._addFace(headPivot, skinMat);

      // ---------- arms ----------
      this._buildArm(spine, J, 'L', -1, kit, skinMat);
      this._buildArm(spine, J, 'R', 1, kit, skinMat);

      // ---------- legs ----------
      this._buildLeg(hips, J, 'L', -1, kit, skinMat);
      this._buildLeg(hips, J, 'R', 1, kit, skinMat);

      // GK keeps gloves
      if (this.isGK) {
        const gloveMat = new THREE.MeshToonMaterial({ color: new THREE.Color(this.team.c2), gradientMap: toon() });
        for (const s of ['L', 'R']) {
          const g = new THREE.Mesh(new THREE.SphereGeometry(0.075, 10, 8), gloveMat);
          g.scale.set(1.3, 1.3, 0.85); g.position.y = -0.02;
          J['hand' + s].add(g); GS.addOutline(g);
        }
      }

      // selection ring (real directional sun shadow handles grounding)
      this.contactShadow = null;
      const ring = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.6),
        new THREE.MeshBasicMaterial({ map: ringTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      ring.rotation.x = -PI / 2; ring.position.y = 0.05; ring.visible = false;
      root.add(ring); this.selRing = ring;

      root.position.copy(this.pos);
      this.scene.add(root);
    }

    _addFace(headPivot, skinMat) {
      const white = new THREE.MeshBasicMaterial({ color: 0xf4f4f4 });
      const dark = new THREE.MeshBasicMaterial({ color: 0x1a1d24 });
      for (const sx of [-1, 1]) {
        const eye = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 6), white);
        eye.position.set(sx * 0.07, 0.02, 0.185); eye.scale.set(1, 1.2, 0.6);
        headPivot.add(eye);
        const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.022, 6, 6), dark);
        pupil.position.set(sx * 0.07, 0.02, 0.21);
        headPivot.add(pupil);
        const brow = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.018, 0.02),
          new THREE.MeshBasicMaterial({ color: new THREE.Color(this._hair) }));
        brow.position.set(sx * 0.07, 0.075, 0.19); brow.rotation.z = sx * -0.15;
        headPivot.add(brow);
      }
      const nose = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.06, 6), skinMat);
      nose.rotation.x = PI / 2; nose.position.set(0, -0.02, 0.21);
      headPivot.add(nose);
    }

    _buildArm(spine, J, side, sx, kit, skinMat) {
      const sh = joint(spine, sx * 0.27, 0.4, 0);
      J['sh' + side] = sh;
      // short sleeve
      const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.075, 0.16, 10), kit.jersey);
      sleeve.position.y = -0.06; sleeve.castShadow = true;
      sh.add(sleeve); GS.addOutline(sleeve);
      const sleeveTrim = new THREE.Mesh(new THREE.CylinderGeometry(0.078, 0.074, 0.025, 10), kit.jerseyTrim);
      sleeveTrim.position.y = -0.145; sh.add(sleeveTrim);
      // upper arm (skin)
      limbMesh(sh, 0.062, 0.052, 0.27, skinMat, true);
      const el = joint(sh, 0, -0.27, 0);
      J['el' + side] = el;
      limbMesh(el, 0.05, 0.045, 0.25, skinMat, true);
      const hand = joint(el, 0, -0.25, 0);
      J['hand' + side] = hand;
      const handMesh = new THREE.Mesh(new THREE.SphereGeometry(0.058, 10, 8), skinMat);
      handMesh.scale.set(0.85, 1.1, 0.6); handMesh.castShadow = true;
      hand.add(handMesh); GS.addOutline(handMesh);
    }

    _buildLeg(hips, J, side, sx, kit, skinMat) {
      const hp = joint(hips, sx * 0.12, -0.14, 0);
      J['hip' + side] = hp;
      // thigh (skin, below shorts)
      limbMesh(hp, 0.1, 0.082, 0.44, skinMat, true);
      const kn = joint(hp, 0, -0.44, 0);
      J['knee' + side] = kn;
      // shin with sock
      limbMesh(kn, 0.084, 0.066, 0.42, kit.socks, true);
      const sockTop = new THREE.Mesh(new THREE.CylinderGeometry(0.088, 0.084, 0.04, 10), kit.sockTrim);
      sockTop.position.y = -0.06; kn.add(sockTop);
      const ank = joint(kn, 0, -0.42, 0);
      J['ankle' + side] = ank;
      // boot: heel block + toe
      const boot = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.1, 0.26), kit.shoe);
      boot.position.set(0, -0.03, 0.06); boot.castShadow = true;
      ank.add(boot); GS.addOutline(boot);
      const toe = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), kit.shoe);
      toe.scale.set(0.9, 0.7, 1.2); toe.position.set(0, -0.05, 0.2); toe.castShadow = true;
      ank.add(toe); GS.addOutline(toe);
      const sole = new THREE.Mesh(new THREE.BoxGeometry(0.135, 0.03, 0.3), kit.jerseyTrim);
      sole.position.set(0, -0.085, 0.07); ank.add(sole);
    }

    setSelected(on, color) { this.selRing.visible = on; if (on && color) this.selRing.material.color.set(color); }

    playKick(power, leg) {
      this.kickTimer = this.kickDur;
      this.kickLeg = leg != null ? leg : (Math.random() < 0.5 ? 1 : -1);
      this.kickPower = U.clamp(power || 0.5, 0, 1);
    }
    playSlide(dir) {
      if (this.fallTimer > 0) return;
      this.slideTimer = this.slideMax;
      this.slideDir.copy(dir).normalize();
      this.vel.addScaledVector(this.slideDir, 9.5);
    }
    celebrate(type) { this.celebrateTimer = 3.2; this.celebrateType = type != null ? type : U.randInt(0, 2); }
    stun(t) { this.stunTimer = Math.max(this.stunTimer, t); }
    knockDown(dir, power) {
      if (this.fallTimer > 0) return;
      this.fallTimer = this.fallMax;
      if (dir) this.fallDir.copy(dir).setY(0).normalize();
      this.slideTimer = 0;
      this.vel.addScaledVector(this.fallDir, power || 4);
    }
    setBoost(type, dur) { this.boost = type; this.boostTimer = dur; }

    // ---------------- physics ----------------
    update(dt, bounds) {
      if (this.kickTimer > 0) this.kickTimer -= dt;
      if (this.celebrateTimer > 0) this.celebrateTimer -= dt;
      if (this.stunTimer > 0) this.stunTimer -= dt;
      if (this.fallTimer > 0) this.fallTimer -= dt;
      if (this.boostTimer > 0) { this.boostTimer -= dt; if (this.boostTimer <= 0) this.boost = null; }
      const sliding = this.slideTimer > 0;
      if (sliding) this.slideTimer -= dt;

      const disabled = this.fallTimer > 0 || this.stunTimer > 0 || this.celebrateTimer > 0;
      const sprinting = this.input.sprint && !sliding && !disabled;
      let speed = this.maxSpeed * (sprinting ? 1.34 : 1);
      if (this.boost === 'sprint') speed *= 1.3;
      if (this.hasBall) speed *= 0.9;

      // desired velocity
      let dvx = 0, dvz = 0, hasInput = false;
      if (!sliding && !disabled) {
        dvx = this.input.x * speed; dvz = this.input.z * speed;
        hasInput = (this.input.x || this.input.z);
      }

      if (sliding) {
        // momentum decays through the slide
        const fr = Math.exp(-2.6 * dt);
        this.vel.x *= fr; this.vel.z *= fr;
      } else if (disabled) {
        const fr = Math.exp(-(this.fallTimer > 0 ? 3.2 : 5.0) * dt);
        this.vel.x *= fr; this.vel.z *= fr;
      } else {
        // accelerate toward desired with momentum; friction when no input
        const rate = (hasInput ? this.accel : this.decel) * dt;
        let ddx = dvx - this.vel.x, ddz = dvz - this.vel.z;
        const dl = U.len2(ddx, ddz);
        if (dl > rate) { ddx = ddx / dl * rate; ddz = ddz / dl * rate; }
        this.vel.x += ddx; this.vel.z += ddz;
      }

      this.pos.x += this.vel.x * dt;
      this.pos.z += this.vel.z * dt;
      if (bounds) {
        this.pos.x = U.clamp(this.pos.x, bounds.minX, bounds.maxX);
        this.pos.z = U.clamp(this.pos.z, bounds.minZ, bounds.maxZ);
      }

      // facing
      const sp = U.len2(this.vel.x, this.vel.z);
      this.speedFrac = U.clamp(sp / this.maxSpeed, 0, 1.4);
      if (!disabled) {
        if (sliding) { /* keep slide facing */ this.facing = U.angleDamp(this.facing, Math.atan2(this.slideDir.z, this.slideDir.x), 6, dt); }
        else if (sp > 0.5) this.facing = U.angleDamp(this.facing, Math.atan2(this.vel.z, this.vel.x), 15, dt);
        else if (hasInput) this.facing = U.angleDamp(this.facing, Math.atan2(this.input.z, this.input.x), 11, dt);
      }

      this.root.position.set(this.pos.x, 0, this.pos.z);
      this.root.rotation.set(0, -this.facing + PI / 2, 0);
      this._animate(dt);
    }

    faceTo(x, z, dt, rate) {
      this.facing = U.angleDamp(this.facing, Math.atan2(z - this.pos.z, x - this.pos.x), rate || 14, dt);
    }

    // ---------------- animation ----------------
    _resetPose() {
      const J = this.J;
      J.hips.position.set(0, 0.92, 0); J.hips.rotation.set(0, 0, 0);
      J.spine.rotation.set(0, 0, 0); J.head.rotation.set(0, 0, 0);
      this.root.position.y = 0; this.root.rotation.x = 0; this.root.rotation.z = 0;
    }

    _animate(dt) {
      if (this.fallTimer > 0) { this._animFall(dt); return; }
      if (this.celebrateTimer > 0) { this._animCelebrate(dt); return; }
      if (this.slideTimer > 0) { this._animSlide(dt); return; }
      if (this.stunTimer > 0) { this._animStun(dt); return; }
      this._animRun(dt);
    }

    _animRun(dt) {
      const J = this.J;
      const f = U.clamp(this.speedFrac, 0, 1.3);
      const amp = U.clamp(f * 1.05, 0, 1.2);
      const idleW = 1 - U.clamp(f / 0.28, 0, 1);
      this.idlePhase += dt;

      // cadence locked to ground speed (stride ~2.3m) -> no foot skating
      const gs = U.len2(this.vel.x, this.vel.z);
      const cadence = U.clamp(gs / 2.3, 0, 3.8);
      this.runCycle = (this.runCycle + dt * cadence) % 1;
      const c = this.runCycle;

      // sample both legs (offset by half a cycle)
      const hipL = sampleKF(RUN.hip, c) * amp;
      const hipR = sampleKF(RUN.hip, c + 0.5) * amp;
      const knL = sampleKF(RUN.knee, c) * amp;
      const knR = sampleKF(RUN.knee, c + 0.5) * amp;
      const anL = sampleKF(RUN.ankle, c) * amp;
      const anR = sampleKF(RUN.ankle, c + 0.5) * amp;

      // legs: forward = -x ; knee flexion = +x ; ankle roll tuned
      J.hipL.rotation.set(-hipL, 0, -0.04 * amp);
      J.hipR.rotation.set(-hipR, 0, 0.04 * amp);
      J.kneeL.rotation.x = knL;
      J.kneeR.rotation.x = knR;
      J.ankleL.rotation.x = -anL * 0.7;
      J.ankleR.rotation.x = -anR * 0.7;

      // arms swing opposite to the SAME-side leg (contralateral overall)
      const armL = -hipL * 0.85, armR = -hipR * 0.85;
      const elbowBase = 0.55 * amp + 0.2 * idleW;
      J.shL.rotation.set(-armL, 0, 0.16 + 0.05 * amp);
      J.shR.rotation.set(-armR, 0, -0.16 - 0.05 * amp);
      J.elL.rotation.x = -(elbowBase + 0.45 * Math.max(0, armL));
      J.elR.rotation.x = -(elbowBase + 0.45 * Math.max(0, armR));

      // pelvis: vertical bob (two bounces), yaw + roll, hip drop on swing side
      const bob = (0.5 - 0.5 * Math.cos(TAU * 2 * c)) * 0.07 * amp;
      const breathe = Math.sin(this.idlePhase * 2.0) * 0.012 * idleW;
      J.hips.position.y = 0.92 - 0.06 * amp + bob + breathe;
      const pelvisYaw = 0.14 * amp * Math.sin(TAU * c);
      const pelvisRoll = 0.07 * amp * Math.sin(TAU * c) + 0.02 * idleW * Math.sin(this.idlePhase * 1.3);
      J.hips.rotation.set(0, pelvisYaw, pelvisRoll);

      // spine: counter-rotate shoulders, lean forward with speed
      const lean = 0.1 + amp * 0.26;
      this._lean = U.damp(this._lean, lean, 10, dt);
      J.spine.rotation.set(-this._lean, -pelvisYaw * 1.3, -pelvisRoll * 0.6);

      // head stays level + small look bob
      J.head.rotation.set(this._lean * 0.75 - 0.02, pelvisYaw * 0.4, 0);

      this.root.position.y = 0;

      // kick overrides the striking leg
      if (this.kickTimer > 0) this._applyKick();

      // GK idle: arms ready, knees soft
      if (this.isGK && f < 0.45 && this.kickTimer <= 0) {
        J.shL.rotation.set(-0.25, 0, 0.7);
        J.shR.rotation.set(-0.25, 0, -0.7);
        J.elL.rotation.x = -0.9; J.elR.rotation.x = -0.9;
        J.hipL.rotation.x = -0.12; J.hipR.rotation.x = -0.12;
        J.kneeL.rotation.x = 0.25; J.kneeR.rotation.x = 0.25;
        J.hips.position.y = 0.86 + breathe;
      }
    }

    _applyKick() {
      const J = this.J;
      const t = 1 - this.kickTimer / this.kickDur;     // 0..1
      const planted = this.kickLeg > 0 ? 'L' : 'R';
      const kick = this.kickLeg > 0 ? 'R' : 'L';
      // wind-up (0..0.4) then explosive strike (0.4..1)
      let hipFwd, kneeFlex;
      if (t < 0.4) {
        const u = t / 0.4;
        hipFwd = U.lerp(0, -0.7, u);                   // leg back
        kneeFlex = U.lerp(0.2, 1.1, u);                // cock the knee
      } else {
        const u = (t - 0.4) / 0.6;
        const e = u * u * (3 - 2 * u);
        hipFwd = U.lerp(-0.7, 1.15, e);                // swing through
        kneeFlex = U.lerp(1.1, 0.05, e);               // snap straight on contact
      }
      J['hip' + kick].rotation.x = -hipFwd;
      J['knee' + kick].rotation.x = Math.max(0, kneeFlex);
      J['ankle' + kick].rotation.x = -0.3 + (t > 0.45 ? -0.35 : 0.2);
      // plant leg braces
      J['hip' + planted].rotation.x = 0.12;
      J['knee' + planted].rotation.x = 0.32;
      // torso + arms balance
      const tw = Math.sin(t * PI);
      J.spine.rotation.set(-(0.12 + tw * 0.18), this.kickLeg * tw * 0.25, 0);
      J['sh' + planted].rotation.z = (planted === 'L' ? 1 : -1) * (0.5 + tw * 0.6);
      J['sh' + planted].rotation.x = -tw * 0.5;
      J['sh' + kick].rotation.set(tw * 0.4, 0, (kick === 'L' ? 1 : -1) * 0.2);
    }

    _animSlide(dt) {
      const J = this.J;
      const t = 1 - this.slideTimer / this.slideMax;
      // drop hips, trail one leg, lead with the other
      J.hips.position.y = U.damp(J.hips.position.y, 0.42, 14, dt);
      J.hips.rotation.set(0, 0, 0);
      this.root.rotation.x = U.damp(this.root.rotation.x, -0.55, 12, dt); // lean back onto slide
      J.spine.rotation.set(0.35, 0, 0.1 * Math.sin(t * 6));
      J.hipL.rotation.set(-1.15, 0, -0.2);   // lead leg extended forward
      J.kneeL.rotation.x = 0.15;
      J.hipR.rotation.set(0.35, 0, 0.25);    // trail leg tucked
      J.kneeR.rotation.x = 1.2;
      J.ankleL.rotation.x = -0.4; J.ankleR.rotation.x = 0.2;
      J.shL.rotation.set(0.2, 0, 1.0); J.shR.rotation.set(-0.3, 0, -1.0);
      J.elL.rotation.x = -0.5; J.elR.rotation.x = -0.7;
      J.head.rotation.set(0.3, 0, 0);
      if (this.slideTimer < 0.18) { // begin getting up
        this.root.rotation.x = U.damp(this.root.rotation.x, 0, 14, dt);
        J.hips.position.y = U.damp(J.hips.position.y, 0.7, 12, dt);
      }
    }

    _animStun(dt) {
      const J = this.J;
      J.hips.position.y = U.damp(J.hips.position.y, 0.72, 9, dt);
      J.spine.rotation.set(0.1, Math.sin(this.stunTimer * 26) * 0.18, Math.sin(this.stunTimer * 31) * 0.12);
      J.hipL.rotation.x = -0.25; J.hipR.rotation.x = 0.2;
      J.kneeL.rotation.x = 0.5; J.kneeR.rotation.x = 0.4;
      J.shL.rotation.set(-0.4, 0, 0.5 + Math.sin(this.stunTimer * 20) * 0.2);
      J.shR.rotation.set(-0.4, 0, -0.5 - Math.sin(this.stunTimer * 22) * 0.2);
      J.elL.rotation.x = -0.6; J.elR.rotation.x = -0.6;
      J.head.rotation.set(-0.15, Math.sin(this.stunTimer * 18) * 0.2, 0);
    }

    _animFall(dt) {
      const J = this.J;
      const e = this.fallMax - this.fallTimer;            // elapsed
      // phases: 0..0.4 topple down, 0.4..1.15 grounded, 1.15..end get up
      let down;
      if (e < 0.4) down = U.smoothstep(0, 0.4, e);
      else if (e < this.fallMax - 0.45) down = 1;
      else down = 1 - U.smoothstep(this.fallMax - 0.45, this.fallMax, e);

      // topple backward relative to facing (fall onto back)
      this.root.rotation.x = down * 1.45;
      J.hips.position.y = U.lerp(0.92, 0.42, down);
      this.root.position.y = 0;
      // flailing/relaxed limbs while grounded
      const fl = down;
      const w = Math.sin(e * 9) * (1 - down) * 0.3; // small wobble going down
      J.spine.rotation.set(-0.1 * fl, w, 0);
      J.head.rotation.set(0.2 * fl, 0, 0);
      J.hipL.rotation.set(-0.4 * fl, 0, -0.25 * fl);
      J.hipR.rotation.set(-0.2 * fl, 0, 0.3 * fl);
      J.kneeL.rotation.x = 0.7 * fl; J.kneeR.rotation.x = 0.45 * fl;
      J.ankleL.rotation.x = 0; J.ankleR.rotation.x = 0;
      J.shL.rotation.set(-0.5 * fl, 0, 0.9 * fl + 0.1);
      J.shR.rotation.set(-0.6 * fl, 0, -0.8 * fl - 0.1);
      J.elL.rotation.x = -0.4 * fl; J.elR.rotation.x = -0.5 * fl;
      J.hips.rotation.set(0, 0, 0);
    }

    _animCelebrate(dt) {
      const J = this.J;
      this._resetPose();
      const t = 3.2 - this.celebrateTimer;
      if (this.celebrateType === 0) {
        // leaping fist-pump
        const j = Math.max(0, Math.sin(t * 5.5));
        this.root.position.y = j * 0.45;
        const pump = Math.sin(t * 13);
        J.shL.rotation.set(-2.5 + pump * 0.3, 0, 0.3);
        J.shR.rotation.set(-2.5 - pump * 0.3, 0, -0.3);
        J.elL.rotation.x = -0.6; J.elR.rotation.x = -0.6;
        J.kneeL.rotation.x = j * 0.6; J.kneeR.rotation.x = j * 0.6;
        J.hipL.rotation.x = j * 0.3; J.hipR.rotation.x = j * 0.3;
        J.head.rotation.x = -0.2;
      } else if (this.celebrateType === 1) {
        // arms-wide aeroplane spin (drive facing so update() keeps it)
        this.facing += dt * 4.5;
        this.root.rotation.y = -this.facing + PI / 2;
        J.shL.rotation.set(0, 0, 1.45); J.shR.rotation.set(0, 0, -1.45);
        J.elL.rotation.x = -0.1; J.elR.rotation.x = -0.1;
        J.spine.rotation.set(-0.15, 0, 0);
        J.hipL.rotation.x = -0.15; J.hipR.rotation.x = -0.15;
        J.hips.position.y = 0.92 + Math.abs(Math.sin(t * 4)) * 0.05;
      } else {
        // knee-slide celebration
        const slide = U.clamp(t / 0.6, 0, 1);
        this.root.rotation.x = -0.4 * (1 - U.clamp((t - 1.2) / 0.6, 0, 1));
        J.hips.position.y = U.lerp(0.92, 0.5, slide) * (1 - 0.3 * U.clamp((t - 1.4) / 0.8, 0, 1)) + 0.3 * U.clamp((t - 1.4) / 0.8, 0, 1) * 0.92;
        J.hipL.rotation.x = -0.2; J.kneeL.rotation.x = 1.4;
        J.hipR.rotation.x = -0.9; J.kneeR.rotation.x = 0.3;
        J.shL.rotation.set(-1.0, 0, 0.9); J.shR.rotation.set(-1.0, 0, -0.9);
        J.elL.rotation.x = -0.3; J.elR.rotation.x = -0.3;
        J.head.rotation.x = -0.25;
      }
    }

    dispose() { this.scene.remove(this.root); }
  }

  let RING_TEX = null;
  function ringTexture() {
    if (RING_TEX) return RING_TEX;
    const { canvas, ctx } = U.makeCanvas(128, 128);
    ctx.clearRect(0, 0, 128, 128);
    ctx.strokeStyle = 'rgba(255,255,255,0.95)'; ctx.lineWidth = 9;
    ctx.beginPath(); ctx.arc(64, 64, 50, 0, TAU); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.32)'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(64, 64, 40, 0, TAU); ctx.stroke();
    RING_TEX = new THREE.CanvasTexture(canvas);
    RING_TEX.encoding = THREE.sRGBEncoding;
    return RING_TEX;
  }

  GS.Player = Player;
})();
