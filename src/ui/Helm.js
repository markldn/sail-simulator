/**
 * Helm.js — keyboard (+ touch, on touch devices) controls for rudder and
 * mainsheet.
 *
 *   ← / →   rudder (hold; self-centres on release, like letting go of
 *           a tiller — the boat's own tracking takes over)
 *   ↑ / ↓   sheet in / ease out (switches trim to MANUAL)
 *   T       toggle auto-trim
 *   C       toggle first-person (helm-seat) camera
 *   F       toggle clean full-screen view (hide overlays)
 *   R       reset the boat
 *
 * On a touch device (no keyboard, e.g. a phone) there is otherwise no way
 * to steer at all, so a coarse-pointer check adds on-screen controls: a
 * rudder joystick (proportional, drag-based) plus two sheet tap buttons
 * driving the SAME `_keys` set the keyboard uses — `update()` below
 * doesn't know or care which input source pressed a key.
 *
 * The exported `state` object is shared BY REFERENCE with BoatPhysics —
 * physics reads it every substep, this class writes it every frame.
 */

const RUDDER_MAX = 32; // deg — must match TUNING.rudderMaxDeg
const RUDDER_RATE = 55; // deg/s towards the stop while a key is held
const RUDDER_CENTER_RATE = 35; // deg/s back to centre when released
const SHEET_RATE = 26; // deg/s of boom travel

