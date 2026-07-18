/**
 * Atmosphere.js — real-time single-scattering Rayleigh/Mie/ozone sky.
 *
 * Replaces the Preetham (1999) empirical fit the three.js Sky addon uses
 * with an actual physically-based scattering integral: for a given view
 * ray, march through a spherical atmosphere shell around a planet-scale
 * sphere, accumulating in-scattered light attenuated by out-scattering
 * along both the primary (view) ray and, at each sample, a secondary ray
 * toward the sun — the standard single-scattering double integral
 * (historically Nishita 1993/1996; this compact real-time form is widely
 * used in public single-pass GLSL atmosphere shaders).
 *
 * This is SINGLE scattering only — no multi-scatter LUT. That's Hillaire
 * 2020's actual contribution over the classic approach, and a materially
 * bigger implementation (precomputed transmittance + multi-scatter +
 * sky-view LUTs across several render passes, generated once and resampled
 * per frame). Single scattering alone is what produces the blue sky, red
 * sunsets and sun halo; multi-scatter mainly brightens the horizon at
 * twilight and softens overcast ambient. Documented as a known
 * simplification — a candidate follow-up — not silently passed off as more
 * than it is.
 *
 * Unlike Preetham/Hosek-Wilkie/Prague, every constant below is a measured
 * physical property of Earth's atmosphere (scattering cross-sections, scale
 * heights, planet radius) rather than a fitted-dataset coefficient, so
 * there's no large opaque table to transcribe or get subtly wrong.
 */

// Reference constants (SI units, metres) matching the calibration used by
// most public real-time single-scattering atmosphere shaders.
export const ATMOSPHERE_DEFAULTS = {
  planetRadius: 6371e3,
  atmosRadius: 6471e3, // 100 km atmosphere shell
  rayleighCoeff: [5.5e-6, 13.0e-6, 22.4e-6], // per-metre, R/G/B wavelengths
  rayleighScaleHeight: 8e3,
  mieCoeff: 21e-6,
  mieScaleHeight: 1.2e3,
  mieG: 0.758, // Henyey-Greenstein asymmetry (forward scattering)
  // Ozone: pure absorption (no scattering of its own), a "tent" density
  // profile peaking around 25 km altitude — the Chappuis band, responsible
  // for the extra deep blue/violet real skies show near dusk.
  ozoneCoeff: [0.650e-6, 1.881e-6, 0.085e-6],
  ozoneCenter: 25e3,
  ozoneWidth: 15e3,
  sunIntensity: 22.0,
};

const D = ATMOSPHERE_DEFAULTS;

/**
 * GLSL chunk: atmRaySphere() + atmosphere(). Include once per shader, then
 * call atmosphere(viewDir, rayOrigin, sunDir, rayleighMul, mieMul).
 * rayOrigin should be vec3(0.0, ATM_PLANET_R + heightAboveSeaLevel, 0.0).
 */
