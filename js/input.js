/* GOALSTORM — input.js
 * Keyboard (1P combined or 2P split schemes) + gamepad polling.
 * Tracks press/release edges and hold durations for charged shots.
 */
window.GS = window.GS || {};
(function () {
  'use strict';
  const U = GS.U;

  // key scheme definitions per player slot (uses KeyboardEvent.code)
  const SCHEMES = {
    single: {
      up: ['KeyW', 'ArrowUp'], down: ['KeyS', 'ArrowDown'],
      left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'],
      pass: ['KeyJ', 'KeyZ'], shoot: ['KeyK', 'Space', 'KeyX'],
      sprint: ['ShiftLeft', 'ShiftRight', 'KeyL'],
    },
    p1: {
      up: ['KeyW'], down: ['KeyS'], left: ['KeyA'], right: ['KeyD'],
      pass: ['KeyC'], shoot: ['KeyV'], sprint: ['KeyB'],
    },
    p2: {
      up: ['ArrowUp'], down: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'],
      pass: ['KeyK'], shoot: ['KeyL'], sprint: ['ShiftRight', 'Semicolon'],
    },
  };

  const ACTIONS = ['pass', 'shoot', 'sprint'];
  const PREVENT = new Set([
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Tab',
  ]);

  class Input {
    constructor() {
      this.keys = new Set();
      this.keyPressed = new Set();   // edge: went down this frame
      this.keyReleased = new Set();  // edge: went up this frame
      // per player-slot action state
      this.slots = [this._mkSlot(), this._mkSlot()];
      this.schemes = ['single', 'p2']; // set by main per mode
      this.now = 0;

      window.addEventListener('keydown', (e) => {
        if (PREVENT.has(e.code)) e.preventDefault();
        if (e.repeat) return;
        this.keys.add(e.code);
        this.keyPressed.add(e.code);
      });
      window.addEventListener('keyup', (e) => {
        this.keys.delete(e.code);
        this.keyReleased.add(e.code);
      });
      window.addEventListener('blur', () => {
        this.keys.clear();
        this.slots.forEach(s => ACTIONS.forEach(a => { s[a].down = false; }));
      });
    }

    _mkSlot() {
      const s = { move: { x: 0, z: 0 }, anyMove: false };
      ACTIONS.forEach(a => {
        s[a] = { down: false, pressed: false, released: false, downAt: 0, hold: 0, holdOnRelease: 0 };
      });
      return s;
    }

    setMode(humans) {
      // humans: 1 -> single scheme for P1; 2 -> split schemes
      this.schemes = humans >= 2 ? ['p1', 'p2'] : ['single', 'p2'];
    }

    _anyDown(codes) { for (let i = 0; i < codes.length; i++) if (this.keys.has(codes[i])) return true; return false; }
    _anyPressed(codes) { for (let i = 0; i < codes.length; i++) if (this.keyPressed.has(codes[i])) return true; return false; }
    _anyReleased(codes) { for (let i = 0; i < codes.length; i++) if (this.keyReleased.has(codes[i])) return true; return false; }

    /** Call once per frame before reading slots. */
    poll(time) {
      this.now = time;
      const pads = (navigator.getGamepads) ? navigator.getGamepads() : [];

      for (let p = 0; p < 2; p++) {
        const slot = this.slots[p];
        const sch = SCHEMES[this.schemes[p]];
        let mx = 0, mz = 0;
        if (sch) {
          if (this._anyDown(sch.left)) mx -= 1;
          if (this._anyDown(sch.right)) mx += 1;
          if (this._anyDown(sch.up)) mz -= 1;
          if (this._anyDown(sch.down)) mz += 1;
        }

        // action edges from keyboard
        const act = {};
        ACTIONS.forEach(a => {
          act[a] = {
            down: sch ? this._anyDown(sch[a]) : false,
            pressed: sch ? this._anyPressed(sch[a]) : false,
            released: sch ? this._anyReleased(sch[a]) : false,
          };
        });

        // merge gamepad p
        const pad = pads && pads[p];
        if (pad && pad.connected) {
          let ax = pad.axes[0] || 0, az = pad.axes[1] || 0;
          if (Math.abs(ax) < 0.22) ax = 0;
          if (Math.abs(az) < 0.22) az = 0;
          mx += ax; mz += az;
          if (pad.buttons[14] && pad.buttons[14].pressed) mx -= 1;
          if (pad.buttons[15] && pad.buttons[15].pressed) mx += 1;
          if (pad.buttons[12] && pad.buttons[12].pressed) mz -= 1;
          if (pad.buttons[13] && pad.buttons[13].pressed) mz += 1;
          const padMap = { pass: [0, 3], shoot: [2, 1], sprint: [5, 7, 4, 6] };
          ACTIONS.forEach(a => {
            let down = false;
            padMap[a].forEach(bi => { const b = pad.buttons[bi]; if (b && (b.pressed || b.value > 0.4)) down = true; });
            if (down && !slot[a].down && !act[a].down) act[a].pressed = true;
            if (!down && slot[a]._padWas && !act[a].down) act[a].released = true;
            slot[a]._padWas = down;
            act[a].down = act[a].down || down;
          });
        }

        const len = U.len2(mx, mz);
        if (len > 1) { mx /= len; mz /= len; }
        slot.move.x = mx; slot.move.z = mz;
        slot.anyMove = len > 0.05;

        ACTIONS.forEach(a => {
          const st = slot[a], cur = act[a];
          st.pressed = false; st.released = false; st.holdOnRelease = 0;
          if (cur.down && !st.down) { st.down = true; st.downAt = time; st.pressed = true; }
          else if (!cur.down && st.down) { st.down = false; st.released = true; st.holdOnRelease = time - st.downAt; }
          // latch quick taps that began-and-ended between sim steps
          if (sch && this._anyPressed(sch[a])) st.pressed = true;
          if (sch && this._anyReleased(sch[a]) && !st.down) st.released = true;
          st.hold = st.down ? (time - st.downAt) : 0;
        });
      }
    }

    /** Per-frame edge cleanup; call at end of frame. */
    endFrame() {
      this.keyPressed.clear();
      this.keyReleased.clear();
    }

    get(p) { return this.slots[p]; }

    // global UI edges (menus)
    pressed(code) { return this.keyPressed.has(code); }
  }

  GS.Input = Input;
})();
