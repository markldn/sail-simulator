/**
 * FFTWaves.js — a Tessendorf FFT ocean with MULTIPLE CASCADES.
 *
 * A single FFT patch cannot resolve both a 200 m swell and 2 m chop: make the
 * patch big and the chop is undersampled; make it small and the swell won't
 * fit. The industry answer (and what the reference renderers do) is a set of
 * band-limited CASCADES — several FFTs, each over a different lengthscale,
 * every one carrying its own slice of the wave spectrum. Summed in world space
 * (at their different, non-aligning tile periods) they give a rich sea across
 * every scale with no visible repetition.
 *
 * Each cascade uses a JONSWAP frequency spectrum with a cos² directional
 * spread (more accurate than the classic Phillips spectrum), evolves it with
 * the deep-water dispersion ω=√(gk), and inverse-FFTs to a height +
 * choppy-displacement field. The physics samples the SAME summed CPU field the
 * GPU displaces the mesh with, so the boat floats on exactly what's drawn.
 *
 * Reference: J. Tessendorf, "Simulating Ocean Water"; cascade/spectrum choices
 * follow modern real-time implementations (e.g. rtryan98/renderer).
 */

const GRAVITY = 9.81;

/** Deterministic PRNG (mulberry32) — identical sea every run. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard-normal sample via Box–Muller. */
function gaussian(rand) {
  let u = 0;
  let v = 0;
  while (u < 1e-9) u = rand();
  while (v < 1e-9) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** In-place iterative radix-2 FFT on one row/column. sign −1 fwd, +1 inverse. */
function fft1d(re, im, n, sign) {
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (sign * 2 * Math.PI) / len;
    const wpr = Math.cos(ang);
    const wpi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wr = 1;
      let wi = 0;
      const half = len >> 1;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
        const nwr = wr * wpr - wi * wpi;
        wi = wr * wpi + wi * wpr;
        wr = nwr;
      }
    }
  }
}

/** 2-D inverse FFT (spectrum → spatial), in place. */
function ifft2d(re, im, N, rowRe, rowIm) {
  for (let r = 0; r < N; r++) {
    const off = r * N;
    for (let c = 0; c < N; c++) { rowRe[c] = re[off + c]; rowIm[c] = im[off + c]; }
    fft1d(rowRe, rowIm, N, 1);
    for (let c = 0; c < N; c++) { re[off + c] = rowRe[c]; im[off + c] = rowIm[c]; }
  }
  for (let c = 0; c < N; c++) {
    for (let r = 0; r < N; r++) { rowRe[r] = re[r * N + c]; rowIm[r] = im[r * N + c]; }
    fft1d(rowRe, rowIm, N, 1);
    for (let r = 0; r < N; r++) { re[r * N + c] = rowRe[r]; im[r * N + c] = rowIm[r]; }
  }
}

// ---------------------------------------------------------------------------
// One band-limited FFT cascade.
// ---------------------------------------------------------------------------
class FFTCascade {
  constructor({ N, patch, windSpeed, windDirRad, choppiness, kMin, kMax, seed }) {
    this.N = N;
    this.patch = patch;
    this.choppiness = choppiness;
    this.windSpeed = windSpeed;
    this.windDirRad = windDirRad;
    this.kMin = kMin; // this cascade only carries kMin ≤ |k| < kMax
    this.kMax = kMax;
    this.scale = 1;

    const n2 = N * N;
    this.h0re = new Float32Array(n2);
    this.h0im = new Float32Array(n2);
    this.h0mkRe = new Float32Array(n2);
    this.h0mkIm = new Float32Array(n2);
    this.kx = new Float32Array(n2);
    this.kz = new Float32Array(n2);
    this.kLen = new Float32Array(n2);
    this.omega = new Float32Array(n2);

    this.dispX = new Float32Array(n2);
    this.dispY = new Float32Array(n2);
    this.dispZ = new Float32Array(n2);
    this.velX = new Float32Array(n2);
    this.velY = new Float32Array(n2);
    this.velZ = new Float32Array(n2);
    this._prevX = new Float32Array(n2);
    this._prevY = new Float32Array(n2);
    this._prevZ = new Float32Array(n2);
    this._havePrev = false;
    this.foam = new Float32Array(n2);

    this._re = new Float32Array(n2);
    this._im = new Float32Array(n2);
    this._re2 = new Float32Array(n2);
    this._im2 = new Float32Array(n2);
    this._rowRe = new Float32Array(N);
    this._rowIm = new Float32Array(N);

    this._buildSpectrum(seed);
  }

