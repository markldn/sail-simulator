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

import { Ocean } from './ocean/Ocean.js';
import { Boat } from './boat/Boat.js';
import { SkySystem } from './environment/SkySystem.js';
import { WindManager, MS_TO_KNOTS } from './wind/WindManager.js';
import { PhysicsWorld } from './physics/PhysicsWorld.js';
import { HUD } from './ui/HUD.js';
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
  renderer.toneMappingExposure = 0.55; // Preetham sky is bright; tame it
  document.getElementById('app').appendChild(renderer.domElement);

  // ------------------------------------------------------------------- scene
  const scene = new THREE.Scene();

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

  const ocean = new Ocean(900, 512);
  scene.add(ocean.mesh);

  const sky = new SkySystem(renderer, scene);
  ocean.applySkyState(sky.getOceanState());

  const wind = new WindManager({ speedKnots: 12, directionDeg: 315 });

  // The boat: visual model + rigid body + buoyancy (see src/boat/).
  const boat = new Boat(scene, physics, ocean);

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
  const cameraState = { followBoat: true };
  wind.onChange((w) => hud.update({ tws: w.speedKnots, twd: w.directionDeg }));
  createControlPanel({ wind, ocean, sky, renderer, probes, boat, cameraState });

  // ----------------------------------------------------------- post-processing
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  const bloom = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.35, // strength — subtle; only sun disc + glints should bloom
    0.55, // radius
    0.9 //   threshold — in HDR, so >0.9 means "brighter than diffuse white"
  );
  composer.addPass(bloom);

  // OutputPass performs tone mapping + linear→sRGB. SMAA runs AFTER it, on
  // the final LDR image, which is where an LDR morphological AA belongs.
  composer.addPass(new OutputPass());
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

  function animate() {
    requestAnimationFrame(animate);

    const frameDt = clock.getDelta();
    const elapsed = clock.elapsedTime;

    // Advance the ocean clock FIRST: the buoyancy hooks inside physics.step
    // query ocean.getHeightAt(), which must see the same time the water is
    // rendered with this frame. (Substeps within a frame share this time —
    // a ≤16 ms approximation, well below anything visible.)
    ocean.update(elapsed, camera);

    physics.step(frameDt);

    // Snap the boat mesh to its rigid body; feed the instruments.
    const boatState = boat.updateVisuals();
    hud.update({ sog: boatState.sog, hdg: boatState.heading, heel: boatState.heel });

    // Chase target: keep orbiting around the boat as it drifts/sails.
    if (cameraState.followBoat) {
      controls.target.lerp(
        { x: boatState.position.x, y: boatState.position.y + 1, z: boatState.position.z },
        0.08
      );
    }

    // Ride the probes on the CPU-evaluated wave height.
    if (probes.visible) {
      for (const probe of probes.children) {
        const { x, z } = probe.userData.gridPos;
        const h = ocean.getHeightAt(x, z);
        probe.position.set(x, h + 0.1, z); // slight lift: ~75% submerged look
      }
    }

    controls.update();
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
