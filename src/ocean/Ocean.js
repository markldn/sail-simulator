/**
 * Ocean.js — Gerstner-wave ocean surface with a custom GLSL material.
 *
 * Design decisions:
 * - Custom ShaderMaterial rather than patching MeshStandardMaterial via
 *   onBeforeCompile: water shading (fresnel-dominated reflection, subsurface
 *   scattering, foam) doesn't fit the standard PBR surface model well, and a
 *   self-contained shader is robust against three.js internal refactors.
 * - The wave sum in the vertex shader mirrors GerstnerWaves.js EXACTLY —
 *   change one, change both. NUM_WAVES is injected as a #define.
 * - The mesh is a flat grid that follows the camera in world-snapped steps
 *   (see update()). Because the shader works in WORLD space, sliding the
 *   grid under the camera is invisible: the waves stay put, the tessellated
 *   region just re-centres. This gives "infinite" ocean without LOD rings
 *   (a clipmap/projected grid is a later optimisation).
 * - Sky reflection is an analytic gradient (uZenith/uHorizon/uSun colors fed
 *   by SkySystem) rather than sampling the PMREM environment texture. It
 *   tracks the real sky closely and keeps the shader simple; switching to
 *   true envmap sampling is a candidate for the graphics-polish phase.
 *
 * Upgrade path noted for later phases: FFT ocean (oceanographic spectrum,
 * hundreds of waves) with the same world-space height-query contract, so
 * physics code won't need to change.
 */

import * as THREE from 'three';
import {
  GRAVITY,
  NUM_WAVES,
  createWaveSet,
  packWaveUniforms,
  getWaveHeight,
  sampleWaveVelocity,
  sampleSubsurfaceVelocity,
} from './GerstnerWaves.js';
import { FFTOcean } from './FFTWaves.js';

// How the sea answers the wind (used when seaFollowsWind is on):
// height scale from wind speed — glassy under 1 kn, ~1.0 at 12 kn,
// capped at 2.4 (the Gerstner self-intersection ceiling).
function seaHeightForWind(kn) {
  if (kn < 0.5) return 0.03;
  return Math.min(0.05 + Math.pow(kn / 12, 1.35), 2.4);
}
function seaChopForWind(kn) {
  return THREE.MathUtils.clamp(0.45 + kn * 0.02, 0.5, 1.05);
}
const SEA_BUILD_TAU = 5; // s — e-folding time for height/chop to respond
const SEA_ROT_RATE = THREE.MathUtils.degToRad(6); // rad/s max direction swing

// ---------------------------------------------------------------------------
// Vertex shader — Gerstner displacement + analytic surface derivatives
// ---------------------------------------------------------------------------
// One extra mutable uniform slot beyond the fixed spectrum: the "event
// wave" (tsunami / rogue-wave presets). Amplitude 0 keeps it inert.
const WAVE_SLOTS = NUM_WAVES + 1;

// Persistent wake: a ring buffer of the boat's recent world positions, fed to
// the shader so the foam trail stays put in world space and curves with the
// boat's actual track (rather than swinging with a boat-relative wedge).
const WAKE_MAX = 48;
const WAKE_LIFE = 7.0; // seconds a wake segment lingers before it fades out

/** 1×1 white RGBA texture: unpacks to depth 1.0 → "nothing in shadow". */
function makeWhiteTexture() {
  const tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  tex.needsUpdate = true;
  return tex;
}

const VERTEX_SHADER = /* glsl */ `
  // The surface is displaced by a stack of FFT CASCADES (FFTWaves.js), each
  // uploaded as a texture: RGBA = (dx, dy, dz, foam) in metres, tiled in world
  // space at its own lengthscale. Summing them gives waves across every scale
  // — long swell through short chop — with no single tiling period. (texture2D
  // in a vertex stage samples the base level; three rewrites it to the ES3
  // texture() built-in, valid in both stages.)
  #define OCEAN_CASCADES 3
  uniform sampler2D uCascadeTex[OCEAN_CASCADES];
  uniform float uCascadePatch[OCEAN_CASCADES]; // tile size (m) per cascade
  uniform float uCascadeTexel[OCEAN_CASCADES]; // metres per texel, slope taps
  uniform float uTime;
  uniform vec4  uSwell;      // event wave: dirX, dirZ, k, amplitude
  uniform vec2  uSwellWave;  // event wave: omega, phase

  varying vec3  vWorldPos;   // displaced world-space position
  varying vec3  vGrad;       // (dHeight/dx, foam, dHeight/dz)
  varying float vHeight;     // vertical displacement (for subsurface tint)

  #define OCEAN_SAMPLE(I) { \
    float P = uCascadePatch[I]; \
    vec4 s = texture2D(uCascadeTex[I], gridWorld.xz / P); \
    disp += s.xyz; foam += s.w; \
    float e = uCascadeTexel[I]; \
    float hl = texture2D(uCascadeTex[I], (gridWorld.xz + vec2(-e, 0.0)) / P).y; \
    float hr = texture2D(uCascadeTex[I], (gridWorld.xz + vec2( e, 0.0)) / P).y; \
    float hd = texture2D(uCascadeTex[I], (gridWorld.xz + vec2(0.0, -e)) / P).y; \
    float hu = texture2D(uCascadeTex[I], (gridWorld.xz + vec2(0.0,  e)) / P).y; \
    slope += vec2(hr - hl, hu - hd) / (2.0 * e); }

  void main() {
    // Undisplaced grid point in world space. The ocean mesh is a plane in
    // XZ; modelMatrix carries the camera-follow offset (see Ocean.update).
    vec3 gridWorld = (modelMatrix * vec4(position, 1.0)).xyz;

    vec3 disp = vec3(0.0);
    vec2 slope = vec2(0.0);
    float foam = 0.0;
    OCEAN_SAMPLE(0)
    OCEAN_SAMPLE(1)
    OCEAN_SAMPLE(2)

    // Event wave (Tsunami/Rogue): one big Gerstner wave layered on the sea.
    if (uSwell.w > 0.0001) {
      vec2 sd = uSwell.xy;
      float sk = uSwell.z;
      float sa = uSwell.w;
      float sf = sk * dot(sd, gridWorld.xz) - uSwellWave.x * uTime + uSwellWave.y;
      disp.xz += sd * (sa * cos(sf)); // Gerstner horizontal pinch
      disp.y  += sa * sin(sf);
      slope   += sd * (sk * sa * cos(sf));
    }

    vec3 displaced = gridWorld + disp;
    vWorldPos = displaced;
    vGrad     = vec3(slope.x, foam, slope.y); // foam rides in the jac slot
    vHeight   = disp.y;
    gl_Position = projectionMatrix * viewMatrix * vec4(displaced, 1.0);
  }
`;

