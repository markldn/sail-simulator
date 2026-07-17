/**
 * test-fft.mjs — validate the multi-cascade FFT ocean core in isolation.
 * Pure math sanity so the engine is trusted before it drives render/physics.
 */
import { FFTOcean } from '../src/ocean/FFTWaves.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
};

const ocean = new FFTOcean(); // real defaults (3 cascades)

console.log('▸ Field generation at t=0');
ocean.update(0, 0);
// Sample the summed surface over a wide grid.
let nan = false;
let sum = 0;
let sum2 = 0;
let maxAbs = 0;
let count = 0;
for (let x = 0; x < 400; x += 2.5) {
  for (let z = 0; z < 400; z += 2.5) {
    const h = ocean.heightAt(x, z);
    if (!Number.isFinite(h)) nan = true;
    sum += h; sum2 += h * h; maxAbs = Math.max(maxAbs, Math.abs(h)); count++;
  }
}
const mean = sum / count;
const rms = Math.sqrt(sum2 / count);
const Hs = 4 * rms;
ok('no NaN in summed surface', !nan);
ok('height mean ≈ 0', Math.abs(mean) < 0.1, `mean=${mean.toFixed(4)}`);
ok('significant wave height sane (0.5–4 m)', Hs > 0.5 && Hs < 4, `Hs≈${Hs.toFixed(2)} m (RMS ${rms.toFixed(2)})`);
ok('crests bounded (maxAbs < 6 m)', maxAbs < 6, `max=${maxAbs.toFixed(2)} m`);

console.log('▸ Cascades cover a spread of scales');
ok('has multiple cascades', ocean.cascades.length >= 3, `${ocean.cascades.length} cascades, L=${ocean.lengthscales.join('/')} m`);

console.log('▸ Time evolution');
const hA = ocean.heightAt(12.3, -7.1);
ocean.update(2.0, 1 / 60);
const hB = ocean.heightAt(12.3, -7.1);
ok('surface changes over time', Math.abs(hA - hB) > 1e-3, `Δ=${(hB - hA).toFixed(3)} m`);
ok('heightAt finite', Number.isFinite(hB));

console.log('▸ Velocity field');
ocean.update(2.0 + 1 / 60, 1 / 60);
const v = ocean.velocityAt(12.3, -7.1, { x: 0, y: 0, z: 0 });
ok('velocity finite', Number.isFinite(v.x + v.y + v.z), `v=(${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})`);
ok('velocity magnitude sane (< 12 m/s)', Math.hypot(v.x, v.y, v.z) < 12);

console.log('▸ Determinism (same seed → same sea)');
const o2 = new FFTOcean();
o2.update(0, 0);
ocean.update(0, 0);
let match = true;
for (let x = 0; x < 200; x += 7) if (Math.abs(ocean.heightAt(x, 3) - o2.heightAt(x, 3)) > 1e-6) match = false;
ok('identical field for identical seed', match);

console.log('▸ Perf (one full update, 3 cascades)');
const t0 = performance.now();
const ITER = 30;
for (let i = 0; i < ITER; i++) ocean.update(i * 0.016, 1 / 60);
const ms = (performance.now() - t0) / ITER;
ok('update under 8 ms/frame', ms < 8, `${ms.toFixed(2)} ms/frame`);

console.log(`\n${fail === 0 ? 'ALL FFT TESTS PASSED' : fail + ' FAILED'} (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
