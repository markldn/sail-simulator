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

    // --- Sun light --------------------------------------------------------
    this.sunLight = new THREE.DirectionalLight(0xffffff, 3.0);
    scene.add(this.sunLight);
    scene.add(this.sunLight.target);

    // Shadows: a tight ortho frustum around the boat (the only caster).
    // trackShadowTarget() re-centres it every frame as the boat sails off.
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    const sc = this.sunLight.shadow.camera;
    sc.left = -14;
    sc.right = 14;
    sc.top = 14;
    sc.bottom = -14;
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
    const dayness = THREE.MathUtils.smoothstep(elevationDeg, 0, 25);
    const horizonAmber = new THREE.Color(1.0, 0.45, 0.18);
    const noonWhite = new THREE.Color(1.0, 0.98, 0.95);
    this.sunLight.color.copy(horizonAmber).lerp(noonWhite, dayness);
    this.sunLight.intensity = 3.2 * THREE.MathUtils.smoothstep(elevationDeg, -2, 12);
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

    this.sunColor.copy(this.sunLight.color).multiplyScalar(this.sunLight.intensity / 3.2);

    // --- rebake environment ------------------------------------------------
    this._bakeEnvironment();

    // --- fog for standard materials (ocean does its own in-shader) ---------
    if (!this.scene.fog) this.scene.fog = new THREE.FogExp2(0xffffff, this.fogDensity);
    this.scene.fog.color.copy(this.horizonColor);
    this.scene.fog.density = this.fogDensity;
  }

  /** Bake the current sky into scene.environment (ambient IBL). */
  _bakeEnvironment() {
    if (this._envRT) this._envRT.dispose();
    // Temporarily reparent the sky into the bake-only scene.
    this._envScene.add(this.sky);
    this._envRT = this.pmrem.fromScene(this._envScene);
    this.scene.add(this.sky); // hand it back to the visible scene
    this.scene.environment = this._envRT.texture;
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