// ---------------------------------------------------------------------------
// Fragment shader — fresnel reflection, subsurface scatter, sun spec, foam
// ---------------------------------------------------------------------------
const FRAGMENT_SHADER = /* glsl */ `
  #define TWO_PI 6.28318530718
  #define GRAVITY ${GRAVITY.toFixed(4)}

  // three's packing chunk: unpackRGBAToDepth for reading the shadow map
  #include <packing>

  #define WAKE_MAX ${WAKE_MAX}
  uniform float uTime;
  uniform float uWaveRot;       // detail ripples swing with the sea too
  uniform vec4  uBoatPosDir;    // boat x, z, forwardX, forwardZ
  uniform float uBoatSpeed;     // m/s
  uniform vec4  uWake[WAKE_MAX]; // (worldX, worldZ, ageNorm, strength)
  uniform int   uWakeCount;
  uniform sampler2D uShadowMap; // sun shadow map (boat shadow on water)
  uniform mat4  uShadowMatrix;
  uniform float uShadowStrength; // 0 = shadow sampling off
  uniform float uWhitecaps;     // 0 calm … 1 gale: how readily crests break
  uniform float uSeaHeight;     // rough Hs proxy — scales the crest foam gate
  uniform vec3  uSunDir;        // TOWARDS the sun, normalized
  uniform vec3  uSunColor;      // linear
  uniform vec3  uZenithColor;   // analytic sky gradient (matches SkySystem)
  uniform vec3  uHorizonColor;
  uniform vec3  uDeepColor;     // water body color (light fully absorbed)
  uniform vec3  uScatterColor;  // color scattered back out near the surface
  uniform float uFogDensity;
  uniform vec2  uGridCenter;    // xz of the camera-snapped grid centre
  uniform float uGridHalf;      // half the grid side length (metres)

  varying vec3  vWorldPos;
  varying vec3  vGrad;
  varying float vHeight;

  // --- cheap hash/value noise, used only to break up foam edges -----------
  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i),                 hash(i + vec2(1, 0)), u.x),
               mix(hash(i + vec2(0, 1)),    hash(i + vec2(1, 1)), u.x), u.y);
  }

  // --- high-frequency ripple detail (gradient only, no displacement) ------
  // Three hard-coded capillary-scale waves evaluated per-pixel. They are far
  // too small for the vertex grid to capture, but their normals sell the
  // surface up close. Faded with distance to avoid specular shimmer/aliasing.
  vec2 detailGradient(vec2 p, float t) {
    vec2 grad = vec2(0.0);
    float cR = cos(uWaveRot);
    float sR = sin(uWaveRot);
    // (dir.x, dir.y, wavelength, amplitude) — deterministic, tiny. Five
    // octaves spanning ~1.2 m ripples down to 18 cm cat's-paws bridge the gap
    // between the coarse vertex Gerstner set and the pixel, so the surface
    // keeps texture (and broken-up reflections) well into the mid-field.
    // Supplement the FFT geometry with fine ripple in the NORMAL only (the
    // FFT is low-passed to ~4 m so the mesh stays alias-free; this carries the
    // sub-metre chop). Kept subtle so it textures rather than granulates.
    vec4 defs[5];
    defs[0] = vec4( 0.95,  0.31, 2.10, 0.0120);
    defs[1] = vec4(-0.40,  0.92, 1.30, 0.0080);
    defs[2] = vec4( 0.60, -0.80, 0.80, 0.0050);
    defs[3] = vec4(-0.86, -0.51, 0.48, 0.0030);
    defs[4] = vec4( 0.24,  0.97, 0.30, 0.0018);
    for (int i = 0; i < 5; i++) {
      vec2  d0 = defs[i].xy;
      vec2  d  = vec2(d0.x * cR - d0.y * sR, d0.x * sR + d0.y * cR);
      float k = TWO_PI / defs[i].z;
      float a = defs[i].w;
      float w = sqrt(GRAVITY * k);
      float f = k * dot(d, p) - w * t * 1.1;
      grad += d * (k * a * cos(f));
    }
    return grad;
  }

  // --- persistent wake trail ------------------------------------------------
  // Foam along the world-space polyline of the boat's recent track (uWake).
  // Because the points are absolute world positions, the trail stays put and
  // curves through the boat's turns, and spreads + fades as each segment ages.
  float wakeFoam(vec2 p) {
    float f = 0.0;
    for (int i = 0; i < WAKE_MAX - 1; i++) {
      if (i + 1 >= uWakeCount) break;
      vec4 A = uWake[i];
      vec4 B = uWake[i + 1];
      vec2 ba = B.xy - A.xy;
      vec2 pa = p - A.xy;
      float bb = max(dot(ba, ba), 1e-4);
      float h = clamp(dot(pa, ba) / bb, 0.0, 1.0);
      float d = length(pa - ba * h);
      float age = mix(A.z, B.z, h);
      float str = mix(A.w, B.w, h);
      float width = 1.0 + 3.2 * age;          // spreads with age
      f += str * exp(-(d * d) / (width * width));
    }
    return clamp(f * 1.4, 0.0, 1.0);
  }

  // --- boat interaction foam ------------------------------------------------
  // Real wake foam is turbulent, patchy white water — never a clean line. So
  // every feature here is SOFT (gaussian falloff, no hard cores) and gated by
  // a noise "clump" mask, so it breaks into scattered froth instead of a
  // painted stripe. Two features only, both speed-gated:
  //   1. bow foam — a soft band along the forward waterline where the stem
  //      parts the water (a real boat throws foam at the bow, not the stern),
  //   2. stern churn — a short, soft, quickly-dissolving disturbed patch
  //      dragged behind the transom, about a beam wide.
  // (A crisp Kelvin V or a long persistent trail needs a world-space trail
  // buffer to look right; a procedural line only ever reads as a laser, so it
  // is deliberately left out.)
  float boatFoam(vec2 p, float t) {
    float sp = clamp(uBoatSpeed / 3.0, 0.0, 1.0);       // ~full by 6 kn
    if (sp < 0.04) return 0.0;                           // lying still: clean water

    vec2 rel = p - uBoatPosDir.xy;
    vec2 fwd = uBoatPosDir.zw;
    float along  = dot(rel, fwd);                       // + ahead (toward bow)
    float across = rel.x * fwd.y - rel.y * fwd.x;
    float b = abs(across);

    // Turbulent texture: two scrolling octaves, thresholded into clumps so no
    // feature can render as a continuous edge.
    float n1 = vnoise(p * 1.9 + vec2(t * 0.40, -t * 0.26));
    float n2 = vnoise(p * 0.8 - vec2(t * 0.12, t * 0.17));
    float clumps = smoothstep(0.28, 0.72, 0.5 * n1 + 0.5 * n2);

    // 1) Bow foam: a soft band on the forward half of the waterline ellipse.
    float e    = (along * along) / (3.7 * 3.7) + (across * across) / (1.2 * 1.2);
    float band = exp(-pow((e - 1.0) * 2.4, 2.0));       // soft, centred on hull edge
    float fwdW = smoothstep(-2.2, 2.4, along);          // 0 aft → 1 at the bow
    float bow  = band * fwdW;

    // 2) Stern churn: soft gaussian across ~a beam, fading within a few metres.
    float back  = max(-along - 2.5, 0.0);               // ~0 at the transom
    float tLen  = 3.5 + 9.0 * sp;
    float wedge = exp(-pow(b / (1.25 + 0.14 * back), 2.0))
                * (1.0 - smoothstep(0.0, tLen, back));

    float foam = (bow + wedge * 0.9) * clumps;
    foam *= (0.2 + 0.8 * sp) * 0.65;                    // subtle, speed-scaled
    return clamp(foam, 0.0, 1.0);
  }

  // --- sun shadow (the boat shading the water) --------------------------------
  // 3×3 PCF against the DirectionalLight's shadow map, widened well beyond
  // the map's native sharpness: on water, surface ripple scatters the edge
  // of any shadow, so crisp penumbras read as "object on a floor".
  // Returns sun VISIBILITY in [1-uShadowStrength, 1]; the caller decides
  // how strongly each lighting term responds (glints die completely in a
  // shadow, the water body barely dims — see main()).
  float sunShadow() {
    if (uShadowStrength < 0.01) return 1.0;
    vec4 sc = uShadowMatrix * vec4(vWorldPos, 1.0);
    vec3 uvz = sc.xyz / sc.w;
    if (uvz.z <= 0.0 || uvz.z >= 1.0) return 1.0;
    // Fade to unshadowed near the frustum border so long mast/sail streaks
    // dissolve instead of being guillotined at the shadow camera's edge.
    vec2 edge = min(uvz.xy, 1.0 - uvz.xy);
    float rim = smoothstep(0.0, 0.09, min(edge.x, edge.y));
    if (rim <= 0.0) return 1.0;
    // 5×5 PCF: 25 taps give a smooth penumbra on the water instead of the
    // stair-stepped blocks a sparse 3×3 kernel leaves when spread wide.
    float lit = 0.0;
    vec2 texel = vec2(1.0 / 4096.0) * 2.2;
    for (int i = -2; i <= 2; i++) {
      for (int j = -2; j <= 2; j++) {
        float d = unpackRGBAToDepth(
          texture2D(uShadowMap, uvz.xy + vec2(float(i), float(j)) * texel));
        lit += step(uvz.z - 0.004, d);
      }
    }
    lit /= 25.0;
    return 1.0 - (1.0 - lit) * rim * uShadowStrength;
  }

  // --- analytic sky, kept consistent with SkySystem's fed colors ----------
  vec3 skyColor(vec3 dir) {
    float h = clamp(dir.y, 0.0, 1.0);
    vec3 sky = mix(uHorizonColor, uZenithColor, pow(h, 0.55));
    float sunDot = max(dot(dir, uSunDir), 0.0);
    // tight disc (picked up by bloom) + wide forward-scatter halo
    sky += uSunColor * (pow(sunDot, 1200.0) * 30.0 + pow(sunDot, 8.0) * 0.12);
    return sky;
  }

  void main() {
    vec3 V = normalize(cameraPosition - vWorldPos);
    float dist = length(cameraPosition - vWorldPos);

    // Reconstruct the normal from raw derivatives so per-pixel detail can be
    // summed BEFORE normalization (correct gradient composition). The detail
    // fades with distance to keep the finest ripples from aliasing into
    // specular shimmer — but gently, so the mid-field stays alive.
    float detailFade = exp(-dist * 0.03);
    vec2 dg = detailGradient(vWorldPos.xz, uTime) * detailFade;
    // Standard height-field normal from the summed cascade slopes + fine detail.
    // vGrad.y is FOAM now (summed cascade folding), not a slope term, so it must
    // NOT feed the normal — the slope alone tilts the surface.
    vec3 N = normalize(vec3(-(vGrad.x + dg.x), 1.0, -(vGrad.z + dg.y)));

    // ---- Fresnel (Schlick, F0 = 0.02 for water) -------------------------
    float NdotV = max(dot(N, V), 0.0);
    float fresnel = 0.02 + 0.98 * pow(1.0 - NdotV, 5.0);

    // Sun visibility here (1 = lit, dips where the boat shades the water).
    // Split response: specular glints need direct sun so they die entirely
    // in shadow; the water BODY is lit by the whole sky dome, so blocking
    // just the sun only mildly darkens it. This split is what makes a
    // shadow on water look like water, not pavement.
    float sunVis = sunShadow();
    float shadow = sunVis;                    // for glints / direct sparkle
    float bodyShadow = mix(1.0, sunVis, 0.4); // for scatter & foam lighting

    // ---- Sky reflection --------------------------------------------------
    vec3 R = reflect(-V, N);
    R.y = max(R.y, 0.02); // water can't reflect what's below the horizon
    vec3 reflected = skyColor(normalize(R));

    // ---- Water body: absorption + subsurface scattering ------------------
    // Light entering a wave gets scattered back out with the water's
    // characteristic blue-green. Strongest when looking towards the sun
    // through the top of a wave (classic backlit "glass" crests).
    float sunThrough = pow(max(dot(V, -uSunDir), 0.0), 3.0);
    float crestBoost = clamp(vHeight * 0.55 + 0.45, 0.0, 1.2);
    vec3 body = uDeepColor;
    body += uScatterColor * (0.30 + 0.70 * max(dot(N, uSunDir), 0.0) * bodyShadow) * 0.35;
    body += uScatterColor * sunThrough * crestBoost * 0.85 * bodyShadow;

    // ---- Sun specular (sharp Blinn lobe; ACES + bloom shape the rest) ---
    vec3 H = normalize(uSunDir + V);
    float spec = pow(max(dot(N, H), 0.0), 380.0) * 2.2 * shadow;
    vec3 specular = uSunColor * spec;

    // ---- Foam ------------------------------------------------------------
    // vGrad.y is the Gerstner "pinch" term: it approaches 1 where crests
    // fold over. Noise breaks the threshold into streaks; foam gets simple
    // diffuse lighting so it darkens correctly at dusk.
    float foamNoise = vnoise(vWorldPos.xz * 1.7 + uTime * 0.15)
                    * vnoise(vWorldPos.xz * 0.23 - uTime * 0.02);
    // Whitecapping: wind lowers the breaking threshold, so with a rising
    // breeze progressively gentler crests carry foam (Beaufort look).
    // vGrad.y is the summed cascade Jacobian folding — whitecaps form where the
    // choppy crests pinch (J small). Wind lowers the breaking threshold so more
    // crests foam as it builds. Noise breaks it into streaks, not a flat wash.
    float foamLo = mix(0.50, 0.08, uWhitecaps);
    float foam = smoothstep(foamLo, foamLo + 0.28, vGrad.y * 1.7 + foamNoise * 0.35 - 0.04);
    // Whitecaps break at the TOPS of waves: gate the folding-foam by height so
    // it caps the crests instead of mottling the whole surface. Scaled by the
    // sea-state Hs proxy so it tracks the actual wave size.
    float crestGate = smoothstep(0.12 * uSeaHeight, 0.5 * uSeaHeight, vHeight);
    foam *= crestGate;
    // Hull churn, the persistent curved wake trail, and the crest foam all add.
    foam = clamp(foam + boatFoam(vWorldPos.xz, uTime) + wakeFoam(vWorldPos.xz), 0.0, 1.0);
    vec3 foamColor = vec3(0.92) * (0.25 + 0.75 * max(dot(N, uSunDir), 0.0) * bodyShadow)
                   * (uSunColor * 0.5 + vec3(0.5));

    // ---- Composite -------------------------------------------------------
    vec3 color = mix(body, reflected, fresnel) + specular;
    color = mix(color, foamColor, clamp(foam, 0.0, 1.0));

    // ---- Height fog towards the horizon color ---------------------------
    float fog = 1.0 - exp(-pow(dist * uFogDensity, 1.6));
    color = mix(color, uHorizonColor, clamp(fog, 0.0, 1.0));

    // ---- Grid-edge dissolve --------------------------------------------
    // The tessellated sea is a finite tile that re-centres on the camera, so
    // without this its square boundary shows as a hard "coastline" against
    // the sky. Fade the outer rim of the tile into the horizon color (using
    // a square/Chebyshev metric so all four edges vanish together): the sea
    // now reads as blending seamlessly into the haze — an endless ocean.
    vec2 gc = abs(vWorldPos.xz - uGridCenter) / uGridHalf;
    float edgeFade = smoothstep(0.70, 0.98, max(gc.x, gc.y));
    color = mix(color, uHorizonColor, edgeFade);

    gl_FragColor = vec4(color, 1.0);
    // Output is linear HDR; tone mapping + sRGB happen in the OutputPass.
  }
`;

