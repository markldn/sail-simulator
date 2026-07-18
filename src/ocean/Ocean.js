/**
 * Ocean.js — FFT ocean surface with a custom GLSL material.
 *
 * Design decisions:
 * - Custom ShaderMaterial rather than patching MeshStandardMaterial via
 *   onBeforeCompile: water shading (fresnel-dominated reflection, subsurface
 *   scattering, foam) doesn't fit the standard PBR surface model well, and a
 *   self-contained shader is robust against three.js internal refactors.
 * - The vertex shader displaces the mesh with the summed FFT cascades
 *   (FFTWaves.js), uploaded as textures each frame — see OCEAN_SAMPLE below.
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
 * The event wave (tsunami/rogue-wave presets) is a single analytic Gerstner
 * wave layered on top of the FFT sea — see uSwell/uSwellWave and
 * setSwell()/_syncSwellSlot() below. GerstnerWaves.js itself now only backs
 * the standalone flat-water physics test harness (scripts/test-buoyancy.mjs);
 * this file no longer uses its multi-wave spectrum.
 */

import * as THREE from 'three';
import { GRAVITY } from './GerstnerWaves.js';
import { FFTOcean } from './FFTWaves.js';

const SEA_BUILD_TAU = 5; // s — e-folding time for height/chop to respond
const SEA_ROT_RATE = THREE.MathUtils.degToRad(6); // rad/s max direction swing
// Event-wave amplitude ramp (m/s). The wave BUILDS to its target height
// instead of materialising at full size: an 8 m crest appearing instantly
// on top of the hull submerged every buoyancy column metres deep in one
// step — a multi-g "buoyancy cannon" that threw the boat clear of the water
// (and then a long, floaty-looking ballistic fall). ~10 s to full tsunami.
const SWELL_RAMP_RATE = 0.8;