  /** JONSWAP × cos² directional spread, band-limited to [kMin, kMax). */
  _spectrum(kx, kz) {
    const k2 = kx * kx + kz * kz;
    if (k2 < 1e-12) return 0;
    const k = Math.sqrt(k2);
    if (k < this.kMin || k >= this.kMax) return 0; // this cascade's band only
    const omega = Math.sqrt(GRAVITY * k);
    const dOmega_dk = GRAVITY / (2 * omega);

    const U = this.windSpeed;
    // Fetch-limited JONSWAP peak, and clamped so the dominant waves stay in the
    // VISIBLE band (≲130 m) instead of shifting into huge invisible swell as
    // wind rises. Height growth with wind is applied as an amplitude scale in
    // Ocean.js (fft.scale) — that keeps the storm sea dramatic AND on-screen.
    const F = 120000; // fetch (m)
    const omegaP = Math.max(22 * Math.pow((GRAVITY * GRAVITY) / (U * F), 1 / 3), 0.68);
    const alpha = 0.076 * Math.pow((U * U) / (F * GRAVITY), 0.22);
    const gamma = 3.3;
    const sigma = omega <= omegaP ? 0.07 : 0.09;
    const r = Math.exp(-((omega - omegaP) * (omega - omegaP)) / (2 * sigma * sigma * omegaP * omegaP));
    const S =
      ((alpha * GRAVITY * GRAVITY) / Math.pow(omega, 5)) *
      Math.exp(-1.25 * Math.pow(omegaP / omega, 4)) *
      Math.pow(gamma, r);

    const theta = Math.atan2(kz, kx) - this.windDirRad;
    const ct = Math.cos(theta);
    const D = (ct > 0 ? ct * ct : 0.05 * ct * ct) / Math.PI;

    // Gentle rolloff at the very top of the band (finest cascade) to soften
    // the hard k cut and avoid Gibbs ringing in the smallest waves.
    const taper = 1 - smoothstep(0.86 * this.kMax, this.kMax, k);

    return (S * D * dOmega_dk) / k * taper;
  }

  _buildSpectrum(seed) {
    const { N, patch } = this;
    const n2 = N * N;
    const rand = mulberry32(seed);
    const twoPiOverL = (2 * Math.PI) / patch;
    // k grid + fixed Gaussian draws (the random phases). Drawn ONCE and reused
    // so re-tuning the spectrum for a new wind morphs the SAME sea smoothly
    // instead of teleporting to a fresh random field.
    this.xiR = new Float32Array(n2);
    this.xiI = new Float32Array(n2);
    for (let m = 0; m < N; m++) {
      const kz = (m - N / 2) * twoPiOverL;
      for (let n = 0; n < N; n++) {
        const kx = (n - N / 2) * twoPiOverL;
        const idx = m * N + n;
        this.kx[idx] = kx;
        this.kz[idx] = kz;
        this.kLen[idx] = Math.sqrt(kx * kx + kz * kz);
        this.omega[idx] = Math.sqrt(GRAVITY * this.kLen[idx]);
      }
    }
    for (let idx = 0; idx < n2; idx++) {
      this.xiR[idx] = gaussian(rand);
      this.xiI[idx] = gaussian(rand);
    }
    this._recomputeSpectrum();
  }

  /** (Re)build h0 from the current wind, reusing the stored phases. */
  _recomputeSpectrum() {
    const { N, patch } = this;
    const dk2 = ((2 * Math.PI) / patch) * ((2 * Math.PI) / patch);
    const INV_SQRT2 = 1 / Math.sqrt(2);
    for (let idx = 0; idx < N * N; idx++) {
      const sp = Math.sqrt(Math.max(0, this._spectrum(this.kx[idx], this.kz[idx]) * dk2)) * INV_SQRT2;
      this.h0re[idx] = this.xiR[idx] * sp;
      this.h0im[idx] = this.xiI[idx] * sp;
    }
    for (let m = 0; m < N; m++) {
      for (let n = 0; n < N; n++) {
        const idx = m * N + n;
        const mid = ((N - m) % N) * N + ((N - n) % N);
        this.h0mkRe[idx] = this.h0re[mid];
        this.h0mkIm[idx] = -this.h0im[mid];
      }
    }
  }

  /** Re-tune this cascade for a new wind speed / heading (morphs smoothly). */
  setWind(windSpeed, windDirRad) {
    this.windSpeed = windSpeed;
    this.windDirRad = windDirRad;
    this._recomputeSpectrum();
  }

