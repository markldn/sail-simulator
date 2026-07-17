/**
 * test-cloth.mjs — headless verification of the ClothSail solver.
 *
 * A main-sail-shaped cloth, luff and foot pinned, blown by a steady beam
 * apparent wind for 20 simulated seconds (3 substeps × 60 Hz, same as the
 * app). Checks:
 *   1. Stability: no NaN, no vertex escaping a sane bounding box.
 *   2. It FILLS: mean z of the free cloth deflects downwind, with a
 *      sail-like draft (a few % of chord, not flat, not a balloon).
 *   3. It LIVES: the leech keeps micro-moving at steady trim (turbulent
 *      inflow) — variance over the last 5 s must be nonzero.
 *   4. Becalmed + no gravity pins it flat; with gravity and no wind the
 *      free leech SAGS below its flat-cut height.
 *
 * Run:  node scripts/test-cloth.mjs   (exit 0 = pass)
 */

import * as THREE from 'three';
import { ClothSail } from '../src/boat/ClothSail.js';

let failures = 0;
function check(label, cond, detail) {
  console.log(`  ${cond ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
}

const FOOT = 3.0;
const HEIGHT = 7.9;

function makeSail() {
  const sail = new ClothSail(null, {
    rows: 20,
    cols: 13,
    layout: (s, c) => [-c * FOOT * (1 - 0.97 * s), s * HEIGHT],
    material: new THREE.MeshBasicMaterial(),
    broadseam: 0.035, // same cut as the app's sails
  });
  return sail;
}

function pinEdges(sail) {
  for (let i = 0; i < sail.rows; i++) {
    const s = i / (sail.rows - 1);
    sail.pin(i, 0, 0, s * HEIGHT, 0);
  }
  for (let j = 1; j < sail.cols; j++) {
    sail.pin(0, j, -(j / (sail.cols - 1)) * FOOT, 0, 0);
  }
}

function run(sail, wind, seconds) {
  const frames = Math.round(seconds * 60);
  const sdt = 1 / 180;
  const leechIdx = sail.id(Math.floor(sail.rows * 0.75), sail.cols - 1) * 3;
  const leechZ = [];
  for (let f = 0; f < frames; f++) {
    const t = f / 60;
    for (let ss = 0; ss < 3; ss++) sail.step(sdt, wind, 1, 1, t + ss * sdt);
    if (f > frames - 300) leechZ.push(sail.pos[leechIdx + 2]);
  }
  return leechZ;
}

function stats(sail) {
  let minZ = Infinity;
  let maxZ = -Infinity;
  let sumZ = 0;
  let free = 0;
  let finite = true;
  for (let p = 0; p < sail.n; p++) {
    const z = sail.pos[p * 3 + 2];
    if (!Number.isFinite(z)) finite = false;
    if (!sail.pinned[p]) {
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
      sumZ += z;
      free++;
    }
  }
  return { minZ, maxZ, meanZ: sumZ / free, finite };
}

// ---------------------------------------------------------------- Test 1+2+3
{
  console.log('\n▸ Beam wind 6 m/s, 20 s — fill, stability, leech life');
  const sail = makeSail();
  pinEdges(sail);
  const leechZ = run(sail, { x: -1.5, y: 0, z: 6 }, 20);
  const s = stats(sail);
  const mean = leechZ.reduce((a, b) => a + b, 0) / leechZ.length;
  const variance = leechZ.reduce((a, b) => a + (b - mean) ** 2, 0) / leechZ.length;
  console.log(
    `    meanZ=${s.meanZ.toFixed(3)} m  z∈[${s.minZ.toFixed(2)}, ${s.maxZ.toFixed(2)}]` +
      `  leech σ=${Math.sqrt(variance).toFixed(4)} m`
  );
  check('no NaN', s.finite);
  check('fills DOWNWIND (meanZ > 0.05 m)', s.meanZ > 0.05, `${s.meanZ.toFixed(3)} m`);
  check('sane draft (maxZ < 1.6 m)', s.maxZ < 1.6, `${s.maxZ.toFixed(2)} m`);
  check('no windward balloon (minZ > -1.0 m)', s.minZ > -1.0, `${s.minZ.toFixed(2)} m`);
  check('leech alive at steady trim (σ > 0.5 mm)', Math.sqrt(variance) > 0.0005,
    `${(Math.sqrt(variance) * 1000).toFixed(2)} mm`);

  // Two-way coupling channel: integrated pressure force and centre of
  // pressure must be sane (downwind push, magnitude of the right order for
  // ~11 m² at 6 m/s, CP inside the sail).
  const F = sail.aeroForce;
  const cp = sail.pressureCentroid;
  console.log(
    `    aeroForce=(${F.x.toFixed(0)}, ${F.y.toFixed(0)}, ${F.z.toFixed(0)}) N` +
      `  CP=(${cp.x.toFixed(2)}, ${cp.y.toFixed(2)})`
  );
  check('integrated force pushes downwind (Fz > 40 N)', F.z > 40, `${F.z.toFixed(0)} N`);
  check('force magnitude sane (< 1200 N)', F.length() < 1200, `${F.length().toFixed(0)} N`);
  check('CP inside the sail (1 < y < 7)', cp.y > 1 && cp.y < 7, `y=${cp.y.toFixed(2)}`);
}

// ---------------------------------------------------------------- collision
{
  console.log('\n▸ Rigging collision — cloth must not pass through a capsule');
  const sail = makeSail();
  pinEdges(sail);
  // vertical "shroud" capsule right where the blown cloth wants to go
  const col = { ax: -1.5, ay: 0, az: 0.3, bx: -1.5, by: HEIGHT, bz: 0.3, r: 0.15 };
  sail.colliders.push(col);
  run(sail, { x: -1.5, y: 0, z: 6 }, 10);
  let minClearance = Infinity;
  for (let p = 0; p < sail.n; p++) {
    if (sail.pinned[p]) continue;
    const k = p * 3;
    const y = sail.pos[k + 1];
    if (y < col.ay || y > col.by) continue;
    minClearance = Math.min(
      minClearance,
      Math.hypot(sail.pos[k] - col.ax, sail.pos[k + 2] - col.az)
    );
  }
  const s = stats(sail);
  console.log(`    min clearance from shroud axis: ${minClearance.toFixed(3)} m (r=${col.r})`);
  check('no NaN with collision active', s.finite);
  check('cloth stays outside the capsule (≥ 95% of r)', minClearance > col.r * 0.95,
    `${minClearance.toFixed(3)} m`);
}

// ---------------------------------------------------------------- Test 4
{
  console.log('\n▸ Becalmed, 10 s — the cloth must SAG under gravity');
  const sail = makeSail();
  pinEdges(sail);
  run(sail, { x: 0, y: 0, z: 0 }, 10);
  // free upper-leech corner: flat-cut height vs sagged height
  const tipIdx = sail.id(sail.rows - 2, sail.cols - 2);
  const flatY = sail.layout((sail.rows - 2) / (sail.rows - 1), 0)[1];
  const sagY = sail.pos[tipIdx * 3 + 1];
  const s = stats(sail);
  console.log(`    upper leech: flat-cut y=${flatY.toFixed(2)}, settled y=${sagY.toFixed(2)}`);
  check('no NaN', s.finite);
  check('sags below flat cut (≥ 3 cm)', sagY < flatY - 0.03, `dropped ${(flatY - sagY).toFixed(3)} m`);
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
