/**
 * SkySystem.js — dynamic HDR sky, sun, and image-based lighting.
 *
 * Responsibilities:
 * - Renders the physically-based Preetham sky (three.js Sky addon).
 * - Positions a DirectionalLight at the sun and scales its intensity/color
 *   with elevation (dawn/dusk go dim and orange automatically).
 * - Bakes the sky into a PMREM environment map so every PBR material in the
 *   scene (the boat, in Phase 2+) receives correct ambient light and
 *   reflections. Re-baked only when the sun moves — not per frame.
 * - Derives a small set of representative colors (zenith, horizon, sun) that
 *   the ocean shader uses for its analytic reflection, and a matching fog,
 *   so water, sky and fog never drift apart visually.
 */

import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

export class SkySystem {
  /**
   * @param {THREE.WebGLRenderer} renderer needed for PMREM baking
   * @param {THREE.Scene}         scene    the main scene
   */
  constructor(renderer, scene) {
    this.renderer = renderer;
    this.scene = scene;

    // --- Sky dome ---------------------------------------------------------
    this.sky = new Sky();
    this.sky.scale.setScalar(45000);
    scene.add(this.sky);

    const u = this.sky.material.uniforms;
    u.turbidity.value = 6; // haze; higher = milkier, warmer horizon
    u.rayleigh.value = 1.8; // blue scattering strength
    u.mieCoefficient.value = 0.005; // aerosol scattering (sun halo)
    u.mieDirectionalG.value = 0.8; // halo tightness

    // Stratus veil: a translucent grey dome INSIDE the sky dome. The
    // Preetham model can only do clear skies — real overcast needs cloud
    // between you and it. Opacity follows the overcast factor.
    this.cloudDome = new THREE.Mesh(
      new THREE.SphereGeometry(40000, 24, 12),
      new THREE.MeshBasicMaterial({
        color: 0x565b61,
        side: THREE.BackSide,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        fog: false,
      })
    );
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

    // --- IBL plumbing ------------------------------------------------------
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this._envRT = null;
    // The Sky must be in a scene of its own while baking, otherwise the
    // ocean etc. would be baked into the environment map too.
    this._envScene = new THREE.Scene();

    // State exposed to the ocean / fog (linear colors).
    this.sunDir = new THREE.Vector3(0, 1, 0);
    this.sunColor = new THREE.Color();
    this.zenithColor = new THREE.Color();
    this.horizonColor = new THREE.Color();
    this.fogDensity = 0.0016;

    // Overcast 0..1: Preetham is a CLEAR-sky model — raising its turbidity
    // makes the sky milky-BRIGHT (more scattered light), which is exactly
    // wrong for storm gloom. This factor supplies the missing behaviour:
    // it dims the sun and its halo, greys the sky colours and cuts ambient.
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
    const theta = THREE.MathUtils.degToRad(azimuthDeg);
    this.sunDir.setFromSphericalCoords(1, phi, theta);

    this.sky.material.uniforms.sunPosition.value.copy(this.sunDir);

    // --- direct light -----------------------------------------------------
    // Intensity fades to ~0 below the horizon; color runs white → amber as
    // the light path through the atmosphere lengthens.
    const o = this.overcast;
    const dayness = THREE.MathUtils.smoothstep(elevationDeg, 0, 25);
    const horizonAmber = new THREE.Color(1.0, 0.45, 0.18);
    const noonWhite = new THREE.Color(1.0, 0.98, 0.95);
    const cloudGrey = new THREE.Color(0.55, 0.57, 0.6);
    this.sunLight.color.copy(horizonAmber).lerp(noonWhite, dayness).lerp(cloudGrey, o * 0.7);
    this.sunLight.intensity =
      3.2 * THREE.MathUtils.smoothstep(elevationDeg, -2, 12) * (1 - 0.78 * o);
    // kill the sun's forward-scatter halo under cloud, veil the dome
    this.sky.material.uniforms.mieCoefficient.value = 0.005 * (1 - 0.85 * o);
    this.cloudDome.material.opacity = o * 0.88;
    this.cloudDome.material.color
      .setRGB(0.4, 0.42, 0.46)
      .multiplyScalar(0.25 + 0.75 * dayness);
    this.trackShadowTarget(this.sunLight.target.position);

    // --- representative colors for the ocean shader & fog ------------------
    // Approximations of what the Preetham model produces at this elevation;
    // tuned by eye, in linear space. Good enough until the ocean samples the
    // real environment map (graphics-polish phase).
    const duskZenith = new THREE.Color(0.02, 0.04, 0.10);
    const dayZenith = new THREE.Color(0.09, 0.26, 0.57);
    this.zenithColor.copy(duskZenith).lerp(dayZenith, dayness);

    const duskHorizon = new THREE.Color(0.55, 0.22, 0.08);
    const dayHorizon = new THREE.Color(0.58, 0.72, 0.85);
    this.horizonColor.copy(duskHorizon).lerp(dayHorizon, dayness);

    // overcast: grey the water-facing sky colours and dim the ambient
    const slate = new THREE.Color().setRGB(0.16, 0.18, 0.2).multiplyScalar(0.4 + 0.6 * dayness);
    const slateHorizon = new THREE.Color().setRGB(0.3, 0.32, 0.35).multiplyScalar(0.4 + 0.6 * dayness);
    this.zenithColor.lerp(slate, o * 0.85);
    this.horizonColor.lerp(slateHorizon, o * 0.8);
    this.scene.environmentIntensity = 0.5 * (1 - 0.55 * o);

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
    this._envScene.add(this.sky);
    this._envScene.add(this.cloudDome);
    this._envRT = this.pmrem.fromScene(this._envScene);
    this.scene.add(this.sky);
    this.scene.add(this.cloudDome);
    this.scene.environment = this._envRT.texture;
  }

  /**
   * Atmospheric mood (scenario presets): turbidity = haze/menace,
   * rayleigh = blueness. Call setSun() afterwards to rebake the
   * environment map — preset code does this via its applySun helper.
   */
  setAtmosphere(turbidity, rayleigh) {
    const u = this.sky.material.uniforms;
    if (turbidity != null) u.turbidity.value = turbidity;
    if (rayleigh != null) u.rayleigh.value = rayleigh;
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
