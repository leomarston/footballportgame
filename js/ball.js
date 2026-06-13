/* GOALSTORM — ball.js
 * Arcade ball physics: gravity, restitution bounce, rolling friction,
 * air drag, Magnus curve from spin, post/crossbar/wall collisions,
 * goal-line detection. Procedural panel texture, rolling rotation,
 * dynamic shadow.
 */
window.GS = window.GS || {};
(function () {
  'use strict';
  const U = GS.U, C = GS.CFG;

  function ballTexture() {
    const S = 256;
    const { canvas, ctx } = U.makeCanvas(S, S);
    // white base with faint gradient
    ctx.fillStyle = '#f4f6f8';
    ctx.fillRect(0, 0, S, S);
    // soft shading
    const g = ctx.createRadialGradient(S * 0.38, S * 0.32, 0, S * 0.5, S * 0.5, S * 0.62);
    g.addColorStop(0, 'rgba(255,255,255,0.9)');
    g.addColorStop(1, 'rgba(180,190,200,0.35)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);

    // classic pentagon-ish pattern via scattered dark patches
    ctx.fillStyle = '#1a1d24';
    const drawPenta = (cx, cy, r, rot) => {
      ctx.beginPath();
      for (let i = 0; i < 5; i++) {
        const a = rot + i * (Math.PI * 2 / 5) - Math.PI / 2;
        const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath(); ctx.fill();
    };
    drawPenta(S * 0.5, S * 0.3, 26, 0);
    drawPenta(S * 0.22, S * 0.62, 22, 0.6);
    drawPenta(S * 0.78, S * 0.62, 22, -0.6);
    drawPenta(S * 0.5, S * 0.86, 20, 0.2);
    // seams
    ctx.strokeStyle = 'rgba(40,44,52,0.5)';
    ctx.lineWidth = 3;
    for (let i = 0; i < 6; i++) {
      ctx.beginPath();
      ctx.moveTo(U.rand(0, S), U.rand(0, S));
      ctx.lineTo(U.rand(0, S), U.rand(0, S));
      ctx.stroke();
    }
    return U.canvasTexture(canvas);
  }

  class Ball {
    constructor(scene, particles) {
      this.scene = scene;
      this.particles = particles;
      this.pos = new THREE.Vector3(0, C.BALL_R, 0);
      this.vel = new THREE.Vector3();
      this.spin = 0;          // horizontal spin (rad/s-ish) -> Magnus curve
      this.angVel = new THREE.Vector3(); // visual rolling
      this.radius = C.BALL_R;
      this.lastTouch = -1;    // team id of last toucher
      this.lastToucher = null;
      this.controlledBy = null;
      this.trailTimer = 0;
      this.outCooldown = 0;

      const mat = new THREE.MeshToonMaterial({
        map: ballTexture(),
        gradientMap: U.toonGradient([0.55, 0.78, 1]),
      });
      this.mesh = new THREE.Mesh(new THREE.SphereGeometry(this.radius, 22, 18), mat);
      this.mesh.castShadow = true;
      this.mesh.position.copy(this.pos);
      scene.add(this.mesh);

      // shadow
      const shTex = U.glowTexture('rgba(0,0,0,0.6)', 'rgba(0,0,0,0.25)');
      this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({ map: shTex, transparent: true, depthWrite: false }));
      this.shadow.rotation.x = -Math.PI / 2;
      this.shadow.position.y = 0.02;
      scene.add(this.shadow);

      // flame glow used while super-shot
      this.glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: U.glowTexture('rgba(255,200,90,0.9)', 'rgba(255,90,30,0.35)'),
        blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
      }));
      this.glow.scale.set(2, 2, 1);
      this.glow.visible = false;
      scene.add(this.glow);
      this.onFire = 0;
    }

    reset(x, z) {
      this.pos.set(x || 0, this.radius, z || 0);
      this.vel.set(0, 0, 0);
      this.spin = 0;
      this.angVel.set(0, 0, 0);
      this.controlledBy = null;
      this.onFire = 0;
      this.glow.visible = false;
      this._sync();
    }

    kick(dir, power, lift, spin, byTeam, byPlayer) {
      this.controlledBy = null;
      this.vel.x = dir.x * power;
      this.vel.z = dir.z * power;
      this.vel.y = lift;
      this.spin = spin || 0;
      this.lastTouch = byTeam;
      this.lastToucher = byPlayer;
      // rolling spin from horizontal speed
      const sp = U.len2(this.vel.x, this.vel.z);
      this.angVel.set(-this.vel.z / this.radius, 0, this.vel.x / this.radius);
    }

    setFire(on) {
      this.onFire = on ? 1 : 0;
      this.glow.visible = on;
    }

    speed() { return this.vel.length(); }
    speed2D() { return U.len2(this.vel.x, this.vel.z); }

    update(dt) {
      if (this.outCooldown > 0) this.outCooldown -= dt;
      if (this.controlledBy) {
        // dribble: handled by match (it positions us); just spin visually
        this._roll(dt);
        this._sync();
        return null;
      }

      let event = null;

      // gravity
      this.vel.y -= C.GRAV * dt;

      // air drag (stronger when airborne)
      const airborne = this.pos.y > this.radius + 0.02;
      const drag = airborne ? 0.32 : 0.0;
      if (drag) {
        const d = Math.exp(-drag * dt);
        this.vel.x *= d; this.vel.z *= d;
      }

      // Magnus curve: lateral accel perpendicular to horizontal velocity
      if (Math.abs(this.spin) > 0.01) {
        const vx = this.vel.x, vz = this.vel.z;
        const sp = U.len2(vx, vz);
        if (sp > 0.5) {
          // perpendicular (rotate velocity 90°)
          const px = -vz / sp, pz = vx / sp;
          const k = this.spin * 2.4;
          this.vel.x += px * k * dt;
          this.vel.z += pz * k * dt;
        }
        this.spin *= Math.exp(-1.1 * dt);
      }

      // integrate
      this.pos.x += this.vel.x * dt;
      this.pos.y += this.vel.y * dt;
      this.pos.z += this.vel.z * dt;

      // ground collision
      if (this.pos.y < this.radius) {
        this.pos.y = this.radius;
        if (this.vel.y < -0.5) {
          const impact = -this.vel.y;
          this.vel.y = impact * 0.62;          // restitution
          this.vel.x *= 0.82; this.vel.z *= 0.82;
          if (impact > 2.5 && GS.AUDIO) GS.AUDIO.bounce(impact);
          if (impact > 4 && this.particles) this.particles.grassKick(this.pos, this.vel);
          event = event || { type: 'bounce', impact };
        } else {
          this.vel.y = 0;
        }
        // rolling friction
        const rf = Math.exp(-1.7 * dt);
        this.vel.x *= rf; this.vel.z *= rf;
        if (this.speed2D() < 0.05) { this.vel.x = 0; this.vel.z = 0; }
      }

      // posts + walls + goal detection
      const ge = this._collide();
      if (ge) event = ge;

      this._roll(dt);

      // trail / fire fx
      const sp2 = this.speed();
      if (this.onFire) {
        this.glow.position.copy(this.pos);
        const s = 1.8 + Math.sin(performance.now() * 0.02) * 0.3;
        this.glow.scale.set(s, s, 1);
        if (this.particles) this.particles.flameTrail(this.pos);
      } else if (sp2 > 11 && this.particles) {
        this.trailTimer -= dt;
        if (this.trailTimer <= 0) { this.trailTimer = 0.016; this.particles.ballTrail(this.pos, sp2); }
      }

      this._sync();
      return event;
    }

    _roll(dt) {
      // rolling rotation from horizontal velocity
      if (this.pos.y <= this.radius + 0.05) {
        this.angVel.set(-this.vel.z / this.radius, 0, this.vel.x / this.radius);
      }
      this.mesh.rotation.x += this.angVel.x * dt;
      this.mesh.rotation.z += this.angVel.z * dt;
      this.mesh.rotation.y += this.spin * 0.5 * dt;
    }

    _collide() {
      const W2 = C.PITCH_W / 2, H2 = C.PITCH_H / 2;
      const GW2 = C.GOAL_W / 2, GH = C.GOAL_H;
      const r = this.radius;
      let event = null;

      // ---- goal posts (vertical cylinders) + crossbar ----
      for (const s of [-1, 1]) {
        const gx = s * W2;
        // posts at z = ±GW2
        for (const pz of [-GW2, GW2]) {
          const dx = this.pos.x - gx, dz = this.pos.z - pz;
          const d = U.len2(dx, dz);
          const minD = r + C.POST_R;
          if (d < minD && this.pos.y < GH + 0.2) {
            const nx = dx / (d || 1), nz = dz / (d || 1);
            this.pos.x = gx + nx * minD;
            this.pos.z = pz + nz * minD;
            const vn = this.vel.x * nx + this.vel.z * nz;
            this.vel.x -= 1.7 * vn * nx;
            this.vel.z -= 1.7 * vn * nz;
            this.vel.multiplyScalar(0.86);
            if (GS.AUDIO) GS.AUDIO.post();
            if (this.particles) this.particles.sparkBurst({ x: this.pos.x, y: this.pos.y, z: this.pos.z }, '#ffffff');
            event = { type: 'post' };
          }
        }
        // crossbar (horizontal at y=GH spanning z in [-GW2,GW2])
        if (Math.abs(this.pos.x - gx) < r + C.POST_R &&
            Math.abs(this.pos.z) < GW2 + 0.1 &&
            Math.abs(this.pos.y - GH) < r + C.POST_R) {
          this.vel.y *= -0.7;
          this.vel.x *= 0.8;
          this.pos.y = GH - (r + C.POST_R) * Math.sign(this.pos.y - GH || -1);
          if (GS.AUDIO) GS.AUDIO.post();
          event = { type: 'post' };
        }
      }

      // ---- goal detection: fully past the line, inside mouth, under bar ----
      for (const s of [-1, 1]) {
        const gx = s * W2;
        if (this.outCooldown <= 0 &&
            ((s > 0 && this.pos.x > gx + r * 0.5) || (s < 0 && this.pos.x < gx - r * 0.5)) &&
            Math.abs(this.pos.z) < GW2 - r * 0.3 &&
            this.pos.y < GH - r * 0.3) {
          this.outCooldown = 1;
          // ripple the net
          if (GS.MATCH) GS.MATCH.onGoalScored(s); // s>0 means ball entered +x goal
          return { type: 'goal', side: s };
        }
      }

      // ---- side & end walls (boarded arena, ball stays in) ----
      // side walls (z)
      if (this.pos.z > H2 - r) { this.pos.z = H2 - r; this.vel.z = -Math.abs(this.vel.z) * 0.72; event = event || { type: 'wall' }; }
      if (this.pos.z < -H2 + r) { this.pos.z = -H2 + r; this.vel.z = Math.abs(this.vel.z) * 0.72; event = event || { type: 'wall' }; }
      // end walls (x) — but leave the goal mouth open
      for (const s of [-1, 1]) {
        const gx = s * W2;
        const inMouth = Math.abs(this.pos.z) < GW2 + 0.1 && this.pos.y < GH + 0.3;
        if (s > 0 && this.pos.x > gx - r && !inMouth) { this.pos.x = gx - r; this.vel.x = -Math.abs(this.vel.x) * 0.72; event = event || { type: 'wall' }; }
        if (s < 0 && this.pos.x < gx + r && !inMouth) { this.pos.x = gx + r; this.vel.x = Math.abs(this.vel.x) * 0.72; event = event || { type: 'wall' }; }
      }
      // back-of-net containment (after a goal, keep ball from flying to infinity)
      const backX = W2 + C.GOAL_D - r;
      if (this.pos.x > backX) { this.pos.x = backX; this.vel.x *= -0.4; }
      if (this.pos.x < -backX) { this.pos.x = -backX; this.vel.x *= -0.4; }

      return event;
    }

    _sync() {
      this.mesh.position.copy(this.pos);
      // shadow follows ground point, fades + shrinks with height
      const h = this.pos.y - this.radius;
      const scale = U.clamp(1.6 - h * 0.06, 0.5, 1.6);
      this.shadow.position.set(this.pos.x, 0.02, this.pos.z);
      this.shadow.scale.set(scale, scale, 1);
      this.shadow.material.opacity = U.clamp(0.55 - h * 0.03, 0.12, 0.55);
    }
  }

  GS.Ball = Ball;
})();
