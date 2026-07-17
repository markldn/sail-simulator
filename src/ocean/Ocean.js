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
} from './GerstnerWaves.js';

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

/** 1×1 white RGBA texture: unpacks to depth 1.0 → "nothing in shadow". */
function makeWhiteTexture() {
  const tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  tex.needsUpdate = true;
  return tex;
}

const VERTEX_SHADER = /* glsl */ `
  #define NUM_WAVES ${WAVE_SLOTS}
  #define TWO_PI 6.28318530718
  #define GRAVITY ${GRAVITY.toFixed(4)}

  uniform float uTime;
  uniform float uHeightScale;   // global amplitude multiplier
  uniform float uChoppiness;    // Gerstner Q factor
  uniform float uWaveRot;       // wave-field rotation (sea follows wind)
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

    // Wave-field rotation — must match sampleWaveDisplacement() in
    // GerstnerWaves.js exactly.
    float cR = cos(uWaveRot);
    float sR = sin(uWaveRot);

    for (int i = 0; i < NUM_WAVES; i++) {
      vec2  d0  = uWaves[i].xy;
      vec2  dir = vec2(d0.x * cR - d0.y * sR, d0.x * sR + d0.y * cR);
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

  // three's packing chunk: unpackRGBAToDepth for reading the shadow map
  #include <packing>

  uniform float uTime;
  uniform float uWaveRot;       // detail ripples swing with the sea too
  uniform vec4  uBoatPosDir;    // boat x, z, forwardX, forwardZ
  uniform float uBoatSpeed;     // m/s
  uniform sampler2D uShadowMap; // sun shadow map (boat shadow on water)
  uniform mat4  uShadowMatrix;
  uniform float uShadowStrength; // 0 = shadow sampling off
  uniform float uWhitecaps;     // 0 calm … 1 gale: how readily crests break
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
    float cR = cos(uWaveRot);
    float sR = sin(uWaveRot);
    // (dir.x, dir.y, wavelength, amplitude) — deterministic, tiny
    vec4 defs[3];
    defs[0] = vec4( 0.95,  0.31, 0.90, 0.014);
    defs[1] = vec4(-0.40,  0.92, 0.51, 0.008);
    defs[2] = vec4( 0.60, -0.80, 0.31, 0.004);
    for (int i = 0; i < 3; i++) {
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

  // --- boat interaction foam ------------------------------------------------
  // Purely cosmetic, but it is what makes the hull look IN the water rather
  // than intersecting it: a churned ring where the hull pierces the
  // surface, and a spreading wake astern that grows with speed.
  float boatFoam(vec2 p, float t) {
    vec2 rel = p - uBoatPosDir.xy;
    vec2 fwd = uBoatPosDir.zw;
    float along  = dot(rel, fwd);
    float across = rel.x * fwd.y - rel.y * fwd.x;

    // Contact ring: a soft band hugging the hull's waterline ellipse.
    float e = (along * along) / (4.6 * 4.6) + (across * across) / (1.9 * 1.9);
    float ring = smoothstep(1.5, 1.0, e) * smoothstep(0.45, 0.85, e);

    // Wake: only astern, longer and denser with speed.
    float wake = 0.0;
    float sp = clamp(uBoatSpeed / 3.0, 0.0, 1.5);
    if (along < 0.0 && sp > 0.05) {
      float back  = -along;
      float len   = 10.0 + 22.0 * sp;
      float width = 1.3 + 0.28 * back;
      wake = sp
           * (1.0 - smoothstep(0.0, len, back))
           * smoothstep(width, width * 0.35, abs(across));
    }

    float n = vnoise(p * 1.3 + vec2(t * 0.2, -t * 0.13));
    return clamp(ring * (0.55 + 0.5 * n) + wake * (0.4 + 0.6 * n), 0.0, 1.0);
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
    float lit = 0.0;
    vec2 texel = vec2(1.0 / 2048.0) * 3.2;
    for (int i = -1; i <= 1; i++) {
      for (int j = -1; j <= 1; j++) {
        float d = unpackRGBAToDepth(
          texture2D(uShadowMap, uvz.xy + vec2(float(i), float(j)) * texel));
        lit += step(uvz.z - 0.004, d);
      }
    }
    lit /= 9.0;
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
    // summed BEFORE normalization (correct gradient composition).
    float detailFade = exp(-dist * 0.03);
    vec2 dg = detailGradient(vWorldPos.xz, uTime) * detailFade;
    vec3 N = normalize(vec3(-(vGrad.x + dg.x), 1.0 - vGrad.y, -(vGrad.z + dg.y)));

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
    float foamLo = mix(0.42, 0.22, uWhitecaps);
    float foam = smoothstep(foamLo, foamLo + 0.43, vGrad.y + foamNoise * 0.35 - 0.18);
    // Hull churn + wake join the natural crest foam.
    foam = clamp(foam + boatFoam(vWorldPos.xz, uTime), 0.0, 1.0);
    vec3 foamColor = vec3(0.92) * (0.25 + 0.75 * max(dot(N, uSunDir), 0.0) * bodyShadow)
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

    const packed = packWaveUniforms(this.waves);

    this.uniforms = {
      uTime: { value: 0 },
      uHeightScale: { value: this.heightScale },
      uChoppiness: { value: this.choppiness },
      uWaveRot: { value: 0 },
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
    return getWaveHeight(
      this.waves, x, z, this.time, this.heightScale, this.choppiness, this.waveRot
    );
  }

  /**
   * Water-particle (orbital) velocity at world (x, z) — analytic, exact.
   * Hull drag is computed relative to this, so waves carry the boat.
   * @param {THREE.Vector3} target filled and returned
   */
  getWaterVelocityAt(x, z, target) {
    const v = sampleWaveVelocity(
      this.waves, x, z, this.time, this.heightScale, this.choppiness, this.waveRot
    );
    return target.set(v.x, v.y, v.z);
  }

  /** Per-frame boat state for contact foam + wake (world XZ, unit forward,
   *  horizontal speed in m/s). */
  setBoatState(x, z, fwdX, fwdZ, speedMs) {
    this.uniforms.uBoatPosDir.value.set(x, z, fwdX, fwdZ);
    this.uniforms.uBoatSpeed.value = speedMs;
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
    const u4 = this.uniforms.uWaves.value[this.waves.length - 1];
    if (!this._swellDesired) {
      slot.amplitude = 0;
      u4.w = 0;
      return;
    }
    const d = this._swellDesired;
    if (slot.wavelength !== d.wavelength) {
      slot.wavelength = d.wavelength;
      slot.k = (2 * Math.PI) / d.wavelength;
      slot.omega = Math.sqrt(GRAVITY * slot.k);
    }
    const b = THREE.MathUtils.degToRad(d.bearingDeg);
    const wx = Math.sin(b);
    const wz = -Math.cos(b);
    const c = Math.cos(-this.waveRot);
    const s = Math.sin(-this.waveRot);
    slot.dirX = wx * c - wz * s;
    slot.dirZ = wx * s + wz * c;
    slot.amplitude = d.amplitude / Math.max(this.heightScale, 0.02);
    u4.set(slot.dirX, slot.dirZ, slot.wavelength, slot.amplitude);
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
    this.setHeightScale(seaHeightForWind(wind.speedKnots));
    this.setChoppiness(seaChopForWind(wind.speedKnots));
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
      this.setHeightScale(
        THREE.MathUtils.lerp(this.heightScale, seaHeightForWind(wind.speedKnots), k)
      );
      this.setChoppiness(
        THREE.MathUtils.lerp(this.choppiness, seaChopForWind(wind.speedKnots), k)
      );

      // shortest-arc, rate-limited swing towards downwind
      const target = this._windTargetRot(wind);
      let diff = target - this.waveRot;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      const maxStep = SEA_ROT_RATE * dt;
      this.waveRot += THREE.MathUtils.clamp(diff, -maxStep, maxStep);
      this.uniforms.uWaveRot.value = this.waveRot;
    }

    // Event wave must re-compensate for whatever rot/height just changed.
    this._syncSwellSlot();

    if (camera) {
      this.mesh.position.x = Math.round(camera.position.x / this.gridStep) * this.gridStep;
      this.mesh.position.z = Math.round(camera.position.z / this.gridStep) * this.gridStep;
    }
  }
}
