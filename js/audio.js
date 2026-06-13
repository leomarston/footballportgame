/* GOALSTORM — audio.js
 * Fully procedural WebAudio sound engine: crowd bed, kicks, whistle,
 * goal roars, posts, UI. No audio files required.
 */
window.GS = window.GS || {};
(function () {
  'use strict';
  const U = GS.U;

  class AudioEngine {
    constructor() {
      this.ctx = null;
      this.master = null;
      this.muted = false;
      this.excite = 0.15;       // crowd excitement 0..1
      this.exciteTarget = 0.15;
      this._noiseBuf = null;
      this._crowd = null;
      this._chantT = 8;
    }

    init() {
      if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.9;
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -14; comp.ratio.value = 4;
      this.master.connect(comp);
      comp.connect(this.ctx.destination);
      this._makeNoise();
      this._startCrowd();
    }

    setMuted(m) {
      this.muted = m;
      if (this.master) this.master.gain.value = m ? 0 : 0.9;
    }

    _makeNoise() {
      const len = this.ctx.sampleRate * 2;
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      let b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < len; i++) {
        // pink-ish noise
        const w = Math.random() * 2 - 1;
        b0 = 0.997 * b0 + 0.029 * w;
        b1 = 0.985 * b1 + 0.032 * w;
        b2 = 0.95 * b2 + 0.048 * w;
        d[i] = (b0 + b1 + b2 + w * 0.05) * 0.55;
      }
      this._noiseBuf = buf;
    }

    _startCrowd() {
      const ctx = this.ctx;
      const src = ctx.createBufferSource();
      src.buffer = this._noiseBuf; src.loop = true;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 700; bp.Q.value = 0.5;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 2400;
      const gain = ctx.createGain();
      gain.gain.value = 0.05;
      src.connect(bp); bp.connect(lp); lp.connect(gain); gain.connect(this.master);
      src.start();
      this._crowd = { gain, bp, lp, wob: 0 };
    }

    update(dt) {
      if (!this.ctx || !this._crowd) return;
      this.excite = U.damp(this.excite, this.exciteTarget, 1.6, dt);
      // slow random wobble so the crowd feels alive
      this._crowd.wob += dt * 0.5;
      const wob = Math.sin(this._crowd.wob) * 0.35 + Math.sin(this._crowd.wob * 2.7) * 0.2;
      const e = this.excite;
      this._crowd.gain.gain.value = (this.muted ? 0 : 1) * (0.035 + e * 0.16 + wob * 0.012 * (0.4 + e));
      this._crowd.bp.frequency.value = 550 + e * 900;
      this._crowd.lp.frequency.value = 1800 + e * 3800;
      // drift excitement back to ambient
      this.exciteTarget = U.damp(this.exciteTarget, 0.16, 0.12, dt);
      // occasional crowd drum thumps when excited
      this._chantT -= dt;
      if (this._chantT <= 0) {
        this._chantT = U.rand(5, 11) - this.excite * 3;
        if (this.excite > 0.25) this._drumRoll();
      }
    }

    bump(amount) { this.exciteTarget = U.clamp(this.exciteTarget + amount, 0, 1); }

    _env(node, t0, a, peak, d, end) {
      node.gain.setValueAtTime(0.0001, t0);
      node.gain.linearRampToValueAtTime(peak, t0 + a);
      node.gain.exponentialRampToValueAtTime(Math.max(end || 0.0001, 0.0001), t0 + a + d);
    }

    _noiseHit(freq, q, peak, dur, type) {
      if (!this.ctx) return;
      const ctx = this.ctx, t = ctx.currentTime;
      const src = ctx.createBufferSource();
      src.buffer = this._noiseBuf;
      src.playbackRate.value = U.rand(0.85, 1.15);
      const f = ctx.createBiquadFilter();
      f.type = type || 'bandpass'; f.frequency.value = freq; f.Q.value = q;
      const g = ctx.createGain();
      this._env(g, t, 0.004, peak, dur);
      src.connect(f); f.connect(g); g.connect(this.master);
      src.start(t, U.rand(0, 1.5)); src.stop(t + dur + 0.1);
    }

    _tone(freq, peak, dur, type, slideTo) {
      if (!this.ctx) return;
      const ctx = this.ctx, t = ctx.currentTime;
      const o = ctx.createOscillator();
      o.type = type || 'sine';
      o.frequency.setValueAtTime(freq, t);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
      const g = ctx.createGain();
      this._env(g, t, 0.005, peak, dur);
      o.connect(g); g.connect(this.master);
      o.start(t); o.stop(t + dur + 0.1);
    }

    kick(power) {
      // thump + leather snap
      this._tone(95 + power * 40, 0.5 + power * 0.4, 0.12, 'sine', 40);
      this._noiseHit(1800, 1.2, 0.25 + power * 0.3, 0.07);
    }

    pass() {
      this._tone(120, 0.3, 0.08, 'sine', 60);
      this._noiseHit(1400, 1.5, 0.16, 0.05);
    }

    bounce(v) {
      const p = U.clamp(v / 18, 0.1, 1);
      this._tone(110, 0.16 * p, 0.07, 'sine', 55);
      this._noiseHit(900, 1, 0.08 * p, 0.05);
    }

    post() {
      // metallic clank
      this._tone(880, 0.4, 0.4, 'triangle');
      this._tone(1320, 0.25, 0.35, 'triangle');
      this._tone(2210, 0.12, 0.28, 'sine');
      this.bump(0.35);
    }

    catchBall() { this._noiseHit(500, 0.8, 0.3, 0.09, 'lowpass'); }

    tackle() {
      this._noiseHit(300, 0.7, 0.5, 0.12, 'lowpass');
      this._tone(70, 0.45, 0.13, 'sine', 38);
    }

    whistle(n, long) {
      if (!this.ctx) return;
      const ctx = this.ctx;
      for (let i = 0; i < (n || 1); i++) {
        const t = ctx.currentTime + i * 0.34;
        const dur = long && i === (n - 1) ? 0.85 : 0.22;
        const o = ctx.createOscillator();
        o.type = 'square';
        o.frequency.value = 2350;
        const vib = ctx.createOscillator();
        vib.frequency.value = 38;
        const vibG = ctx.createGain(); vibG.gain.value = 160;
        vib.connect(vibG); vibG.connect(o.frequency);
        const f = ctx.createBiquadFilter();
        f.type = 'bandpass'; f.frequency.value = 2400; f.Q.value = 3;
        const g = ctx.createGain();
        this._env(g, t, 0.01, 0.16, dur);
        o.connect(f); f.connect(g); g.connect(this.master);
        o.start(t); o.stop(t + dur + 0.1);
        vib.start(t); vib.stop(t + dur + 0.1);
      }
    }

    goal() {
      this.bump(1.0);
      if (!this.ctx) return;
      const ctx = this.ctx, t = ctx.currentTime;
      // huge crowd roar swell
      const src = ctx.createBufferSource();
      src.buffer = this._noiseBuf; src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass'; f.frequency.setValueAtTime(800, t);
      f.frequency.linearRampToValueAtTime(1600, t + 0.5);
      f.Q.value = 0.4;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.55, t + 0.35);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 4.2);
      src.connect(f); f.connect(g); g.connect(this.master);
      src.start(t, U.rand(0, 1)); src.stop(t + 4.5);
      // air-horn style triad
      [392, 494, 587].forEach((fr, i) => {
        setTimeout(() => this._tone(fr, 0.16, 0.5, 'sawtooth'), 120 + i * 90);
      });
    }

    ooh() {
      this.bump(0.4);
      if (!this.ctx) return;
      const ctx = this.ctx, t = ctx.currentTime;
      const src = ctx.createBufferSource();
      src.buffer = this._noiseBuf;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.setValueAtTime(500, t);
      f.frequency.linearRampToValueAtTime(280, t + 0.7);
      f.Q.value = 1.4;
      const g = ctx.createGain();
      this._env(g, t, 0.12, 0.4, 0.8);
      src.connect(f); f.connect(g); g.connect(this.master);
      src.start(t, U.rand(0, 1)); src.stop(t + 1.2);
    }

    _drumRoll() {
      if (!this.ctx) return;
      const beats = [0, 0.18, 0.36, 0.54, 0.72, 0.81, 0.9];
      beats.forEach(b => {
        setTimeout(() => {
          this._tone(75, 0.22 * (0.5 + this.excite), 0.1, 'sine', 45);
          this._noiseHit(220, 1, 0.1, 0.06, 'lowpass');
        }, b * 1000);
      });
    }

    powerup() {
      this._tone(620, 0.2, 0.1, 'square', 940);
      setTimeout(() => this._tone(940, 0.2, 0.14, 'square', 1280), 90);
    }

    countBeep(final) {
      this._tone(final ? 1180 : 740, 0.18, final ? 0.3 : 0.1, 'square');
    }

    ui() { this._tone(900, 0.12, 0.06, 'triangle', 600); }
    uiBig() { this._tone(520, 0.18, 0.16, 'triangle', 780); }
  }

  GS.AudioEngine = AudioEngine;
})();
