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

/**
 * Donelan-Banner spreading exponent βs (Arc Blanc Eq 9-10, after Horvath):
 * frequency-DEPENDENT directional width. Near the spectral peak (rω≈1) the
 * sea is narrow and aligned; well above it (rω ≥ 1.6) βs collapses toward
 * ~0.4 and the short waves fan out across nearly the whole compass. That
 * wide high-frequency fan is what makes chop from different directions run
 * through and over the swell — the old fixed cos² spread gave every
 * frequency the same narrow lobe, so all waves marched in parallel.
 */
function donelanBannerBeta(rw) {
  if (rw < 0.95) return 2.61 * Math.pow(Math.max(rw, 0.56), 1.3);
  if (rw < 1.6) return 2.28 * Math.pow(rw, -1.3);
  const eps = -0.4 + 0.8393 * Math.exp(-0.567 * Math.log(rw * rw));
  return Math.pow(10, eps);
}

/**
 * Normalization Q(rω) = 1/∫ D_DB·D_ξ dθ (Arc Blanc Eq 16). The paper fits
 * Lagrange polynomials (Eq 17); we build the table numerically instead —
 * exact for OUR swell value, and immune to any transcription slip in the
 * printed coefficients. 256 log-spaced rω entries, midpoint rule over θ.
 */