export class Ocean {
  /**
   * @param {number} size     side length of the ocean grid in metres
   * @param {number} segments grid resolution per side
   */
  constructor(size = 900, segments = 512) {
    this.size = size;
    this.segments = segments;
    this.gridStep = size / segments;

    // Live sea-state parameters. With seaFollowsWind on (default) they are
    // driven from the wind each frame; turn it off in the GUI for manual
    // slider control.
    this.heightScale = 1.0;
    this.choppiness = 0.8;
    this.waveRot = 0; // radians; wave travel dir = spectrum dirs rotated by this
    this.seaFollowsWind = true;

    // The wave set shared with physics. Ocean owns it; physics asks Ocean.
    this.waves = createWaveSet();

    // Event-wave slot (tsunami/rogue presets): lives INSIDE this.waves and
    // the uniform array, so the CPU buoyancy queries and the GPU surface
    // stay in lockstep by construction. See setSwell()/_syncSwellSlot().
    const k0 = (2 * Math.PI) / 200;
    this._swellSlot = {
      dirX: 1, dirZ: 0, wavelength: 200, amplitude: 0, phase: 0,
      k: k0, omega: Math.sqrt(GRAVITY * k0),
    };
    this.waves.push(this._swellSlot);
    this._swellDesired = null; // {bearingDeg, wavelength, amplitude}

    // --- FFT spectral field: the real source of truth ----------------------
    // Drives BOTH the vertex displacement (uploaded as uDispTex each frame)
    // and the CPU height/velocity queries the physics uses — so the boat
    // floats on exactly the water that's drawn. N=128 over a 160 m patch runs
    // ~3 ms/frame (see test-fft.mjs) and tiles seamlessly.
    this.fft = new FFTOcean({ windSpeed: 9 }); // 3 band-limited cascades
    // Live sea-state wind (m/s) driving the spectrum; morphs toward the wind.
    this._seaWindMs = 9;
    this._lastRebuildWind = 9;
    this._lastRebuildDir = 0;
    const cascades = this.fft.cascades;
    this._cascadeData = cascades.map((c) => new Uint16Array(c.N * c.N * 4)); // half-float RGBA
    this.cascadeTextures = cascades.map((c, i) => {
      const t = new THREE.DataTexture(
        this._cascadeData[i], c.N, c.N, THREE.RGBAFormat, THREE.HalfFloatType
      );
      t.magFilter = THREE.LinearFilter;
      t.minFilter = THREE.LinearFilter;
      t.wrapS = THREE.RepeatWrapping;
      t.wrapT = THREE.RepeatWrapping;
      t.needsUpdate = true;
      return t;
    });

    const packed = packWaveUniforms(this.waves);

    this.uniforms = {
      uTime: { value: 0 },
      uHeightScale: { value: this.heightScale },
      uChoppiness: { value: this.choppiness },
      uWaveRot: { value: 0 },
      uWaves: { value: packed.waveVectors },
      uPhases: { value: packed.phases },
      // FFT cascade displacement fields (vertex) — see FFTWaves.js.
      uCascadeTex: { value: this.cascadeTextures },
      uCascadePatch: { value: cascades.map((c) => c.patch) },
      uCascadeTexel: { value: cascades.map((c) => c.patch / c.N) },
      uSeaHeight: { value: 3.0 }, // rough Hs proxy — places whitecaps on crests
      // Event wave (Tsunami/Rogue): one big analytic Gerstner wave on top of
      // the FFT sea. Amplitude 0 = inert.
      uSwell: { value: new THREE.Vector4(1, 0, 0.0314, 0) }, // dirX,dirZ,k,amp
      uSwellWave: { value: new THREE.Vector2(0.556, 0) }, // omega, phase
      // Persistent wake trail: each vec4 = (worldX, worldZ, ageNorm, strength).
      uWake: { value: Array.from({ length: WAKE_MAX }, () => new THREE.Vector4(0, 0, 1, 0)) },
      uWakeCount: { value: 0 },
      // Sky-driven values; SkySystem overwrites these via applySkyState().
      uSunDir: { value: new THREE.Vector3(0.3, 0.7, 0.2).normalize() },
      uSunColor: { value: new THREE.Color(1.0, 0.95, 0.85) },
      uZenithColor: { value: new THREE.Color(0.11, 0.28, 0.55) },
      uHorizonColor: { value: new THREE.Color(0.65, 0.78, 0.88) },
      uDeepColor: { value: new THREE.Color(0.008, 0.042, 0.09) },
      uScatterColor: { value: new THREE.Color(0.02, 0.22, 0.26) },
      uFogDensity: { value: 0.0016 },
      // Grid-edge dissolve: centre follows the camera-snapped mesh each frame.
      uGridCenter: { value: new THREE.Vector2(0, 0) },
      uGridHalf: { value: size * 0.5 },
      // Boat interaction: (x, z, forwardX, forwardZ) + speed. Drives hull
      // contact foam and the wake trail in the fragment shader.
      uBoatPosDir: { value: new THREE.Vector4(0, 0, 1, 0) },
      uBoatSpeed: { value: 0 },
      // Sun shadow (the boat's shadow on the water). Starts as a 1×1 white
      // texture (= "no shadow") until main.js wires the real shadow map
      // after the first shadow render.
      uShadowMap: { value: makeWhiteTexture() },
      uShadowMatrix: { value: new THREE.Matrix4() },
      uShadowStrength: { value: 0 },
      uWhitecaps: { value: 0.15 },
    };

    // Plane built in the XZ plane directly (rotateX would complicate the
    // world-space reasoning in the shader for no benefit).
    const geometry = new THREE.PlaneGeometry(size, size, segments, segments);
    geometry.rotateX(-Math.PI / 2);

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      uniforms: this.uniforms,
      // DoubleSide so the surface exists when the camera dips under a wave
      // (the underwater post-pass in main.js supplies the murk; the
      // backside shading itself is approximate — noted for a future true
      // underwater phase).
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.frustumCulled = false; // displaced verts break the static AABB
    this.mesh.matrixAutoUpdate = true;
  }

