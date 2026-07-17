/**
 * main.js — application bootstrap and render loop.
 *
 * Phase 1: scene / renderer / post-processing, fixed-step Rapier world,
 * Gerstner ocean with CPU height queries, dynamic sky + IBL, wind + HUD.
 * Phase 2: the boat — procedural hull, rigid body, sampled-column buoyancy
 * and hydrodynamic drag (src/boat/), chase camera, live SOG/HDG/HEEL.
 * The debug probes (spheres riding ocean.getHeightAt()) remain available
 * to verify the CPU wave math still matches the GPU surface.
 *
 * Post-processing status (honest accounting):
 *   ✓ HDR pipeline, ACES tone mapping (OutputPass)
 *   ✓ Bloom (UnrealBloomPass — sun glints on water)
 *   ✓ SMAA (post-AA that works with the composer)
 *   ✗ TAA — three's TAARenderPass only accumulates on static scenes, so it
 *     is useless for animated water; the plan is TRAA from the
 *     `postprocessing` package (or the WebGPU node pipeline) in the
 *     graphics-polish phase.
 *   ✗ SSR / volumetric light shafts — same phase; SSR needs the boat first
 *     (there is nothing to reflect yet but sky, which fresnel already does).
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

/**
 * Underwater veil: fades in when the camera dips below the local wave
 * surface (a plunge or a knockdown). Submerging should read as *being in the
 * water* — heavy teal absorption that kills the bright storm haze, depth
 * darkening, a soft vignette, drifting light shafts from the surface, and a
 * gentle refraction wobble. Runs on the LDR image after tone mapping.
 */
