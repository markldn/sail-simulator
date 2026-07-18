/**
 * SkySystem.js — dynamic HDR sky, sun, and image-based lighting.
 *
 * Responsibilities:
 * - Renders a physically-based single-scattering Rayleigh/Mie/ozone sky
 *   (Atmosphere.js) — real scattering physics, not a fitted empirical model.
 * - Positions a DirectionalLight at the sun and scales its intensity/color
 *   with elevation (dawn/dusk go dim and orange automatically).
 * - Bakes the sky into a PMREM environment map so every PBR material in the
 *   scene (the boat) receives correct ambient light and reflections.
 *   Re-baked only when the sun moves — not per frame.
 * - Derives a small set of representative colors (zenith, horizon) that the
 *   ocean shader uses for its analytic reflection, and a matching fog, by
 *   sampling the SAME atmosphere function the visible dome renders with —
 *   so water, sky and fog can't drift apart, by construction.
 */

import * as THREE from 'three';
import { ATMOSPHERE_GLSL, sampleAtmosphere } from './Atmosphere.js';

// turbidity/rayleigh are the historical UI knob names (haze / blueness);
// they now map onto direct multipliers of the atmosphere's physical Mie and
// Rayleigh coefficients rather than Preetham parameters. The reference
// values below are "1.0" on that multiplier scale, chosen to land on the
// SkySystem/preset defaults already tuned against Atmosphere.js's baseline
// (see ControlPanel.js PRESETS and the constructor default below).
const TURBIDITY_REF = 3; // → mieMul = 1.0 (clear open-ocean day)
const RAYLEIGH_REF = 2.2; // → rayleighMul = 1.0

