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
} from './GerstnerWaves.js';

// ---------------------------------------------------------------------------
// Vertex shader — Gerstner displacement + analytic surface derivatives
// ---------------------------------------------------------------------------
const VERTEX_SHADER = /* glsl */ `
  #define NUM_WAVES ${NUM_WAVES}
  #define TWO_PI 6.28318530718
  #define GRAVITY ${GRAVITY.toFixed(4)}

  uniform float uTime;
  uniform float uHeightScale;   // global amplitude multiplier (GUI)
  uniform float uChoppiness;    // Gerstner Q factor (GUI)
  uniform vec4  uWaves[NUM_WAVES];   // (dirX, dirZ, wavelength, amplitude)
  uniform float uPhases[NUM_WAVES];

  varying vec3  vWorldPos;   // displaced world-space position
  varying vec3  vGrad;       // (dHeight/dx, jacobian term, dHeight/dz)
  varying float vHeight;     // vertical displacement (for subsurface tint)

  void main() {
    // Undisplaced grid point in world space. The ocean mesh is a plane in
    // XZ; modelMatrix carries the camera-follow offset (see Ocean.update).
    vec3 gridWorld = (modelMatrix * vec4(position, 1.0)).xyz;

    vec3 disp = vec3(0.0);
    // Accumulated derivatives for the exact Gerstner normal:
    //   N = normalize(-dY/dx, 1 - Q·Σ(k·A·sin f), -dY/dz)
    vec2  slope = vec2(0.0); // Σ D * k * A * cos(f)  → dY/dx, dY/dz
    float jac   = 0.0;       // Σ Q * k * A * sin(f)  → crest pinch (foam!)

    for (int i = 0; i < NUM_WAVES; i++) {
      vec2  dir = uWaves[i].xy;
      float k   = TWO_PI / uWaves[i].z;
      float a   = uWaves[i].w * uHeightScale;
      float w   = sqrt(GRAVITY * k);            // deep-water dispersion
      float f   = k * dot(dir, gridWorld.xz) - w * uTime + uPhases[i];
      float s   = sin(f);
      float c   = cos(f);

      disp.xz += dir * (uChoppiness * a * c);   // horizontal chop
      disp.y  += a * s;                          // vertical heave

      slope   += dir * (k * a * c);
      jac     += uChoppiness * k * a * s;
    }

    vec3 displaced = gridWorld + disp;

    vWorldPos = displaced;
    vGrad     = vec3(slope.x, jac, slope.y);
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

  uniform float uTime;
  uniform vec3  uSunDir;        // TOWARDS the sun, normalized
  uniform vec3  uSunColor;      // linear
  uniform vec3  uZenithColor;   // analytic sky gradient (matches SkySystem)
  uniform vec3  uHorizonColor;
  uniform vec3  uDeepColor;     // water body color (light fully absorbed)
  uniform vec3  uScatterColor;  // color scattered back out near the surface
  uniform float uFogDensity;

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
    // (dir.x, dir.y, wavelength, amplitude) — deterministic, tiny
    vec4 defs[3];
    defs[0] = vec4( 0.95,  0.31, 0.90, 0.014);
    defs[1] = vec4(-0.40,  0.92, 0.51, 0.008);
    defs[2] = vec4( 0.60, -0.80, 0.31, 0.004);
    for (int i = 0; i < 3; i++) {
      vec2  d = defs[i].xy;
      float k = TWO_PI / defs[i].z;
      float a = defs[i].w;
      float w = sqrt(GRAVITY * k);
      float f = k * dot(d, p) - w * t * 1.1;
      grad += d * (k * a * cos(f));
    }
    return grad;
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
    // summed BEFORE normalization (correct gradient composition).
    float detailFade = exp(-dist * 0.03);
    vec2 dg = detailGradient(vWorldPos.xz, uTime) * detailFade;
    vec3 N = normalize(vec3(-(vGrad.x + dg.x), 1.0 - vGrad.y, -(vGrad.z + dg.y)));

    // ---- Fresnel (Schlick, F0 = 0.02 for water) -------------------------
    float NdotV = max(dot(N, V), 0.0);
    float fresnel = 0.02 + 0.98 * pow(1.0 - NdotV, 5.0);

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
    body += uScatterColor * (0.30 + 0.70 * max(dot(N, uSunDir), 0.0)) * 0.35;
    body += uScatterColor * sunThrough * crestBoost * 0.85;

    // ---- Sun specular (sharp Blinn lobe; ACES + bloom shape the rest) ---
    vec3 H = normalize(uSunDir + V);
    float spec = pow(max(dot(N, H), 0.0), 380.0) * 2.2;
    vec3 specular = uSunColor * spec;

    // ---- Foam ------------------------------------------------------------
    // vGrad.y is the Gerstner "pinch" term: it approaches 1 where crests
    // fold over. Noise breaks the threshold into streaks; foam gets simple
    // diffuse lighting so it darkens correctly at dusk.
    float foamNoise = vnoise(vWorldPos.xz * 1.7 + uTime * 0.15)
                    * vnoise(vWorldPos.xz * 0.23 - uTime * 0.02);
    float foam = smoothstep(0.42, 0.85, vGrad.y + foamNoise * 0.35 - 0.18);
    vec3 foamColor = vec3(0.92) * (0.25 + 0.75 * max(dot(N, uSunDir), 0.0))
                   * (uSunColor * 0.5 + vec3(0.5));

    // ---- Composite -------------------------------------------------------
    vec3 color = mix(body, reflected, fresnel) + specular;
    color = mix(color, foamColor, clamp(foam, 0.0, 1.0));

    // ---- Height fog towards the horizon color ---------------------------
    float fog = 1.0 - exp(-pow(dist * uFogDensity, 1.6));
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

    // Live sea-state parameters (GUI writes these via setters below).
    this.heightScale = 1.0;
    this.choppiness = 0.8;

    // The wave set shared with physics. Ocean owns it; physics asks Ocean.
    this.waves = createWaveSet();
    const packed = packWaveUniforms(this.waves);

    this.uniforms = {
      uTime: { value: 0 },
      uHeightScale: { value: this.heightScale },
      uChoppiness: { value: this.choppiness },
      uWaves: { value: packed.waveVectors },
      uPhases: { value: packed.phases },
      // Sky-driven values; SkySystem overwrites these via applySkyState().
      uSunDir: { value: new THREE.Vector3(0.3, 0.7, 0.2).normalize() },
      uSunColor: { value: new THREE.Color(1.0, 0.95, 0.85) },
      uZenithColor: { value: new THREE.Color(0.11, 0.28, 0.55) },
      uHorizonColor: { value: new THREE.Color(0.65, 0.78, 0.88) },
      uDeepColor: { value: new THREE.Color(0.008, 0.042, 0.09) },
      uScatterColor: { value: new THREE.Color(0.02, 0.22, 0.26) },
      uFogDensity: { value: 0.0016 },
    };

    // Plane built in the XZ plane directly (rotateX would complicate the
    // world-space reasoning in the shader for no benefit).
    const geometry = new THREE.PlaneGeometry(size, size, segments, segments);
    geometry.rotateX(-Math.PI / 2);

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      uniforms: this.uniforms,
      side: THREE.FrontSide,
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
    return getWaveHeight(this.waves, x, z, this.time, this.heightScale, this.choppiness);
  }

  /**
   * Per-frame update: advance time and slide the grid under the camera in
   * whole-grid-cell steps. Snapping to gridStep keeps vertices at identical
   * world positions frame-to-frame, so the follow is imperceptible.
   */
  update(time, camera) {
    this.uniforms.uTime.value = time;
    if (camera) {
      this.mesh.position.x = Math.round(camera.position.x / this.gridStep) * this.gridStep;
      this.mesh.position.z = Math.round(camera.position.z / this.gridStep) * this.gridStep;
    }
  }
}