export const ATMOSPHERE_GLSL = /* glsl */ `
  const float ATM_PLANET_R = ${D.planetRadius.toFixed(1)};
  const float ATM_TOP_R = ${D.atmosRadius.toFixed(1)};
  const vec3  ATM_K_RLH_BASE = vec3(${D.rayleighCoeff.map((v) => v.toExponential(6)).join(', ')});
  const float ATM_SH_RLH = ${D.rayleighScaleHeight.toFixed(1)};
  const float ATM_K_MIE_BASE = ${D.mieCoeff.toExponential(6)};
  const float ATM_SH_MIE = ${D.mieScaleHeight.toFixed(1)};
  const float ATM_MIE_G = ${D.mieG.toFixed(4)};
  const vec3  ATM_K_OZONE = vec3(${D.ozoneCoeff.map((v) => v.toExponential(6)).join(', ')});
  const float ATM_OZONE_CENTER = ${D.ozoneCenter.toFixed(1)};
  const float ATM_OZONE_WIDTH = ${D.ozoneWidth.toFixed(1)};
  const float ATM_SUN_INTENSITY = ${D.sunIntensity.toFixed(2)};
  #define ATM_ISTEPS 16
  #define ATM_JSTEPS 8

  // Ray/sphere intersection about the origin: returns (tNear, tFar); if the
  // ray misses, tNear > tFar.
  vec2 atmRaySphere(vec3 r0, vec3 rd, float sr) {
    float a = dot(rd, rd);
    float b = 2.0 * dot(rd, r0);
    float c = dot(r0, r0) - (sr * sr);
    float disc = (b * b) - 4.0 * a * c;
    if (disc < 0.0) return vec2(1e5, -1e5);
    float sq = sqrt(disc);
    return vec2((-b - sq) / (2.0 * a), (-b + sq) / (2.0 * a));
  }

  float atmOzoneDensity(float h) {
    return max(0.0, 1.0 - abs(h - ATM_OZONE_CENTER) / ATM_OZONE_WIDTH);
  }

  // rayleighMul/mieMul: the UI's "rayleigh"/"turbidity" knobs, 1.0 = the
  // reference clear-day calibration above.
  vec3 atmosphere(vec3 rdIn, vec3 r0, vec3 sunDir, float rayleighMul, float mieMul) {
    vec3  kRlh = ATM_K_RLH_BASE * rayleighMul;
    float kMie = ATM_K_MIE_BASE * mieMul;

    // Clamp the view ray to never dip below a shallow "grazing" angle —
    // same trick, same reason, as Ocean.js's own reflection ray
    // (R.y = max(R.y, 0.02)): r0 sits only ~2-50 m above the ground sphere,
    // a planet-scale 6371 km radius, so ANY direction with even a hint of
    // downward tilt reaches the ground sphere within metres. Two broken
    // things happen if that's not guarded: terminating there gives an
    // almost-zero optical path → returns near-black (this sky dome is only
    // ever actually VISIBLE in the first place through the thin sliver at
    // the true horizon where the camera-following, finite ocean mesh
    // doesn't quite reach — so "near black right at the horizon" was
    // showing up as a solid dark band). Not terminating there is worse: the
    // ray tunnels through/past the solid planet to the far side, integrating
    // a physically-nonsensical, enormous optical path that overflows to
    // Infinity/NaN (confirmed: straight down produced NaN, which would
    // poison an entire face of the PMREM environment bake). Clamping the
    // angle sidesteps both — the sky just flattens out near the horizon,
    // same as it does for the ocean's reflection.
    vec3 rd = rdIn;
    rd.y = max(rd.y, 0.02);
    rd = normalize(rd);

    // Primary ray: camera (r0, always well inside the shell) to wherever it
    // exits the top of the atmosphere — always a valid positive root once
    // rd is clamped above.
    float tFar = atmRaySphere(r0, rd, ATM_TOP_R).y;
    float iStepSize = tFar / float(ATM_ISTEPS);
    float iTime = 0.0;

    vec3 totalRlh = vec3(0.0);
    vec3 totalMie = vec3(0.0);
    float iOdRlh = 0.0;
    float iOdMie = 0.0;
    float iOdOzone = 0.0;

    float mu = dot(rd, sunDir);
    float mumu = mu * mu;
    float gg = ATM_MIE_G * ATM_MIE_G;
    float pRlh = 3.0 / (16.0 * 3.14159265) * (1.0 + mumu);
    float pMie = 3.0 / (8.0 * 3.14159265) * ((1.0 - gg) * (mumu + 1.0))
               / (pow(1.0 + gg - 2.0 * mu * ATM_MIE_G, 1.5) * (2.0 + gg));

    for (int i = 0; i < ATM_ISTEPS; i++) {
      vec3 iPos = r0 + rd * (iTime + iStepSize * 0.5);
      float iHeight = length(iPos) - ATM_PLANET_R;

      float odStepRlh = exp(-iHeight / ATM_SH_RLH) * iStepSize;
      float odStepMie = exp(-iHeight / ATM_SH_MIE) * iStepSize;
      float odStepOzone = atmOzoneDensity(iHeight) * iStepSize;
      iOdRlh += odStepRlh;
      iOdMie += odStepMie;
      iOdOzone += odStepOzone;

      // Secondary ray: iPos (inside the shell) to the top of the
      // atmosphere along the sun direction — its optical depth is what
      // attenuates the light reaching iPos from the sun.
      float jStepSize = atmRaySphere(iPos, sunDir, ATM_TOP_R).y / float(ATM_JSTEPS);
      float jTime = 0.0;
      float jOdRlh = 0.0;
      float jOdMie = 0.0;
      float jOdOzone = 0.0;
      for (int j = 0; j < ATM_JSTEPS; j++) {
        vec3 jPos = iPos + sunDir * (jTime + jStepSize * 0.5);
        float jHeight = length(jPos) - ATM_PLANET_R;
        jOdRlh += exp(-jHeight / ATM_SH_RLH) * jStepSize;
        jOdMie += exp(-jHeight / ATM_SH_MIE) * jStepSize;
        jOdOzone += atmOzoneDensity(jHeight) * jStepSize;
        jTime += jStepSize;
      }

      vec3 attn = exp(-(kMie * (iOdMie + jOdMie) + kRlh * (iOdRlh + jOdRlh)
                       + ATM_K_OZONE * (iOdOzone + jOdOzone)));
      totalRlh += odStepRlh * attn;
      totalMie += odStepMie * attn;
      iTime += iStepSize;
    }

    return ATM_SUN_INTENSITY * (pRlh * kRlh * totalRlh + pMie * kMie * totalMie);
  }
`;

