/* GOALSTORM — match.js
 * Match engine: teams & formations, possession/dribble, charged shots
 * with curve, passing, tackling, goalkeeper catches, power-up boosts,
 * scoring, halves, broadcast camera, and HUD wiring.
 */
window.GS = window.GS || {};
(function () {
  'use strict';
  const U = GS.U, C = GS.CFG;

  // base formation in "attacking +x" frame (own goal at -x)
  const FORMATION = [
    { role: 'GK',  x: -C.PITCH_W / 2 + 1.5, z: 0 },
    { role: 'DEF', x: -16, z: -6.5 },
    { role: 'DEF', x: -16, z: 6.5 },
    { role: 'MID', x: -4,  z: -10 },
    { role: 'MID', x: -4,  z: 10 },
    { role: 'ATT', x: 9,   z: 0 },
  ];

  const HALF_LENGTH = 135;   // seconds of real time per half
  const BOOST_TYPES = ['sprint', 'shot', 'tackle'];
  const BOOST_LABELS = { sprint: '⚡ SUPER SPRINT', shot: '🔥 SUPER SHOT', tackle: '🛡 SUPER TACKLE' };

  class Team {
    constructor(id, data, attackDir) {
      this.id = id;
      this.data = data;
      this.attackDir = attackDir;
      this.players = [];
      this.score = 0;
      this.boost = null;
      this.boostTimer = 0;
      this.possessionTime = 0;
      this.shots = 0;
    }
  }

  class Match {
    constructor(opts) {
      this.scene = opts.scene;
      this.gfx = opts.gfx;
      this.particles = opts.particles;
      this.stadium = opts.stadium;
      this.camera = opts.camera;
      this.input = opts.input;
      this.audio = opts.audio;
      this.hud = opts.hud;
      this.mode = opts.mode;             // '1p' | '2p' | 'watch'
      this.difficulty = opts.difficulty || 'pro';

      this.dt = 0;
      this.time = 0;
      this.half = 1;
      this.clock = 0;
      this.state = 'kickoff';            // kickoff|play|goal|half|fulltime|paused
      this.stateTimer = 0;
      this.paused = false;

      this.shakeAmt = 0;
      this.camBall = new THREE.Vector3();
      this.camLook = new THREE.Vector3();
      this.camPos = new THREE.Vector3();
      this.camDist = 31;

      this.boostTimer = 16;
      this.boostOrb = null;

      GS.MATCH = this;
      GS.AUDIO = this.audio;

      this._buildTeams(opts.home, opts.away);
      this.ball = new GS.Ball(this.scene, this.particles);
      this.ai = new GS.AIController(this, this.difficulty);

      // who do humans control
      this.humanTeams = [];
      if (this.mode === '1p') this.humanTeams = [{ teamId: 0, slot: 0 }];
      else if (this.mode === '2p') this.humanTeams = [{ teamId: 0, slot: 0 }, { teamId: 1, slot: 1 }];
      this.input.setMode(this.humanTeams.length);

      this.control = [{ active: null, charging: false, charge: 0 }, { active: null, charging: false, charge: 0 }];
      this.humanSet = new Set();

      this._setupKickoff(0);
      this._camInstant();
    }

    _buildTeams(home, away) {
      this.teams = [new Team(0, home, +1), new Team(1, away, -1)];
      const usedNames = new Set();
      const pickName = () => { let n; do { n = U.choice(GS.NAMES); } while (usedNames.has(n) && usedNames.size < GS.NAMES.length); usedNames.add(n); return n; };
      const diff = GS.DIFF[this.difficulty] || GS.DIFF.pro;
      for (const team of this.teams) {
        const d = team.attackDir;
        let num = 1;
        FORMATION.forEach((f, i) => {
          const isGK = f.role === 'GK';
          const p = new GS.Player(this.scene, {
            team: team.data, teamId: team.id, attackDir: d,
            isGK, role: f.role, number: isGK ? 1 : (i + 1),
            name: pickName(),
            homeX: f.x * d, homeZ: f.z,
            speedMul: team.id === 1 && this.mode === '1p' ? diff.speedMul : 1,
          });
          team.players.push(p);
        });
      }
    }

    // ---------------- kickoff / state ----------------
    _setupKickoff(scoredByTeam) {
      // place all players in their own halves
      for (const team of this.teams) {
        const d = team.attackDir;
        team.players.forEach((p, i) => {
          const f = FORMATION[i];
          p.pos.set(f.x * d, 0, f.z);
          p.vel.set(0, 0, 0);
          p.input.x = 0; p.input.z = 0; p.input.sprint = false;
          p.facing = d > 0 ? 0 : Math.PI;
          p.hasBall = false;
          p.root.position.copy(p.pos);
          p.root.position.y = 0;
        });
      }
      // the team that conceded kicks off; nudge one MID to center
      const kicking = this.teams[scoredByTeam != null ? 1 - scoredByTeam : 0];
      const taker = kicking.players[3];
      taker.pos.set(-kicking.attackDir * 1.2, 0, 0.4);
      taker.root.position.copy(taker.pos);
      this.ball.reset(0, 0);
      this.ball.controlledBy = null;
      this.state = 'kickoff';
      this.stateTimer = 1.6;
      this.kickoffTaker = taker;
    }

    _swapEnds() {
      for (const team of this.teams) {
        team.attackDir *= -1;
        team.players.forEach((p, i) => {
          p.attackDir = team.attackDir;
          const f = FORMATION[i];
          p.home.x = f.x * team.attackDir; p.home.z = f.z;
        });
      }
    }

    // ---------------- per-frame ----------------
    update(dt) {
      if (this.paused) return;
      this.dt = dt;
      this.time += dt;

      // state machine
      if (this.state === 'kickoff') {
        this.stateTimer -= dt;
        this.hud.banner('', '');
        if (this.stateTimer <= 0) { this.state = 'play'; this.hud.bannerHide(); }
      } else if (this.state === 'goal') {
        this.stateTimer -= dt;
        if (this.stateTimer <= 0) {
          this.hud.bannerHide();
          if (this._checkFullOrHalf()) { /* handled */ }
          else this._setupKickoff(this._lastScorer);
        }
      } else if (this.state === 'half') {
        this.stateTimer -= dt;
        if (this.stateTimer <= 0) { this.hud.bannerHide(); this._setupKickoff(null); }
      } else if (this.state === 'play') {
        this.clock += dt;
        if (this.clock >= HALF_LENGTH) this._endHalf();
      }

      const playing = this.state === 'play' || this.state === 'kickoff';

      // controls + AI
      this._resolveActivePlayers();
      this._handleHumans(dt);
      for (const team of this.teams) {
        this.ai.driveTeam(team, dt, this.humanSet);
      }
      if (this.state === 'kickoff') this._freezeNonTakers();

      // integrate players
      const bounds = { minX: -C.PITCH_W / 2 - 2.5, maxX: C.PITCH_W / 2 + 2.5, minZ: -C.PITCH_H / 2 + 0.3, maxZ: C.PITCH_H / 2 - 0.3 };
      for (const team of this.teams) for (const p of team.players) p.update(dt, bounds);

      this._playerCollisions();

      // possession & ball
      this._resolvePossession(dt);
      if (this.ball.controlledBy) this._dribble(dt);
      else { this.ball.update(dt); this._ballBodyCollisions(); }

      // boosts
      this._updateBoosts(dt);

      // fx, camera, hud
      this.stadium.update(dt);
      this._updateCamera(dt);
      this._updateHUD(dt);
      this.audio.update(dt);

      // crowd excitement from ball proximity to goals + speed
      const gx = C.PITCH_W / 2;
      const nearGoal = Math.min(Math.abs(this.ball.pos.x - gx), Math.abs(this.ball.pos.x + gx));
      const ex = U.clamp(0.16 + (1 - nearGoal / gx) * 0.5 + this.ball.speed() * 0.012, 0.12, 1);
      this.stadium.setExcitement(U.damp(this.stadium.crowd.mat.uniforms.uExcite.value, ex, 2, dt));

      this.input.endFrame();
    }

    _checkFullOrHalf() {
      // called after goal delay — only continues to kickoff normally
      return false;
    }

    _freezeNonTakers() {
      // during kickoff nobody charges past center until whistle
      for (const team of this.teams) for (const p of team.players) {
        if (p === this.kickoffTaker) continue;
        const d = team.attackDir;
        // keep onside in own half
        if (p.pos.x * d > -0.5) { p.pos.x = -0.6 * d; }
      }
    }

    // ---------------- active player selection ----------------
    _resolveActivePlayers() {
      this.humanSet.clear();
      for (const ht of this.humanTeams) {
        const team = this.teams[ht.teamId];
        let active;
        if (this.ball.controlledBy && this.ball.controlledBy.teamId === team.id && !this.ball.controlledBy.isGK) {
          active = this.ball.controlledBy;
        } else {
          // nearest outfield player to ball
          let best = null, bd = 1e9;
          for (const p of team.players) {
            if (p.isGK) continue;
            const d = U.dist2D(p.pos, this.ball.pos);
            if (d < bd) { bd = d; best = p; }
          }
          active = best;
        }
        this.control[ht.teamId].active = active;
        if (active) this.humanSet.add(active);
        // selection ring
        for (const p of team.players) p.setSelected(p === active && this.state !== 'fulltime', team.id === 0 ? '#27e07f' : '#ff4d6d');
      }
    }

    _handleHumans(dt) {
      for (const ht of this.humanTeams) {
        const slot = this.input.get(ht.slot);
        const team = this.teams[ht.teamId];
        const ctl = this.control[ht.teamId];
        const p = ctl.active;
        if (!p) continue;
        if (this.state !== 'play') {
          // allow kickoff taker to move slightly + take
          if (this.state === 'kickoff' && p === this.kickoffTaker) {
            p.input.x = slot.move.x; p.input.z = slot.move.z; p.input.sprint = false;
            if (slot.pass.pressed || slot.shoot.pressed) { this.state = 'play'; this.hud.bannerHide(); }
          } else { p.input.x = 0; p.input.z = 0; p.input.sprint = false; }
          continue;
        }

        p.input.x = slot.move.x; p.input.z = slot.move.z;
        p.input.sprint = slot.sprint.down;

        const hasBall = this.ball.controlledBy === p;
        if (hasBall) {
          // SHOOT (charge)
          if (slot.shoot.down) {
            ctl.charging = true;
            ctl.charge = U.clamp(slot.shoot.hold / 0.85, 0, 1);
          }
          if (slot.shoot.released) {
            const charge = U.clamp(slot.shoot.holdOnRelease / 0.85, 0, 1);
            this.shoot(p, this._aimDir(p, slot), charge);
            ctl.charging = false; ctl.charge = 0;
          }
          // PASS (tap)
          if (slot.pass.pressed) {
            const mate = this._bestHumanPass(p, slot);
            if (mate) this.passTo(p, mate); else this.shoot(p, this._aimDir(p, slot), 0.45);
          }
        } else {
          ctl.charging = false; ctl.charge = 0;
          // tackle / pressure
          if ((slot.shoot.pressed || slot.pass.pressed) && p.slideTimer <= 0 && (p._tackleCd || 0) <= 0) {
            const aim = this._aimDir(p, slot);
            this.tackle(p, aim);
            p._tackleCd = 0.7;
          }
        }
        if (p._tackleCd > 0) p._tackleCd -= dt;
      }
    }

    _aimDir(p, slot) {
      if (slot && U.len2(slot.move.x, slot.move.z) > 0.35) {
        const l = U.len2(slot.move.x, slot.move.z);
        return { x: slot.move.x / l, z: slot.move.z / l };
      }
      return { x: Math.cos(p.facing), z: Math.sin(p.facing) };
    }

    _bestHumanPass(p, slot) {
      const team = this.teams[p.teamId];
      const aim = this._aimDir(p, slot);
      let best = null, score = -1e9;
      for (const mate of team.players) {
        if (mate === p || mate.isGK) continue;
        const dx = mate.pos.x - p.pos.x, dz = mate.pos.z - p.pos.z;
        const d = U.len2(dx, dz);
        if (d < 2) continue;
        const dot = (dx / d) * aim.x + (dz / d) * aim.z; // alignment with aim
        let openMin = 1e9;
        for (const o of this.teams[1 - p.teamId].players) openMin = Math.min(openMin, U.dist2D(o.pos, mate.pos));
        const s = dot * 6 + openMin * 0.6 - d * 0.05;
        if (s > score) { score = s; best = mate; }
      }
      return best;
    }

    // ---------------- ball actions ----------------
    shoot(p, dir, charge) {
      const team = this.teams[p.teamId];
      const superShot = team.boost === 'shot';
      // a first-time volley on an airborne ball is harder but hits harder
      const volley = this.ball.pos.y > 0.7 && !this.ball.controlledBy;
      const basePow = 17, maxPow = 31;
      let power = U.lerp(basePow, maxPow, charge);
      if (superShot) power *= 1.35;
      if (volley) power *= 1.18;
      // lift: flatter for tap, a bit of loft when charged; volleys stay flat
      let lift = 1.6 + charge * 4.2 + (superShot ? 1.5 : 0);
      if (volley) lift = 1.0 + charge * 1.6;
      // curve from lateral movement at release
      const px = -dir.z, pz = dir.x;
      const lateral = (p.input.x * px + p.input.z * pz);
      const spin = lateral * (2.2 + charge * 2.5);
      // accuracy scatter (worse on volleys, better when charged)
      const acc = p.attr ? p.attr.shootAcc : 0.9;
      const scatter = (1 - acc) * 0.12 * (1 - charge * 0.5) + (volley ? 0.05 : 0);
      const ang = Math.atan2(dir.z, dir.x) + U.rand(-scatter, scatter);
      const sd = { x: Math.cos(ang), z: Math.sin(ang) };

      p.playKick(Math.max(charge, volley ? 0.7 : 0.4), sd.z * p.attackDir >= 0 ? 1 : -1);
      this.ball.kick(sd, power, lift, spin, p.teamId, p);
      this.ball.outCooldown = 0.05;
      this.ball.setFire(superShot);
      team.shots++;
      this.audio.kick(Math.max(charge, volley ? 0.8 : charge));
      this.particles.shotBlast({ x: this.ball.pos.x, y: this.ball.pos.y, z: this.ball.pos.z }, sd);
      if (volley) this.shake(0.3);
      if (superShot) { this.shake(0.5); this.particles.sparkBurst(this.ball.pos, '#ff7a1a'); }
      this._kickCooldownFor(p);
    }

    passTo(p, mate) {
      // lead the receiver: aim where they'll be by the time the ball arrives
      const rough = U.dist2D(p.pos, mate.pos);
      const travel = U.clamp(rough / 20, 0.1, 0.7);
      const tx = mate.pos.x + mate.vel.x * travel;
      const tz = mate.pos.z + mate.vel.z * travel;
      const dx = tx - p.pos.x, dz = tz - p.pos.z;
      const d = U.len2(dx, dz) || 1;
      const dir = { x: dx / d, z: dz / d };

      // is an opponent blocking the ground lane? if so, lift it over them
      let blocked = false;
      for (const o of this.teams[1 - p.teamId].players) {
        if (U.distToSeg2D(o.pos.x, o.pos.z, p.pos.x, p.pos.z, tx, tz) < 1.1 &&
            U.dist2D(o.pos, p.pos) < d - 1) { blocked = true; break; }
      }
      const power = U.clamp(d * 1.16, 12, 27);
      const lift = blocked ? U.clamp(d * 0.42, 5, 9) : (d > 16 ? 3.0 : 1.3);
      // tiny outswing so passes bend into the runner's path
      const px = -dir.z, pz = dir.x;
      const spin = (mate.vel.x * px + mate.vel.z * pz) * 0.25;

      p.playKick(blocked ? 0.5 : 0.3);
      this.ball.kick(dir, power, lift, spin, p.teamId, p);
      this.ball.setFire(false);
      this.audio.pass();
      this.particles.grassKick(this.ball.pos, this.ball.vel);
      this._kickCooldownFor(p);
      mate._reactT = 0;
    }

    aiShoot(p) {
      const dir = { x: Math.cos(p.facing), z: Math.sin(p.facing) };
      // aim toward goal centre-ish with attribute accuracy
      const goalX = p.attackDir * (C.PITCH_W / 2);
      const tz = U.clamp((Math.random() - 0.5) * (C.GOAL_W - 0.8), -C.GOAL_W / 2 + 0.4, C.GOAL_W / 2 - 0.4);
      const ddx = goalX - p.pos.x, ddz = tz - p.pos.z;
      const dl = U.len2(ddx, ddz);
      const acc = this.ai.diff.shootAcc;
      const scatter = (1 - acc) * 0.16;
      const ang = Math.atan2(ddz, ddx) + U.rand(-scatter, scatter);
      const sd = { x: Math.cos(ang), z: Math.sin(ang) };
      const charge = U.clamp(dl / this.ai.diff.shootRange, 0.4, 1);
      p.facing = ang;
      this.shoot(p, sd, charge);
    }

    aiPass(p, mate) { this.passTo(p, mate); }

    aiTackle(p, dir) { this.tackle(p, { x: dir.x, z: dir.z }); }

    tackle(p, dir) {
      const l = U.len2(dir.x, dir.z) || 1;
      const v = new THREE.Vector3(dir.x / l, 0, dir.z / l);
      p.playSlide(v);
      if (this.teams[p.teamId].boost === 'tackle') p.vel.addScaledVector(v, 4);
      this.audio.tackle();
      this.particles.slideDust(p.pos);
    }

    _kickCooldownFor(p) {
      p._kickCd = 0.32;
      this.ball.controlledBy = null;
    }

    // ---------------- possession ----------------
    _resolvePossession(dt) {
      const ball = this.ball;
      // decay kick cooldowns
      for (const team of this.teams) for (const p of team.players) {
        if (p._kickCd > 0) p._kickCd -= dt;
        p.hasBall = (ball.controlledBy === p);
      }
      if (ball.controlledBy) {
        // can a slide-tackling opponent steal?
        for (const o of this.teams[1 - ball.controlledBy.teamId].players) {
          if (o.slideTimer > 0 && U.dist2D(o.pos, ball.pos) < 1.3 && (o._kickCd || 0) <= 0) {
            // steal
            ball.controlledBy.stun(0.5);
            this._giveBall(o);
            this.particles.slideDust(o.pos);
            this.audio.tackle();
            return;
          }
        }
        return;
      }
      if (ball.outCooldown > 0) return;
      // ground-ish ball can be collected
      if (ball.pos.y > 1.5) return;
      let best = null, bd = C.CONTROL_R + 0.2;
      for (const team of this.teams) for (const p of team.players) {
        if ((p._kickCd || 0) > 0) continue;
        if (p.stunTimer > 0) continue;
        const d = U.dist2D(p.pos, ball.pos);
        // sliding players have a longer reach
        const reach = p.slideTimer > 0 ? C.CONTROL_R + 0.7 : C.CONTROL_R;
        if (d < reach && d < bd) { bd = d; best = p; }
      }
      if (best) {
        // fast ball needs a controlling "trap"; sometimes deflects
        const sp = ball.speed();
        if (sp > 16 && best.slideTimer <= 0 && Math.random() < 0.4) {
          // heavy touch: deflect ball, no clean control
          const ang = U.rand(0, Math.PI * 2);
          ball.vel.x = Math.cos(ang) * sp * 0.4;
          ball.vel.z = Math.sin(ang) * sp * 0.4;
          ball.lastTouch = best.teamId;
          ball.outCooldown = 0.18;
          return;
        }
        this._giveBall(best);
      }
    }

    // loose ball physically deflects off players that can't trap it right now
    _ballBodyCollisions() {
      const ball = this.ball;
      if (ball.controlledBy) return;
      if (ball.pos.y > 1.7) return;            // sailing over heads
      const minD = C.PLAYER_R + ball.radius;
      for (const team of this.teams) for (const p of team.players) {
        const canControl = (p._kickCd || 0) <= 0 && p.stunTimer <= 0 && p.fallTimer <= 0;
        if (canControl) continue;              // those are handled by possession
        const dx = ball.pos.x - p.pos.x, dz = ball.pos.z - p.pos.z;
        const d = U.len2(dx, dz);
        if (d < minD && d > 1e-4) {
          const nx = dx / d, nz = dz / d;
          ball.pos.x = p.pos.x + nx * minD;
          ball.pos.z = p.pos.z + nz * minD;
          const vn = ball.vel.x * nx + ball.vel.z * nz;
          if (vn < 0) { ball.vel.x -= 1.6 * vn * nx; ball.vel.z -= 1.6 * vn * nz; }
          ball.vel.x += p.vel.x * 0.3; ball.vel.z += p.vel.z * 0.3;
          ball.outCooldown = Math.max(ball.outCooldown, 0.12);
          if (ball.speed() > 6 && GS.AUDIO) GS.AUDIO.bounce(ball.speed());
        }
      }
    }

    _giveBall(p) {
      this.ball.controlledBy = p;
      this.ball.lastTouch = p.teamId;
      this.ball.lastToucher = p;
      this.ball.vel.set(0, 0, 0);
      this.ball.setFire(false);
      p._kickCd = 0;
      if (p.isGK) this._gkHold(p);
    }

    _dribble(dt) {
      const p = this.ball.controlledBy;
      if (!p) return;
      // control point ahead of feet in facing dir; sprinting => heavier touch
      const ahead = (this.ball.radius + 0.55) + (p.input.sprint ? p.speedFrac * 0.7 : p.speedFrac * 0.25);
      const fx = Math.cos(p.facing), fz = Math.sin(p.facing);
      const tx = p.pos.x + fx * ahead;
      const tz = p.pos.z + fz * ahead;
      this.ball.pos.x = U.damp(this.ball.pos.x, tx, 18, dt);
      this.ball.pos.z = U.damp(this.ball.pos.z, tz, 18, dt);
      this.ball.pos.y = this.ball.radius;
      // velocity for rolling visual
      this.ball.vel.set(p.vel.x, 0, p.vel.z);
      this.ball.angVel.set(-p.vel.z / this.ball.radius, 0, p.vel.x / this.ball.radius);
      this.ball.mesh.rotation.x += this.ball.angVel.x * dt;
      this.ball.mesh.rotation.z += this.ball.angVel.z * dt;
      this.ball._sync();
    }

    tryGKCatch(gk) {
      const ball = this.ball;
      if (ball.controlledBy) return;
      if ((gk._kickCd || 0) > 0) return;
      const d = U.dist2D(gk.pos, ball.pos);
      if (d < 1.6 && ball.pos.y < 2.4 && ball.speed() < 30) {
        // chance to catch vs parry depending on difficulty/speed
        const catchChance = 0.6 + this.ai.diff.anticip * 0.4 - ball.speed() * 0.01;
        if (Math.random() < catchChance) {
          this._giveBall(gk);
          this.audio.catchBall();
          this.particles.slideDust(gk.pos);
        } else {
          // parry away
          const ang = gk.facing + U.rand(-0.6, 0.6);
          ball.vel.x = Math.cos(ang) * 12;
          ball.vel.z = Math.sin(ang) * 12;
          ball.vel.y = 5;
          ball.outCooldown = 0.2;
          this.audio.catchBall();
        }
      }
    }

    _gkHold(gk) {
      // GK holds briefly then distributes upfield
      gk._holdT = 0.9;
      gk._distribute = true;
    }

    // ---------------- collisions ----------------
    _playerCollisions() {
      const all = [];
      for (const team of this.teams) for (const p of team.players) all.push(p);
      const minD = C.PLAYER_R * 2;
      for (let i = 0; i < all.length; i++) {
        for (let j = i + 1; j < all.length; j++) {
          const a = all[i], b = all[j];
          let dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
          let d = U.len2(dx, dz);
          if (d < minD && d > 1e-4) {
            const push = (minD - d) * 0.5;
            const nx = dx / d, nz = dz / d;
            // a sliding player bowls an opponent over (full knock-down + getup)
            const aSlide = a.slideTimer > 0, bSlide = b.slideTimer > 0;
            if (aSlide && !bSlide && a.teamId !== b.teamId && b.fallTimer <= 0) {
              b.knockDown({ x: nx, y: 0, z: nz }, 5.5);
            } else if (bSlide && !aSlide && a.teamId !== b.teamId && a.fallTimer <= 0) {
              a.knockDown({ x: -nx, y: 0, z: -nz }, 5.5);
            } else if (!aSlide && !bSlide) {
              // shoulder-to-shoulder jostle: faster/heavier player nudges the other
              const sa = U.len2(a.vel.x, a.vel.z), sb = U.len2(b.vel.x, b.vel.z);
              if (Math.abs(sa - sb) > 4 && a.teamId !== b.teamId) {
                (sa > sb ? b : a).stun(0.18);
              }
            }
            a.pos.x -= nx * push; a.pos.z -= nz * push;
            b.pos.x += nx * push; b.pos.z += nz * push;
          }
        }
      }
    }

    // ---------------- scoring ----------------
    onGoalScored(side) {
      if (this.state !== 'play' && this.state !== 'kickoff') return;
      // side>0 -> ball entered +x goal -> team attacking +x scores
      const scorer = side > 0 ? this.teams.find(t => t.attackDir > 0) : this.teams.find(t => t.attackDir < 0);
      // own goal credit
      const scorerTeam = scorer.id;
      scorer.score++;
      this._lastScorer = scorerTeam;
      this.state = 'goal';
      this.stateTimer = 3.6;

      // net ripple + fx
      const dir = new THREE.Vector3(side, 0.2, U.rand(-0.4, 0.4)).normalize();
      this.stadium.netImpulse(side, this.ball.pos.clone(), dir, 14);
      this.particles.confettiBurst({ x: side * (C.PITCH_W / 2 - 4), y: 10, z: 0 }, [this.teams[scorerTeam].data.c1, this.teams[scorerTeam].data.c2]);
      for (let i = 0; i < 4; i++) {
        setTimeout(() => this.particles.firework(
          new THREE.Vector3(U.rand(-20, 20), U.rand(8, 16), U.rand(-12, 12)),
          U.choice([this.teams[scorerTeam].data.c1, '#ffd23f', '#ffffff'])), i * 220);
      }
      this.audio.goal();
      this.shake(1.2);
      this.ball.setFire(false);

      // celebration
      const sc = this.teams[scorerTeam];
      for (const p of sc.players) if (!p.isGK) p.celebrate();
      if (this.ball.lastToucher && this.ball.lastToucher.teamId === scorerTeam)
        this._lastScorerName = this.ball.lastToucher.name;
      else this._lastScorerName = U.choice(sc.players.filter(p => !p.isGK)).name;

      this.hud.score(this.teams[0].score, this.teams[1].score);
      this.hud.banner('GOAL!', this._lastScorerName + ' • ' + sc.data.name);
    }

    _endHalf() {
      if (this.half >= 2) { this._fullTime(); return; }
      this.half = 2;
      this.clock = 0;
      this.state = 'half';
      this.stateTimer = 3.0;
      this._swapEnds();
      this.hud.banner('HALF TIME', this.teams[0].score + ' – ' + this.teams[1].score);
    }

    _fullTime() {
      this.state = 'fulltime';
      this.audio.whistle(3, true);
      for (const team of this.teams) for (const p of team.players) { p.input.x = 0; p.input.z = 0; }
      // winner celebrates
      const a = this.teams[0].score, b = this.teams[1].score;
      let winId = a === b ? -1 : (a > b ? 0 : 1);
      if (winId >= 0) for (const p of this.teams[winId].players) if (!p.isGK) p.celebrate(0);
      const totalPoss = this.teams[0].possessionTime + this.teams[1].possessionTime + 0.001;
      this.hud.fulltime({
        a, b,
        nameA: this.teams[0].data.name, nameB: this.teams[1].data.name,
        result: winId < 0 ? 'Draw' : (this.teams[winId].data.name + ' Win'),
        shotsA: this.teams[0].shots, shotsB: this.teams[1].shots,
        possA: Math.round(this.teams[0].possessionTime / totalPoss * 100),
        possB: Math.round(this.teams[1].possessionTime / totalPoss * 100),
      });
    }

    // ---------------- boosts ----------------
    _updateBoosts(dt) {
      // possession timer
      if (this.ball.controlledBy) this.teams[this.ball.controlledBy.teamId].possessionTime += dt;

      // gk distribution
      for (const team of this.teams) for (const gk of team.players) {
        if (gk.isGK && gk._distribute && this.ball.controlledBy === gk) {
          gk._holdT -= dt;
          // face upfield
          gk.faceTo(gk.attackDir * 10, U.rand(-8, 8), dt, 6);
          if (gk._holdT <= 0) {
            const mate = this.ai._bestPassTarget(gk) || gk;
            const dir = { x: gk.attackDir, z: U.rand(-0.4, 0.4) };
            this.ball.kick(dir, 24, 6, 0, team.id, gk);
            gk._distribute = false;
            gk._kickCd = 0.4;
            this.ball.controlledBy = null;
            this.audio.kick(0.6);
          }
        }
      }

      // team boost timers
      for (const team of this.teams) {
        if (team.boostTimer > 0) {
          team.boostTimer -= dt;
          if (team.boostTimer <= 0) {
            team.boost = null;
            for (const p of team.players) p.setBoost(null, 0);
            this.hud.boost(team.id, null);
          }
        }
      }

      if (this.state !== 'play') return;
      // spawn orb
      if (!this.boostOrb) {
        this.boostTimer -= dt;
        if (this.boostTimer <= 0) this._spawnBoostOrb();
      } else {
        this._updateBoostOrb(dt);
      }
    }

    _spawnBoostOrb() {
      const type = U.choice(BOOST_TYPES);
      const x = U.rand(-18, 18), z = U.rand(-14, 14);
      const colorMap = { sprint: 0x48e0ff, shot: 0xff7a1a, tackle: 0x27e07f };
      const g = new THREE.Group();
      const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.5, 0),
        new THREE.MeshToonMaterial({ color: colorMap[type], gradientMap: U.toonGradient([0.6, 0.85, 1]), emissive: colorMap[type], emissiveIntensity: 0.4 }));
      g.add(core);
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({
        map: U.glowTexture('rgba(255,255,255,0.9)', 'rgba(255,255,255,0.2)'),
        color: colorMap[type], blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
      }));
      halo.scale.set(2.4, 2.4, 1);
      g.add(halo);
      g.position.set(x, 1.1, z);
      this.scene.add(g);
      this.boostOrb = { group: g, core, halo, type, color: colorMap[type], pos: new THREE.Vector3(x, 1.1, z), spin: 0 };
    }

    _updateBoostOrb(dt) {
      const o = this.boostOrb;
      o.spin += dt;
      o.core.rotation.y = o.spin * 2;
      o.core.rotation.x = o.spin;
      o.group.position.y = 1.1 + Math.sin(o.spin * 2) * 0.2;
      const s = 2.4 + Math.sin(o.spin * 4) * 0.3;
      o.halo.scale.set(s, s, 1);
      this.particles.pickupAura(o.pos, '#ffffff');
      // pickup
      let grabber = null;
      for (const team of this.teams) for (const p of team.players) {
        if (U.dist2D(p.pos, o.pos) < 1.3) { grabber = p; break; }
        if (grabber) break;
      }
      if (grabber) {
        const team = this.teams[grabber.teamId];
        team.boost = o.type;
        team.boostTimer = 8.5;
        for (const p of team.players) p.setBoost(o.type === 'sprint' ? 'sprint' : null, 8.5);
        this.hud.boost(team.id, BOOST_LABELS[o.type]);
        this.audio.powerup();
        this.particles.sparkBurst(o.pos, '#' + o.color.toString(16).padStart(6, '0'));
        this.scene.remove(o.group);
        this.boostOrb = null;
        this.boostTimer = U.rand(14, 22);
      }
    }

    // ---------------- camera ----------------
    _camInstant() {
      this.camBall.copy(this.ball.pos);
      this._updateCamera(0.001, true);
      this.camera.position.copy(this.camPos);
      this.camera.lookAt(this.camLook);
    }

    shake(a) { this.shakeAmt = Math.min(this.shakeAmt + a, 1.6); }

    _updateCamera(dt, instant) {
      // close, angled chase cam that follows the ball across the whole pitch
      const ball = this.ball;
      const fx = ball.controlledBy ? ball.controlledBy.pos.x : ball.pos.x;
      const fz = ball.controlledBy ? ball.controlledBy.pos.z : ball.pos.z;
      // lead the camera in the direction the ball is travelling
      const leadX = U.clamp(ball.vel.x * 0.16, -6, 6);
      const leadZ = U.clamp(ball.vel.z * 0.12, -4, 4);
      const k = instant ? 999 : 3.4;
      this.camBall.x = U.damp(this.camBall.x, fx + leadX, k, dt);
      this.camBall.z = U.damp(this.camBall.z, U.clamp(fz + leadZ, -C.PITCH_H / 2 + 2, C.PITCH_H / 2 - 2), k * 0.8, dt);

      // dynamic zoom: pull back when the ball is fast
      const sp = ball.speed();
      const want = 30 + U.clamp(sp * 0.45, 0, 11);
      this.camDist = U.damp(this.camDist || 31, want, 2, dt);
      const dist = this.camDist;

      // ~38° downward, sitting behind the play on +z — keeps a consistent
      // orientation (good for 2P) while still feeling like a chase cam
      const camX = this.camBall.x * 0.96;
      const camY = dist * 0.62;
      const camZ = this.camBall.z + dist * 0.82;
      this.camPos.set(camX, camY, camZ);
      this.camLook.set(this.camBall.x, 1.1, this.camBall.z - dist * 0.16);

      // shake
      if (this.shakeAmt > 0.001) {
        const s = this.shakeAmt;
        this.camPos.x += U.rand(-1, 1) * s;
        this.camPos.y += U.rand(-1, 1) * s * 0.6;
        this.camPos.z += U.rand(-1, 1) * s * 0.4;
        this.camLook.x += U.rand(-1, 1) * s * 0.5;
        this.shakeAmt = Math.max(0, this.shakeAmt - dt * 2.4);
      }

      this.camera.position.lerp(this.camPos, instant ? 1 : U.clamp(dt * 7, 0, 1));
      this.camera.lookAt(this.camLook);
    }

    // ---------------- HUD ----------------
    _updateHUD(dt) {
      const disp = this.half === 1 ? this.clock : HALF_LENGTH + this.clock;
      const mins = Math.floor((disp / (HALF_LENGTH * 2)) * 90);
      const secs = Math.floor((disp / (HALF_LENGTH * 2) * 90 % 1) * 60);
      this.hud.clock(
        (mins < 10 ? '0' + mins : mins) + ':' + (secs < 10 ? '0' + secs : secs),
        this.half === 1 ? '1st half' : '2nd half');

      // power bar for charging human
      let charging = null;
      for (const ht of this.humanTeams) {
        const c = this.control[ht.teamId];
        if (c.charging) charging = c.charge;
      }
      this.hud.power(charging);
    }

    setPaused(v) { this.paused = v; }

    dispose() {
      for (const team of this.teams) for (const p of team.players) p.dispose();
      if (this.boostOrb) this.scene.remove(this.boostOrb.group);
    }
  }

  GS.Match = Match;
})();