const UnderwaterShader = {
  uniforms: { tDiffuse: { value: null }, uAmount: { value: 0 }, uTime: { value: 0 } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uAmount;
    uniform float uTime;
    varying vec2 vUv;
    void main() {
      // Refraction wobble: the image seen through moving water shimmers.
      float rip = uAmount * 0.006;
      vec2 w = vUv + vec2(
        sin(vUv.y * 22.0 + uTime * 1.8),
        cos(vUv.x * 26.0 - uTime * 1.5)
      ) * rip;
      vec4 c = texture2D(tDiffuse, w);

      // Teal absorption + depth darkening + vignette. The heavy mix toward the
      // water colour is what suppresses the white haze so it looks submerged.
      vec3 water = vec3(0.04, 0.16, 0.19);
      float vig = smoothstep(1.3, 0.25, length(vUv - 0.5) * 2.0);
      vec3 murk = mix(c.rgb, water, 0.74) * (0.42 + 0.45 * vig);

      // Faint light shafts drifting down from the surface (top of frame).
      float shafts = smoothstep(0.15, 1.0, vUv.y)
                   * (0.5 + 0.5 * sin(vUv.x * 34.0 + uTime * 0.8));
      murk += shafts * 0.05 * vec3(0.4, 0.7, 0.7);

      gl_FragColor = vec4(mix(c.rgb, murk, uAmount), c.a);
    }`,
};

import { Ocean } from './ocean/Ocean.js';
import { Boat } from './boat/Boat.js';
import { Spray } from './effects/Spray.js';
import { SkySystem } from './environment/SkySystem.js';
import { WindManager, MS_TO_KNOTS } from './wind/WindManager.js';
import { PhysicsWorld } from './physics/PhysicsWorld.js';
import { HUD } from './ui/HUD.js';
import { Helm } from './ui/Helm.js';
import { createControlPanel } from './ui/ControlPanel.js';

async function init() {
  // ---------------------------------------------------------------- renderer
  const renderer = new THREE.WebGLRenderer({
    antialias: false, // AA is done in post (SMAA); MSAA would be wasted
    powerPreference: 'high-performance',
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.5; // Preetham sky is bright; tame it
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.getElementById('app').appendChild(renderer.domElement);

  // ------------------------------------------------------------------- scene
  const scene = new THREE.Scene();
  // Full-strength sky IBL washes the PBR materials out; direct sun +
  // shadows carry the modelling, the environment just fills.
  scene.environmentIntensity = 0.5;

  const camera = new THREE.PerspectiveCamera(
    55,
    window.innerWidth / window.innerHeight,
    0.5,
    50000
  );
  camera.position.set(22, 9, 30);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.minDistance = 4;
  controls.maxDistance = 250;
  // Keep the camera above the waves — there is no underwater rendering yet.
  controls.maxPolarAngle = Math.PI * 0.49;

  // ------------------------------------------------------------ core systems
  // Rapier WASM init is the only real await here; do it first so a failure
  // surfaces before anything renders.
  const physics = await PhysicsWorld.create();

  // Denser mesh (~0.94 m spacing) so the FFT cascades' short chop is carried
  // as real geometry without aliasing, not smoothed away.
  const ocean = new Ocean(720, 768);
  scene.add(ocean.mesh);

  const sky = new SkySystem(renderer, scene);
  ocean.applySkyState(sky.getOceanState());

  const wind = new WindManager({ speedKnots: 12, directionDeg: 315 });
  // Start with the sea already fully developed for this wind (no 30 s of
  // watching it build from calm at load).
  ocean.snapSeaToWind(wind);

  // Helm before boat: physics keeps a live reference to helm.state.
  const helm = new Helm();

  // The boat: model + rigid body + buoyancy + sails (see src/boat/).
  const boat = new Boat(scene, physics, ocean, wind, helm.state);
  helm.onReset = () => boat.reset();

  // First-person "helm seat": an empty parented to the hull, so it inherits
  // the boat's full pose — heave, pitch and heel all move the view exactly as
  // they would for someone sitting in the cockpit. Placed on the starboard
  // coaming at seated eye height, facing the bow with a slight downward gaze.
  const fpSeat = new THREE.Object3D();
  fpSeat.position.set(-2.6, 1.5, 0.5); // body frame: aft cockpit, +X = bow
  fpSeat.quaternion
    .setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2) // face the bow
    .multiply(
      new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(1, 0, 0),
        THREE.MathUtils.degToRad(-7) // tip the gaze down onto the deck a touch
      )
    );
  boat.model.add(fpSeat);

  // Bow spray, fed by the slam detector inside the buoyancy loop.
  const spray = new Spray(scene);

  // ------------------------------------------------ debug wave-height probes
  // Three PBR spheres that follow ocean.getHeightAt() — the visual contract
  // test between the CPU wave math and the GPU surface (see file header).
  // Off by default now the boat itself demonstrates the same contract;
  // re-enable from the Debug folder.
  const probes = new THREE.Group();
  const probeGeo = new THREE.SphereGeometry(0.45, 32, 24);
  const probeMat = new THREE.MeshStandardMaterial({
    color: 0xff5522,
    roughness: 0.35,
    metalness: 0.0,
  });
  const probePositions = [
    [10, 0],
    [14, -8],
    [-11, 16],
  ];
  for (const [px, pz] of probePositions) {
    const m = new THREE.Mesh(probeGeo, probeMat);
    m.userData.gridPos = { x: px, z: pz };
    probes.add(m);
  }
  probes.visible = false;
  scene.add(probes);

  // ---------------------------------------------------------------------- UI
  const hud = new HUD();
  const cameraState = { followBoat: true, firstPerson: false };

  // First-person look-around: drag to turn your head. The yaw/pitch offset is
  // applied ON TOP of the seat's pose, so you can look anywhere on board while
  // the view still rides the boat's heave, pitch and heel.
  const fpLook = { yaw: 0, pitch: 0, dragging: false, px: 0, py: 0 };
  helm.onToggleView = () => {
    cameraState.firstPerson = !cameraState.firstPerson;
    if (cameraState.firstPerson) {
      fpLook.yaw = 0;
      fpLook.pitch = 0;
    } // entering the seat always faces forward
  };
  // Clean view (F): hide every overlay and go fullscreen for a cinematic
  // frame. Kept in sync with the browser so pressing Esc also restores the UI.
  helm.onToggleClean = () => {
    const on = !document.body.classList.contains('clean-view');
    document.body.classList.toggle('clean-view', on);
    if (on && document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else if (!on && document.fullscreenElement && document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    }
  };
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) document.body.classList.remove('clean-view');
  });

  renderer.domElement.addEventListener('pointerdown', (e) => {
    if (!cameraState.firstPerson) return;
    fpLook.dragging = true;
    fpLook.px = e.clientX;
    fpLook.py = e.clientY;
  });
  window.addEventListener('pointerup', () => {
    fpLook.dragging = false;
  });
  window.addEventListener('pointermove', (e) => {
    if (!cameraState.firstPerson || !fpLook.dragging) return;
    fpLook.yaw -= (e.clientX - fpLook.px) * 0.005;
    fpLook.pitch -= (e.clientY - fpLook.py) * 0.005;
    fpLook.px = e.clientX;
    fpLook.py = e.clientY;
    fpLook.yaw = THREE.MathUtils.clamp(fpLook.yaw, -Math.PI * 0.92, Math.PI * 0.92);
    fpLook.pitch = THREE.MathUtils.clamp(fpLook.pitch, -1.2, 1.35);
  });
  // (TWS/TWD are fed per-frame in the loop now — the actual, gusty values.)
  createControlPanel({ wind, ocean, sky, renderer, probes, boat, cameraState, helm });

  // ----------------------------------------------------------- post-processing
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  const bloom = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.28, // strength — subtle; only sun disc + glints should bloom
    0.55, // radius
    1.15 // threshold — safely above sunlit white surfaces (the hull was
    //      blooming at 0.9, which is what washed the whole boat out)
  );
  composer.addPass(bloom);

  // OutputPass performs tone mapping + linear→sRGB. SMAA runs AFTER it, on
  // the final LDR image, which is where an LDR morphological AA belongs.
  composer.addPass(new OutputPass());
  const underwaterPass = new ShaderPass(UnderwaterShader);
  underwaterPass.enabled = false;
  composer.addPass(underwaterPass);
  const smaa = new SMAAPass(
    window.innerWidth * renderer.getPixelRatio(),
    window.innerHeight * renderer.getPixelRatio()
  );
  composer.addPass(smaa);

  // ------------------------------------------------------------------- resize
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
  });

  // -------------------------------------------------------------- render loop
  const clock = new THREE.Clock();
  const _fwd = new THREE.Vector3(); // scratch: boat forward for the wake
  const _seatQ = new THREE.Quaternion(); // scratch: FPV seat world orientation
  const _lookQ = new THREE.Quaternion(); // scratch: FPV look-around offset
  const _lookEuler = new THREE.Euler();
  let underwaterAmt = 0;

  function animate() {
    requestAnimationFrame(animate);

    const frameDt = clock.getDelta();
    const elapsed = clock.elapsedTime;

    // Wind turbulence first — physics below reads the gusty actual values.
    wind.update(elapsed);

    // Advance the ocean clock FIRST: the buoyancy hooks inside physics.step
    // query ocean.getHeightAt(), which must see the same time the water is
    // rendered with this frame. (Substeps within a frame share this time —
    // a ≤16 ms approximation, well below anything visible.) The wind ref
    // lets the sea state follow the wind sliders.
    ocean.update(elapsed, camera, frameDt, wind);

    helm.update(frameDt); // move rudder/sheet from held keys
    physics.step(frameDt);

    // Snap the boat mesh to its rigid body; pose sails; feed instruments.
    const boatState = boat.updateVisuals(elapsed, frameDt);
    const aero = boat.physics.lastAero;
    hud.update({
      tws: wind.speedKnotsActual,
      twd: wind.directionDegActual,
      sog: boatState.sog,
      hdg: boatState.heading,
      heel: boatState.heel,
      awa: aero.awaDeg,
      sail: aero.mainBetaDeg,
    });

    // Bow spray: consume any slam the buoyancy loop flagged this frame.
    if (boat.physics.slamIntensity > 0) {
      spray.burst(boat.physics.slamPoint, boat.physics.body.linvel(), boat.physics.slamIntensity);
      boat.physics.slamIntensity = 0;
    }
    spray.update(frameDt);

    // Keep the sun's shadow frustum on the boat.
    sky.trackShadowTarget(boatState.position);

    // Boat → ocean shader: contact foam / wake, and the shadow map (which
    // only exists after the first shadowed render, hence wired here).
    _fwd.set(1, 0, 0).applyQuaternion(boatState.quaternion);
    const fwdLen = Math.hypot(_fwd.x, _fwd.z) || 1;
    ocean.setBoatState(
      boatState.position.x,
      boatState.position.z,
      _fwd.x / fwdLen,
      _fwd.z / fwdLen,
      boatState.sog * 0.514444
    );
    ocean.updateShadow(sky.sunLight);

    // Underwater veil when the camera dips below the local wave surface.
    const camWaterY = ocean.getHeightAt(camera.position.x, camera.position.z);
    const underTarget = camera.position.y < camWaterY - 0.05 ? 1 : 0;
    underwaterAmt += (underTarget - underwaterAmt) * (1 - Math.exp(-frameDt * 10));
    underwaterPass.uniforms.uAmount.value = underwaterAmt;
    underwaterPass.uniforms.uTime.value = elapsed;
    underwaterPass.enabled = underwaterAmt > 0.01;

    // Camera: first-person helm seat, or the orbiting chase cam.
    // The finite check protects the camera: a NaN pose blacks out the whole
    // render and never recovers.
    const poseOk = Number.isFinite(
      boatState.position.x + boatState.position.y + boatState.position.z
    );
    if (cameraState.firstPerson && poseOk) {
      // Ride the seat: it inherits the hull's pose this frame, so the horizon
      // pitches and heels exactly as it would from on board. The drag-driven
      // look offset is layered on in the seat's local frame, so "turning your
      // head" is relative to the boat, not the world.
      controls.enabled = false;
      fpSeat.getWorldPosition(camera.position);
      fpSeat.getWorldQuaternion(_seatQ);
      _lookQ.setFromEuler(_lookEuler.set(fpLook.pitch, fpLook.yaw, 0, 'YXZ'));
      camera.quaternion.copy(_seatQ).multiply(_lookQ);
    } else {
      controls.enabled = true;
      // Chase target: keep orbiting around the boat as it drifts/sails.
      if (cameraState.followBoat && poseOk) {
        controls.target.lerp(
          { x: boatState.position.x, y: boatState.position.y + 1, z: boatState.position.z },
          0.08
        );
      }
    }

    // Ride the probes on the CPU-evaluated wave height.
    if (probes.visible) {
      for (const probe of probes.children) {
        const { x, z } = probe.userData.gridPos;
        const h = ocean.getHeightAt(x, z);
        probe.position.set(x, h + 0.1, z); // slight lift: ~75% submerged look
      }
    }

    if (controls.enabled) controls.update();
    composer.render();
  }

  animate();

  // Reveal the scene.
  document.getElementById('loading').classList.add('done');
}

init().catch((err) => {
  console.error('Simulator failed to initialise:', err);
  const sub = document.querySelector('#loading .loading-sub');
  if (sub) {
    sub.textContent = `initialisation failed: ${err.message} — see console`;
    sub.style.color = '#ff7b6b';
  }
});
