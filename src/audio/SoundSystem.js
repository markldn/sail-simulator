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

    // --- underwater regime -------------------------------------------------
    // The final mix forks into a dry path and a heavily low-passed "wet"
    // path; setUnderwater() crossfades them the instant the camera dips
    // under a wave. Water passes lows and murders highs — the classic
    // instant muffle — with a slight resonant hump for the pressure feel.
    this.dryOut = ctx.createGain();
    this.wetOut = ctx.createGain();
    this.wetOut.gain.value = 0;
    this.uwFilter = ctx.createBiquadFilter();
    this.uwFilter.type = 'lowpass';
    this.uwFilter.frequency.value = 480;
    this.uwFilter.Q.value = 1.3;
    this.master.connect(this.dryOut).connect(ctx.destination);
    this.master.connect(this.uwFilter).connect(this.wetOut).connect(ctx.destination);

    // --- listener buses ----------------------------------------------------
    // What you hear depends on where the CAMERA is. Boat-borne sounds (hull
    // rush, slams, creaks, deck patter) route through boatBus → air-
    // absorption lowpass → an HRTF panner PLACED AT THE BOAT, so orbiting
    // the camera swings the whole boat soundstage around your head. The
    // ambient sea field routes through seaBus and stays with the listener.
    this.boatLP = ctx.createBiquadFilter();
    this.boatLP.type = 'lowpass';
    this.boatLP.frequency.value = 16000;
    this.boatLP.Q.value = 0.4;
    this.boatPanner = new PannerNode(ctx, {
      panningModel: 'HRTF',
      distanceModel: 'inverse',
      rolloffFactor: 0, // direction only — distance loudness is our own curve
    });
    // Two renderings of the boat, crossfaded by where the EAR is:
    //  - aboard: you are INSIDE the soundstage — hull rush and slams are
    //    diffuse, all around you, and must NOT swing as you look about;
    //  - zoomed out: the boat is a localized object over there → HRTF.
    this.boatDirect = ctx.createGain(); // aboard path
    this.boatPanGain = ctx.createGain(); // distant path
    this.boatPanGain.gain.value = 0;
    this.boatBus = ctx.createGain();
    this.boatBus.connect(this.boatLP);
    this.boatLP.connect(this.boatDirect).connect(this.master);
    this.boatLP.connect(this.boatPanGain).connect(this.boatPanner).connect(this.master);
    this.seaBus = ctx.createGain();
    this.seaBus.connect(this.master);

    // Hull modal resonator: a GRP hull is a stiff shell with a handful of
    // low structural modes — a slam heard from on deck rings THROUGH them.
    // Parallel bandpass bank (modes loosely after small-craft vibration
    // surveys: fundamental panel ~85 Hz, then inharmonic partials), summed
    // back into the boat bus. Feed transients into this.hullIn.
    this.hullIn = ctx.createGain();
    this.hullIn.gain.value = 1;
    const MODES = [
      [85, 9, 1.0],
      [141, 11, 0.55],
      [223, 13, 0.3],
      [356, 15, 0.16],
    ];
    for (const [f, q, g] of MODES) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = f;
      bp.Q.value = q;
      const mg = ctx.createGain();
      mg.gain.value = g;
      this.hullIn.connect(bp).connect(mg).connect(this.boatBus);
    }

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
    this.seaFilter.connect(this.seaGain).connect(this.seaBus);

    // --- rush: hiss of water past the hull -------------------------------
    this.rushFilter = ctx.createBiquadFilter();
    this.rushFilter.type = 'bandpass';
    this.rushFilter.frequency.value = 1600;
    this.rushFilter.Q.value = 0.5;
    this.rushGain = ctx.createGain();
    this.rushGain.gain.value = 0;
    loop(white).connect(this.rushFilter);
    this.rushFilter.connect(this.rushGain).connect(this.boatBus);

    // --- rain: white-noise hiss ------------------------------------------
    this.rainFilter = ctx.createBiquadFilter();
    this.rainFilter.type = 'highpass';
    this.rainFilter.frequency.value = 1200;
    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0;
    loop(white).connect(this.rainFilter);
    this.rainFilter.connect(this.rainGain).connect(this.master);

    this._white = white; // reused for one-shot slams/washes
    this._brown = brown; // reused for thunder rolls and slam whumps
    this._pink = pink; // reused for breaking-wave washes
  }

  setEnabled(on) {
    this.enabled = on;
    if (this.master) this.master.gain.value = on ? 0.9 : 0.0;
  }

  /** Set an AudioParam (or legacy fallback triple) smoothly. */
  _setParam3(obj, prefix, x, y, z, tc = 0.04) {
    const t = this.ctx.currentTime;
    if (obj[prefix + 'X']) {
      obj[prefix + 'X'].setTargetAtTime(x, t, tc);
      obj[prefix + 'Y'].setTargetAtTime(y, t, tc);
      obj[prefix + 'Z'].setTargetAtTime(z, t, tc);
      return true;
    }
    return false;
  }

  /**
   * Per-frame binaural listener pose from the camera: position + facing +
   * up. With the listener truly oriented, every PannerNode('HRTF') source
   * renders through a head-related transfer function — over headphones, a
   * wash off the port bow sits off the port bow.
   */
  setListenerPose(pos, fwd, up) {
    if (!this.ctx) return;
    const L = this.ctx.listener;
    if (!this._setParam3(L, 'position', pos.x, pos.y, pos.z)) {
      L.setPosition(pos.x, pos.y, pos.z);
    }
    if (L.forwardX) {
      this._setParam3(L, 'forward', fwd.x, fwd.y, fwd.z);
      this._setParam3(L, 'up', up.x, up.y, up.z);
    } else {
      L.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z);
    }
  }

  /** Keep the boat's positional source glued to the hull. */
  setBoatPosition(pos) {
    if (!this.ctx || !this.boatPanner) return;
    if (!this._setParam3(this.boatPanner, 'position', pos.x, pos.y, pos.z)) {
      this.boatPanner.setPosition(pos.x, pos.y, pos.z);
    }
  }

  /** 0 = in air, 1 = head under the wave. Fast crossfade — dunking is instant. */
  setUnderwater(wet) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.dryOut.gain.setTargetAtTime(1 - wet, t, 0.05);
    this.wetOut.gain.setTargetAtTime(wet * 1.15, t, 0.05);
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

    // A real sea BREATHES: loudness swells and eases with the wave groups
    // passing, it is never a constant hiss. Two incommensurate slow sines
    // (11 s and 27 s) give an irregular group rhythm without bookkeeping.
    const breathe =
      0.74 + 0.26 * (0.6 * Math.sin(s.time * 0.57) + 0.4 * Math.sin(s.time * 0.233 + 1.7));
    this._ramp(this.seaGain.gain, (0.04 + 0.22 * s.seaState) * breathe, 0.4);
    this._ramp(this.seaFilter.frequency, 220 + 260 * s.seaState, 0.3);

    const rush = Math.min(1, Math.max(0, s.sog) / 8);
    this._ramp(this.rushGain.gain, 0.16 * rush);
    this._ramp(this.rushFilter.frequency, 1100 + 900 * rush, 0.2);

    // Listener position: on board (camDist ~3 m) the boat is the whole
    // soundstage; zoomed out it recedes — quieter AND duller, because air
    // absorption takes the highs first. The sea field stays with the ear.
    const d = Math.max(0, s.camDist ?? 5);
    const prox = 1 / (1 + Math.pow(d / 16, 2));
    this._ramp(this.boatBus.gain, 0.12 + 0.88 * prox, 0.25);
    this._ramp(this.boatLP.frequency, 2400 + 13500 * prox, 0.3);
    // Diffuse aboard ↔ localized at range (fully positional beyond ~20 m).
    const localized = Math.min(1, Math.max(0, (d - 6) / 14));
    this._ramp(this.boatDirect.gain, 1 - localized, 0.25);
    this._ramp(this.boatPanGain.gain, localized, 0.25);

    this._ramp(this.rainGain.gain, 0.3 * s.rainI, 0.4);

    // Rig creak when heavily heeled — an occasional groan, not continuous.
    const heel = Math.abs(s.heel);
    if (heel > 25 && s.time - this._lastCreak > 1.2 + Math.random() * 2) {
      this._lastCreak = s.time;
      this._creak(Math.min(1, (heel - 25) / 40));
    }

    // --- the rig's own voice ---------------------------------------------
    // Halyard slap: wire on mast, driven by ROLLING (each roll flings the
    // halyard against the spar) and a bit by plain wind. Calm marina rate ~
    // one tink each few seconds; rolling in a seaway, a proper clatter.
    const rollRate = Math.abs(heel - (this._lastHeel ?? heel)) / Math.max(s.dt ?? 0.016, 0.004);
    this._lastHeel = heel;
    this._slapT = (this._slapT ?? 2) - (s.dt ?? 0.016) * (0.25 + wind * 0.05 + Math.min(rollRate * 0.12, 1.5));
    if (this._slapT <= 0) {
      this._slapT = 0.6 + Math.random() * 3.5;
      const nTink = 1 + (Math.random() < 0.35 ? 1 : 0); // sometimes a double
      for (let i = 0; i < nTink; i++) {
        setTimeout(() => this._tink(0.02 + Math.random() * 0.025), i * 90);
      }
    }

    // Sail flogging while luffing: cloth slaps at 4-7 Hz, harder in more
    // wind — the unmistakable "you're pinching" flutter.
    if (s.luffing) {
      this._flapT = (this._flapT ?? 0) - (s.dt ?? 0.016);
      if (this._flapT <= 0) {
        this._flapT = 0.13 + Math.random() * 0.12;
        this._flap(0.03 + Math.min(0.07, wind * 0.006));
      }
    }

    // Winch pawls: sheeting IN ratchets the drum — a click per degree or so.
    if (this._lastSheet !== undefined && s.sheetDeg < this._lastSheet - 0.2) {
      const clicks = Math.min(4, Math.ceil(this._lastSheet - s.sheetDeg));
      for (let i = 0; i < clicks; i++) {
        this._noiseBurst(
          this.ctx.currentTime + i * 0.045, this._white, 'bandpass',
          3600, 3600, 9, 0.03, 0.001, 0.012, this.boatBus
        );
      }
    }
    this._lastSheet = s.sheetDeg;
  }

  /**
   * Halyard slap: a steel wire + shackle striking the aluminium mast — the
   * classic marina "tink". Two or three inharmonic metallic partials with a
   * fast decay; a thin tube rings bright and short, nothing like a bell.
   */
  _tink(amp) {
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const base = 640 + Math.random() * 260;
    for (const [mult, g, dur] of [[1, 1.0, 0.09], [2.31, 0.55, 0.06], [4.07, 0.3, 0.04]]) {
      const osc = ctx.createOscillator();
      osc.frequency.value = base * mult * (0.97 + Math.random() * 0.06);
      const gg = ctx.createGain();
      gg.gain.setValueAtTime(0, t0);
      gg.gain.linearRampToValueAtTime(amp * g, t0 + 0.002);
      gg.gain.exponentialRampToValueAtTime(0.0004, t0 + dur);
      osc.connect(gg).connect(this.boatBus);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    }
  }

  /** One cloth FLAP of a luffing sail: a soft low-mid broadband slap. */
  _flap(amp) {
    this._noiseBurst(
      this.ctx.currentTime, this._pink, 'bandpass',
      240 + Math.random() * 160, 180, 0.9, amp, 0.008, 0.05 + Math.random() * 0.04,
      this.boatBus
    );
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
    osc.connect(f).connect(g).connect(this.boatBus); // creaks live in the boat
    osc.start(now);
    osc.stop(now + 0.55);
  }

  /**
   * Thunder for a strike `distKm` away: the rumble arrives after the real
   * sound-travel delay (~2.9 s/km), longer and softer with distance. Deep
   * brown-noise burst through a falling lowpass — crack up close, long roll
   * far away.
   */
  thunder(distKm) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const ctx = this.ctx;
    const start = ctx.currentTime + distKm * 2.9;
    const near = Math.max(0, 1 - distKm / 8); // 1 close … 0 at 8 km
    const dur = 1.5 + (1 - near) * 3.5;
    const src = ctx.createBufferSource();
    src.buffer = this._brown;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(120 + 500 * near, start);
    f.frequency.exponentialRampToValueAtTime(60, start + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(0.10 + 0.30 * near, start + 0.08 + 0.3 * (1 - near));
    g.gain.exponentialRampToValueAtTime(0.001, start + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(start);
    src.stop(start + dur + 0.1);
  }

  /** A gull cry: descending "kee-yah" — FM'd saw through a bandpass. */
  gull() {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const n = 1 + Math.floor(Math.random() * 2); // single cry or a pair
    for (let i = 0; i < n; i++) {
      const t0 = now + i * (0.35 + Math.random() * 0.2);
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      const f0 = 1150 + Math.random() * 250;
      osc.frequency.setValueAtTime(f0, t0);
      osc.frequency.linearRampToValueAtTime(f0 * 1.12, t0 + 0.07); // the "kee"
      osc.frequency.exponentialRampToValueAtTime(f0 * 0.58, t0 + 0.34); // "yah"
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = 1500;
      f.Q.value = 2.5;
      const g = ctx.createGain();
      const amp = 0.025 + Math.random() * 0.02; // distant, never foreground
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(amp, t0 + 0.04);
      g.gain.exponentialRampToValueAtTime(0.0005, t0 + 0.38);
      osc.connect(f).connect(g).connect(this.master);
      osc.start(t0);
      osc.stop(t0 + 0.42);
    }
  }

  /**
   * One bubble: the atomic unit every natural water sound is built from
   * (Farnell, "Designing Sound"). A decaying sine whose pitch RISES a little
   * over its life — the Minnaert resonance of a shrinking, rising bubble.
   * Pure noise never reads as "liquid"; a handful of these instantly does.
   */
  _bubble(t0, freq, dur, amp, dest = this.master) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(freq, t0);
    osc.frequency.exponentialRampToValueAtTime(freq * (1.08 + Math.random() * 0.18), t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(amp, t0 + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0004, t0 + dur);
    osc.connect(g).connect(dest);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  /**
   * A physically-sampled bubble POPULATION — the actual sound-making
   * mechanism of breaking water, statistically faithful instead of solved:
   *  - radii drawn from the measured entrainment spectrum of breaking waves
   *    (Deane & Stokes, Nature 2002): r^-3/2 below the ~1 mm Hinze scale,
   *    r^-10/3 above it — mostly tiny fizz, a few big glugs;
   *  - each radius converted to its ring frequency by the Minnaert
   *    resonance (f ≈ 3260/r_mm Hz);
   *  - ring time from a radius-dependent quality factor (big bubbles ring
   *    long and round, small ones are millisecond clicks whose CHORUS is
   *    the familiar fizz).
   * @param {number} t0     start time
   * @param {number} spread seconds over which the population is released
   * @param {number} count  bubbles
   * @param {number} amp    loudness scale
   */
  _bubblePopulation(t0, spread, count, amp, dest = this.master) {
    for (let i = 0; i < count; i++) {
      let r; // radius in mm
      if (Math.random() < 0.72) {
        // small branch: pdf ∝ r^-3/2 on [0.3, 1] mm (inverse-transform)
        r = Math.pow(1.826 + Math.random() * (1 - 1.826), -2);
      } else {
        // large branch: pdf ∝ r^-10/3 on [1, 10] mm
        r = Math.pow(1 + Math.random() * (0.00464 - 1), -3 / 7);
      }
      const f = 3260 / r; // Minnaert
      const Q = 15 + 4 * r;
      const tau = Q / (Math.PI * f); // e-folding ring time
      this._bubble(
        t0 + Math.pow(Math.random(), 0.8) * spread,
        f,
        tau * 4,
        amp * Math.min(1, r * 0.35) * (0.5 + Math.random()),
        dest
      );
    }
  }

  /** Short filtered-noise burst helper: type/freq/Q, attack→decay envelope. */
  _noiseBurst(t0, buf, type, f0, f1, q, amp, attack, decay, dest = this.master, rate = 1) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = (0.85 + Math.random() * 0.3) * rate; // jitter × doppler
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t0);
    if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(f1, t0 + attack + decay);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(amp, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0005, t0 + attack + decay);
    src.connect(f).connect(g).connect(dest);
    src.start(t0);
    src.stop(t0 + attack + decay + 0.05);
  }

  /**
   * Bow-wave impact (intensity ≈ m/s beyond the slam threshold), heard from
   * the COCKPIT — which changes everything about the recipe:
   *
   *   1. hull thud — short structure-borne knock through the boat itself
   *      (broadband low noise with a hint of hull resonance, NOT a pitched
   *      drum sweep), hard slams only;
   *   2. spray burst — three overlapping, band-jittered noise bursts. One
   *      smooth burst sounds like radio static; overlapping decorrelated
   *      bands give the torn, whooshing texture of a real sheet of water;
   *   3. droplet patter — dozens of millisecond noise grains raining back
   *      onto the deck and sea over the following second. This granular
   *      tail is the strongest "that was WATER" cue at deck level.
   *
   * Deliberately NO sine bubbles here: bubble chirps are an underwater /
   * gentle-lapping sound. In an above-deck smash they read as cartoon
   * plinks — exactly the "doesn't sound real" complaint.
   */
  slam(intensity) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    // Merge machine-gun contacts: bouncing through chop fires several small
    // impacts a second — one composite splash per ~180 ms reads as water,
    // separate hits read as percussion.
    if (now - (this._lastSlam || 0) < 0.18) return;
    this._lastSlam = now;
    const k = Math.min(1, intensity / 3); // 0 light kiss … 1 green water

    // 1. hull thud: a broadband excitation rung THROUGH the hull's modal
    // bank (4 structural resonances, see resume()) — the boat sounds like a
    // struck shell because acoustically it is one. No pitch sweep anywhere.
    const thudAmp = Math.min(0.8, Math.max(0, intensity - 0.7) * 0.34);
    if (thudAmp > 0.02) {
      this._noiseBurst(now, this._brown, 'lowpass', 500, 500, 0.4, thudAmp, 0.006, 0.09, this.hullIn);
    }

    // 2. spray burst: three staggered bands, each jittered in centre
    // frequency and playback rate so no two slams — and no two layers —
    // correlate. Bright band decays fastest, low band lingers.
    const j = () => 0.85 + Math.random() * 0.35;
    this._noiseBurst(now + 0.005, this._white, 'bandpass', 4200 * j(), 1800, 0.9,
      0.045 + 0.10 * k, 0.015, 0.22 + 0.18 * k, this.boatBus);
    this._noiseBurst(now + 0.03 + Math.random() * 0.05, this._white, 'bandpass', 2200 * j(), 900, 0.8,
      0.04 + 0.11 * k, 0.03, 0.35 + 0.3 * k, this.boatBus);
    this._noiseBurst(now + 0.06 + Math.random() * 0.06, this._pink, 'bandpass', 1100 * j(), 450, 0.7,
      0.03 + 0.10 * k, 0.05, 0.5 + 0.45 * k, this.boatBus);
    // (Splash-back patter now comes from the ACTUAL spray particles — see
    // patter(); nothing synthetic to add here.)
  }

  /**
   * Deck/sea patter from REAL simulated droplets: Spray.js reports how many
   * of its particles ended their flight this frame, and each becomes one
   * millisecond noise grain. The patter's rhythm and density are therefore
   * the actual ballistics of the actual spray — the "correct driver" tier.
   */
  patter(count) {
    if (!this.ctx || this.ctx.state !== 'running' || count <= 0) return;
    const now = this.ctx.currentTime;
    const n = Math.min(count, 14); // cap per frame; a deluge saturates anyway
    for (let i = 0; i < n; i++) {
      this._noiseBurst(
        now + Math.random() * 0.045, this._white, 'bandpass',
        2600 + Math.random() * 3400, 2600, 1.4,
        0.008 + Math.random() * 0.014, 0.002, 0.004 + Math.random() * 0.009,
        this.boatBus
      );
    }
  }

  /**
   * A wave breaking NEARBY (fired by the Breakers system, so crashes are
   * heard where they're seen). Not an impact: a slow swelling WASH — the
   * crest collapses, the aerated water rolls, the foam fizzes out.
   * @param {number} strength 0..1 — fold depth × proximity
   * @param {{x:number,y:number,z:number}|null} pos world position of the
   *        collapse: rendered as a true binaural (HRTF) source there
   * @param {number} distM    metres away — distant washes lose their highs
   *                          to air absorption before they lose loudness
   * @param {number} rate     doppler factor (1 ± v_radial/343) from the
   *                          listener's real motion toward/away the source
   */
  wash(strength, pos = null, distM = 30, rate = 1) {
    if (!this.ctx || this.ctx.state !== 'running' || strength < 0.05) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    // At most one new wash ~each second unless clearly louder — overlapping
    // identical washes just sum into mush.
    if (now - (this._lastWash || 0) < 1.1 && strength < 1.4 * (this._lastWashStr || 0)) return;
    this._lastWash = now;
    this._lastWashStr = strength;

    const s = Math.min(1, strength);
    // Per-event spatial chain: HRTF position (direction only — loudness is
    // already folded into `strength`) + air absorption → sea bus.
    let head = this.seaBus;
    if (pos) {
      const panner = new PannerNode(ctx, {
        panningModel: 'HRTF',
        distanceModel: 'inverse',
        rolloffFactor: 0,
        positionX: pos.x,
        positionY: pos.y,
        positionZ: pos.z,
      });
      const air = ctx.createBiquadFilter();
      air.type = 'lowpass';
      air.frequency.value = 12000 * Math.exp(-distM / 90) + 900; // dull with range
      panner.connect(air).connect(this.seaBus);
      head = panner;
    }

    // The roll: pink noise, slow ~0.6 s attack, 2-3.5 s decay, band drifting
    // down as the broken water loses energy.
    this._noiseBurst(
      now, this._pink, 'bandpass', 900, 320, 0.5,
      0.05 + 0.17 * s, 0.45 + 0.3 * s, 2.0 + 1.6 * s, head, rate
    );
    // The bubble population IS the fizz-and-glug of broken water — sampled
    // from the real measured entrainment spectrum (see _bubblePopulation).
    this._bubblePopulation(now + 0.15, 1.3 + 1.2 * s, 28 + Math.floor(s * 55), 0.02 + 0.025 * s, head);
  }
}