export class SkySystem {
  /**
   * @param {THREE.WebGLRenderer} renderer needed for PMREM baking
   * @param {THREE.Scene}         scene    the main scene
   */
  constructor(renderer, scene) {
    this.renderer = renderer;
    this.scene = scene;

    this._turbidity = TURBIDITY_REF;
    this._rayleigh = RAYLEIGH_REF;

    // --- Sky dome -----------------------------------------------------------
    // A single physically-based scattering function (Atmosphere.js) drives
    // both this visible dome AND the ocean's reflected-sky colors below —
    // one source of truth instead of a hand-eyeballed approximation.
    this.skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false, // it's "at infinity" — never occlude via depth
      toneMapped: false, // tonemapped once, by the composer's OutputPass
      uniforms: {
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uRayleighMul: { value: 1 },
        uMieMul: { value: 1 },
        uOvercast: { value: 0 },
        uDayness: { value: 1 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          // The dome (scale 45000) dwarfs the camera's travel range (tens to
          // low hundreds of metres), so the raw world position is already an
          // excellent proxy for view direction after normalizing — no need
          // to subtract cameraPosition (same convention as the cloud dome).
          vDir = (modelMatrix * vec4(position, 1.0)).xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec3 vDir;
        uniform vec3 uSunDir;
        uniform float uRayleighMul, uMieMul, uOvercast, uDayness;
        ${ATMOSPHERE_GLSL}
        void main() {
          vec3 rd = normalize(vDir);
          vec3 r0 = vec3(0.0, ATM_PLANET_R + 50.0, 0.0);
          vec3 col = atmosphere(rd, r0, uSunDir, uRayleighMul, uMieMul);

          // Sun disc: a tight core (bloom picks it up) atop a slightly
          // wider aureole — the scattering integral alone gives the diffuse
          // sky glow around the sun but not its own near-parallel disc.
          // Magnitudes are calibrated against the atmosphere's own typical
          // output (roughly 0.05-0.9 across the dome) rather than picked
          // blind — the sky went badly overexposed (and, worse, appears to
          // have corrupted the PMREM-baked IBL cubemap and left the boat
          // pitch black) when this peaked at 400: during PMREM baking the
          // sky is rendered from many more directions than a normal view
          // ever shows at once, so a spot THAT bright covered enough solid
          // angle to blow past sane values in the bake.
          float sunDot = max(dot(rd, uSunDir), 0.0);
          col += vec3(1.0, 0.96, 0.9) * (pow(sunDot, 800.0) * 6.0 + pow(sunDot, 120.0) * 0.6);

          // Horizon whitening: SINGLE-scatter models starve the grazing
          // paths of the multiply-scattered light that washes a real
          // daylight horizon nearly white — what's left reads as a muddy
          // amber band sitting on the sea. Desaturate + lift toward the
          // ray's own luminance near the horizon (daylight only; sunsets
          // keep their color because uDayness fades the correction).
          float hLum = dot(col, vec3(0.299, 0.587, 0.114));
          float horiz = (1.0 - smoothstep(0.0, 0.12, rd.y)) * uDayness;
          col = mix(col, vec3(hLum) * 1.22 + vec3(0.015), horiz * 0.72);

          // Overcast: not a real cloud-occlusion pass — the procedural
          // cloud dome layered in front handles cloud SHAPE. This just
          // dims/greys the clear-sky scattering result behind it so an
          // overcast preset doesn't leave a bright blue gap between clouds.
          vec3 slate = vec3(0.16, 0.18, 0.20) * (0.4 + 0.6 * uDayness);
          col = mix(col, slate, uOvercast * 0.85);

          // Safety clamp: whatever the scattering/disc math produces, never
          // let a single frame reach into runaway-HDR territory — this is
          // what gets fed to PMREMGenerator's mip-chain convolution, where
          // an unexpectedly huge value has an outsized, hard-to-predict
          // effect on the whole baked environment (see above).
          col = min(col, vec3(12.0));

          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.skyMesh = new THREE.Mesh(new THREE.SphereGeometry(45000, 32, 16), this.skyMat);
    scene.add(this.skyMesh);

    // Cloud dome: a procedural fractal-cloud layer INSIDE the sky dome.
    // Coverage follows the overcast factor (a few fair-weather cumulus at 0,
    // full stratus at 1); the layer drifts with the wind.
    this.cloudMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      fog: false,
      uniforms: {
        uTime: { value: 0 },
        uCoverage: { value: 0 }, // 0 clear-ish … 1 overcast
        uWind: { value: new THREE.Vector2(0, 0) },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Color(1, 1, 1) },
        uCloudColor: { value: new THREE.Color(0.8, 0.82, 0.86) },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = (modelMatrix * vec4(position, 1.0)).xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec3 vDir;
        uniform float uTime, uCoverage;
        uniform vec2 uWind;
        uniform vec3 uSunDir, uSunColor, uCloudColor;
        float hash(vec2 p){ p = fract(p*vec2(123.34,345.45)); p += dot(p,p+34.345); return fract(p.x*p.y); }
        float noise(vec2 p){ vec2 i=floor(p),f=fract(p); f=f*f*(3.0-2.0*f);
          return mix(mix(hash(i),hash(i+vec2(1,0)),f.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x), f.y); }
        float fbm(vec2 p){ float s=0.0,a=0.5; for(int i=0;i<5;i++){ s+=a*noise(p); p*=2.03; a*=0.5; } return s; }
        void main(){
          vec3 d = normalize(vDir);
          if (d.y < 0.03) discard;                 // below the horizon
          // project the view direction onto a cloud plane, drift with wind
          vec2 uv = d.xz / (d.y + 0.16) * 1.3 + uWind; // uWind = accumulated drift
          float f = fbm(uv);
          float base = mix(0.72, 0.04, uCoverage); // more coverage → lower threshold
          float density = smoothstep(base, base + 0.33, f);
          density *= smoothstep(0.03, 0.20, d.y);  // dissolve at the horizon

          // Internal detail: the interior used to be one FLAT tone the whole
          // way through a cloud (only the EDGE had any gradient, from the
          // density threshold's soft falloff), which reads as a plain blob
          // and — reflected in the water and magnified/stretched by wave
          // normals — as a flat, "overexposed", detail-less streak. Real
          // clouds have visible internal structure: brighter dense cores,
          // darker wispy margins. Reuses the SAME fbm sample at a wider
          // threshold range (no extra noise cost) so depth INTO the cloud
          // shapes its own brightness, not just its silhouette.
          float internal = smoothstep(base, base + 0.9, f);
          vec3 cloudBody = mix(uCloudColor * 0.72, uCloudColor * 1.18, internal);

          float sd = max(dot(d, uSunDir), 0.0);
          vec3 lit = cloudBody + uSunColor * pow(sd, 8.0) * 0.5; // sun through cloud
          vec3 col = mix(uCloudColor * 0.6, lit, density);
          gl_FragColor = vec4(col, density);
        }`,
    });
    this.cloudDome = new THREE.Mesh(new THREE.SphereGeometry(40000, 32, 16), this.cloudMat);
    scene.add(this.cloudDome);

    // --- Sun light --------------------------------------------------------
    this.sunLight = new THREE.DirectionalLight(0xffffff, 3.0);
    scene.add(this.sunLight);
    scene.add(this.sunLight.target);

    // Shadows: a tight ortho frustum around the boat (the only caster).
    // trackShadowTarget() re-centres it every frame as the boat sails off.
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(4096, 4096);
    const sc = this.sunLight.shadow.camera;
    // Wide enough to contain the long mast/sail shadow at a low sun without
    // clipping; the 4096 map keeps texels fine (~9 mm) and the ocean's 5×5 PCF
    // softens the rest.
    sc.left = -22;
    sc.right = 22;
    sc.top = 22;
    sc.bottom = -22;
    sc.near = 20;
    sc.far = 400;
    this.sunLight.shadow.bias = -0.0002;
    this.sunLight.shadow.normalBias = 0.02;

    // --- Ambient fill (HemisphereLight) ------------------------------------
    // The PMREM-baked environment (scene.environment) is the "correct"
    // source of ambient/IBL, but on an opaque surface facing away from the
    // sun its contribution is small enough to fall into ACES's toe: same
    // renderer.toneMappingExposure(0.5) pre-multiply, same hard crush-to-
    // black behaviour that made the sails read as flat black despite
    // genuinely receiving light (see Sails.js _applyBacklight — verified
    // there with the actual ACES curve that a ~0.05 raw contribution
    // tonemaps to ~0.009, indistinguishable from 0; ~0.35 tonemaps to a
    // visible ~0.13-0.16). A hull is opaque, so unlike the sails there's no
    // "translucency" fix available — a straightforward, always-on sky/
    // ground ambient term sized with the same exposure-aware target is the
    // direct fix: guarantees a comparable minimum fill on every PBR material
    // in the scene (hull, deck, spars) regardless of the PMREM bake's exact
    // calibration, on top of whatever scene.environment adds.
    //
    // First attempt (0.8 intensity, near-black 0x1a2430 ground) still read
    // as black — modelling error, not just an undertuned number: a hull's
    // SIDE (what's visible in every broadside screenshot so far) is a
    // roughly VERTICAL surface, so HemisphereLight gives it the ~50/50
    // sky/ground BLEND (interpolated by the surface normal's up-component),
    // not the sky color alone — the number I'd checked against the ACES
    // curve. A near-black ground color drags that blend down hard. Fixed
    // both: brightened groundColor to a plausible bright-sea reflectance,
    // and re-verified intensity against the CORRECT blended value — 1.5 ×
    // the sky/ground blend × ~0.8 hull albedo tonemaps to ~0.42, clearly
    // visible with real margin this time rather than landing right at the
    // edge of visibility again.
    this.hemiLight = new THREE.HemisphereLight(0x99bbdd, 0x3a5a6c, 1.5);
    scene.add(this.hemiLight);

    // --- IBL plumbing ------------------------------------------------------
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this._envRT = null;
    // The sky must be in a scene of its own while baking, otherwise the
    // ocean etc. would be baked into the environment map too.
    this._envScene = new THREE.Scene();

    // State exposed to the ocean / fog (linear colors).
    this.sunDir = new THREE.Vector3(0, 1, 0);
    this.sunColor = new THREE.Color();
    this.zenithColor = new THREE.Color();
    this.horizonColor = new THREE.Color();
    this.fogDensity = 0.0016;

    // Overcast 0..1: the clear-sky scattering model has no cloud occlusion
    // of its own (the procedural cloud dome handles cloud SHAPE) — this
    // factor supplies the missing storm-gloom behaviour: it dims the sun,
    // greys the sky colours, and cuts ambient.
    this.overcast = 0;

    this.elevationDeg = 32;
    this.azimuthDeg = 155;
    this.setSun(this.elevationDeg, this.azimuthDeg);
  }

  /**
   * Move the sun and update everything that depends on it. Call from the
   * GUI (or a day/night cycle later) — cost is one small cubemap bake.
   *
   * @param {number} elevationDeg 0 = on the horizon, 90 = zenith
   * @param {number} azimuthDeg   compass bearing of the sun
   */
  setSun(elevationDeg, azimuthDeg) {
    this.elevationDeg = elevationDeg;
    this.azimuthDeg = azimuthDeg;

    const phi = THREE.MathUtils.degToRad(90 - elevationDeg); // polar
    // Compass convention: bearing b → horizontal (sin b, −cos b), i.e. −Z is
    // north (same as WindManager/_windTargetRot). setFromSphericalCoords
    // gives (sin θ, cos θ) in XZ, which lands at bearing 180−θ — so feed it
    // 180−azimuth to make the azimuth knob a true compass bearing. (Before
    // this fix "azimuth 155°" actually put the sun at bearing 25°, parked
    // almost dead ahead of the default course — the root of the perpetual
    // sun-glitter lane "ahead of the boat".)
    const theta = THREE.MathUtils.degToRad(180 - azimuthDeg);
    this.sunDir.setFromSphericalCoords(1, phi, theta);

    const o = this.overcast;
    const dayness = THREE.MathUtils.smoothstep(elevationDeg, 0, 25);
    const rayleighMul = this._rayleigh / RAYLEIGH_REF;
    // Overcast also kills the sun halo/aerosol glow, same as before.
    const mieMul = (this._turbidity / TURBIDITY_REF) * (1 - 0.85 * o);

    const su = this.skyMat.uniforms;
    su.uSunDir.value.copy(this.sunDir);
    su.uRayleighMul.value = rayleighMul;
    su.uMieMul.value = mieMul;
    su.uOvercast.value = o;
    su.uDayness.value = dayness;

    // --- direct light -----------------------------------------------------
    // Intensity fades to ~0 below the horizon; color runs white → amber as
    // the light path through the atmosphere lengthens.
    const horizonAmber = new THREE.Color(1.0, 0.45, 0.18);
    const noonWhite = new THREE.Color(1.0, 0.98, 0.95);
    const cloudGrey = new THREE.Color(0.55, 0.57, 0.6);
    this.sunLight.color.copy(horizonAmber).lerp(noonWhite, dayness).lerp(cloudGrey, o * 0.7);
    this.sunLight.intensity =
      3.2 * THREE.MathUtils.smoothstep(elevationDeg, -2, 12) * (1 - 0.78 * o);
    // Feed the procedural cloud layer: coverage from overcast, colour greyed
    // and dimmed at dusk / under cloud, sun direction for the lit edges.
    const cu = this.cloudMat.uniforms;
    cu.uCoverage.value = o;
    cu.uSunDir.value.copy(this.sunLight.position).normalize();
    cu.uSunColor.value.copy(this.sunLight.color);
    cu.uCloudColor.value
      .setRGB(0.86, 0.88, 0.92)
      .multiplyScalar(0.28 + 0.72 * dayness)
      .lerp(cloudGrey, o * 0.6);
    this.trackShadowTarget(this.sunLight.target.position);

    // --- representative colors for the ocean shader & fog ------------------
    // Sampled from the SAME scattering function the visible dome renders
    // with — these can't drift out of sync with what's actually on screen.
    // Horizon is sampled at a PERPENDICULAR azimuth to the sun, not toward
    // it: Ocean.js's skyColor() already adds its own separate sun-disc/halo
    // term on top of mix(horizon, zenith, ...), so a horizon color sampled
    // looking straight at the sun would double-count that glow and bleed a
    // sun-warm tint across grazing angles all the way round the compass,
    // not just near the sun where it belongs.
    const sunArr = [this.sunDir.x, this.sunDir.y, this.sunDir.z];
    const sampleOpts = { rayleighMul, mieMul, heightM: 50 };
    const [zr, zg, zb] = sampleAtmosphere([0, 1, 0], sunArr, sampleOpts);
    this.zenithColor.setRGB(zr, zg, zb);

    const horizonDir = new THREE.Vector3(-this.sunDir.z, 0.05, this.sunDir.x).normalize();
    const [hr, hg, hb] = sampleAtmosphere([horizonDir.x, horizonDir.y, horizonDir.z], sunArr, sampleOpts);
    // Same horizon whitening as the sky-dome shader (evaluated at this
    // sample's elevation y=0.05 → smoothstep factor 0.624): the ocean's fog
    // fades into THIS color, so the two must agree or the sea-sky seam shows.
    {
      const hLum = 0.299 * hr + 0.587 * hg + 0.114 * hb;
      const k = 0.624 * dayness * 0.72;
      const wr = hLum * 1.22 + 0.015;
      this.horizonColor.setRGB(hr + (wr - hr) * k, hg + (wr - hg) * k, hb + (wr - hb) * k);
    }

    // overcast: grey the water-facing sky colours and dim the ambient
    const slate = new THREE.Color().setRGB(0.16, 0.18, 0.2).multiplyScalar(0.4 + 0.6 * dayness);
    const slateHorizon = new THREE.Color().setRGB(0.3, 0.32, 0.35).multiplyScalar(0.4 + 0.6 * dayness);
    this.zenithColor.lerp(slate, o * 0.85);
    this.horizonColor.lerp(slateHorizon, o * 0.8);
    // This multiplier was calibrated against the old Preetham sky's PMREM
    // bake brightness, not the new Atmosphere.js one — the boat's hull and
    // sails came out under-lit (flat black, no rim light) even after fixing
    // the earlier overflow/black-band bugs, consistent with the new
    // environment map being genuinely dimmer at the lowish sun elevations
    // tested so far. Bumped up; environmentIntensity only scales IBL
    // fill for materials, it doesn't touch the visible sky dome itself, so
    // this can be corrected independently of how the sky looks.
    this.scene.environmentIntensity = 1.1 * (1 - 0.55 * o);
    // Fixed base color/magnitude (see constructor) — deliberately NOT tied
    // to zenithColor's own elevation-dependent dimming, same reasoning as
    // the sail floor: it would weaken exactly when a strong ambient floor
    // is needed most (low sun, long shadows). Only dims for night/overcast.
    this.hemiLight.intensity = 1.5 * THREE.MathUtils.smoothstep(elevationDeg, -5, 5) * (1 - 0.6 * o);

    this.sunColor.copy(this.sunLight.color).multiplyScalar(this.sunLight.intensity / 3.2);

    // --- rebake environment ------------------------------------------------
    this._bakeEnvironment();

    // --- fog for standard materials (ocean does its own in-shader) ---------
    if (!this.scene.fog) this.scene.fog = new THREE.FogExp2(0xffffff, this.fogDensity);
    this.scene.fog.color.copy(this.horizonColor);
    this.scene.fog.density = this.fogDensity;
  }

  /** Bake the current sky (incl. cloud veil) into scene.environment. */
  _bakeEnvironment() {
    if (this._envRT) this._envRT.dispose();
    // Temporarily reparent sky + veil into the bake-only scene so ambient
    // light greys out under overcast along with the visible dome.
    this._envScene.add(this.skyMesh);
    this._envScene.add(this.cloudDome);
    this._envRT = this.pmrem.fromScene(this._envScene);
    this.scene.add(this.skyMesh);
    this.scene.add(this.cloudDome);
    this.scene.environment = this._envRT.texture;
  }

  /**
   * Atmospheric mood (scenario presets): turbidity = haze/menace (maps onto
   * the Mie/aerosol coefficient multiplier), rayleigh = blueness (maps onto
   * the Rayleigh coefficient multiplier). 3 / 2.2 are the reference values
   * (multiplier = 1.0, see TURBIDITY_REF/RAYLEIGH_REF above). Call setSun()
   * afterwards to rebake the environment map — preset code does this via
   * its applySun helper.
   */
  setAtmosphere(turbidity, rayleigh) {
    if (turbidity != null) this._turbidity = turbidity;
    if (rayleigh != null) this._rayleigh = rayleigh;
  }

  /**
   * Keep the sun's shadow frustum centred on the boat. Cheap (a couple of
   * vector ops) — call every frame with the boat position.
   */
  trackShadowTarget(pos) {
    this.sunLight.target.position.set(pos.x, 0, pos.z);
    this.sunLight.position
      .copy(this.sunLight.target.position)
      .addScaledVector(this.sunDir, 150);
  }

  /**
   * Drift the cloud layer downwind. Call each frame.
   * @param {number} dt      frame delta
   * @param {{x,z}} windVec  wind velocity (m/s)
   */
  updateClouds(dt, windVec) {
    if (!this._cloudDrift) this._cloudDrift = this.cloudMat.uniforms.uWind.value;
    const rate = 0.00035; // uv units per (m/s · s)
    this._cloudDrift.x += windVec.x * rate * dt;
    this._cloudDrift.y += windVec.z * rate * dt;
  }

  /** Bundle of values the ocean shader needs — see Ocean.applySkyState(). */
  getOceanState() {
    return {
      sunDir: this.sunDir,
      sunColor: this.sunColor,
      zenithColor: this.zenithColor,
      horizonColor: this.horizonColor,
      fogDensity: this.fogDensity,
    };
  }
}