export class Helm {
  constructor() {
    this.state = { rudderDeg: 0, sheetMaxDeg: 40, autoTrim: true };
    this.onReset = null; // main.js wires this to boat.reset()
    this.onToggleView = null; // main.js wires this to the camera toggle
    this.onToggleClean = null; // main.js wires this to the clean-view toggle
    this._keys = new Set();
    this._joyDragging = false;
    this._joyValue = 0; // -1 (full port/left) .. +1 (full starboard/right)

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      switch (e.code) {
        case 'ArrowLeft':
        case 'ArrowRight':
        case 'ArrowUp':
        case 'ArrowDown':
          this._keys.add(e.code);
          e.preventDefault(); // arrows must not scroll the page
          break;
        case 'KeyT':
          this.state.autoTrim = !this.state.autoTrim;
          break;
        case 'KeyC':
          this.onToggleView?.();
          break;
        case 'KeyF':
          this.onToggleClean?.();
          break;
        case 'KeyR':
          this.onReset?.();
          break;
      }
    });
    window.addEventListener('keyup', (e) => this._keys.delete(e.code));
    // Dropped keyups (window lost focus mid-press) must not jam the helm.
    window.addEventListener('blur', () => this._keys.clear());

    if (window.matchMedia?.('(pointer: coarse)').matches) this._buildTouchControls();
  }

  /** Rudder joystick (bottom-left) + sheet tap buttons (bottom-right). */
  _buildTouchControls() {
    const wrap = document.createElement('div');
    wrap.id = 'touchHelm';
    this._buildRudderJoystick(wrap);
    const mkPad = (side, labels, codes) => {
      const pad = document.createElement('div');
      pad.className = 'touchPad';
      pad.style.cssText = `position:fixed;bottom:18px;${side}:14px;display:flex;gap:10px;z-index:20;`;
      codes.forEach((code, i) => {
        const btn = document.createElement('button');
        btn.className = 'touchBtn';
        btn.textContent = labels[i];
        btn.style.cssText =
          'width:64px;height:64px;border-radius:50%;border:1px solid rgba(255,255,255,0.25);' +
          'background:rgba(10,18,26,0.55);color:#e8f1f8;font:600 22px system-ui,sans-serif;' +
          'backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);user-select:none;touch-action:none;';
        const press = (e) => {
          e.preventDefault();
          this._keys.add(code);
        };
        const release = (e) => {
          e.preventDefault();
          this._keys.delete(code);
        };
        btn.addEventListener('pointerdown', press);
        btn.addEventListener('pointerup', release);
        btn.addEventListener('pointercancel', release);
        btn.addEventListener('pointerleave', release);
        pad.appendChild(btn);
      });
      wrap.appendChild(pad);
    };
    mkPad('right', ['▲', '▼'], ['ArrowUp', 'ArrowDown']); // ▲ ▼ sheet
    document.body.appendChild(wrap);
  }

  /** Rudder joystick: a round base with a knob that slides freely left/right
   *  (drag, not tap-and-release) — the knob's offset maps directly and
   *  continuously to rudder angle, like a real tiller, instead of the
   *  binary full-lock-or-nothing feel of a tap button. Snaps back to
   *  centre on release. */
  _buildRudderJoystick(wrap) {
    const SIZE = 116;
    const KNOB = 56;
    const MAX_TRAVEL = (SIZE - KNOB) / 2;

    const base = document.createElement('div');
    base.id = 'rudderJoyBase';
    base.style.cssText =
      `position:fixed;bottom:16px;left:14px;width:${SIZE}px;height:${SIZE}px;` +
      'border-radius:50%;border:1px solid rgba(255,255,255,0.25);' +
      'background:rgba(10,18,26,0.45);backdrop-filter:blur(6px);' +
      '-webkit-backdrop-filter:blur(6px);touch-action:none;z-index:20;';

    const knob = document.createElement('div');
    knob.style.cssText =
      `position:absolute;top:50%;left:50%;width:${KNOB}px;height:${KNOB}px;` +
      `margin:${-KNOB / 2}px 0 0 ${-KNOB / 2}px;border-radius:50%;` +
      'background:rgba(127,212,255,0.35);border:1px solid rgba(255,255,255,0.45);' +
      'transition:transform 0.15s ease;';
    base.appendChild(knob);

    let pointerId = null;
    const setKnob = (dx) => {
      knob.style.transition = this._joyDragging ? 'none' : 'transform 0.15s ease';
      knob.style.transform = `translateX(${dx}px)`;
    };
    const onMove = (e) => {
      if (!this._joyDragging || e.pointerId !== pointerId) return;
      const r = base.getBoundingClientRect();
      const dx = Math.max(-MAX_TRAVEL, Math.min(MAX_TRAVEL, e.clientX - (r.left + r.width / 2)));
      setKnob(dx);
      this._joyValue = dx / MAX_TRAVEL;
    };
    const endDrag = (e) => {
      if (e && e.pointerId !== pointerId) return;
      this._joyDragging = false;
      pointerId = null;
      this._joyValue = 0;
      setKnob(0);
    };

    base.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this._joyDragging = true;
      pointerId = e.pointerId;
      base.setPointerCapture(pointerId);
      onMove(e);
    });
    base.addEventListener('pointermove', onMove);
    base.addEventListener('pointerup', endDrag);
    base.addEventListener('pointercancel', endDrag);
    base.addEventListener('lostpointercapture', endDrag);

    wrap.appendChild(base);
  }

  /** Advance control positions. Call once per frame with the frame dt. */
  update(dt) {
    const s = this.state;

    // Rudder: the joystick (while dragged) sets position directly and
    // proportionally — the knob offset IS the rudder angle, like a tiller
    // under your hand. Otherwise arrow keys drive towards the stop while
    // held, and it springs back to centre when nothing is held/dragged.
    if (this._joyDragging) {
      // convention: +rudder turns the bow to starboard (→ drag right)
      s.rudderDeg = this._joyValue * RUDDER_MAX;
    } else {
      const left = this._keys.has('ArrowLeft');
      const right = this._keys.has('ArrowRight');
      if (left !== right) {
        s.rudderDeg += (right ? 1 : -1) * RUDDER_RATE * dt;
        s.rudderDeg = Math.max(-RUDDER_MAX, Math.min(RUDDER_MAX, s.rudderDeg));
      } else if (s.rudderDeg !== 0) {
        const back = Math.min(Math.abs(s.rudderDeg), RUDDER_CENTER_RATE * dt);
        s.rudderDeg -= Math.sign(s.rudderDeg) * back;
      }
    }

    // Sheet: any manual input takes trim off auto.
    const sheetIn = this._keys.has('ArrowUp');
    const sheetOut = this._keys.has('ArrowDown');
    if (sheetIn !== sheetOut) {
      s.autoTrim = false;
      s.sheetMaxDeg += (sheetOut ? 1 : -1) * SHEET_RATE * dt;
      s.sheetMaxDeg = Math.max(8, Math.min(88, s.sheetMaxDeg));
    }
  }
}