const QLUT_SIZE = 256;
const QLUT_RW_MIN = 0.05;
const QLUT_RW_MAX = 20;
function buildSpreadNormLUT(swell) {
  const lut = new Float32Array(QLUT_SIZE);
  const logMin = Math.log(QLUT_RW_MIN);
  const logStep = (Math.log(QLUT_RW_MAX) - logMin) / (QLUT_SIZE - 1);
  const NTH = 128;
  const dTh = (2 * Math.PI) / NTH;
  for (let i = 0; i < QLUT_SIZE; i++) {
    const rw = Math.exp(logMin + i * logStep);
    const bs = donelanBannerBeta(rw);
    const norm = 0.5 * bs / Math.tanh(bs * Math.PI); // Q_DB · ½βs
    const sxi = 16 * Math.tanh(1 / rw) * swell * swell;
    let integ = 0;
    for (let j = 0; j < NTH; j++) {
      const th = -Math.PI + (j + 0.5) * dTh;
      const sech = 1 / Math.cosh(bs * th);
      const dxi = Math.pow(Math.abs(Math.cos(th / 2)), 2 * sxi);
      integ += norm * sech * sech * dxi * dTh;
    }
    lut[i] = 1 / Math.max(integ, 1e-6);
  }
  return lut;
}
function lookupSpreadNorm(lut, rw) {
  const logMin = Math.log(QLUT_RW_MIN);
  const logStep = (Math.log(QLUT_RW_MAX) - logMin) / (QLUT_SIZE - 1);
  const f = (Math.log(Math.min(Math.max(rw, QLUT_RW_MIN), QLUT_RW_MAX)) - logMin) / logStep;
  const i0 = Math.min(Math.floor(f), QLUT_SIZE - 2);
  const t = f - i0;
  return lut[i0] * (1 - t) + lut[i0 + 1] * t;
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
  constructor({ N, patch, windSpeed, windDirRad, choppiness, kMin, kMax, seed, swell, delta, qlut }) {
    this.N = N;
    this.patch = patch;
    this.choppiness = choppiness;
    this.windSpeed = windSpeed;
    this.windDirRad = windDirRad;
    this.kMin = kMin; // this cascade only carries kMin ≤ |k| < kMax
    this.kMax = kMax;
    this.scale = 1;
    this.swell = swell; // ξ ∈ [0,1] — elongates waves toward parallel crests
    this.delta = delta; // δ ∈ [0,1] — 0: isotropic, 1: full Donelan-Banner
    this.qlut = qlut;   // shared normalization table Q(rω) (Arc Blanc Eq 16)

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
    // Exact spectral derivatives of the horizontal displacement (Arc Blanc
    // §3.2): ∂Dx/∂x, ∂Dz/∂z, ∂Dx/∂z (= ∂Dz/∂x by symmetry). These feed the
    // TRUE Jacobian — computed on the summed field in the shader — instead
    // of per-cascade finite differences.
    this.jacA = new Float32Array(n2); // ∂Dx/∂x
    this.jacD = new Float32Array(n2); // ∂Dz/∂z
    this.jacB = new Float32Array(n2); // ∂Dx/∂z
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
    // Fetch-limited JONSWAP peak. The fetch GROWS with wind: at a fixed
    // 120 km the peak wavelength saturates near ~100 m, so at storm winds
    // every scrap of energy piled into the 10-100 m mid band and the sea
    // became a field of same-sized lumps — the 128-720 m swell cascade sat
    // EMPTY. A real gale's sea is long 250-300 m rollers with breaking chop
    // riding on top; letting the fetch open up with wind moves the spectral
    // peak into the swell band exactly when it should be there. (ωp clamp
    // 0.45 ↔ λp ≤ ~300 m, inside the 720 m cascade's range.)
    const F = 120000 * (1 + Math.max(0, U - 10) * 0.35); // fetch (m)
    const omegaP = Math.max(22 * Math.pow((GRAVITY * GRAVITY) / (U * F), 1 / 3), 0.45);
    const alpha = 0.076 * Math.pow((U * U) / (F * GRAVITY), 0.22);
    const gamma = 3.3;
    const sigma = omega <= omegaP ? 0.07 : 0.09;
    const r = Math.exp(-((omega - omegaP) * (omega - omegaP)) / (2 * sigma * sigma * omegaP * omegaP));
    const S =
      ((alpha * GRAVITY * GRAVITY) / Math.pow(omega, 5)) *
      Math.exp(-1.25 * Math.pow(omegaP / omega, 4)) *
      Math.pow(gamma, r);

    // Directional spread (Arc Blanc §3.1.2, Eqs 7-18): custom Donelan-Banner
    // × swell elongation, blended with a neutral spread by δ. Properly
    // normalized (∫D dθ = 1), unlike the old cos²/π which integrated to ~½.
    let theta = Math.atan2(kz, kx) - this.windDirRad;
    theta -= 2 * Math.PI * Math.round(theta / (2 * Math.PI)); // wrap to [-π, π]
    const rw = omega / omegaP;
    const bs = donelanBannerBeta(rw);
    const sech = 1 / Math.cosh(bs * theta);
    const DDB = (0.5 * bs / Math.tanh(bs * Math.PI)) * sech * sech; // Eq 8+12
    const sxi = 16 * Math.tanh(1 / rw) * this.swell * this.swell;   // Eq 14
    const Dxi = Math.pow(Math.abs(Math.cos(theta / 2)), 2 * sxi);   // Eq 13
    const Q = lookupSpreadNorm(this.qlut, rw);                      // Eq 16
    const D = (1 - this.delta) / (2 * Math.PI) + this.delta * Q * DDB * Dxi; // Eq 18

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
    // Packing factors (Arc Blanc Theorem 1): every needed field's spectrum is
    // h̃(k,t) times a time-INDEPENDENT complex scalar, and pairs of Hermitian
    // spectra ride one complex IFFT (real part → field 1, imag part → field 2).
    //   IFFT 1: h̃·(1 + kx/k)            → height     + i·Dx
    //   IFFT 2: h̃·i·(kx²/k − kz/k)      → Dz         + i·∂Dx/∂x
    //   IFFT 3: h̃·(kz²/k + i·kx·kz/k)   → ∂Dz/∂z     + i·∂Dx/∂z
    // (with D̃ = −i(k/k)h̃, the sign convention the choppy look was tuned on).
    this._pf1 = new Float32Array(n2);
    this._pf2 = new Float32Array(n2);
    this._pf3re = new Float32Array(n2);
    this._pf3im = new Float32Array(n2);
    for (let m = 0; m < N; m++) {
      const kz = (m - N / 2) * twoPiOverL;
      for (let n = 0; n < N; n++) {
        const kx = (n - N / 2) * twoPiOverL;
        const idx = m * N + n;
        this.kx[idx] = kx;
        this.kz[idx] = kz;
        this.kLen[idx] = Math.sqrt(kx * kx + kz * kz);
        this.omega[idx] = Math.sqrt(GRAVITY * this.kLen[idx]);
        const kl = this.kLen[idx];
        const kxn = kl > 1e-6 ? kx / kl : 0;
        const kzn = kl > 1e-6 ? kz / kl : 0;
        this._pf1[idx] = 1 + kxn;
        this._pf2[idx] = kx * kxn - kzn;
        this._pf3re[idx] = kz * kzn;
        this._pf3im[idx] = kz * kxn;
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
      let sp = Math.sqrt(Math.max(0, this._spectrum(this.kx[idx], this.kz[idx]) * dk2)) * INV_SQRT2;
      // Math.max(0, NaN) is NaN: one bad bin would poison the whole field
      // (and via bloom, black the entire frame). Zero energy is always safe.
      if (!Number.isFinite(sp)) sp = 0;
      this.h0re[idx] = this.xiR[idx] * sp;
      this.h0im[idx] = this.xiI[idx] * sp;
    }
    // Unscaled slope variance E[|∇h|²] via Parseval: Σ k²·(time-averaged
    // |h̃(k)|²). The ocean-level steepness governor divides the physical
    // breaking limit by √(Σ cascades) to cap the user's amplitude stack.
    let sv = 0;
    for (let m = 0; m < N; m++) {
      for (let n = 0; n < N; n++) {
        const idx = m * N + n;
        const mid = ((N - m) % N) * N + ((N - n) % N);
        this.h0mkRe[idx] = this.h0re[mid];
        this.h0mkIm[idx] = -this.h0im[mid];
        const k2 = this.kLen[idx] * this.kLen[idx];
        sv += k2 * (this.h0re[idx] * this.h0re[idx] + this.h0im[idx] * this.h0im[idx]
                  + this.h0mkRe[idx] * this.h0mkRe[idx] + this.h0mkIm[idx] * this.h0mkIm[idx]);
      }
    }
    this.slopeVar0 = sv;
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
    // Time-evolved spectrum h̃(k,t) — computed ONCE (the old code re-derived
    // it per output field, tripling the trig work).
    if (!this._htRe) { this._htRe = new Float32Array(n2); this._htIm = new Float32Array(n2); }
    const htRe = this._htRe;
    const htIm = this._htIm;
    for (let idx = 0; idx < n2; idx++) {
      // NEGATIVE ωt: with the e^{+ik·x} basis, e^{i(k·x − ωt)} travels along
      // +k̂ — the direction the spectrum assigns its energy to. The old +ωt
      // made every wave run OPPOSITE its spectral direction; the symmetric
      // cos² spread masked it, the one-sided Donelan-Banner exposed it as a
      // sea marching upwind against the rain.
      const wt = -this.omega[idx] * time;
      const c = Math.cos(wt);
      const s = Math.sin(wt);
      htRe[idx] = this.h0re[idx] * c - this.h0im[idx] * s + this.h0mkRe[idx] * c + this.h0mkIm[idx] * s;
      htIm[idx] = this.h0re[idx] * s + this.h0im[idx] * c + this.h0mkIm[idx] * c - this.h0mkRe[idx] * s;
    }

    const re = this._re;
    const im = this._im;
    const chopScale = this.choppiness * this.scale;

    // IFFT 1: height (re) + choppy Dx (im), packed per Theorem 1.
    for (let idx = 0; idx < n2; idx++) {
      const f = this._pf1[idx];
      re[idx] = f * htRe[idx];
      im[idx] = f * htIm[idx];
    }
    ifft2d(re, im, N, this._rowRe, this._rowIm);
    for (let m = 0; m < N; m++) {
      for (let n = 0; n < N; n++) {
        const idx = m * N + n;
        const sgn = (m + n) & 1 ? -1 : 1;
        this.dispY[idx] = re[idx] * sgn * this.scale;
        this.dispX[idx] = im[idx] * sgn * chopScale;
      }
    }

    // IFFT 2: choppy Dz (re) + ∂Dx/∂x (im).
    for (let idx = 0; idx < n2; idx++) {
      const f = this._pf2[idx]; // spectrum = i·f·h̃
      re[idx] = -f * htIm[idx];
      im[idx] = f * htRe[idx];
    }
    ifft2d(re, im, N, this._rowRe, this._rowIm);
    for (let m = 0; m < N; m++) {
      for (let n = 0; n < N; n++) {
        const idx = m * N + n;
        const sgn = (m + n) & 1 ? -1 : 1;
        this.dispZ[idx] = re[idx] * sgn * chopScale;
        this.jacA[idx] = im[idx] * sgn * chopScale;
      }
    }

    // IFFT 3: ∂Dz/∂z (re) + ∂Dx/∂z (im).
    for (let idx = 0; idx < n2; idx++) {
      const fr = this._pf3re[idx];
      const fi = this._pf3im[idx];
      re[idx] = fr * htRe[idx] - fi * htIm[idx];
      im[idx] = fr * htIm[idx] + fi * htRe[idx];
    }
    ifft2d(re, im, N, this._rowRe, this._rowIm);
    for (let m = 0; m < N; m++) {
      for (let n = 0; n < N; n++) {
        const idx = m * N + n;
        const sgn = (m + n) & 1 ? -1 : 1;
        this.jacD[idx] = re[idx] * sgn * chopScale;
        this.jacB[idx] = im[idx] * sgn * chopScale;
      }
    }

    this._computeFoam(dt > 0 ? dt : 1 / 60);

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

  _computeFoam(dt = 1 / 60) {
    const { N } = this;
    // Foam persistence: real whitecap bubbles outlive the crest that made
    // them by seconds and are left behind on the water as the wave phase
    // travels on. Instantaneous 1−J only marks the moment of folding, so
    // each texel keeps a decaying memory of its last break (~5 s e-folding),
    // which is what turns point breaks into trailing foam patches.
    //
    // J here uses the EXACT spectral derivatives (Arc Blanc §3.2) — the old
    // centered finite differences smoothed the sharpest folds (exactly the
    // texels that should foam) below threshold. Cross-CASCADE folding is
    // handled separately, on the summed derivatives in the fragment shader.
    const decay = Math.exp(-dt / 3.5);
    for (let idx = 0; idx < N * N; idx++) {
      const J = (1 + this.jacA[idx]) * (1 + this.jacD[idx]) - this.jacB[idx] * this.jacB[idx];
      // Require genuine folding (J well below 1) before any foam
      // registers — the constant low-level pinch every wave carries is
      // not a breaking event.
      const fresh = Math.max(0, 1 - J - 0.25) * 1.35;
      const f = Math.min(1.6, Math.max(fresh, this.foam[idx] * decay));
      // The max() memory is a one-way NaN trap (max(NaN, x) = NaN forever,
      // rendered as a permanently black texel) — never store a non-finite.
      this.foam[idx] = Number.isFinite(f) ? f : 0;
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
   *   N            grid per cascade (power of two) — either one number
   *                applied to every cascade, or an array (same length as
   *                lengthscales) giving each cascade its own resolution.
   *   lengthscales tile size (m) of each cascade, largest → smallest
   *   minWave      shortest wave carried as geometry (m) — set near the ocean
   *                mesh's Nyquist so the finest chop doesn't alias
   *   windSpeed/windDirRad/choppiness  sea parameters
   */
  constructor({
    // N per cascade. See gridScales below for why these numbers changed
    // from an earlier [128,64,64]: the swell cascade actually got CHEAPER
    // (128→64) despite looking better, because the real fix was grid
    // spacing, not raw resolution.
    N = [64, 64, 128],
    // Span storm-scale swell (a fully-developed peak reaches ~700 m at gale
    // force) down to ~2 m chop across three non-aligning cascades.
    lengthscales = [720, 128, 23],
    // Every cascade's kMin sits at EXACTLY 2π/lengthscale — and if the FFT
    // grid's own spacing (dk = 2π/patch) uses that SAME lengthscale as its
    // patch, kMin lands at exactly 1 grid step from the origin: only ~8
    // discrete directions available for each cascade's lowest-wavenumber,
    // highest-energy components, no matter how high N goes (confirmed
    // numerically — bumping N alone only adds resolution further OUT,
    // nowhere near kMin). That's what produced dead-straight, overly
    // coherent wave crests — reported independently as a "stripe following
    // the boat" (actually a swell crest line) and as "lined up" close-range
    // chop (the fine cascade suffers the identical problem).
    //
    // Fix: decouple the GRID's spatial patch (which sets dk and the
    // world-space tiling period) from the BAND's defining lengthscale
    // (kMin/kMax, unchanged below) via a per-cascade multiplier. Grid patch
    // = lengthscale × gridScale, so kMin lands at grid-radius = gridScale
    // instead of always 1 — e.g. gridScale=4 gives ~2π×4≈25 directions
    // instead of ~8. Verified numerically (grid cells actually carrying
    // energy: swell 96→1552, mid ~similar→1520, fine ~similar→3720) and
    // checked against Nyquist for each band's shortest wavelength. The
    // larger grid patch is also a bigger world-space tiling period — a
    // free side benefit, less visible repetition. Fine cascade uses a
    // smaller gridScale (3, not 4) because its kMax is high (up to
    // 2π/minWave) and a bigger grid patch would need much more N to still
    // reach it — 3 was enough headroom at N=128.
    gridScales = [4, 4, 3],
    minWave = 2.0,
    windSpeed = 9,
    windDirRad = 0,
    choppiness = 1.1,
    amplitude = 0.6,
    seed = 1337,
    // Arc Blanc directional-spectrum controls (Eqs 13-18): ξ elongates the
    // waves (swell that has traveled out of its generating area), δ blends
    // between a neutral spread (0) and full Donelan-Banner directionality (1).
    //
    // δ defaults to 1 (the paper's actual spectrum). Anything below 1 adds an
    // ISOTROPIC energy floor — equal energy in +k and −k — and equal counter-
    // propagating energy at one wavelength is a STANDING wave: the sea
    // degenerates into fields of dome-shaped lumps that bob in place instead
    // of traveling crests ("bubble-wrap"). ξ > 0 matters for the same reason:
    // its |cos(θ/2)|^2sξ factor is what zeroes the upwind half of the
    // spectrum. Crossing seas come from DB's wide high-frequency fan (waves
    // at ±60-90° to the wind), NOT from counter-propagating energy.
    swell = 0.4,
    delta = 1.0,
  } = {}) {
    this.scale = 1;
    this.amplitude = amplitude;
    this.lengthscales = lengthscales;
    this.swell = swell;
    this.delta = delta;
    this._qlut = buildSpreadNormLUT(swell);
    const Ns = Array.isArray(N) ? N : lengthscales.map(() => N);
    // Band edges: each cascade carries [2π/L_i, 2π/L_{i+1}); the last runs up
    // to the min-wave cutoff. Contiguous and non-overlapping → no double count.
    const kEdge = lengthscales.map((l) => (2 * Math.PI) / l);
    const kTop = (2 * Math.PI) / minWave;
    this.cascades = lengthscales.map((lengthscale, i) => {
      const kMin = kEdge[i];
      const kMax = i < lengthscales.length - 1 ? kEdge[i + 1] : kTop;
      const patch = lengthscale * gridScales[i]; // grid spacing + world tiling only
      const c = new FFTCascade({
        N: Ns[i], patch, windSpeed, windDirRad, choppiness, kMin, kMax, seed: seed + i * 101,
        swell, delta, qlut: this._qlut,
      });
      return c;
    });
    // Fold the global amplitude into each cascade's scale baseline.
    this._applyScale();
  }

  _applyScale() {
    // Steepness governor. Amplitude multipliers (wave-height slider × wind
    // response) scale HEIGHT but not WAVELENGTH, and past ~1/7 height/length
    // real waves cannot exist — they break. Numerically the choppy Jacobian
    // goes negative and the surface folds through itself into ball-shaped
    // loops: the "bubble-wrap sea" seen with everything maxed. Cap the total
    // multiplier so the sea's RMS slope (√Σ k²|h̃|², cross-checked against
    // the realized field) stays ≤ 0.24 — a violent storm sea, at the top of
    // the Cox-Munk gravity-band slope range. Below the cap sliders act
    // normally; past it they saturate instead of ballooning.
    const SLOPE_RMS_MAX = 0.24;
    let sv = 0;
    for (const c of this.cascades) sv += c.slopeVar0 || 0;
    const rms0 = Math.sqrt(sv);
    const M = this.scale * this.amplitude;
    let Meff = rms0 > 1e-9 ? Math.min(M, SLOPE_RMS_MAX / rms0) : M;
    if (!Number.isFinite(Meff)) Meff = 0; // a NaN scale would poison every field
    for (const c of this.cascades) c.scale = Meff;
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

  /** Re-tune the directional spread (swell ξ, directionality δ) live. */
  setSpread(swell, delta) {
    if (swell !== this.swell) {
      this.swell = swell;
      this._qlut = buildSpreadNormLUT(swell);
    }
    this.delta = delta;
    for (const c of this.cascades) {
      c.swell = swell;
      c.delta = delta;
      c.qlut = this._qlut;
      c._recomputeSpectrum();
    }
  }

  update(time, dt = 0) {
    this._applyScale();
    for (const c of this.cascades) c.update(time, dt);
    // Honest significant wave height, MEASURED from the field: Hs = 4·RMS(η).
    // Band variances are independent, so they sum across cascades. The old
    // consumer-side proxy (1.1·wind·ampScale) overestimated wildly at high
    // wind (~48 "m" at 64 kn vs a real ~7 m), which pushed the whitecap
    // crest gate above every actual crest — no foam in exactly the
    // conditions that should be streaked white.
    let varSum = 0;
    for (const c of this.cascades) {
      const f = c.dispY;
      let s = 0;
      for (let i = 0; i < f.length; i++) s += f[i] * f[i];
      varSum += s / f.length;
    }
    this.Hs = 4 * Math.sqrt(varSum);
  }

  /**
   * Total Jacobian of the summed horizontal displacement at world (x, z) —
   * the breaking detector. J ≈ 1 on open water, → 0 as a crest pinches, < 0
   * when the surface folds through itself (an actively breaking wave). Same
   * math as the fragment shader, so CPU-spawned white water lands exactly
   * where the rendered surface is folding.
   */
  jacobianAt(x, z) {
    let a = 0;
    let d = 0;
    let b = 0;
    for (const c of this.cascades) {
      a += c._bilinear(c.jacA, x, z);
      d += c._bilinear(c.jacD, x, z);
      b += c._bilinear(c.jacB, x, z);
    }
    return (1 + a) * (1 + d) - b * b;
  }

  /** Summed water surface height at world (x, z). */
  heightAt(x, z) {
    // Sample dispY directly at (x, z) — the SAME point the GPU vertex shader
    // uses (it displaces gridWorld + disp, sampling disp at gridWorld.xz). The
    // boat must float on the surface that is actually DRAWN, so we match the
    // shader exactly rather than inverse-solving for the undisplaced point
    // (that would shift the sample by the horizontal chop offset and make the
    // hull hover off the crest it appears to sit on).
    let h = 0;
    for (const c of this.cascades) h += c._bilinear(c.dispY, x, z);
    return h;
  }

  /**
   * Summed water-particle velocity at world (x, z), optionally `depth` metres
   * below the surface. Orbital velocity decays as exp(k·y) per wave number
   * (Arc Blanc Eq 23) — applied here per CASCADE with its dominant k (the
   * band's energy sits at its low-k edge), so the 200 m swell still surges
   * at keel depth while the 5 m chop's orbits have already vanished. The old
   * single global exp(-0.2·depth) killed swell and chop at the same rate.
   */
  velocityAt(x, z, out, depth = 0) {
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
    const d = Math.max(depth, 0);
    for (const c of this.cascades) {
      const att = d > 0 ? Math.exp(-c.kMin * d) : 1;
      vx += c._bilinear(c.velX, px, pz) * att;
      vy += c._bilinear(c.velY, px, pz) * att;
      vz += c._bilinear(c.velZ, px, pz) * att;
    }
    out.x = vx;
    out.y = vy;
    out.z = vz;
    return out;
  }
}
