/**
 * SoundSystem.js — fully procedural ambience via the Web Audio API.
 *
 * No audio files: every sound is synthesised from noise + filters, so the
 * bundle stays asset-free and the mix reacts continuously to the simulation.
 *
 *   wind   band-passed noise; louder and higher-pitched as it pipes up
 *   sea    low brown-noise rumble that swells with the sea state
 *   rush   the hiss of water past the hull, tracking boat speed
 *   rain   white-noise hiss, tied to the rain intensity
 *   creak  a filtered groan when the rig loads up (heel) — throttled
 *   slam   a low thud + splash when the bow buries (from the spray slam)
 *
 * Browsers block audio until a user gesture, so nothing is created until
 * resume() is first called (wired to the first pointer/key event in main.js).
 */

const KN_TO_MS = 0.514444;

function noiseBuffer(ctx, seconds, kind) {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < n; i++) {
    const white = Math.random() * 2 - 1;
    if (kind === 'brown') {
      last = (last + 0.02 * white) / 1.02;
      d[i] = last * 3.5;
    } else if (kind === 'pink') {
      last = 0.98 * last + 0.02 * white;
      d[i] = (white + last * 4) * 0.25;
    } else {
      d[i] = white;
    }
  }
  return buf;
}

export class SoundSystem {
  constructor() {
    this.ctx = null;
    this.enabled = true; // master toggle (GUI can flip)
    this._started = false;
    this._lastCreak = 0;
  }

  /** Create the graph on the first user gesture (autoplay policy). */
  resume() {
    if (this._started) {
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this._started = true;
    const ctx = new AC();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = this.enabled ? 0.9 : 0.0;
    this.master.connect(ctx.destination);

    const loop = (buf) => {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.start();
      return src;
    };
    const white = noiseBuffer(ctx, 2, 'white');
    const brown = noiseBuffer(ctx, 3, 'brown');
    const pink = noiseBuffer(ctx, 3, 'pink');

    // --- wind: band-pass pink noise --------------------------------------
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 500;
    this.windFilter.Q.value = 0.7;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    loop(pink).connect(this.windFilter);
    this.windFilter.connect(this.windGain).connect(this.master);

    // --- sea: low brown rumble -------------------------------------------
    this.seaFilter = ctx.createBiquadFilter();
    this.seaFilter.type = 'lowpass';
    this.seaFilter.frequency.value = 320;
    this.seaGain = ctx.createGain();
    this.seaGain.gain.value = 0.05;
    loop(brown).connect(this.seaFilter);
    this.seaFilter.connect(this.seaGain).connect(this.master);

    // --- rush: hiss of water past the hull -------------------------------
    this.rushFilter = ctx.createBiquadFilter();
    this.rushFilter.type = 'bandpass';
    this.rushFilter.frequency.value = 1600;
    this.rushFilter.Q.value = 0.5;
    this.rushGain = ctx.createGain();
    this.rushGain.gain.value = 0;
    loop(white).connect(this.rushFilter);
    this.rushFilter.connect(this.rushGain).connect(this.master);

    // --- rain: white-noise hiss ------------------------------------------
    this.rainFilter = ctx.createBiquadFilter();
    this.rainFilter.type = 'highpass';
    this.rainFilter.frequency.value = 1200;
    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0;
    loop(white).connect(this.rainFilter);
    this.rainFilter.connect(this.rainGain).connect(this.master);

    this._white = white; // reused for one-shot slams
  }

  setEnabled(on) {
    this.enabled = on;
    if (this.master) this.master.gain.value = on ? 0.9 : 0.0;
  }

  /** Smoothly ramp a gain param. */
  _ramp(param, value, t = 0.15) {
    const now = this.ctx.currentTime;
    param.cancelScheduledValues(now);
    param.setTargetAtTime(value, now, t);
  }

  /**
   * @param {object} s  live sim state:
   *   windKn, seaState (0..1), rainI (0..1), sog (kn), heel (deg), time (s)
   */
  update(s) {
    if (!this.ctx || this.ctx.state !== 'running') return;

    const wind = Math.max(0, s.windKn) * KN_TO_MS; // m/s
    // Wind rises steeply and its pitch climbs — a rigging howl in a gale.
    this._ramp(this.windGain.gain, Math.min(0.28, 0.006 * wind * wind * 0.06 + 0.02 * wind));
    this._ramp(this.windFilter.frequency, 360 + wind * 34, 0.3);

    this._ramp(this.seaGain.gain, 0.04 + 0.22 * s.seaState);
    this._ramp(this.seaFilter.frequency, 220 + 260 * s.seaState, 0.3);

    const rush = Math.min(1, Math.max(0, s.sog) / 8);
    this._ramp(this.rushGain.gain, 0.16 * rush);
    this._ramp(this.rushFilter.frequency, 1100 + 900 * rush, 0.2);

    this._ramp(this.rainGain.gain, 0.3 * s.rainI, 0.4);

    // Rig creak when heavily heeled — an occasional groan, not continuous.
    const heel = Math.abs(s.heel);
    if (heel > 25 && s.time - this._lastCreak > 1.2 + Math.random() * 2) {
      this._lastCreak = s.time;
      this._creak(Math.min(1, (heel - 25) / 40));
    }
  }

  /** A short filtered groan (rig/hull working). */
  _creak(intensity) {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(70 + Math.random() * 40, now);
    osc.frequency.linearRampToValueAtTime(45, now + 0.5);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 300;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.09 * intensity, now + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0008, now + 0.5);
    osc.connect(f).connect(g).connect(this.master);
    osc.start(now);
    osc.stop(now + 0.55);
  }

  /** A low thud + splash burst when the bow slams (intensity ≈ m/s over). */
  slam(intensity) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const amp = Math.min(0.35, 0.08 + intensity * 0.08);
    // thud
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(120, now);
    osc.frequency.exponentialRampToValueAtTime(45, now + 0.18);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(amp, now);
    tg.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
    osc.connect(tg).connect(this.master);
    osc.start(now);
    osc.stop(now + 0.24);
    // splash (short noise burst)
    const src = ctx.createBufferSource();
    src.buffer = this._white;
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 900;
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(amp * 0.8, now);
    sg.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
    src.connect(f).connect(sg).connect(this.master);
    src.start(now);
    src.stop(now + 0.36);
  }
}
