/**
 * GerstnerWaves.js — the single source of truth for the ocean's wave field.
 *
 * The SAME wave definitions are used in two places:
 *   1. Uploaded as uniforms to the ocean vertex shader (GPU) — see Ocean.js.
 *   2. Evaluated here in JavaScript (CPU) so the physics engine can ask
 *      "how high is the water at (x, z) right now?" for buoyancy sampling
 *      in Phase 2. Keeping one definition guarantees the boat floats on the
 *      *rendered* water, not an approximation of it.
 *
 * Gerstner (trochoidal) waves displace points both vertically AND
 * horizontally, which is what gives real ocean waves their sharp crests and
 * flat troughs. For a set of waves i with:
 *   direction  D_i (unit 2D vector, the direction of travel)
 *   wavelength λ_i  →  wavenumber  k_i = 2π / λ_i
 *   amplitude  A_i  (× global height scale)
 *   phase      φ_i
 * deep-water dispersion gives angular frequency ω_i = sqrt(g · k_i),
 * and the displacement of a grid point P = (x, z) is:
 *
 *   f_i  = k_i · dot(D_i, P) − ω_i · t + φ_i
 *   X   += chop · A_i · D_i.x · cos(f_i)      (horizontal "chop")
 *   Z   += chop · A_i · D_i.y · cos(f_i)
 *   Y   += A_i · sin(f_i)                     (vertical heave)
 *
 * `chop` (choppiness) is the classic Gerstner Q factor. If
 * chop · Σ(k_i·A_i) exceeds ~1 the surface self-intersects (crests curl
 * through themselves) — the GUI ranges in ControlPanel.js are clamped to
 * stay below that in normal use.
 */

import * as THREE from 'three';

export const GRAVITY = 9.81; // m/s² — must match the shader's #define

/**
 * Hand-tuned wave spectrum for a moderate open-water sea state.
 *
 * Wavelengths span ~1.3 m ripples to a 68 m primary swell. Amplitudes are
 * chosen so each wave's individual steepness k·A stays ≤ 0.09 and the total
 * Σ(k·A) ≈ 0.59, leaving headroom for the global height/choppiness sliders.
 * `angle` is degrees away from the primary travel direction (+X world axis
 * for now — Phase 3 can slave this to the wind direction), giving a
 * believable directional spread instead of parallel corduroy waves.
 *
 * Phases are arbitrary fixed offsets so waves don't all crest at the origin
 * at t=0. Deterministic (no Math.random) so CPU and GPU always agree.
 */
const WAVE_DEFS = [
  { angle: 0, wavelength: 68.0, amplitude: 0.9, phase: 0.0 },
  { angle: 14, wavelength: 39.0, amplitude: 0.55, phase: 1.7 },
  { angle: -19, wavelength: 23.0, amplitude: 0.32, phase: 4.1 },
  { angle: 31, wavelength: 13.0, amplitude: 0.18, phase: 2.6 },
  { angle: -27, wavelength: 7.5, amplitude: 0.09, phase: 5.3 },
  { angle: 42, wavelength: 4.2, amplitude: 0.045, phase: 0.8 },
  { angle: -49, wavelength: 2.4, amplitude: 0.022, phase: 3.4 },
  { angle: 8, wavelength: 1.3, amplitude: 0.01, phase: 5.9 },
];

export const NUM_WAVES = WAVE_DEFS.length;

/**
 * Build the runtime wave set: precompute direction vectors, wavenumbers and
 * angular frequencies once. Returns plain objects (cheap to iterate every
 * physics substep).
 */
export function createWaveSet() {
  return WAVE_DEFS.map((w) => {
    const theta = THREE.MathUtils.degToRad(w.angle);
    const k = (2 * Math.PI) / w.wavelength;
    return {
      dirX: Math.cos(theta),
      dirZ: Math.sin(theta),
      wavelength: w.wavelength,
      amplitude: w.amplitude,
      phase: w.phase,
      k,
      omega: Math.sqrt(GRAVITY * k), // deep-water dispersion relation
    };
  });
}

/**
 * Pack the wave set into uniform-friendly arrays for the shader:
 *   uWaves[i]  = vec4(dirX, dirZ, wavelength, amplitude)
 *   uPhases[i] = float
 */
export function packWaveUniforms(waves) {
  return {
    waveVectors: waves.map(
      (w) => new THREE.Vector4(w.dirX, w.dirZ, w.wavelength, w.amplitude)
    ),
    phases: waves.map((w) => w.phase),
  };
}

// Scratch objects reused to avoid per-call GC churn (these functions run
// hundreds of times per frame in the buoyancy loop).
const _disp = { dx: 0, dy: 0, dz: 0 };
const _vel = { x: 0, y: 0, z: 0 };

