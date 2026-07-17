/**
 * test-buoyancy.mjs — headless sanity test of the boat physics.
 *
 * Rapier and the wave math both run fine in Node, so we can verify the
 * buoyancy model without a browser:
 *
 *   Test 1 (flat water): boat must settle upright at a sane draft with no
 *           residual motion — proves buoyancy/gravity balance and that the
 *           heave damping actually converges instead of oscillating.
 *   Test 2 (full Gerstner sea, height ×1, chop 0.8): 60 simulated seconds;
 *           boat must stay afloat, upright-ish, and produce no NaNs —
 *           proves stability of the force model under real wave forcing.
 *
 * Run:  node scripts/test-buoyancy.mjs   (exit code 0 = pass)
 */

import { PhysicsWorld, FIXED_DT } from '../src/physics/PhysicsWorld.js';
import { BoatPhysics } from '../src/boat/BoatPhysics.js';
import {
  createWaveSet,
  getWaveHeight,
  sampleWaveVelocity,
} from '../src/ocean/GerstnerWaves.js';

let failures = 0;
function check(label, cond, detail) {
  console.log(`  ${cond ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
}

/** Minimal stand-in for Ocean: height + orbital velocity + settable clock. */
function makeOcean(heightScale, choppiness) {
  const waves = createWaveSet();
  return {
    t: 0,
    getHeightAt(x, z) {
      if (heightScale === 0) return 0;
      return getWaveHeight(waves, x, z, this.t, heightScale, choppiness);
    },
    getWaterVelocityAt(x, z, out) {
      if (heightScale === 0) return out.set(0, 0, 0);
      const v = sampleWaveVelocity(waves, x, z, this.t, heightScale, choppiness);
      return out.set(v.x, v.y, v.z);
    },
  };
}

async function runScenario(name, heightScale, choppiness, seconds) {
  console.log(`\n▸ ${name}`);
  const pw = await PhysicsWorld.create();
  const ocean = makeOcean(heightScale, choppiness);
  const bp = new BoatPhysics(pw, ocean);

  const steps = Math.round(seconds / FIXED_DT);
  let maxAbsHeel = 0;
  let maxAbsPitch = 0;
  let minY = Infinity;
  let maxY = -Infinity;
  const state = {};

  for (let i = 0; i < steps; i++) {
    ocean.t += FIXED_DT;
    // Feed step() slightly more than FIXED_DT so float rounding can never
    // starve the accumulator of its single substep.
    pw.step(FIXED_DT * 1.000001);
    bp.getState(state);
    if (i > steps / 2) {
      // only judge the second half — let transients from spawn die out
      maxAbsHeel = Math.max(maxAbsHeel, Math.abs(state.heel));
      maxAbsPitch = Math.max(maxAbsPitch, Math.abs(state.pitch));
      minY = Math.min(minY, state.position.y);
      maxY = Math.max(maxY, state.position.y);
    }
  }

  const tr = bp.body.translation();
  const lv = bp.body.linvel();
  const speed = Math.hypot(lv.x, lv.y, lv.z);

  check('no NaN in final state', Number.isFinite(tr.x + tr.y + tr.z + speed));
  return { bp, state, maxAbsHeel, maxAbsPitch, minY, maxY, speed };
}

// ---------------------------------------------------------------- Test 1
{
  const r = await runScenario('Flat water — settle test (20 s)', 0, 0, 20);
  console.log(
    `    mass=${r.bp.body.mass().toFixed(0)} kg  restY=${r.state.position.y.toFixed(3)} m` +
      `  heel=${r.state.heel.toFixed(2)}°  pitch=${r.state.pitch.toFixed(2)}°  |v|=${r.speed.toFixed(4)} m/s`
  );
  check('mass ≈ 2500 kg', Math.abs(r.bp.body.mass() - 2500) < 50, `${r.bp.body.mass().toFixed(0)} kg`);
  check('settled (|v| < 0.05 m/s)', r.speed < 0.05, `${r.speed.toFixed(4)} m/s`);
  check('sane draft (-0.2 < y < 0.45)', r.state.position.y > -0.2 && r.state.position.y < 0.45, `y=${r.state.position.y.toFixed(3)}`);
  check('upright (|heel| < 1.5°)', Math.abs(r.state.heel) < 1.5, `${r.state.heel.toFixed(2)}°`);
  check('level trim (|pitch| < 4°)', Math.abs(r.state.pitch) < 4, `${r.state.pitch.toFixed(2)}°`);
}

// ---------------------------------------------------------------- Test 2
{
  const r = await runScenario('Gerstner sea ×1.0, chop 0.8 — endurance (60 s)', 1.0, 0.8, 60);
  console.log(
    `    y∈[${r.minY.toFixed(2)}, ${r.maxY.toFixed(2)}] m  maxHeel=${r.maxAbsHeel.toFixed(1)}°` +
      `  maxPitch=${r.maxAbsPitch.toFixed(1)}°`
  );
  // Wave troughs at this sea state reach ≈ −1.6 m; a boat correctly riding
  // the surface will follow them down. "Sinking" would be well past −2.
  check('stays afloat (y > -2.0 m)', r.minY > -2.0, `minY=${r.minY.toFixed(2)}`);
  check('not airborne (y < 3 m)', r.maxY < 3, `maxY=${r.maxY.toFixed(2)}`);
  check('no capsize (max |heel| < 35°)', r.maxAbsHeel < 35, `${r.maxAbsHeel.toFixed(1)}°`);
  check('no pitchpole (max |pitch| < 25°)', r.maxAbsPitch < 25, `${r.maxAbsPitch.toFixed(1)}°`);
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
