/**
 * Helm.js — keyboard controls for rudder and mainsheet.
 *
 *   ← / →   rudder (hold; self-centres on release, like letting go of
 *           a tiller — the boat's own tracking takes over)
 *   ↑ / ↓   sheet in / ease out (switches trim to MANUAL)
 *   T       toggle auto-trim
 *   C       toggle first-person (helm-seat) camera
 *   F       toggle clean full-screen view (hide overlays)
 *   R       reset the boat
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
  }

  /** Advance control positions. Call once per frame with the frame dt. */
  update(dt) {
    const s = this.state;

    // Rudder: drive towards the stop while held, else spring to centre.
    const left = this._keys.has('ArrowLeft');
    const right = this._keys.has('ArrowRight');
    if (left !== right) {
      // convention: +rudder turns the bow to starboard (→ ArrowRight)
      s.rudderDeg += (right ? 1 : -1) * RUDDER_RATE * dt;
      s.rudderDeg = Math.max(-RUDDER_MAX, Math.min(RUDDER_MAX, s.rudderDeg));
    } else if (s.rudderDeg !== 0) {
      const back = Math.min(Math.abs(s.rudderDeg), RUDDER_CENTER_RATE * dt);
      s.rudderDeg -= Math.sign(s.rudderDeg) * back;
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