  /** Current simulation time — physics MUST query heights with this value. */
  get time() {
    return this.uniforms.uTime.value;
  }

  setHeightScale(v) {
    this.heightScale = v;
    this.uniforms.uHeightScale.value = v;
  }

  setChoppiness(v) {
    this.choppiness = v;
    this.uniforms.uChoppiness.value = v;
  }

  /** SkySystem pushes its state here whenever the sun moves. */
  applySkyState({ sunDir, sunColor, zenithColor, horizonColor, fogDensity }) {
    this.uniforms.uSunDir.value.copy(sunDir);
    this.uniforms.uSunColor.value.copy(sunColor);
    this.uniforms.uZenithColor.value.copy(zenithColor);
    this.uniforms.uHorizonColor.value.copy(horizonColor);
    if (fogDensity !== undefined) this.uniforms.uFogDensity.value = fogDensity;
  }

  /**
   * Water height at world (x, z) — THE buoyancy query. Thin wrapper so
   * callers never have to think about wave sets, scales or clocks.
   */
  getHeightAt(x, z) {
    let h = this.fft.heightAt(x, z);
    const s = this._swellSlot;
    if (s.amplitude > 0.0001) {
      h += s.amplitude * Math.sin(s.k * (s.dirX * x + s.dirZ * z) - s.omega * this.time + s.phase);
    }
    return h;
  }

