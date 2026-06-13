/* GOALSTORM — player.js
 * Procedural toon-shaded footballer: jointed skeleton with run / idle /
 * kick / slide / celebrate animation, per-team kit materials, jersey
 * number, soft contact shadow. Movement physics + ball-dribble logic.
 */
window.GS = window.GS || {};
(function () {
  'use strict';
  const U = GS.U, C = GS.CFG;

  let TOON = null;
  function toon() { if (!TOON) TOON = U.toonGradient([0.45, 0.68, 0.88, 1]); return TOON; }

  // shared per-team material cache
  const KIT_CACHE = {};
  function teamKit(team, isGK) {
    const key = team.abbr + (isGK ? '_gk' : '');
    if (KIT_CACHE[key]) return KIT_CACHE[key];
    const jc = isGK ? team.gk : team.c1;
    const mk = (col) => new THREE.MeshToonMaterial({ color: new THREE.Color(col), gradientMap: toon() });
    const kit = {
      jersey: mk(jc),
      jerseyTrim: mk(team.c2),
      shorts: mk(isGK ? U.shade(team.gk, 0.55) : team.short),
      socks: mk(jc),
      sockTrim: mk(team.c2),
      shoe: mk('#16181d'),
    };
    KIT_CACHE[key] = kit;
    return kit;
  }

  function numberTexture(num, bg, fg) {
    const { canvas, ctx } = U.makeCanvas(64, 64);
    ctx.fillStyle = 'rgba(0,0,0,0)';
    ctx.clearRect(0, 0, 64, 64);
    ctx.fillStyle = fg;
    ctx.font = '900 46px "Arial Black", Arial, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(num), 32, 34);
    const t = new THREE.CanvasTexture(canvas);
    t.encoding = THREE.sRGBEncoding;
    return t;
  }

  // build a limb group pivoting at its top; returns {pivot, joint}
  function makeLimb(len, rTop, rBot, mat) {
    const pivot = new THREE.Group();
    const seg = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, len, 8), mat);
    seg.position.y = -len / 2;
    seg.castShadow = true;
    pivot.add(seg);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(rBot, 8, 6), mat);
    cap.position.y = -len;
    pivot.add(cap);
    const joint = new THREE.Group();
    joint.position.y = -len;
    pivot.add(joint);
    return { pivot, joint };
  }

  class Player {
    constructor(scene, opts) {
      this.scene = scene;
      this.team = opts.team;
      this.teamId = opts.teamId;       // 0 or 1
      this.attackDir = opts.attackDir; // +1 toward +x goal, -1 toward -x
      this.isGK = !!opts.isGK;
      this.role = opts.role || 'MID';
      this.number = opts.number;
      this.name = opts.name;
      this.home = { x: opts.homeX, z: opts.homeZ };
      this.formation = { x: opts.homeX, z: opts.homeZ };

      // physics state
      this.pos = new THREE.Vector3(opts.homeX, 0, opts.homeZ);
      this.vel = new THREE.Vector3();
      this.facing = this.attackDir > 0 ? 0 : Math.PI;
      this.input = { x: 0, z: 0, sprint: false };
      this.maxSpeed = (this.isGK ? 7.4 : 8.6) * (opts.speedMul || 1);
      this.accel = 52;
      this.speedFrac = 0;

      // attributes (AI/difficulty)
      this.attr = opts.attr || { speed: 1, react: 0.12, shootAcc: 0.85, pass: 0.9 };

      // anim / action state
      this.animPhase = 0;
      this.kickTimer = 0; this.kickDur = 0.34; this.kickLeg = 1; this.kickFired = false;
      this.slideTimer = 0; this.slideDir = new THREE.Vector3();
      this.celebrateTimer = 0; this.celebrateType = 0;
      this.stunTimer = 0;
      this.hasBall = false;
      this.boost = null; this.boostTimer = 0;

      this._buildModel();
    }

    _buildModel() {
      const kit = teamKit(this.team, this.isGK);
      this.kit = kit;
      const root = new THREE.Group();
      this.root = root;
      this.parts = {};

      // hips anchor — whole body bobs from here
      const body = new THREE.Group();
      body.position.y = 0.92;
      root.add(body);
      this.parts.body = body;

      // torso (tapered)
      const torso = new THREE.Mesh(
        new THREE.CylinderGeometry(0.27, 0.32, 0.62, 12), kit.jersey);
      torso.position.y = 0.31;
      torso.castShadow = true;
      body.add(torso);
      this.parts.torso = torso;

      // chest shoulder yoke (trim color collar)
      const collar = new THREE.Mesh(
        new THREE.CylinderGeometry(0.285, 0.27, 0.12, 12), kit.jerseyTrim);
      collar.position.y = 0.58;
      body.add(collar);

      // side stripe accents
      for (const s of [-1, 1]) {
        const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.5, 0.12), kit.jerseyTrim);
        stripe.position.set(s * 0.26, 0.32, 0);
        body.add(stripe);
      }

      // jersey number on back
      const numTex = numberTexture(this.number, this.team.c1, this.team.c2);
      const numPlane = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.34),
        new THREE.MeshBasicMaterial({ map: numTex, transparent: true }));
      numPlane.position.set(0, 0.36, -0.31);
      numPlane.rotation.y = Math.PI;
      body.add(numPlane);

      // neck + head
      const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 0.1, 8),
        new THREE.MeshToonMaterial({ color: new THREE.Color(opts_skin(this)), gradientMap: toon() }));
      neck.position.y = 0.66;
      body.add(neck);

      const skinMat = new THREE.MeshToonMaterial({ color: new THREE.Color(this._skin), gradientMap: toon() });
      this._skinMat = skinMat;
      const headG = new THREE.Group();
      headG.position.y = 0.82;
      body.add(headG);
      this.parts.head = headG;
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.18, 14, 12), skinMat);
      head.scale.set(1, 1.12, 1.02);
      head.castShadow = true;
      headG.add(head);

      // hair cap
      const hairMat = new THREE.MeshToonMaterial({ color: new THREE.Color(this._hair), gradientMap: toon() });
      const hair = new THREE.Mesh(new THREE.SphereGeometry(0.185, 12, 10, 0, Math.PI * 2, 0, Math.PI * 0.62), hairMat);
      hair.position.y = 0.04;
      hair.scale.set(1.04, 1.1, 1.06);
      headG.add(hair);
      // nose nub for facing readability
      const nose = new THREE.Mesh(new THREE.SphereGeometry(0.035, 6, 6), skinMat);
      nose.position.set(0.17, -0.01, 0);
      headG.add(nose);

      // arms
      this.parts.armL = makeLimb(0.3, 0.07, 0.055, kit.jersey);
      this.parts.armR = makeLimb(0.3, 0.07, 0.055, kit.jersey);
      this.parts.armL.pivot.position.set(-0.3, 0.56, 0);
      this.parts.armR.pivot.position.set(0.3, 0.56, 0);
      body.add(this.parts.armL.pivot, this.parts.armR.pivot);
      this.parts.foreL = makeLimb(0.28, 0.055, 0.05, skinMat);
      this.parts.foreR = makeLimb(0.28, 0.055, 0.05, skinMat);
      this.parts.armL.joint.add(this.parts.foreL.pivot);
      this.parts.armR.joint.add(this.parts.foreR.pivot);

      // legs (upper = skin/shorts boundary; we color upper as shorts then skin knee)
      this.parts.legL = makeLimb(0.42, 0.1, 0.085, kit.shorts);
      this.parts.legR = makeLimb(0.42, 0.1, 0.085, kit.shorts);
      this.parts.legL.pivot.position.set(-0.13, 0.02, 0);
      this.parts.legR.pivot.position.set(0.13, 0.02, 0);
      body.add(this.parts.legL.pivot, this.parts.legR.pivot);

      // shins with socks
      this.parts.shinL = makeLimb(0.4, 0.08, 0.07, kit.socks);
      this.parts.shinR = makeLimb(0.4, 0.08, 0.07, kit.socks);
      this.parts.legL.joint.add(this.parts.shinL.pivot);
      this.parts.legR.joint.add(this.parts.shinR.pivot);
      // sock trim ring
      for (const sh of [this.parts.shinL, this.parts.shinR]) {
        const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.06, 8), kit.sockTrim);
        ring.position.y = -0.05;
        sh.pivot.add(ring);
      }
      // boots
      for (const side of ['L', 'R']) {
        const shin = this.parts['shin' + side];
        const boot = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.1, 0.28), kit.shoe);
        boot.position.set(0, -0.4, 0.07);
        boot.castShadow = true;
        shin.pivot.add(boot);
      }

      // shorts block over hips
      const shortsBlock = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.24, 0.22, 10), kit.shorts);
      shortsBlock.position.y = 0.04;
      body.add(shortsBlock);

      // GK gloves
      if (this.isGK) {
        for (const f of [this.parts.foreL, this.parts.foreR]) {
          const glove = new THREE.Mesh(new THREE.SphereGeometry(0.085, 8, 6),
            new THREE.MeshToonMaterial({ color: new THREE.Color(this.team.c2), gradientMap: toon() }));
          glove.position.y = -0.28;
          glove.scale.set(1.2, 1.2, 0.9);
          f.pivot.add(glove);
        }
      }

      // soft contact shadow
      const shTex = U.glowTexture('rgba(0,0,0,0.55)', 'rgba(0,0,0,0.25)');
      const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1.05, 0.78),
        new THREE.MeshBasicMaterial({ map: shTex, transparent: true, depthWrite: false, opacity: 0.6 }));
      shadow.rotation.x = -Math.PI / 2;
      shadow.position.y = 0.02;
      root.add(shadow);
      this.contactShadow = shadow;

      // selection ring (hidden by default)
      const ringTex = ringTexture();
      const ring = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.5),
        new THREE.MeshBasicMaterial({
          map: ringTex, transparent: true, depthWrite: false,
          blending: THREE.AdditiveBlending,
        }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.05;
      ring.visible = false;
      root.add(ring);
      this.selRing = ring;

      root.position.copy(this.pos);
      this.scene.add(root);
    }

    get _skin() { if (!this.__skin) this.__skin = U.choice(GS.SKINS); return this.__skin; }
    get _hair() { if (!this.__hair) this.__hair = U.choice(GS.HAIRS); return this.__hair; }

    setSelected(on, color) {
      this.selRing.visible = on;
      if (on && color) this.selRing.material.color.set(color);
    }

    playKick(power, leg) {
      this.kickTimer = this.kickDur;
      this.kickLeg = leg != null ? leg : (Math.random() < 0.5 ? 1 : -1);
      this.kickFired = false;
      this.kickPower = power;
    }

    playSlide(dir) {
      this.slideTimer = 0.6;
      this.slideDir.copy(dir).normalize();
      this.vel.addScaledVector(this.slideDir, 9);
    }

    celebrate(type) {
      this.celebrateTimer = 3.0;
      this.celebrateType = type != null ? type : U.randInt(0, 2);
    }

    stun(t) { this.stunTimer = Math.max(this.stunTimer, t); }

    setBoost(type, dur) { this.boost = type; this.boostTimer = dur; }

    // ---- physics integration ----
    update(dt, bounds) {
      // timers
      if (this.kickTimer > 0) this.kickTimer -= dt;
      if (this.celebrateTimer > 0) this.celebrateTimer -= dt;
      if (this.stunTimer > 0) this.stunTimer -= dt;
      if (this.boostTimer > 0) { this.boostTimer -= dt; if (this.boostTimer <= 0) this.boost = null; }

      const sliding = this.slideTimer > 0;
      if (sliding) this.slideTimer -= dt;

      let targetVX = 0, targetVZ = 0;
      const sprinting = this.input.sprint && !sliding && this.stunTimer <= 0;
      let speed = this.maxSpeed * (sprinting ? 1.32 : 1);
      if (this.boost === 'sprint') speed *= 1.32;
      if (this.hasBall) speed *= 0.92; // slightly slower with the ball
      if (this.celebrateTimer > 0) speed = 0;

      if (!sliding && this.stunTimer <= 0 && this.celebrateTimer <= 0) {
        targetVX = this.input.x * speed;
        targetVZ = this.input.z * speed;
      }

      // accelerate toward target velocity
      const a = sliding ? 6 : this.accel;
      this.vel.x = U.damp(this.vel.x, targetVX, a / Math.max(speed, 1) * 2.2, dt);
      this.vel.z = U.damp(this.vel.z, targetVZ, a / Math.max(speed, 1) * 2.2, dt);
      if (sliding) { this.vel.x *= Math.exp(-2.5 * dt); this.vel.z *= Math.exp(-2.5 * dt); }

      this.pos.x += this.vel.x * dt;
      this.pos.z += this.vel.z * dt;

      // bounds clamp (players can roam a bit outside the lines)
      if (bounds) {
        this.pos.x = U.clamp(this.pos.x, bounds.minX, bounds.maxX);
        this.pos.z = U.clamp(this.pos.z, bounds.minZ, bounds.maxZ);
      }

      // facing
      const sp = U.len2(this.vel.x, this.vel.z);
      this.speedFrac = U.clamp(sp / this.maxSpeed, 0, 1.4);
      if (sp > 0.6 && this.celebrateTimer <= 0) {
        const want = Math.atan2(this.vel.z, this.vel.x);
        this.facing = U.angleDamp(this.facing, want, 16, dt);
      } else if (this.input.x || this.input.z) {
        const want = Math.atan2(this.input.z, this.input.x);
        this.facing = U.angleDamp(this.facing, want, 12, dt);
      }

      this.root.position.copy(this.pos);
      this.root.rotation.y = -this.facing + Math.PI / 2;

      this._animate(dt);
    }

    faceTo(x, z, dt, rate) {
      const want = Math.atan2(z - this.pos.z, x - this.pos.x);
      this.facing = U.angleDamp(this.facing, want, rate || 14, dt);
    }

    _animate(dt) {
      const P = this.parts;
      const sliding = this.slideTimer > 0;
      const celeb = this.celebrateTimer > 0;

      if (celeb) { this._animCelebrate(dt); return; }
      if (sliding) { this._animSlide(dt); return; }
      if (this.stunTimer > 0) { this._animStun(dt); return; }

      // run / idle blend
      const f = this.speedFrac;
      const stride = 9 + f * 5;
      this.animPhase += dt * stride * (0.3 + f);
      const ph = this.animPhase;
      const sw = Math.sin(ph) * (0.25 + f * 0.95);   // leg swing amplitude
      const knee = Math.max(0, Math.sin(ph + Math.PI / 2)) * (0.2 + f * 1.2);

      // legs
      P.legL.pivot.rotation.x = sw;
      P.legR.pivot.rotation.x = -sw;
      P.shinL.pivot.rotation.x = Math.max(0, -Math.sin(ph)) * (0.3 + f * 1.4);
      P.shinR.pivot.rotation.x = Math.max(0, Math.sin(ph)) * (0.3 + f * 1.4);

      // arms counter-swing
      const asw = Math.sin(ph) * (0.2 + f * 0.7);
      P.armL.pivot.rotation.x = -asw;
      P.armR.pivot.rotation.x = asw;
      P.armL.pivot.rotation.z = 0.18 + f * 0.05;
      P.armR.pivot.rotation.z = -0.18 - f * 0.05;
      P.foreL.pivot.rotation.x = 0.3 + f * 0.3;
      P.foreR.pivot.rotation.x = 0.3 + f * 0.3;

      // body bob + lean
      const bob = Math.abs(Math.sin(ph)) * (0.02 + f * 0.06);
      P.body.position.y = 0.92 + bob;
      P.body.rotation.x = f * 0.14;
      P.body.rotation.z = Math.sin(ph) * f * 0.04;
      P.head.rotation.x = -f * 0.1;

      // idle breathing when nearly stopped
      if (f < 0.05) {
        const br = Math.sin(this.animPhase * 0.2) * 0.012;
        P.body.position.y = 0.92 + br;
        P.legL.pivot.rotation.x *= 0.1; P.legR.pivot.rotation.x *= 0.1;
        P.shinL.pivot.rotation.x *= 0.1; P.shinR.pivot.rotation.x *= 0.1;
      }

      // kick overrides one leg
      if (this.kickTimer > 0) this._animKick();

      // GK ready stance arms out
      if (this.isGK && f < 0.4) {
        P.armL.pivot.rotation.z = 0.65;
        P.armR.pivot.rotation.z = -0.65;
        P.armL.pivot.rotation.x = -0.2;
        P.armR.pivot.rotation.x = -0.2;
      }
    }

    _animKick() {
      const P = this.parts;
      const t = 1 - this.kickTimer / this.kickDur;   // 0..1
      // wind up then snap
      const swing = t < 0.4
        ? U.lerp(0, -1.0, t / 0.4)                    // back-lift
        : U.lerp(-1.0, 1.5, (t - 0.4) / 0.6);         // forward strike
      const leg = this.kickLeg > 0 ? P.legR : P.legL;
      const shin = this.kickLeg > 0 ? P.shinR : P.shinL;
      leg.pivot.rotation.x = swing;
      shin.pivot.rotation.x = Math.max(0, -swing * 0.6) + (t > 0.4 ? 0 : 0.4);
      P.body.rotation.x = 0.1 + Math.sin(t * Math.PI) * 0.12;
      // plant other arm out for balance
      const arm = this.kickLeg > 0 ? P.armL : P.armR;
      arm.pivot.rotation.z = (this.kickLeg > 0 ? 1 : -1) * (0.4 + Math.sin(t * Math.PI) * 0.5);
    }

    _animSlide(dt) {
      const P = this.parts;
      // lean back, legs extended forward
      P.body.position.y = U.damp(P.body.position.y, 0.45, 12, dt);
      P.body.rotation.x = U.damp(P.body.rotation.x, -0.5, 12, dt);
      P.legL.pivot.rotation.x = U.damp(P.legL.pivot.rotation.x, 1.3, 12, dt);
      P.legR.pivot.rotation.x = U.damp(P.legR.pivot.rotation.x, 0.5, 12, dt);
      P.shinL.pivot.rotation.x = 0.2; P.shinR.pivot.rotation.x = 0.9;
      P.armL.pivot.rotation.z = 1.0; P.armR.pivot.rotation.z = -1.0;
      this.root.rotation.y = -this.facing + Math.PI / 2;
    }

    _animStun(dt) {
      const P = this.parts;
      P.body.position.y = U.damp(P.body.position.y, 0.7, 8, dt);
      P.body.rotation.x = Math.sin(this.stunTimer * 30) * 0.1;
      P.legL.pivot.rotation.x = 0.2; P.legR.pivot.rotation.x = -0.2;
    }

    _animCelebrate(dt) {
      const P = this.parts;
      const t = 3.0 - this.celebrateTimer;
      P.legL.pivot.rotation.x = 0; P.legR.pivot.rotation.x = 0;
      P.shinL.pivot.rotation.x = 0; P.shinR.pivot.rotation.x = 0;
      if (this.celebrateType === 0) {
        // jump + arms up pumping
        const j = Math.max(0, Math.sin(t * 6)) * 0.4;
        this.root.position.y = j;
        P.armL.pivot.rotation.x = -2.4 + Math.sin(t * 12) * 0.3;
        P.armR.pivot.rotation.x = -2.4 + Math.sin(t * 12 + 1) * 0.3;
        P.body.position.y = 0.92;
      } else if (this.celebrateType === 1) {
        // slide-knee: arms wide spinning
        this.root.position.y = 0;
        this.root.rotation.y += dt * 4;
        P.armL.pivot.rotation.z = 1.4; P.armR.pivot.rotation.z = -1.4;
        P.body.rotation.x = -0.2;
      } else {
        // running man, arms wide
        this.animPhase += dt * 14;
        const sw = Math.sin(this.animPhase) * 1.0;
        P.legL.pivot.rotation.x = sw; P.legR.pivot.rotation.x = -sw;
        P.armL.pivot.rotation.x = -1.6; P.armR.pivot.rotation.x = -1.6;
        P.armL.pivot.rotation.z = 0.8; P.armR.pivot.rotation.z = -0.8;
        this.root.position.y = Math.abs(Math.sin(this.animPhase)) * 0.1;
      }
    }

    dispose() { this.scene.remove(this.root); }
  }

  // helper accessor since getters defined after constructor uses _skin
  function opts_skin(p) { return p._skin; }

  let RING_TEX = null;
  function ringTexture() {
    if (RING_TEX) return RING_TEX;
    const { canvas, ctx } = U.makeCanvas(128, 128);
    ctx.clearRect(0, 0, 128, 128);
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.lineWidth = 9;
    ctx.beginPath(); ctx.arc(64, 64, 50, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(64, 64, 40, 0, Math.PI * 2); ctx.stroke();
    RING_TEX = new THREE.CanvasTexture(canvas);
    RING_TEX.encoding = THREE.sRGBEncoding;
    return RING_TEX;
  }

  GS.Player = Player;
})();