/**
 * Evaluate the summed Gerstner displacement that the vertex shader would
 * apply to grid point (x, z) at time t. MUST mirror the GLSL loop in
 * Ocean.js exactly (same signs, same phase convention).
 *
 * @param {number} rot global wave-field rotation in radians — the whole
 *        spectrum swings with the wind (Ocean drives this). Applied to
 *        every wave's travel direction, identically on CPU and GPU.
 * @returns {{dx:number, dy:number, dz:number}} shared scratch object — copy
 *          the values out if you need to keep them across calls.
 */
export function sampleWaveDisplacement(waves, x, z, time, heightScale, choppiness, rot = 0) {
  const cR = Math.cos(rot);
  const sR = Math.sin(rot);
  let dx = 0;
  let dy = 0;
  let dz = 0;
  for (let i = 0; i < waves.length; i++) {
    const w = waves[i];
    const dX = w.dirX * cR - w.dirZ * sR;
    const dZ = w.dirX * sR + w.dirZ * cR;
    const a = w.amplitude * heightScale;
    const f = w.k * (dX * x + dZ * z) - w.omega * time + w.phase;
    const c = Math.cos(f) * a;
    dx += dX * choppiness * c;
    dz += dZ * choppiness * c;
    dy += a * Math.sin(f);
  }
  _disp.dx = dx;
  _disp.dy = dy;
  _disp.dz = dz;
  return _disp;
}

/**
 * EXACT water-particle velocity at (x, z): the analytic time derivative of
 * sampleWaveDisplacement (d/dt of a·sin(f) and chop·a·cos(f), with
 * df/dt = −ω). This is the orbital motion of the water itself — hull drag
 * is computed RELATIVE to it, which is how waves carry, surge and drift
 * the boat. Analytic beats finite differencing: no timestep noise, no
 * previous-sample bookkeeping.
 *
 * @returns {{x:number, y:number, z:number}} shared scratch object.
 */
export function sampleWaveVelocity(waves, x, z, time, heightScale, choppiness, rot = 0) {
  const cR = Math.cos(rot);
  const sR = Math.sin(rot);
  let vx = 0;
  let vy = 0;
  let vz = 0;
  for (let i = 0; i < waves.length; i++) {
    const w = waves[i];
    const dX = w.dirX * cR - w.dirZ * sR;
    const dZ = w.dirX * sR + w.dirZ * cR;
    const a = w.amplitude * heightScale;
    const f = w.k * (dX * x + dZ * z) - w.omega * time + w.phase;
    const s = Math.sin(f) * a * w.omega;
    vx += dX * choppiness * s;
    vz += dZ * choppiness * s;
    vy += -a * w.omega * Math.cos(f);
  }
  _vel.x = vx;
  _vel.y = vy;
  _vel.z = vz;
  return _vel;
}

/**
 * True water surface height at a fixed WORLD position (x, z).
 *
 * This is the function buoyancy will lean on. It is NOT simply
 * sampleWaveDisplacement(x, z).dy — Gerstner waves displace grid points
 * horizontally, so the grid point that ends up above (x, z) started
 * somewhere else. We invert that mapping with fixed-point iteration:
 * start at (x, z), see where it lands, and shift the guess by the error.
 * 3 iterations brings the horizontal error to millimetres at sane
 * choppiness values — plenty for physics.
 *
 * @param {Array}  waves       from createWaveSet()
 * @param {number} x, z        world position to query
 * @param {number} time        simulation time (MUST be the same clock the
 *                             shader's uTime uses, or physics and visuals
 *                             will disagree)
 * @param {number} heightScale global wave-height multiplier (GUI)
 * @param {number} choppiness  global Gerstner Q factor (GUI)
 * @returns {number} water surface Y at (x, z)
 */
export function getWaveHeight(waves, x, z, time, heightScale, choppiness, rot = 0) {
  let px = x;
  let pz = z;
  for (let i = 0; i < 3; i++) {
    const d = sampleWaveDisplacement(waves, px, pz, time, heightScale, choppiness, rot);
    px = x - d.dx;
    pz = z - d.dz;
  }
  return sampleWaveDisplacement(waves, px, pz, time, heightScale, choppiness, rot).dy;
}

/**
 * Approximate surface normal at world (x, z), by central differences on
 * getWaveHeight. Slower than the analytic GPU normal but only used by
 * physics (wave-impact torque in Phase 2), where a handful of samples per
 * frame is fine.
 */
export function getWaveNormal(waves, x, z, time, heightScale, choppiness, rot = 0, eps = 0.15) {
  const hL = getWaveHeight(waves, x - eps, z, time, heightScale, choppiness, rot);
  const hR = getWaveHeight(waves, x + eps, z, time, heightScale, choppiness, rot);
  const hD = getWaveHeight(waves, x, z - eps, time, heightScale, choppiness, rot);
  const hU = getWaveHeight(waves, x, z + eps, time, heightScale, choppiness, rot);
  const n = new THREE.Vector3(hL - hR, 2 * eps, hD - hU);
  return n.normalize();
}