  /**
   * Water-particle (orbital) velocity at world (x, z). Hull drag is computed
   * relative to this, so waves carry the boat (incl. the event wave's surge).
   * @param {THREE.Vector3} target filled and returned
   */
  getWaterVelocityAt(x, z, target) {
    this.fft.velocityAt(x, z, target);
    const s = this._swellSlot;
    if (s.amplitude > 0.0001) {
      const f = s.k * (s.dirX * x + s.dirZ * z) - s.omega * this.time + s.phase;
      const aw = s.amplitude * s.omega;
      target.x += s.dirX * aw * Math.sin(f);
      target.y += -aw * Math.cos(f);
      target.z += s.dirZ * aw * Math.sin(f);
    }
    return target;
  }

  /**
   * Water-particle velocity at (x, z) some `depth` metres below the surface.
   * The FFT field is a surface field, so we apply a representative exponential
   * depth decay to the orbital velocity (the swell reaches deeper than chop).
   * @param {THREE.Vector3} target filled and returned
   */
  getSubsurfaceVelocityAt(x, z, depth, target) {
    this.fft.velocityAt(x, z, target);
    return target.multiplyScalar(Math.exp(-Math.max(depth, 0) * 0.2));
  }

  /**
   * Pack each FFT cascade's displacement/foam field into its half-float
   * texture. RGBA = (dx, dy, dz, foam), metres.
   */
  _packDispTexture() {
    const toHalf = THREE.DataUtils.toHalfFloat;
    const cs = this.fft.cascades;
    for (let ci = 0; ci < cs.length; ci++) {
      const c = cs[ci];
      const data = this._cascadeData[ci];
      const n2 = c.N * c.N;
      for (let i = 0; i < n2; i++) {
        const o = i * 4;
        data[o] = toHalf(c.dispX[i]);
        data[o + 1] = toHalf(c.dispY[i]);
        data[o + 2] = toHalf(c.dispZ[i]);
        data[o + 3] = toHalf(c.foam[i]);
      }
      this.cascadeTextures[ci].needsUpdate = true;
    }
  }

