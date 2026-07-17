/**
 * test-sailing.mjs — headless verification of the Phase 3 aero + helm model.
 *
 * Flat water (isolates aerodynamics from wave forcing), true wind 12 kn
 * from due North. A simple proportional autopilot drives the rudder to
 * hold each test heading — which also proves rudder authority: if steering
 * didn't work, no scenario could hold its course.
 *
 *   1. Beam reach, auto-trim  → boat must accelerate and heel to leeward.
 *   2. Dead upwind (no-go)    → boat must NOT make meaningful headway.
 *   3. Beam reach, oversheeted (α ≈ 80°, stalled) → drastically less drive
 *      than test 1 while still heeling: the "sheeted too tight" failure.
 *
 * Run:  node scripts/test-sailing.mjs   (exit 0 = pass)
 */

import { PhysicsWorld, FIXED_DT } from '../src/physics/PhysicsWorld.js';
import { BoatPhysics } from '../src/boat/BoatPhysics.js';
import { WindManager } from '../src/wind/WindManager.js';

let failures = 0;
function check(label, cond, detail) {
  console.log(`  ${cond ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
}

const wrap180 = (a) => ((a + 540) % 360) - 180;

async function sail({ name, headingDeg, autoTrim, sheetMaxDeg, seconds }) {
  console.log(`\n▸ ${name}`);
  const pw = await PhysicsWorld.create();
  const ocean = { getHeightAt: () => 0 }; // flat water
  const wind = new WindManager({ speedKnots: 12, directionDeg: 0 }); // from N
  const helm = { rudderDeg: 0, sheetMaxDeg, autoTrim };
  const bp = new BoatPhysics(pw, ocean, wind, helm);

  // Point the bow at the target heading: body +X sits at compass bearing h
  // after a yaw of θ = 90° − h about +Y.
  const theta = ((90 - headingDeg) * Math.PI) / 180;
  bp.body.setRotation({ x: 0, y: Math.sin(theta / 2), z: 0, w: Math.cos(theta / 2) }, true);

  const steps = Math.round(seconds / FIXED_DT);
  const state = {};
  let sumSog = 0;
  let sumHeel = 0;
  let sumHdgErr = 0;
  let n = 0;

  for (let i = 0; i < steps; i++) {
    // Proportional autopilot: + rudder turns the bow to starboard, which
    // increases the compass heading — so gain is positive.
    bp.getState(state);
    const err = wrap180(headingDeg - state.heading);
    helm.rudderDeg = Math.max(-25, Math.min(25, err * 1.2));

    pw.step(FIXED_DT * 1.000001);

    if (i > steps * 0.7) {
      // judge steady state only
      sumSog += state.sog;
      sumHeel += state.heel;
      sumHdgErr += Math.abs(err);
      n++;
    }
  }

  const res = {
    sogKn: sumSog / n,
    sogMs: (sumSog / n) * 0.514444,
    heel: sumHeel / n,
    hdgErr: sumHdgErr / n,
    aero: bp.lastAero,
    finite: Number.isFinite(bp.body.translation().x + bp.body.translation().y),
  };
  console.log(
    `    SOG=${res.sogKn.toFixed(2)} kn  heel=${res.heel.toFixed(1)}°  ` +
      `hdgErr=${res.hdgErr.toFixed(1)}°  AWA=${res.aero.awaDeg.toFixed(0)}°  ` +
      `boom β=${res.aero.mainBetaDeg.toFixed(0)}°  α=${res.aero.mainAlphaDeg.toFixed(0)}°`
  );
  check('no NaN', res.finite);
  return res;
}

// 1 — beam reach, trimmed
const reach = await sail({
  name: 'Beam reach E, wind N 12 kn, auto-trim (120 s)',
  headingDeg: 90,
  autoTrim: true,
  sheetMaxDeg: 40,
  seconds: 120,
});
check('makes way (SOG > 3 kn)', reach.sogKn > 3, `${reach.sogKn.toFixed(2)} kn`);
check('holds course (hdg err < 8°)', reach.hdgErr < 8, `${reach.hdgErr.toFixed(1)}°`);
check('heels to leeward (heel > +0.5°)', reach.heel > 0.5, `${reach.heel.toFixed(1)}°`);
check('reasonable heel (< 25°)', reach.heel < 25, `${reach.heel.toFixed(1)}°`);
check('wind on port side (AWA < 0)', reach.aero.awaDeg < 0, `${reach.aero.awaDeg.toFixed(0)}°`);

// 2 — the no-go zone
const nogo = await sail({
  name: 'Dead upwind N, sheeted hard (60 s) — the no-go zone',
  headingDeg: 0,
  autoTrim: false,
  sheetMaxDeg: 10,
  seconds: 60,
});
check('cannot beat straight upwind (SOG < 1 kn)', nogo.sogKn < 1, `${nogo.sogKn.toFixed(2)} kn`);

// 3 — oversheeted on a beam reach: stalled
const stalled = await sail({
  name: 'Beam reach E, oversheeted to 8° (120 s) — stalled sail',
  headingDeg: 90,
  autoTrim: false,
  sheetMaxDeg: 8,
  seconds: 120,
});
check(
  'stall kills drive (SOG < 60% of trimmed)',
  stalled.sogKn < reach.sogKn * 0.6,
  `${stalled.sogKn.toFixed(2)} vs ${reach.sogKn.toFixed(2)} kn`
);
check('but still heels (|heel| > 0.5°)', Math.abs(stalled.heel) > 0.5, `${stalled.heel.toFixed(1)}°`);
check('deep stall α > 45°', stalled.aero.mainAlphaDeg > 45, `${stalled.aero.mainAlphaDeg.toFixed(0)}°`);

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