  update(time, dt) {
    const { N } = this;
    const n2 = N * N;
    const hRe = this._re;
    const hIm = this._im;
    for (let idx = 0; idx < n2; idx++) {
      const wt = this.omega[idx] * time;
      const c = Math.cos(wt);
      const s = Math.sin(wt);
      const ar = this.h0re[idx] * c - this.h0im[idx] * s;
      const ai = this.h0re[idx] * s + this.h0im[idx] * c;
      const br = this.h0mkRe[idx] * c + this.h0mkIm[idx] * s;
      const bi = this.h0mkIm[idx] * c - this.h0mkRe[idx] * s;
      hRe[idx] = ar + br;
      hIm[idx] = ai + bi;
    }

    // height
    ifft2d(hRe, hIm, N, this._rowRe, this._rowIm);
    for (let m = 0; m < N; m++) {
      for (let n = 0; n < N; n++) {
        const idx = m * N + n;
        const sgn = (m + n) & 1 ? -1 : 1;
        this.dispY[idx] = hRe[idx] * sgn * this.scale;
      }
    }
    // choppy Dx
    const dRe = this._re2;
    const dIm = this._im2;
    for (let idx = 0; idx < n2; idx++) {
      const kl = this.kLen[idx];
      const kxn = kl > 1e-6 ? this.kx[idx] / kl : 0;
      const wt = this.omega[idx] * time;
      const c = Math.cos(wt);
      const s = Math.sin(wt);
      const ar = this.h0re[idx] * c - this.h0im[idx] * s + (this.h0mkRe[idx] * c + this.h0mkIm[idx] * s);
      const ai = this.h0re[idx] * s + this.h0im[idx] * c + (this.h0mkIm[idx] * c - this.h0mkRe[idx] * s);
      dRe[idx] = kxn * ai;
      dIm[idx] = -kxn * ar;
    }
    ifft2d(dRe, dIm, N, this._rowRe, this._rowIm);
    for (let m = 0; m < N; m++) {
      for (let n = 0; n < N; n++) {
        const idx = m * N + n;
        const sgn = (m + n) & 1 ? -1 : 1;
        this.dispX[idx] = this.choppiness * dRe[idx] * sgn * this.scale;
      }
    }
    // choppy Dz
    for (let idx = 0; idx < n2; idx++) {
      const kl = this.kLen[idx];
      const kzn = kl > 1e-6 ? this.kz[idx] / kl : 0;
      const wt = this.omega[idx] * time;
      const c = Math.cos(wt);
      const s = Math.sin(wt);
      const ar = this.h0re[idx] * c - this.h0im[idx] * s + (this.h0mkRe[idx] * c + this.h0mkIm[idx] * s);
      const ai = this.h0re[idx] * s + this.h0im[idx] * c + (this.h0mkIm[idx] * c - this.h0mkRe[idx] * s);
      dRe[idx] = kzn * ai;
      dIm[idx] = -kzn * ar;
    }
    ifft2d(dRe, dIm, N, this._rowRe, this._rowIm);
    for (let m = 0; m < N; m++) {
      for (let n = 0; n < N; n++) {
        const idx = m * N + n;
        const sgn = (m + n) & 1 ? -1 : 1;
        this.dispZ[idx] = this.choppiness * dRe[idx] * sgn * this.scale;
      }
    }

    this._computeFoam();

    if (dt > 0 && this._havePrev) {
      const inv = 1 / dt;
      for (let idx = 0; idx < n2; idx++) {
        this.velX[idx] = (this.dispX[idx] - this._prevX[idx]) * inv;
        this.velY[idx] = (this.dispY[idx] - this._prevY[idx]) * inv;
        this.velZ[idx] = (this.dispZ[idx] - this._prevZ[idx]) * inv;
      }
    }
    this._prevX.set(this.dispX);
    this._prevY.set(this.dispY);
    this._prevZ.set(this.dispZ);
    this._havePrev = true;
  }

  _computeFoam() {
    const { N, patch } = this;
    const inv2d = 1 / (2 * (patch / N));
    for (let m = 0; m < N; m++) {
      const mn = ((m + 1) % N) * N;
      const mp = ((m - 1 + N) % N) * N;
      for (let n = 0; n < N; n++) {
        const np = (n + 1) % N;
        const nm = (n - 1 + N) % N;
        const idx = m * N + n;
        const dXdx = (this.dispX[m * N + np] - this.dispX[m * N + nm]) * inv2d;
        const dXdz = (this.dispX[mn + n] - this.dispX[mp + n]) * inv2d;
        const dZdx = (this.dispZ[m * N + np] - this.dispZ[m * N + nm]) * inv2d;
        const dZdz = (this.dispZ[mn + n] - this.dispZ[mp + n]) * inv2d;
        const J = (1 + dXdx) * (1 + dZdz) - dXdz * dZdx;
        this.foam[idx] = Math.max(0, 1 - J);
      }
    }
  }