  /** Per-frame boat state for contact foam + wake (world XZ, unit forward,
   *  horizontal speed in m/s). */
  setBoatState(x, z, fwdX, fwdZ, speedMs) {
    this.uniforms.uBoatPosDir.value.set(x, z, fwdX, fwdZ);
    this.uniforms.uBoatSpeed.value = speedMs;
  }

  /**
   * Record the boat's track into the persistent wake trail. A new point is
   * dropped every ~1.5 m of travel while under way; points age out over
   * WAKE_LIFE. The trail lives in WORLD space, so it stays where the boat has
   * been and curves through turns.
   */
  updateWake(x, z, speedMs, dt) {
    if (!this._wake) this._wake = [];
    const w = this._wake;
    for (let i = 0; i < w.length; i++) w[i].age += dt;
    while (w.length && w[0].age > WAKE_LIFE) w.shift();

    const last = w[w.length - 1];
    if (speedMs > 0.2 && (!last || Math.hypot(x - last.x, z - last.z) > 0.9)) {
      if (w.length >= WAKE_MAX) w.shift();
      w.push({ x, z, age: 0, str: Math.min(1, 0.4 + speedMs / 3) });
    }

    const arr = this.uniforms.uWake.value;
    for (let i = 0; i < WAKE_MAX; i++) {
      const pt = w[i];
      if (pt) {
        const a = pt.age / WAKE_LIFE;
        arr[i].set(pt.x, pt.z, a, pt.str * (1 - a) * (1 - a));
      } else {
        arr[i].set(0, 0, 1, 0);
      }
    }
    this.uniforms.uWakeCount.value = w.length;
  }