// --- CPU mirror ------------------------------------------------------------
// Same math, same constants, so SkySystem can pull a couple of
// representative colors (zenith, horizon-toward-sun) for the ocean shader's
// analytic reflection and for scene.fog without reading back from the GPU.
// Only called when the sun moves (not per-frame), so plain JS is plenty fast.

function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function add3(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function scale3(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
function length3(a) { return Math.sqrt(dot3(a, a)); }
function normalize3(a) { const l = length3(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
function ozoneDensity(h) { return Math.max(0, 1 - Math.abs(h - D.ozoneCenter) / D.ozoneWidth); }

function raySphere(r0, rd, sr) {
  const a = dot3(rd, rd);
  const b = 2 * dot3(rd, r0);
  const c = dot3(r0, r0) - sr * sr;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return [1e5, -1e5];
  const sq = Math.sqrt(disc);
  return [(-b - sq) / (2 * a), (-b + sq) / (2 * a)];
}

/**
 * @param {[number,number,number]} dir     view direction, world space
 * @param {[number,number,number]} sunDir  direction TOWARDS the sun
 * @param {{rayleighMul?:number, mieMul?:number, heightM?:number}} opts
 * @returns {[number,number,number]} linear HDR RGB
 */
export function sampleAtmosphere(dir, sunDir, { rayleighMul = 1, mieMul = 1, heightM = 2 } = {}) {
  const kRlh = D.rayleighCoeff.map((v) => v * rayleighMul);
  const kMie = D.mieCoeff * mieMul;

  const r0 = [0, D.planetRadius + Math.max(heightM, 0), 0];
  // Clamp to a shallow grazing angle — see the matching comment in
  // ATMOSPHERE_GLSL (avoids both a near-black horizon and a NaN-producing
  // tunnel-through-the-planet path for steeper downward directions).
  const dirClamped = [dir[0], Math.max(dir[1], 0.02), dir[2]];
  const rd = normalize3(dirClamped);
  const sd = normalize3(sunDir);

  const tFar = raySphere(r0, rd, D.atmosRadius)[1];

  const iSteps = 16;
  const jSteps = 8;
  const iStepSize = tFar / iSteps;

  let totalRlh = [0, 0, 0];
  let totalMie = [0, 0, 0];
  let iOdRlh = 0, iOdMie = 0, iOdOzone = 0;

  const mu = dot3(rd, sd);
  const mumu = mu * mu;
  const gg = D.mieG * D.mieG;
  const pRlh = (3 / (16 * Math.PI)) * (1 + mumu);
  const pMie =
    ((3 / (8 * Math.PI)) * ((1 - gg) * (mumu + 1))) /
    (Math.pow(1 + gg - 2 * mu * D.mieG, 1.5) * (2 + gg));

  let iTime = 0;
  for (let i = 0; i < iSteps; i++) {
    const iPos = add3(r0, scale3(rd, iTime + iStepSize * 0.5));
    const iHeight = length3(iPos) - D.planetRadius;
    const odStepRlh = Math.exp(-iHeight / D.rayleighScaleHeight) * iStepSize;
    const odStepMie = Math.exp(-iHeight / D.mieScaleHeight) * iStepSize;
    const odStepOzone = ozoneDensity(iHeight) * iStepSize;
    iOdRlh += odStepRlh;
    iOdMie += odStepMie;
    iOdOzone += odStepOzone;

    const jFar = raySphere(iPos, sd, D.atmosRadius)[1];
    const jStepSize = jFar / jSteps;
    let jOdRlh = 0, jOdMie = 0, jOdOzone = 0;
    let jTime = 0;
    for (let j = 0; j < jSteps; j++) {
      const jPos = add3(iPos, scale3(sd, jTime + jStepSize * 0.5));
      const jHeight = length3(jPos) - D.planetRadius;
      jOdRlh += Math.exp(-jHeight / D.rayleighScaleHeight) * jStepSize;
      jOdMie += Math.exp(-jHeight / D.mieScaleHeight) * jStepSize;
      jOdOzone += ozoneDensity(jHeight) * jStepSize;
      jTime += jStepSize;
    }

    const attn = [0, 1, 2].map((k) =>
      Math.exp(
        -(kMie * (iOdMie + jOdMie) +
          kRlh[k] * (iOdRlh + jOdRlh) +
          D.ozoneCoeff[k] * (iOdOzone + jOdOzone))
      )
    );
    totalRlh = totalRlh.map((v, k) => v + odStepRlh * attn[k]);
    totalMie = totalMie.map((v, k) => v + odStepMie * attn[k]);
    iTime += iStepSize;
  }

  return [0, 1, 2].map(
    (k) => D.sunIntensity * (pRlh * kRlh[k] * totalRlh[k] + pMie * kMie * totalMie[k])
  );
}