  _bilinear(field, x, z) {
    const { N, patch } = this;
    const g = N / patch;
    let fx = x * g;
    let fz = z * g;
    fx = ((fx % N) + N) % N;
    fz = ((fz % N) + N) % N;
    const x0 = Math.floor(fx);
    const z0 = Math.floor(fz);
    const x1 = (x0 + 1) % N;
    const z1 = (z0 + 1) % N;
    const tx = fx - x0;
    const tz = fz - z0;
    const a = field[z0 * N + x0];
    const b = field[z0 * N + x1];
    const c = field[z1 * N + x0];
    const dd = field[z1 * N + x1];
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + dd * tx) * tz;
  }
}

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------
// The ocean: a stack of cascades summed in world space.
// ---------------------------------------------------------------------------
export class FFTOcean {
  /**
   * @param {object} opts
   *   N            grid per cascade (power of two)
   *   lengthscales tile size (m) of each cascade, largest → smallest
   *   minWave      shortest wave carried as geometry (m) — set near the ocean
   *                mesh's Nyquist so the finest chop doesn't alias
   *   windSpeed/windDirRad/choppiness  sea parameters
   */
  constructor({
    N = 64,
    // Span storm-scale swell (a fully-developed peak reaches ~700 m at gale
    // force) down to ~2 m chop across three non-aligning cascades.
    lengthscales = [720, 128, 23],
    minWave = 2.0,
    windSpeed = 9,
    windDirRad = 0,
    choppiness = 1.1,
    amplitude = 0.6,
    seed = 1337,
  } = {}) {
    this.scale = 1;
    this.amplitude = amplitude;
    this.lengthscales = lengthscales;
    // Band edges: each cascade carries [2π/L_i, 2π/L_{i+1}); the last runs up
    // to the min-wave cutoff. Contiguous and non-overlapping → no double count.
    const kEdge = lengthscales.map((l) => (2 * Math.PI) / l);
    const kTop = (2 * Math.PI) / minWave;
    this.cascades = lengthscales.map((patch, i) => {
      const kMin = kEdge[i];
      const kMax = i < lengthscales.length - 1 ? kEdge[i + 1] : kTop;
      const c = new FFTCascade({
        N, patch, windSpeed, windDirRad, choppiness, kMin, kMax, seed: seed + i * 101,
      });
      return c;
    });
    // Fold the global amplitude into each cascade's scale baseline.
    this._applyScale();
  }

  _applyScale() {
    for (const c of this.cascades) c.scale = this.scale * this.amplitude;
  }

  /**
   * Re-tune the whole sea for a new wind speed / heading. Rebuilds every
   * cascade's spectrum (reusing phases so it morphs, not jumps). At higher
   * wind the JONSWAP peak shifts to longer, taller waves — a real storm sea —
   * rather than the same chop scaled up.
   */
  setWind(windSpeed, windDirRad) {
    this.windSpeed = windSpeed;
    this.windDirRad = windDirRad;
    for (const c of this.cascades) c.setWind(windSpeed, windDirRad);
  }

  update(time, dt = 0) {
    this._applyScale();
    for (const c of this.cascades) c.update(time, dt);
  }

  /** Summed water surface height at world (x, z). */
  heightAt(x, z) {
    let px = x;
    let pz = z;
    for (let it = 0; it < 4; it++) {
      let dx = 0;
      let dz = 0;
      for (const c of this.cascades) {
        dx += c._bilinear(c.dispX, px, pz);
        dz += c._bilinear(c.dispZ, px, pz);
      }
      px = x - dx;
      pz = z - dz;
    }
    let h = 0;
    for (const c of this.cascades) h += c._bilinear(c.dispY, px, pz);
    return h;
  }

  /** Summed water-particle velocity at world (x, z). */
  velocityAt(x, z, out) {
    let px = x;
    let pz = z;
    for (let it = 0; it < 4; it++) {
      let dx = 0;
      let dz = 0;
      for (const c of this.cascades) {
        dx += c._bilinear(c.dispX, px, pz);
        dz += c._bilinear(c.dispZ, px, pz);
      }
      px = x - dx;
      pz = z - dz;
    }
    let vx = 0;
    let vy = 0;
    let vz = 0;
    for (const c of this.cascades) {
      vx += c._bilinear(c.velX, px, pz);
      vy += c._bilinear(c.velY, px, pz);
      vz += c._bilinear(c.velZ, px, pz);
    }
    out.x = vx;
    out.y = vy;
    out.z = vz;
    return out;
  }
}