  /**
   * Wire the sun's live shadow map so the boat shades the water. The map
   * only exists after the first shadowed render, hence per-frame wiring
   * from main.js rather than at construction. The Matrix4 is shared by
   * reference — three re-uploads its current values every draw.
   */
  updateShadow(sunLight) {
    if (sunLight.shadow.map && this.uniforms.uShadowStrength.value === 0) {
      this.uniforms.uShadowMap.value = sunLight.shadow.map.texture;
      this.uniforms.uShadowMatrix.value = sunLight.shadow.matrix;
      // Glints die almost completely in shadow; the water body only takes
      // 40% of this (see the bodyShadow split in the fragment shader).
      this.uniforms.uShadowStrength.value = 0.85;
    }
  }

  /**
   * Launch (or retune) the event wave.
   * @param {object} p {bearingDeg: compass direction it TRAVELS TOWARDS,
   *                    wavelength: m, amplitude: m}
   */
  setSwell(p) {
    this._swellDesired = p;
    this._syncSwellSlot();
  }

  clearSwell() {
    this._swellDesired = null;
    this._syncSwellSlot();
  }

  /**
   * Keep the event-wave slot consistent every frame. Two compensations:
   * - the slot sits inside the wave array, which is globally rotated by
   *   waveRot (sea-follows-wind) — so we pre-rotate its direction by
   *   −waveRot to keep its ABSOLUTE bearing fixed as the sea swings;
   * - amplitudes are globally scaled by heightScale — so we store
   *   amplitude/heightScale to keep the event wave's TRUE height fixed.
   * The uniform Vector4 is updated with the identical numbers, so CPU
   * height queries and the rendered surface cannot disagree.
   */
  _syncSwellSlot() {
    const slot = this._swellSlot;
    const uS = this.uniforms.uSwell.value; // (dirX, dirZ, k, amplitude)
    const uW = this.uniforms.uSwellWave.value; // (omega, phase)
    if (!this._swellDesired) {
      slot.amplitude = 0;
      uS.set(1, 0, slot.k, 0);
      uW.set(slot.omega, 0);
      return;
    }
    const d = this._swellDesired;
    if (slot.wavelength !== d.wavelength) {
      slot.wavelength = d.wavelength;
      slot.k = (2 * Math.PI) / d.wavelength;
      slot.omega = Math.sqrt(GRAVITY * slot.k);
    }
    // The event wave now rides ON TOP of the FFT sea as one analytic Gerstner
    // wave — so its bearing and height are ABSOLUTE (no waveRot / heightScale
    // compensation). Same numbers drive the GPU vertex and the CPU height query.
    const b = THREE.MathUtils.degToRad(d.bearingDeg);
    slot.dirX = Math.sin(b);
    slot.dirZ = -Math.cos(b);
    slot.amplitude = d.amplitude;
    slot.phase = 0;
    uS.set(slot.dirX, slot.dirZ, slot.k, slot.amplitude);
    uW.set(slot.omega, slot.phase);
  }

