/* GOALSTORM — ai.js
 * Per-player AI: role-aware decisions (chase, mark, support, dribble,
 * shoot, pass, goalkeep) layered over a team formation that slides with
 * the ball. Difficulty scales reaction, accuracy and aggression.
 */
window.GS = window.GS || {};
(function () {
  'use strict';
  const U = GS.U, C = GS.CFG;

  const DIFF = {
    easy:   { react: 0.26, speedMul: 0.92, shootAcc: 0.7,  pass: 0.78, aggression: 0.7,  anticip: 0.3, shootRange: 17 },
    pro:    { react: 0.15, speedMul: 1.0,  shootAcc: 0.85, pass: 0.9,  aggression: 0.9,  anticip: 0.55, shootRange: 21 },
    legend: { react: 0.07, speedMul: 1.06, shootAcc: 0.95, pass: 0.97, aggression: 1.0,  anticip: 0.8, shootRange: 25 },
  };

  class AIController {
    constructor(match, difficulty) {
      this.match = match;
      this.setDifficulty(difficulty);
      this._tmp = new THREE.Vector3();
    }

    setDifficulty(d) { this.diff = DIFF[d] || DIFF.pro; }

    // main entry: drive every CPU player on the given team
    driveTeam(team, dt, humanControlledSet) {
      const m = this.match;
      const ball = m.ball;
      const weHaveBall = ball.controlledBy && ball.controlledBy.teamId === team.id;
      const ballLoose = !ball.controlledBy;

      // pick the team's "active" responder (closest field player to ball)
      let responder = null, bestD = 1e9;
      for (const p of team.players) {
        if (p.isGK) continue;
        if (humanControlledSet && humanControlledSet.has(p)) continue;
        const d = U.dist2D(p.pos, ball.pos);
        if (d < bestD) { bestD = d; responder = p; }
      }

      for (const p of team.players) {
        if (humanControlledSet && humanControlledSet.has(p)) continue;
        if (p.isGK) { this._goalkeeper(p, dt); continue; }
        if (p === ball.controlledBy) { this._withBall(p, dt); continue; }
        if (p === responder && (ballLoose || !weHaveBall)) { this._chase(p, dt); continue; }
        this._support(p, dt, weHaveBall);
      }
    }

    _react(p) {
      // emulate reaction lag: occasionally hold last decision
      p._reactT = (p._reactT || 0) - this.match.dt;
      if (p._reactT <= 0) { p._reactT = this.diff.react * U.rand(0.6, 1.4); return true; }
      return false;
    }

    _moveTo(p, x, z, sprint) {
      const dx = x - p.pos.x, dz = z - p.pos.z;
      const d = U.len2(dx, dz);
      if (d < 0.15) { p.input.x = 0; p.input.z = 0; p.input.sprint = false; return d; }
      p.input.x = dx / d; p.input.z = dz / d;
      p.input.sprint = !!sprint && d > 3;
      return d;
    }

    _goalDir(p) { return p.attackDir; } // +1 -> attack +x goal

    _withBall(p, dt) {
      const m = this.match, ball = m.ball;
      const dir = p.attackDir;
      const goalX = dir * (C.PITCH_W / 2);
      const distToGoal = Math.abs(goalX - p.pos.x);

      // find pressure
      const opp = m.teams[1 - p.teamId];
      let nearOpp = null, nd = 1e9;
      for (const o of opp.players) {
        const d = U.dist2D(o.pos, p.pos);
        if (d < nd) { nd = d; nearOpp = o; }
      }
      const pressured = nd < 2.6;

      // shoot if in range and roughly facing goal
      const inRange = distToGoal < this.diff.shootRange &&
        Math.abs(p.pos.z) < C.PITCH_H / 2 - 1;
      const goodAngle = Math.abs(p.pos.z) < C.GOAL_W * 1.4 + (this.diff.shootRange - distToGoal) * 0.4;
      if (inRange && goodAngle && (pressured || distToGoal < 12 || Math.random() < 0.02)) {
        if (this._react(p)) { m.aiShoot(p); return; }
      }

      // pass if pressured and a good option exists
      if (pressured && this._react(p)) {
        const mate = this._bestPassTarget(p);
        if (mate) { m.aiPass(p, mate); return; }
      }

      // otherwise dribble toward goal, steering around nearest opponent
      let tx = goalX, tz = U.clamp(p.pos.z * 0.6, -C.GOAL_W, C.GOAL_W);
      if (nearOpp && nd < 4) {
        // veer away from defender's side
        const side = U.sign(p.pos.z - nearOpp.pos.z || U.rand(-1, 1));
        tz += side * 3.5;
        tz = U.clamp(tz, -C.PITCH_H / 2 + 2, C.PITCH_H / 2 - 2);
      }
      this._moveTo(p, tx, tz, distToGoal > 14 && !pressured);
      p.faceTo(goalX, p.pos.z, dt, 10);
    }

    _bestPassTarget(p) {
      const m = this.match;
      const team = m.teams[p.teamId];
      const dir = p.attackDir;
      let best = null, score = -1e9;
      for (const mate of team.players) {
        if (mate === p || mate.isGK) continue;
        const ahead = (mate.pos.x - p.pos.x) * dir; // positive = forward
        const d = U.dist2D(mate.pos, p.pos);
        if (d < 3 || d > 32) continue;
        // openness: distance to nearest opponent
        let openMin = 1e9;
        for (const o of m.teams[1 - p.teamId].players) {
          openMin = Math.min(openMin, U.dist2D(o.pos, mate.pos));
        }
        const s = ahead * 1.4 + openMin * 1.2 - d * 0.15;
        if (s > score) { score = s; best = mate; }
      }
      return best;
    }

    _chase(p, dt) {
      const m = this.match, ball = m.ball;
      // anticipate ball position
      const lead = this.diff.anticip;
      this._tmp.set(ball.pos.x + ball.vel.x * lead, 0, ball.pos.z + ball.vel.z * lead);
      const d = this._moveTo(p, this._tmp.x, this._tmp.z, true);

      // try to win it: tackle when very close to opponent carrier
      if (ball.controlledBy && ball.controlledBy.teamId !== p.teamId) {
        const dc = U.dist2D(p.pos, ball.controlledBy.pos);
        if (dc < 1.7 && this.diff.aggression > Math.random()) {
          if (p.slideTimer <= 0 && p._tackleCd == null || p._tackleCd <= 0) {
            const dir = new THREE.Vector3(ball.controlledBy.pos.x - p.pos.x, 0, ball.controlledBy.pos.z - p.pos.z);
            m.aiTackle(p, dir);
            p._tackleCd = 1.2;
          }
        }
      }
      if (p._tackleCd > 0) p._tackleCd -= dt;
    }

    _support(p, dt, weHaveBall) {
      const m = this.match, ball = m.ball;
      const dir = p.attackDir;
      // formation slides toward ball along x, biased by role
      const ballX = ball.pos.x, ballZ = ball.pos.z;
      const roleBias = p.role === 'DEF' ? -0.5 : p.role === 'ATT' ? 0.5 : 0.05;
      let tx = U.lerp(p.home.x, p.home.x + dir * 14, U.clamp((ballX * dir) / (C.PITCH_W / 2) * 0.5 + 0.5, 0, 1));
      tx += dir * roleBias * 4;
      // shift toward ball's z lane a little, keep formation width
      let tz = U.lerp(p.home.z, ballZ, 0.28);

      if (weHaveBall) {
        // make attacking runs: push forward, spread
        if (p.role === 'ATT' || p.role === 'MID') {
          tx = U.clamp(ballX + dir * U.rand(5, 11), -C.PITCH_W / 2 + 3, C.PITCH_W / 2 - 3);
          tz = U.clamp(p.home.z * 0.7 + ballZ * 0.2, -C.PITCH_H / 2 + 3, C.PITCH_H / 2 - 3);
        }
      } else {
        // defend: drop between ball and own goal, mark space
        const ownGoalX = -dir * (C.PITCH_W / 2);
        tx = U.lerp(ballX, ownGoalX, 0.32) + dir * roleBias * 6;
        tz = U.lerp(p.home.z, ballZ, 0.4);
      }

      tx = U.clamp(tx, -C.PITCH_W / 2 + 1.5, C.PITCH_W / 2 - 1.5);
      tz = U.clamp(tz, -C.PITCH_H / 2 + 1.5, C.PITCH_H / 2 - 1.5);
      p.formation.x = tx; p.formation.z = tz;
      const d = this._moveTo(p, tx, tz, U.dist2D(p.pos, { x: tx, z: tz }) > 8);
      // face the ball when idle-ish
      if (d < 1.2) p.faceTo(ball.pos.x, ball.pos.z, dt, 8);
    }

    _goalkeeper(p, dt) {
      const m = this.match, ball = m.ball;
      const dir = p.attackDir;            // GK defends the -dir goal? No: GK on own goal
      const goalX = -p.attackDir * (C.PITCH_W / 2); // own goal line
      // stay on a short arc in front of goal, track ball z
      const targetZ = U.clamp(ball.pos.z * 0.65, -C.GOAL_W / 2 + 0.4, C.GOAL_W / 2 - 0.4);
      let standX = goalX + p.attackDir * 1.4;

      const ballComing = (ball.vel.x * (-p.attackDir)) > 2; // moving toward our goal
      const ballNear = Math.abs(ball.pos.x - goalX) < 16;

      // rush out if ball is loose and close, or attacker bearing down inside box
      const inBox = Math.abs(ball.pos.x - goalX) < C.BOX_D + 1 && Math.abs(ball.pos.z) < C.BOX_W / 2;
      if (inBox && (!ball.controlledBy || ball.controlledBy.teamId !== p.teamId)) {
        const d = this._moveTo(p, ball.pos.x, ball.pos.z, true);
        // dive/parry happens automatically via possession when close
        if (d < 1.4 && m.tryGKCatch) m.tryGKCatch(p);
        return;
      }

      // shot-stopping: predict crossing point at the goal line
      if (ballComing && ballNear) {
        const t = Math.abs((ball.pos.x - standX) / (ball.vel.x || 0.01));
        const predZ = ball.pos.z + ball.vel.z * t;
        const tz = U.clamp(predZ, -C.GOAL_W / 2 - 0.6, C.GOAL_W / 2 + 0.6);
        this._moveTo(p, standX, tz, true);
        if (m.tryGKCatch) m.tryGKCatch(p);
      } else {
        this._moveTo(p, standX, targetZ, false);
      }
      p.faceTo(ball.pos.x, ball.pos.z, dt, 9);
    }
  }

  GS.AIController = AIController;
  GS.DIFF = DIFF;
})();