// ---------------------------------------------------------------------------
// Vertex shader — FFT cascade displacement + analytic surface derivatives
// ---------------------------------------------------------------------------
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
  uniform vec2  uGridCenter; // xz of the camera-snapped grid centre
  uniform float uGridHalf;   // half the grid side length (metres)

  varying vec3  vWorldPos;   // displaced world-space position
  varying vec3  vGrad;       // (dHeight/dx, rim, dHeight/dz)
  varying float vHeight;     // vertical displacement (for subsurface tint)
  varying vec2  vGridPos;    // UNdisplaced world xz — foam/Jacobian sampling

  #define OCEAN_SAMPLE(I) { \
    float P = uCascadePatch[I]; \
    vec4 s = texture2D(uCascadeTex[I], gridWorld.xz / P); \
    disp += s.xyz; \
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

    // Rim taper: the tessellated tile is finite, so at big sea states its
    // displaced edge silhouetted against the sky as a lumpy "ridge" — the
    // ocean visibly ENDED there. Fade the displacement to flat over the
    // outer rim; a flat skirt mesh (same material) carries the sea on to
    // the horizon from there, and distance haze does the rest. Skirt
    // vertices land outside uGridHalf → rim 0 → they stay flat by the same
    // formula, so tile and skirt agree at the seam by construction.
    float rimD = max(abs(gridWorld.x - uGridCenter.x), abs(gridWorld.z - uGridCenter.y));
    float rim = 1.0 - smoothstep(0.80, 0.985, rimD / uGridHalf);
    disp *= rim;
    slope *= rim;

    vec3 displaced = gridWorld + disp;
    vWorldPos = displaced;
    vGrad     = vec3(slope.x, rim, slope.y); // rim gates fragment foam/Jacobian
    vHeight   = disp.y;
    vGridPos  = gridWorld.xz;
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
  uniform sampler2D uReflMap;   // planar reflection of the world
  uniform mat4  uReflMatrix;    // world → reflection UV
  uniform float uReflOn;        // 0 = analytic sky only, 1 = planar

  // Cascade fields, sampled PER PIXEL here (the vertex grid is ~1.8 m —
  // coarser than the fine cascade's 0.5 m texels, so vertex-sampled foam
  // smeared away the sharpest breaks). uCascadeTex.w carries the persisted
  // per-cascade foam; uCascadeJacTex carries the exact spectral derivatives
  // (∂Dx/∂x, ∂Dz/∂z, ∂Dx/∂z) of the horizontal displacement.
  #define OCEAN_CASCADES 3
  uniform sampler2D uCascadeTex[OCEAN_CASCADES];
  uniform sampler2D uCascadeJacTex[OCEAN_CASCADES];
  uniform float uCascadePatch[OCEAN_CASCADES];

  varying vec3  vWorldPos;
  varying vec3  vGrad;
  varying float vHeight;
  varying vec2  vGridPos;

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
  // Five hard-coded capillary-scale waves evaluated per-pixel. They are far
  // too small for the vertex grid to capture, but their normals sell the
  // surface up close. Faded with distance to avoid specular shimmer/aliasing.
  vec2 detailGradient(vec2 p, float t) {
    vec2 grad = vec2(0.0);
    float cR = cos(uWaveRot);
    float sR = sin(uWaveRot);
    // (dir.x, dir.y, wavelength, amplitude) — Five octaves spanning ~1.2 m
    // ripples down to 18 cm cat's-paws bridge the gap between the coarse
    // vertex FFT set and the pixel, so the surface keeps texture (and
    // broken-up reflections) well into the mid-field. Supplement the FFT
    // geometry with fine ripple in the NORMAL only (the FFT is low-passed to
    // ~4 m so the mesh stays alias-free; this carries the sub-metre chop).
    // Kept subtle so it textures rather than granulates.
    //
    // Each octave is a perfectly regular plane wave, though — evaluated with
    // no spatial variation, five infinite sine trains read as a "corduroy"
    // of dead-straight parallel bands from horizon to horizon (visible from
    // above, or as glinting dashes at grazing angles). Real capillary chop
    // has no such global coherence: wind gusts and interference with the
    // waves underneath break it into patches with locally-varying phase and
    // strength. A slow value-noise field (patch scale >> ripple wavelength)
    // jitters each octave's phase and amplitude, so nearby crests still look
    // regular (correct — that IS what real ripple patches look like) but the
    // pattern decorrelates every few tens of metres instead of running
    // straight across the whole sea.
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
      // Patch noise: one low-frequency sample per octave, offset per-octave
      // so the five patterns decorrelate from EACH OTHER too (otherwise all
      // five would still fade in/out together and the corduroy would just
      // pulse instead of breaking up). Patch scale ~167-45 m originally —
      // fine for breaking up the pattern across a wide aerial view, but a
      // close, low-angle shot can show as little as ~20-40 m of water, i.e.
      // ENTIRELY inside one patch, so it still read as perfectly uniform up
      // close. Tightened to ~20-6 m patches: still 3-60x the 0.3-2.1 m
      // ripple wavelengths (so each patch still looks like coherent chop,
      // not noise), but now several patches fit inside a close-up view too.
      vec2 patchUV = p * (0.05 + 0.03 * float(i)) + vec2(float(i) * 41.7, -float(i) * 23.1);
      float n = vnoise(patchUV);
      float phaseJitter = (n - 0.5) * TWO_PI;
      float ampMod = 0.35 + 1.3 * n;
      float f = k * dot(d, p) - w * t * 1.1 + phaseJitter;
      grad += d * (k * a * ampMod * cos(f));
    }
    return grad;
  }

  // --- persistent wake trail ------------------------------------------------
  // Foam along the world-space polyline of the boat's recent track (uWake).
  // Because the points are absolute world positions, the trail stays put and
  // curves through the boat's turns, and spreads + fades as each segment ages.
  float wakeFoam(vec2 p) {
    // Union (max) of the segment gaussians, NOT a sum: the ~1 m point spacing
    // makes neighbouring segments overlap almost entirely, so summing ~40 of
    // them blew far past 1.0 and clamped into a solid saturated white slab
    // reaching ~8 m out from the track — a boat-sized foam disc, not a wake.
    // max() keeps the trail's cross-section the gaussian of the NEAREST
    // segment: a bounded ribbon that spreads and fades as it ages.
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
      float width = 0.9 + 2.6 * age;          // spreads with age
      f = max(f, str * exp(-(d * d) / (width * width)));
    }
    // Patchy, not painted-on: real propwash/stern foam is broken froth.
    f *= 0.55 + 0.45 * vnoise(p * 1.1 + uTime * 0.06);
    return f;
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
    // (Squared by hand, not pow(): e-1 is negative inside the ellipse and
    // GLSL pow() is undefined for a negative base.)
    float e    = (along * along) / (3.7 * 3.7) + (across * across) / (1.2 * 1.2);
    float eq   = (e - 1.0) * 2.4;
    float band = exp(-eq * eq);                         // soft, centred on hull edge
    float fwdW = smoothstep(-2.2, 2.4, along);          // 0 aft → 1 at the bow
    float bow  = band * fwdW;

    // 2) Stern churn: soft gaussian across ~a beam, fading within a few metres.
    // MUST be gated to aft of the transom: "back" is 0 across the entire
    // forward half-plane, so without the aft gate the length fade
    // (1 - smoothstep(back)) sat fully open ahead of the boat and the
    // lateral gaussian alone painted a clump-mottled foam stripe straight
    // down the heading line to the horizon — the long-standing "stripe in
    // front of the boat" (it tracked the bow in real time, appeared only
    // under way, and being foam, survived every reflection/sky/glint test).
    float aft   = smoothstep(1.0, 2.5, -along);         // 0 ahead → 1 aft of transom
    float back  = max(-along - 2.5, 0.0);               // metres behind the transom
    float tLen  = 3.5 + 9.0 * sp;
    float bq    = b / (1.25 + 0.14 * back);
    float wedge = exp(-bq * bq)
                * (1.0 - smoothstep(0.0, tLen, back)) * aft;

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
    // Tight disc (picked up by bloom) + a NARROW forward-scatter halo.
    // The water reflects this at near-unity fresnel from a low FPV eye
    // height, over a wide range of wave-perturbed normals — a halo with a
    // wide angular skirt (the old pow(.,8) had a ~24° half-width) then sums
    // across a large fraction of the visible sea and reads as a flat white
    // wash rather than a localised glitter path toward the sun, the way a
    // real photographed sea looks (rich blue everywhere except a bounded
    // glint lane). Narrower cone, lower peak.
    sky += uSunColor * (pow(sunDot, 1200.0) * 30.0 + pow(sunDot, 20.0) * 0.05);
    return sky;
  }

  void main() {
    vec3 V = normalize(cameraPosition - vWorldPos);
    float dist = length(cameraPosition - vWorldPos);

    // Summed Jacobian of the horizontal displacement (Arc Blanc §3.2): the
    // derivative fields of ALL cascades add BEFORE the determinant — a swell
    // pinching under already-steep chop folds the summed surface even when no
    // single cascade folds alone. That cross-scale term is where waves
    // visibly break against each other; per-cascade Jacobians cannot see it.
    float rim = vGrad.y;
    vec3 jac = vec3(0.0);      // (∂Dx/∂x, ∂Dz/∂z, ∂Dx/∂z) summed
    float persist = 0.0;       // per-cascade persisted foam (bubble memory)
    // Persisted-foam weights: breaking lives at chop scale — unweighted, the
    // swell cascade's 45 m texels paint continent-sized foam fields.
    #define FOAM_SAMPLE(I, W) { \
      vec2 cuv = vGridPos / uCascadePatch[I]; \
      persist += texture2D(uCascadeTex[I], cuv).w * W; \
      jac += texture2D(uCascadeJacTex[I], cuv).xyz; }
    FOAM_SAMPLE(0, 0.05)
    FOAM_SAMPLE(1, 0.30)
    FOAM_SAMPLE(2, 1.0)
    persist *= rim;
    jac *= rim;
    float Jtot = (1.0 + jac.x) * (1.0 + jac.y) - jac.z * jac.z;

    // Reconstruct the normal from raw derivatives so per-pixel detail can be
    // summed BEFORE normalization (correct gradient composition). The detail
    // fades with distance to keep the finest ripples from aliasing into
    // specular shimmer — but gently, so the mid-field stays alive.
    // The cascade slope is divided by the horizontal compression (1 + ∂D/∂x):
    // the true normal of a CHOPPY surface, which steepens the forward face of
    // a pinching crest right where it is about to fold (Tessendorf §4.5).
    float detailFade = exp(-dist * 0.03);
    vec2 dg = detailGradient(vWorldPos.xz, uTime) * detailFade;
    vec3 N = normalize(vec3(-(vGrad.x / max(1.0 + jac.x, 0.20) + dg.x), 1.0,
                            -(vGrad.z / max(1.0 + jac.y, 0.20) + dg.y)));

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
    // A steep wave face tilted toward the camera reflects DOWNWARD — real
    // water there mirrors the dark sea, not the sky. The old hard clamp
    // rerouted those rays to the pale horizon color, painting tall faces
    // (rogue wave, storm swell) as a washed-out sheet — the "two different
    // colors of sea". Fall back toward dark water instead.
    float reflBelow = clamp(-R.y * 5.0, 0.0, 1.0);
    R.y = max(R.y, 0.02);
    vec3 reflected = mix(skyColor(normalize(R)), uDeepColor * 1.7, reflBelow);

    // Planar reflection of the boat/world, distorted by the wave normal and
    // faded back to the analytic sky off-screen and at grazing chop.
    if (uReflOn > 0.5) {
      vec4 rc = uReflMatrix * vec4(vWorldPos, 1.0);
      if (rc.w > 0.0) {
        vec2 ruv = rc.xy / rc.w + N.xz * 0.10; // ripple distortion
        vec4 planar = texture2D(uReflMap, ruv);
        // valid only inside the reflection viewport; fade at the edges
        vec2 edge = min(ruv, 1.0 - ruv);
        float inside = smoothstep(0.0, 0.05, min(edge.x, edge.y));
        reflected = mix(reflected, planar.rgb, inside * planar.a);
      }
    }

    // ---- Water body: absorption + subsurface scattering ------------------
    // Light entering a wave gets scattered back out with the water's
    // characteristic blue-green. Strongest when looking towards the sun
    // through the top of a wave (classic backlit "glass" crests).
    float sunThrough = pow(max(dot(V, -uSunDir), 0.0), 3.0);
    float crestBoost = clamp(vHeight * 0.55 + 0.45, 0.0, 1.2);
    vec3 body = uDeepColor;
    body += uScatterColor * (0.30 + 0.70 * max(dot(N, uSunDir), 0.0) * bodyShadow) * 0.35;
    body += uScatterColor * sunThrough * crestBoost * 0.85 * bodyShadow;

    // ---- Sun specular (glitter path) ------------------------------------
    // A fixed sharp Blinn lobe (power 380) evaluated on smooth interpolated
    // normals renders the glitter path as long CONTINUOUS bright bands along
    // the wave/ripple crests — dead-parallel dashed streaks running from the
    // camera toward the sun's azimuth (one of the layered sources of the
    // long-standing "stripe ahead of the boat"). Real glitter at distance is
    // the sub-pixel AVERAGE of many micro-glints: filter the lobe with the
    // pixel footprint instead of sharpening it. Two parts:
    //  - widen the lobe with distance (380 near → 56 far) and renormalize
    //    its energy, so the far lane is a smooth dim gradient, not bands;
    //  - jitter the specular normal with a world-anchored hash that grows
    //    with distance, breaking any residual crest coherence into sparkle.
    vec3 H = normalize(uSunDir + V);
    float farness = 1.0 - exp(-dist * 0.015);
    float specPow = mix(380.0, 56.0, farness);
    // SMOOTH noise for the jitter: per-pixel white noise (hash) decorrelates
    // every single pixel — the glitter lane rendered as uniform pixel-grain
    // "pixelated sunlight" across the whole sea. Value noise at a couple of
    // cycles per metre still breaks the crest-coherent bands, but the
    // perturbation now varies smoothly between neighbouring pixels.
    vec3 Ns = normalize(N + vec3(vnoise(vWorldPos.xz * 2.3) - 0.5, 0.0,
                                 vnoise(vWorldPos.zx * 1.7) - 0.5) * (0.11 * farness));
    float spec = pow(max(dot(Ns, H), 0.0), specPow)
               * ((specPow + 8.0) / 388.0) * 2.2 * shadow;
    vec3 specular = uSunColor * spec;

    // ---- Foam ------------------------------------------------------------
    // Grounded in observed storm-sea behaviour (Beaufort scale imagery,
    // Monahan & O'Muircheartaigh 1980 coverage law) rather than generic
    // noise blobs:
    //  - foam forms where crests FOLD (the summed-cascade Jacobian Jtot,
    //    plus each cascade's persisted foam channel — bubbles outlive the
    //    break and get left behind as the wave phase travels on);
    //  - up close it is LACEWORK — bubble rafts torn into filaments and
    //    holes at sub-metre scale — never a soft cloud (the old two-octave
    //    27 m blur noise was exactly that soft cloud);
    //  - from ~F7 up it is dragged into long STREAKS ALONG THE WIND
    //    (windrows / Langmuir circulation); by F10 the streaks dominate;
    //  - total coverage stays modest (roughly 1% at 20 kn, ~10% at 40 kn)
    //    but high-contrast against the dark sea.
    float cR2 = cos(uWaveRot);
    float sR2 = sin(uWaveRot);
    vec2 wp = vec2( vWorldPos.x * cR2 + vWorldPos.z * sR2,   // downwind
                   -vWorldPos.x * sR2 + vWorldPos.z * cR2);  // crosswind
    // Lacework: three octaves drifting slowly (foam rides the surface).
    // Sampled in wind-aligned coordinates, stretched ~3:1 downwind: decaying
    // foam tears into ELONGATED streaky filaments along the wind. Isotropic
    // noise gave round holes — patches read as leopard-print spots.
    float lace = 0.50 * vnoise(vec2(wp.x * 0.30, wp.y * 0.85) + uTime * 0.02)
               + 0.30 * vnoise(vec2(wp.x * 0.90, wp.y * 2.40) - uTime * 0.03)
               + 0.20 * vnoise(vec2(wp.x * 2.20, wp.y * 5.50));
    // Windrows: noise stretched ~9:1 along the wind direction.
    float streaks = vnoise(vec2(wp.x * 0.055, wp.y * 0.50) + uTime * 0.012);

    // Thresholds CALIBRATED against the measured field at storm wind
    // (weighted foam channel percentiles: p80≈0.15, p99≈0.38 on the breakF
    // scale) so full whitecapping covers the top ~15-20% of the sea, with
    // near-solid white only on the freshest few percent — the Monahan
    // coverage ballpark, not a guess.
    //
    // Two sources now feed the break signal:
    //  - persist: each cascade's own folding, with ~seconds of bubble memory
    //    (trailing foam patches left behind the crest);
    //  - fresh: the TOTAL Jacobian dropping toward 0 — the summed surface
    //    actually folding right here, right now, including the cross-cascade
    //    collisions the per-cascade term is blind to.
    // Ramp calibrated against the MEASURED summed-J distribution (jstats):
    // 12 kn: p1=0.77 min=0.62 · 22 kn: p1=0.57 p5=0.69 · 35 kn: p5=0.49
    // p20=0.71. This span puts scattered caps at Beaufort 4, a few percent
    // coverage at 6, and broad streaked whitecapping in a full gale —
    // Monahan & O'Muircheartaigh's coverage law, not a guess.
    float fresh = smoothstep(0.90, 0.35, Jtot);
    // No height gate. The old crest gates scaled with TOTAL Hs — once the
    // storm spectrum grew real 300 m swell, Hs became swell-dominated and
    // the gates demanded metres of elevation before ANY foam: chop breaking
    // in a swell trough (which real seas do everywhere) was erased, and what
    // survived read as isolated blobs. The Jacobian IS the crest detector —
    // it folds exactly where a wave face is pinching, at every scale.
    float breakF = max(persist * 1.1, fresh * 1.15);
    // Floor raised 0.15→0.24: at hurricane wind an ISOTROPIC-leaning sea
    // (low δ) pinches everywhere at once, and the old floor let coverage run
    // to a near-solid white field — real hurricane seas photograph as
    // ~30-40% streaked white over dark water, never a soap layer.
    float foamLo = mix(0.55, 0.19, uWhitecaps);
    // The lace noise also ERODES the coverage boundary: the persisted-foam
    // texels are 0.5-8 m across, and a clean smoothstep of their bilinear
    // ramp draws diamond-shaped white blocks. Subtracting noise from the
    // input tears those edges into ragged fingers before thresholding.
    float cover = smoothstep(foamLo, foamLo + 0.17,
                             breakF + 0.14 * streaks * uWhitecaps - 0.10 * (1.0 - lace));
    // Carve the covered patch into lacework — ALWAYS, via a wide smoothstep
    // band (the old near-binary gate saturated fresh patches into solid
    // paint). Fresh dense foam (cover→1) closes toward mostly-white with
    // dark tears; a decaying patch opens back up into filaments.
    float texGate = smoothstep(0.58 - 0.22 * cover, 0.95 - 0.22 * cover,
                               lace + 0.22 * streaks * uWhitecaps);
    // Squared: a half-open gate must read as thin bright filaments on dark
    // water, not a uniform pale wash (translucent "fog patches"). The final
    // sub-metre granulation is what separates "bubble raft" from "white
    // sheet": real foam is millions of bubbles with holes, and a smooth
    // saturated patch has no interior detail for the eye to hold on to.
    // Two octaves, softened: one frequency of value noise renders as an
    // even dot-matrix stipple from any range where its cells span a few
    // pixels — the "pixelated" foam. Layered scales read as bubble clumps.
    float grain = 0.62 + 0.38 * (0.55 * vnoise(vWorldPos.xz * 2.6 - uTime * 0.03)
                               + 0.45 * vnoise(vWorldPos.xz * 7.9 + uTime * 0.05));
    // Foam LIFE CYCLE. stage 1 = this crest is folding RIGHT NOW: aerated
    // white water — near-solid (air doesn't leave holes yet), at its
    // brightest. stage → 0: the raft left behind, torn to lace and dimming.
    float stage = clamp(fresh * 1.4 - 0.15, 0.0, 1.0);
    float foam = cover * texGate * texGate * mix(grain, 1.0, 0.65 * stage);
    // Wind-torn streak foam clear of the crests (F8 and up): thin windrows.
    foam += smoothstep(0.80, 0.92, streaks * (0.55 + 0.45 * lace))
          * uWhitecaps * uWhitecaps * 0.55;
    // Hull churn, the persistent curved wake trail, and the crest foam all add.
    foam = clamp(foam + boatFoam(vWorldPos.xz, uTime) + wakeFoam(vWorldPos.xz), 0.0, 1.0);
    // Bubbly micro-relief: foam is not a decal on the wave — it has its own
    // centimetre-scale surface of bubble domes. Perturbing the foam-lighting
    // normal with a fine noise gradient gives each patch internal shading,
    // which is most of what separates "foam" from "white layer".
    vec2 fp = vWorldPos.xz * 3.9 + uTime * 0.04;
    float f0 = vnoise(fp);
    vec2 fgrad = vec2(vnoise(fp + vec2(0.19, 0.0)) - f0,
                      vnoise(fp + vec2(0.0, 0.19)) - f0) * 3.5;
    vec3 Nf = normalize(vec3(N.x - fgrad.x, 1.6, N.z - fgrad.y));
    // High ambient floor + nearly-neutral tint: foam is a dense multiple-
    // scattering medium lit by the whole sky dome — it stays bright WHITE
    // under overcast. The old 0.25 floor × warm sun tint rendered overcast
    // foam as muddy grey-brown spots.
    float foamLit = 0.48 + 0.52 * max(dot(Nf, uSunDir), 0.0) * bodyShadow;
    // Fresh white water scatters sunlight from its whole aerated volume —
    // brighter and whiter than the settled raft it decays into.
    vec3 foamAlb = mix(vec3(0.88), vec3(1.0), stage);
    vec3 foamColor = foamAlb * foamLit * (uSunColor * 0.25 + vec3(0.75));

    // ---- Underside (camera below a wave) --------------------------------
    // From below, the surface is a different material entirely: inside the
    // ~49° Snell window the sky shines through; outside it, total internal
    // reflection returns the water's own darkness. No foam lace, no glitter
    // — those are air-side features; foam instead BLOCKS light, reading as
    // dark rafts on the ceiling of the sea. Without this branch the
    // DoubleSide surface showed its air-side shading from underneath: a
    // pale sky-coloured sheet mid-knockdown.
    if (!gl_FrontFacing) {
      float upRay = clamp(-V.y, 0.0, 1.0); // how vertically we look up at it
      float snell = smoothstep(0.55, 0.80, upRay);
      vec3 tir = uDeepColor * 1.5 + uScatterColor * 0.3;
      vec3 through = mix(uHorizonColor, uZenithColor, 0.45) * 1.1 + uSunColor * 0.15;
      vec3 uc = mix(tir, through, snell);
      uc = mix(uc, uc * 0.4, clamp(foam, 0.0, 1.0) * 0.85);
      uc = mix(uc, uDeepColor * 1.3, 1.0 - exp(-dist * 0.06));
      gl_FragColor = vec4(uc, 1.0);
      return;
    }

    // ---- Composite -------------------------------------------------------
    vec3 color = mix(body, reflected, fresnel) + specular;
    color = mix(color, foamColor, clamp(foam, 0.0, 1.0));

    // ---- Height fog towards the horizon color ---------------------------
    // Storm haze: a heavy blow fills the air with spume and spray, so
    // visibility drops with the whitecapping factor. This is also what
    // hides the rim taper + flat skirt at big sea states (the old
    // grid-edge color dissolve at ~250 m is gone — the sea now runs to the
    // horizon and haze, not a painted fade, ends the view).
    float fogD = uFogDensity * (1.0 + 1.3 * uWhitecaps);
    float fog = 1.0 - exp(-pow(dist * fogD, 1.6));
    color = mix(color, uHorizonColor, clamp(fog, 0.0, 1.0));

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

    // Event-wave slot (tsunami/rogue presets): its fields ARE the uSwell/
    // uSwellWave uniform values (see _syncSwellSlot()), so the CPU buoyancy
    // queries and the GPU surface stay in lockstep by construction.
    const k0 = (2 * Math.PI) / 200;
    this._swellSlot = {
      dirX: 1, dirZ: 0, wavelength: 200, amplitude: 0, phase: 0,
      k: k0, omega: Math.sqrt(GRAVITY * k0),
    };
    this._swellDesired = null; // {bearingDeg, wavelength, amplitude}
    this._swellAmpCur = 0; // ramped amplitude (see SWELL_RAMP_RATE)

    // --- FFT spectral field: the real source of truth ----------------------
    // Drives BOTH the vertex displacement (uploaded as uDispTex each frame)
    // and the CPU height/velocity queries the physics uses — so the boat
    // floats on exactly the water that's drawn. Three cascades (720/128/23 m
    // patches, N=128/64/64) run ~4.5 ms/frame (see test-fft.mjs) and tile
    // seamlessly.
    this.fft = new FFTOcean({ windSpeed: 9 }); // 3 band-limited cascades
    // Live sea-state wind (m/s) driving the spectrum; morphs toward the wind.
    this._seaWindMs = 9;
    this._lastRebuildWind = 9;
    this._lastRebuildDir = 0;
    const cascades = this.fft.cascades;
    const makeTex = (data, N) => {
      const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.HalfFloatType);
      t.magFilter = THREE.LinearFilter;
      t.minFilter = THREE.LinearFilter;
      t.wrapS = THREE.RepeatWrapping;
      t.wrapT = THREE.RepeatWrapping;
      t.needsUpdate = true;
      return t;
    };
    this._cascadeData = cascades.map((c) => new Uint16Array(c.N * c.N * 4)); // half-float RGBA
    this.cascadeTextures = cascades.map((c, i) => makeTex(this._cascadeData[i], c.N));
    // Exact spectral derivatives per cascade (∂Dx/∂x, ∂Dz/∂z, ∂Dx/∂z) — the
    // fragment shader sums them across cascades for the TRUE Jacobian.
    this._jacData = cascades.map((c) => new Uint16Array(c.N * c.N * 4));
    this.jacTextures = cascades.map((c, i) => makeTex(this._jacData[i], c.N));

    this.uniforms = {
      uTime: { value: 0 },
      uHeightScale: { value: this.heightScale },
      uChoppiness: { value: this.choppiness },
      uWaveRot: { value: 0 },
      // FFT cascade displacement fields (vertex) — see FFTWaves.js.
      uCascadeTex: { value: this.cascadeTextures },
      uCascadeJacTex: { value: this.jacTextures },
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
      // Planar reflection (wired by main.js once the reflection pass exists).
      uReflMap: { value: makeWhiteTexture() },
      uReflMatrix: { value: new THREE.Matrix4() },
      uReflOn: { value: 0 },
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

    // Flat skirt: a huge square annulus around the tile, SAME material.
    // Its vertices sit outside uGridHalf, so the vertex shader's rim taper
    // leaves them undisplaced at y=0 — matching the tile's tapered edge —
    // and the fragment shader shades/hazes them identically. This is what
    // carries the sea to the true horizon instead of ending at the tile.
    // Slight overlap with the tile (hole inset) + a 2 cm drop kills both
    // seam cracks and z-fighting; both surfaces are flat and identically
    // colored there, so neither is visible.
    const R = 30000;
    const inner = size * 0.5 * 0.96;
    const shape = new THREE.Shape()
      .moveTo(-R, -R).lineTo(R, -R).lineTo(R, R).lineTo(-R, R).closePath();
    const hole = new THREE.Path()
      .moveTo(-inner, -inner).lineTo(-inner, inner)
      .lineTo(inner, inner).lineTo(inner, -inner).closePath();
    shape.holes.push(hole);
    const skirtGeo = new THREE.ShapeGeometry(shape);
    skirtGeo.rotateX(-Math.PI / 2);
    skirtGeo.translate(0, -0.02, 0);
    this.skirtMesh = new THREE.Mesh(skirtGeo, this.material);
    this.skirtMesh.frustumCulled = false;

    // Sync the FFT pinch factor with the slider default (see setChoppiness).
    this.setChoppiness(this.choppiness);
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
    // Wire the slider through to the FFT's horizontal-pinch factor — it
    // used to stop at the (unread) uniform, leaving crest sharpness frozen
    // at the construction-time value. Mapping keeps the default slider
    // (0.8) at ≈ the old effective 1.1, so the stock look barely moves;
    // pushing the slider now genuinely sharpens the crests (and, via the
    // Jacobian, makes them foam sooner — the two effects are physically
    // the same event: a crest pinching to the point of folding).
    for (const c of this.fft.cascades) c.choppiness = 1.4 * v;
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
   * Orbital velocity decays as exp(-k·depth) PER CASCADE (Arc Blanc Eq 23):
   * the swell still surges at keel depth while chop orbits vanish within a
   * metre or two — the old single global decay rate treated them alike.
   * @param {THREE.Vector3} target filled and returned
   */
  getSubsurfaceVelocityAt(x, z, depth, target) {
    return this.fft.velocityAt(x, z, target, depth);
  }

  /**
   * Directional-spread controls (Arc Blanc Eqs 13-18): swell ξ elongates the
   * crests, directionality δ blends neutral (0: waves from everywhere,
   * maximal crossing) toward full Donelan-Banner (1).
   */
  setSpread(swell, delta) {
    this.fft.setSpread(swell, delta);
  }

  /**
   * Pack each FFT cascade's displacement/foam field into its half-float
   * texture. RGBA = (dx, dy, dz, foam), metres.
   */
  _packDispTexture() {
    const toHalf = THREE.DataUtils.toHalfFloat;
    const cs = this.fft.cascades;
    const zero = toHalf(0);
    for (let ci = 0; ci < cs.length; ci++) {
      const c = cs[ci];
      const data = this._cascadeData[ci];
      const jd = this._jacData[ci];
      const n2 = c.N * c.N;
      for (let i = 0; i < n2; i++) {
        const o = i * 4;
        data[o] = toHalf(c.dispX[i]);
        data[o + 1] = toHalf(c.dispY[i]);
        data[o + 2] = toHalf(c.dispZ[i]);
        data[o + 3] = toHalf(c.foam[i]);
        jd[o] = toHalf(c.jacA[i]);
        jd[o + 1] = toHalf(c.jacD[i]);
        jd[o + 2] = toHalf(c.jacB[i]);
        jd[o + 3] = zero;
      }
      this.cascadeTextures[ci].needsUpdate = true;
      this.jacTextures[ci].needsUpdate = true;
    }
  }

  /** Wire the planar-reflection texture + world→UV matrix (see main.js). */
  setReflection(texture, matrix) {
    this.uniforms.uReflMap.value = texture;
    this.uniforms.uReflMatrix.value.copy(matrix);
    this.uniforms.uReflOn.value = 1;
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
    this._swellLast = p; // retained so a cleared wave can ramp out in place
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
    // Keep the last direction/wavelength while a cleared wave ramps out.
    const d = this._swellDesired ?? this._swellLast;
    if (!d || this._swellAmpCur < 0.0001) {
      slot.amplitude = 0;
      uS.set(1, 0, slot.k, 0);
      uW.set(slot.omega, 0);
      return;
    }
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
    slot.amplitude = this._swellAmpCur; // ramped, not the instant target
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
    this._seaWindMs = Math.min(wind.speedKnots * 0.514444, 22);
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
      // Capped at 22 m/s (~43 kn of sea): with the wind-opened fetch this is
      // a 300 m-roller storm sea; the steepness governor keeps it physical.
      const targetWind = Math.min(wind.speedKnots * 0.514444, 22);
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

    // Event wave ramps toward its target height (down-ramp 2× faster), so
    // launching a tsunami reads as a wave ARRIVING, not appearing — and the
    // hull is never instantaneously buried under a full-height crest.
    const swellTarget = this._swellDesired ? this._swellDesired.amplitude : 0;
    if (dt > 0 && this._swellAmpCur !== swellTarget) {
      const up = SWELL_RAMP_RATE * dt;
      this._swellAmpCur += THREE.MathUtils.clamp(swellTarget - this._swellAmpCur, -2 * up, up);
    }
    // Event wave must re-compensate for whatever rot/height just changed.
    this._syncSwellSlot();

    // Advance the FFT field and upload it. Wave HEIGHT grows with wind here
    // (amplitude scale) while the spectral peak stays in the visible band —
    // so a rising wind makes the on-screen waves visibly build, not shift into
    // invisible swell. heightScale is a manual "wave height ×" on top. uSeaHeight
    // is a rough Hs proxy the shader uses to place whitecaps on the crests.
    // Gentler than the old (w/6)^0.8 cap-3 curve: the Donelan-Banner spectrum
    // is properly normalized (∫D dθ = 1, ~2× the old cos²/π energy), so the
    // old multiplier stacked on top produced impossibly steep, dome-shaped
    // waves — height beyond what the capped peak wavelength can carry reads
    // as "bubbles", not sea. Storm Hs now lands ≈6 m instead of ≈8.6 m.
    const windAmp = THREE.MathUtils.clamp(Math.pow(this._seaWindMs / 6.5, 0.62), 0.12, 1.9);
    this.fft.scale = this.heightScale * windAmp;
    this.fft.update(time, dt > 0 ? dt : 1 / 60);
    // Honest Hs, measured from the actual field (see FFTWaves.update). The
    // old 1.1·wind·scale proxy hit ~48 at 64 kn while real crests were ~4 m,
    // parking the whitecap crest gate above every wave — a storm sea with
    // not one whitecap on it.
    this.uniforms.uSeaHeight.value = Math.max(this.fft.Hs || 0, 0.05);
    this._packDispTexture();

    if (camera) {
      this.mesh.position.x = Math.round(camera.position.x / this.gridStep) * this.gridStep;
      this.mesh.position.z = Math.round(camera.position.z / this.gridStep) * this.gridStep;
      // The rim taper (vertex shader) is centred on the tile via uGridCenter;
      // the flat skirt rides along so its hole always frames the tile.
      this.uniforms.uGridCenter.value.set(this.mesh.position.x, this.mesh.position.z);
      this.skirtMesh.position.copy(this.mesh.position);
    }
  }
}