  /** Target wave-field rotation so the spectrum travels dead downwind. */
  _windTargetRot(wind) {
    const b = THREE.MathUtils.degToRad(wind.directionDeg + 180); // travel bearing
    // Primary spectrum dir is +X; world vector of bearing b is (sin b, −cos b).
    return Math.atan2(-Math.cos(b), Math.sin(b));
  }

  /** Jump the sea state straight to the wind (no build-up) — used at load. */
  snapSeaToWind(wind) {
    this.waveRot = this._windTargetRot(wind);
    this.uniforms.uWaveRot.value = this.waveRot;
    this._seaWindMs = Math.min(wind.speedKnots * 0.514444, 18);
    this._lastRebuildWind = this._seaWindMs;
    this._lastRebuildDir = this.waveRot;
    this.fft.setWind(this._seaWindMs, this.waveRot);
  }

  /**
   * Per-frame update: advance time, follow the wind, slide the grid under
   * the camera in whole-grid-cell steps (world-anchored waves make the
   * follow imperceptible).
   *
   * Sea-follows-wind is deliberately SLOW: height builds/decays with a 5 s
   * time constant and the direction swings at ≤6°/s, so moving the wind
   * sliders reads as the sea reacting, not the world snapping. (Rotating a
   * phase field shifts wave positions; rate-limiting is what keeps that
   * shift looking like a natural migration.)
   */
  update(time, camera, dt = 0, wind = null) {
    this.uniforms.uTime.value = time;

    // Whitecapping tracks the ACTUAL (gusty) wind: crests start breaking
    // around 8 kn and the sea is fully streaked white by ~38 kn.
    if (wind) {
      const kn = wind.speedKnotsActual ?? wind.speedKnots;
      this.uniforms.uWhitecaps.value = THREE.MathUtils.clamp((kn - 8) / 30, 0, 1);
    }

    if (wind && this.seaFollowsWind && dt > 0) {
      const k = 1 - Math.exp(-dt / SEA_BUILD_TAU);
      // Sea state now lives in the SPECTRUM: drive the FFT's wind speed so the
      // waves grow in length AND height with wind (a real storm sea), not just
      // scale up the same chop. Capped so hurricane waves stay big but the
      // physics sane.
      const targetWind = Math.min(wind.speedKnots * 0.514444, 18);
      this._seaWindMs = THREE.MathUtils.lerp(this._seaWindMs, targetWind, k);

      // shortest-arc, rate-limited swing of the wave heading towards downwind
      const target = this._windTargetRot(wind);
      const diff = Math.atan2(Math.sin(target - this.waveRot), Math.cos(target - this.waveRot));
      this.waveRot += THREE.MathUtils.clamp(diff, -SEA_ROT_RATE * dt, SEA_ROT_RATE * dt);
      this.uniforms.uWaveRot.value = this.waveRot;

      // Rebuilding the spectrum costs ~1–2 ms, so only do it once it has
      // drifted enough (the field morphs smoothly — phases are preserved).
      if (
        Math.abs(this._seaWindMs - this._lastRebuildWind) > 0.15 ||
        Math.abs(this.waveRot - this._lastRebuildDir) > 0.03
      ) {
        this.fft.setWind(this._seaWindMs, this.waveRot);
        this._lastRebuildWind = this._seaWindMs;
        this._lastRebuildDir = this.waveRot;
      }
    }

    // Event wave must re-compensate for whatever rot/height just changed.
    this._syncSwellSlot();

    // Advance the FFT field and upload it. Wave HEIGHT grows with wind here
    // (amplitude scale) while the spectral peak stays in the visible band —
    // so a rising wind makes the on-screen waves visibly build, not shift into
    // invisible swell. heightScale is a manual "wave height ×" on top. uSeaHeight
    // is a rough Hs proxy the shader uses to place whitecaps on the crests.
    const windAmp = THREE.MathUtils.clamp(Math.pow(this._seaWindMs / 6, 0.8), 0.12, 3);
    this.fft.scale = this.heightScale * windAmp;
    this.uniforms.uSeaHeight.value = 1.1 * this._seaWindMs * this.heightScale * windAmp;
    this.fft.update(time, dt > 0 ? dt : 1 / 60);
    this._packDispTexture();

    if (camera) {
      this.mesh.position.x = Math.round(camera.position.x / this.gridStep) * this.gridStep;
      this.mesh.position.z = Math.round(camera.position.z / this.gridStep) * this.gridStep;
      // Keep the edge-dissolve centred on the tile so its rim always fades.
      this.uniforms.uGridCenter.value.set(this.mesh.position.x, this.mesh.position.z);
    }
  }
}
