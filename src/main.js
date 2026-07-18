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
  uniforms: {
    tDiffuse: { value: null },
    uAmount: { value: 0 },
    uTime: { value: 0 },
    // Per-pixel waterline: camera height above the local water surface plus
    // the camera basis, so the murk is applied only to the part of the FRAME
    // that is actually below the surface — a half-dunked lens shows a split
    // screen (tilted with camera roll), not an all-or-nothing flicker.
    uCamRel: { value: 10 },
    uCamFwd: { value: new THREE.Vector3(0, 0, -1) },
    uCamRight: { value: new THREE.Vector3(1, 0, 0) },
    uCamUp: { value: new THREE.Vector3(0, 1, 0) },
    uTanHalf: { value: 0.6 },
    uAspect: { value: 1.7 },
  },
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
    uniform float uCamRel;
    uniform vec3 uCamFwd, uCamRight, uCamUp;
    uniform float uTanHalf, uAspect;
    varying vec2 vUv;
    void main() {
      // Which side of the waterline is THIS pixel? Reconstruct its view ray
      // and test a point a lens-length along it against the water plane.
      vec2 ndc = vUv * 2.0 - 1.0;
      vec3 dir = normalize(uCamFwd + uCamRight * ndc.x * uTanHalf * uAspect
                                   + uCamUp * ndc.y * uTanHalf);
      float sub = smoothstep(0.06, -0.06, uCamRel + dir.y * 0.18);
      float amt = uAmount * sub;

      // Refraction wobble: the image seen through moving water shimmers.
      float rip = amt * 0.006;
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

      gl_FragColor = vec4(mix(c.rgb, murk, amt), c.a);
    }`,
};

import { Ocean } from './ocean/Ocean.js';
import { Boat } from './boat/Boat.js';
import { Spray } from './effects/Spray.js';
import { Runoff } from './effects/Runoff.js';
import { Rain } from './effects/Rain.js';
import { Spindrift } from './effects/Spindrift.js';
import { Breakers } from './effects/Breakers.js';
import { Birds } from './effects/Birds.js';
import { MarineLife } from './effects/MarineLife.js';
import { Thunderstorm } from './environment/Thunderstorm.js';
import { RigInteract } from './ui/RigInteract.js';
import { SoundSystem } from './audio/SoundSystem.js';
import { SkySystem } from './environment/SkySystem.js';
import { PlanarReflection } from './environment/PlanarReflection.js';
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
  scene.add(ocean.skirtMesh); // flat far-field sea, out to the horizon haze

  const sky = new SkySystem(renderer, scene);
  ocean.applySkyState(sky.getOceanState());

  const wind = new WindManager({ speedKnots: 12, directionDeg: 315 });
  // Start with the sea already fully developed for this wind (no 30 s of
  // watching it build from calm at load).
  ocean.snapSeaToWind(wind);

  // Helm before boat: physics keeps a live reference to helm.state.
  const helm = new Helm();

  // The boat: model + rigid body + buoyancy + sails (see src/boat/).
  const boat = new Boat(scene, physics, ocean, wind, helm.state, sky);
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

  // Walk-around: in first person, WASD strolls the deck (walk direction
  // follows where you're LOOKING, so drag to face the bow and press W to go
  // forward); B climbs down the companionway into the saloon and back up.
  // The anchor slides in the boat frame so the deck still heaves and heels
  // underfoot exactly as before.
  const fpWalk = { x: -2.6, z: 0.5, below: false };
  const keysDown = new Set();
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyB' && cameraState.firstPerson) {
      fpWalk.below = !fpWalk.below;
      if (fpWalk.below) {
        fpWalk.x = -1.0;
        fpWalk.z = 0;
      } else {
        fpWalk.x = -2.3;
        fpWalk.z = 0.4;
      }
    }
    keysDown.add(e.code);
  });
  window.addEventListener('keyup', (e) => keysDown.delete(e.code));
  const stepWalk = (dt) => {
    let mf = 0;
    let ms = 0;
    if (keysDown.has('KeyW')) mf += 1;
    if (keysDown.has('KeyS')) mf -= 1;
    if (keysDown.has('KeyD')) ms += 1;
    if (keysDown.has('KeyA')) ms -= 1;
    if (mf || ms) {
      const sp = (fpWalk.below ? 1.1 : 1.9) * dt;
      const cy = Math.cos(fpLook.yaw);
      const sy = Math.sin(fpLook.yaw);
      // Look-relative axes mapped into the boat frame (seat faces +X).
      fpWalk.x += (mf * cy + ms * sy) * sp;
      fpWalk.z += (-mf * sy + ms * cy) * sp;
    }
    if (fpWalk.below) {
      // Saloon bounds and crouched-standing eye height over the sole.
      fpWalk.x = THREE.MathUtils.clamp(fpWalk.x, -1.5, 0.6);
      fpWalk.z = THREE.MathUtils.clamp(fpWalk.z, -0.42, 0.42);
      fpSeat.position.set(fpWalk.x, 0.85, fpWalk.z);
    } else {
      // Deck bounds: taper the walkable beam toward bow and stern.
      fpWalk.x = THREE.MathUtils.clamp(fpWalk.x, -3.0, 3.15);
      const halfZ = THREE.MathUtils.clamp(
        1.02 - Math.max(0, Math.abs(fpWalk.x - 0.2) - 1.2) * 0.34,
        0.15,
        1.02
      );
      fpWalk.z = THREE.MathUtils.clamp(fpWalk.z, -halfZ, halfZ);
      fpSeat.position.set(fpWalk.x, 2.0, fpWalk.z); // standing eye height
    }
  };

  // Bow spray, fed by the slam detector inside the buoyancy loop.
  const spray = new Spray(scene);
  // Water dripping/running off the decks and topsides after spray or green
  // water (fed a "wetness" value in the render loop).
  const runoff = new Runoff(scene);
  // Wind-driven rain — fades in around gale force, lashes down in a storm.
  const rain = new Rain(scene);
  // Spindrift — spray torn off the wave crests, driven downwind in a blow.
  const spindrift = new Spindrift(scene);
  // Breakers — white-water bursts where the surface Jacobian says a crest is
  // actually folding (including two wave trains colliding). The moment of
  // breaking as a 3D event, not just painted foam.
  const breakers = new Breakers(scene);
  // Gulls wheeling over the sea — life above the waterline.
  const birds = new Birds(scene);
  // …and below it: dolphin pods, the odd shark fin, a rare whale.
  const marineLife = new MarineLife(scene, ocean);
  const _windVec = new THREE.Vector3();

  // Planar reflection of the boat/world in the water surface.
  const reflection = new PlanarReflection(768);

  // Procedural ambience (wind/sea/rush/rain/creak/slam). Browsers need a user
  // gesture before audio starts, so resume() on the first pointer/key event.
  const sound = new SoundSystem();
  // Lightning + distance-delayed thunder once the sky is black and it blows.
  const thunderstorm = new Thunderstorm(scene, sound);
  // Breaking crests near the camera are HEARD as washes: strength from fold
  // depth × proximity, stereo pan from the burst's bearing relative to the
  // camera (break to your left → heard left), highs dulled with distance.
  const _camVel = new THREE.Vector3();
  const _camPrev = new THREE.Vector3();
  const _sndFwd = new THREE.Vector3();
  const _sndUp = new THREE.Vector3();
  breakers.onBurst = (fold, dist, bx, bz) => {
    if (dist > 130) return;
    // Doppler from the LISTENER's real motion: radial velocity toward the
    // collapse over the speed of sound. Subtle (a few percent at chase-cam
    // speeds) — which is exactly how subtle it is in life.
    const len = Math.max(dist, 1);
    const vr = (_camVel.x * (bx - camera.position.x) + _camVel.z * (bz - camera.position.z)) / len;
    const rate = THREE.MathUtils.clamp(1 + vr / 343, 0.94, 1.06);
    const by = ocean.getHeightAt(bx, bz);
    sound.wash(fold * (1 - dist / 140), { x: bx, y: by, z: bz }, dist, rate);
  };
  const startAudio = () => sound.resume();
  window.addEventListener('pointerdown', startAudio, { once: false });
  window.addEventListener('keydown', startAudio, { once: false });

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
      fpWalk.x = -2.6; // board at the helm, on deck
      fpWalk.z = 0.5;
      fpWalk.below = false;
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

  // Grabbable running rigging + companionway door (drag sheets/halyard to
  // trim, click the washboards to open the cabin). Checked FIRST on pointer
  // down — a grabbed rope must not also start a look-drag or orbit.
  const rig = new RigInteract(renderer.domElement, camera, boat, helm, controls);

  // Capture phase + stopImmediatePropagation: a grabbed rope must reach us
  // BEFORE OrbitControls' own pointerdown on the same canvas, or the camera
  // orbits while you're hauling on a sheet.
  renderer.domElement.addEventListener(
    'pointerdown',
    (e) => {
      // Always resume audio on the raw gesture — grabbing a rope below calls
      // stopImmediatePropagation() and would otherwise swallow this event
      // before it bubbles to the window listener that starts the AudioContext.
      // On mobile this WAS the sound bug: the boat fills most of the screen,
      // so a first tap very often lands on a rope and audio never started.
      startAudio();
      if (rig.tryGrab(e)) {
        e.stopImmediatePropagation();
        return;
      }
      if (!cameraState.firstPerson) return;
      fpLook.dragging = true;
      fpLook.px = e.clientX;
      fpLook.py = e.clientY;
    },
    true
  );
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
  createControlPanel({ wind, ocean, sky, renderer, probes, boat, cameraState, helm, sound });

  // ----------------------------------------------------------- post-processing
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  const bloom = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.28, // strength — subtle; only sun disc + glints should bloom
    0.55, // radius
    2.0 // threshold — was 1.15, tuned against the old Preetham sky. The new
    //     Atmosphere.js horizon reaches ~1.5-1.6 toward the sun, so at 1.15
    //     a huge slab of sky (and its reflection lane on the water) bloomed
    //     into one giant white glow. 2.0 keeps the sun disc (clamped at 12)
    //     and the brightest glints blooming, nothing else.
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
  let deckWet = 0; // 0 dry … 1 streaming — decays as the boat dries out
  let nextGull = 15; // seconds to the next gull cry

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
    const boatVel = boat.physics.body.linvel();
    if (boat.physics.slamIntensity > 0) {
      spray.burst(boat.physics.slamPoint, boatVel, boat.physics.slamIntensity);
      sound.slam(boat.physics.slamIntensity);
      // A slam leaves the foredeck streaming.
      deckWet = Math.min(1, deckWet + 0.25 + boat.physics.slamIntensity * 0.12);
      boat.physics.slamIntensity = 0;
    }
    spray.update(frameDt);

    // Runoff wetness: rises with green water (hull samples awash), a buried
    // rail (heel), and slams; dries over a few seconds.
    let awashN = 0;
    const S = boat.physics.samples;
    const D = boat.physics.lastDepth;
    for (let i = 0; i < S.length; i++) if (D[i] >= S[i].columnHeight * 0.6) awashN++;
    const awash = awashN / S.length; // fraction of the hull awash
    const railDown = Math.max(0, (Math.abs(boatState.heel) - 22) / 45); // rail in the water
    deckWet = Math.min(1, deckWet + (awash * 3.5 + railDown * 2.0) * frameDt);
    // ~7 s to dry (was ~3.5 s) — water washing the deck used to read as
    // "instantly dry" the moment the wave passed, because the falling
    // Runoff droplets are the only visible cue and they're sparse. Slower
    // decay plus the wet-material look below (Boat.setWetness) gives a
    // just-washed deck real, visible persistence.
    deckWet = Math.max(0, deckWet - frameDt * 0.14);
    runoff.update(frameDt, boatState, boatVel, deckWet);
    boat.setWetness(deckWet);

    // Rain: fades in from ~gale (25 kn) to storm (50 kn), slanted by the
    // wind — plus the squall burst a lightning strike dumps for ~15 s.
    const rainI = Math.max(
      THREE.MathUtils.clamp((wind.speedKnotsActual - 25) / 25, 0, 1),
      thunderstorm.squall * 0.9
    );
    const wdir = THREE.MathUtils.degToRad(wind.directionDegActual + 180); // blowing TO
    _windVec.set(Math.sin(wdir), 0, -Math.cos(wdir)).multiplyScalar(wind.speedMs);
    rain.update(frameDt, camera.position, _windVec, rainI);
    // Spindrift starts a bit earlier than rain (crests blow off ~gale force).
    const driftI = THREE.MathUtils.clamp((wind.speedKnotsActual - 30) / 25, 0, 1);
    spindrift.update(frameDt, camera.position, ocean, _windVec, driftI);
    // Breaking bursts start with the first whitecaps (~12 kn); the Jacobian
    // gate inside does the real work of picking WHERE.
    const breakI = THREE.MathUtils.clamp((wind.speedKnotsActual - 10) / 22, 0, 1);
    breakers.update(frameDt, camera.position, ocean, _windVec, breakI);
    birds.update(frameDt, camera.position, _windVec, elapsed);
    marineLife.update(frameDt, camera.position, boatState.heading);
    // Thunderstorm arms itself when the sky is properly black AND it blows —
    // so the Gale/Hurricane presets with overcast cranked become electrical.
    thunderstorm.intensity =
      THREE.MathUtils.clamp((wind.speedKnotsActual - 30) / 22, 0, 1) *
      THREE.MathUtils.smoothstep(sky.overcast, 0.5, 0.85);
    thunderstorm.update(frameDt, camera.position, elapsed);
    rig.update(frameDt);
    // Gull cries: occasional and only while it isn't howling (birds go quiet
    // and land-bound in a real storm).
    nextGull -= frameDt;
    if (nextGull <= 0) {
      nextGull = 9 + Math.random() * 24;
      if (wind.speedKnotsActual < 28) sound.gull();
    }

    // Procedural ambience mix.
    // Splashdown patter: every spray droplet that ended its flight this
    // frame becomes one audible micro-grain (see SoundSystem.patter).
    if (spray.splashdowns) {
      sound.patter(spray.splashdowns);
      spray.splashdowns = 0;
    }
    // Binaural listener = the camera: position, facing and up, every frame.
    // Also track its velocity (for wash doppler), pin the boat's positional
    // source to the hull, and dunk the whole mix when a wave rolls over the
    // camera (works both underwater-camera and below-decks-at-sea moments).
    if (frameDt > 0) {
      _camVel.copy(camera.position).sub(_camPrev).divideScalar(frameDt);
      _camPrev.copy(camera.position);
    }
    camera.getWorldDirection(_sndFwd);
    _sndUp.setFromMatrixColumn(camera.matrixWorld, 1);
    sound.setListenerPose(camera.position, _sndFwd, _sndUp);
    sound.setBoatPosition(boatState.position);
    sound.setUnderwater(
      camera.position.y < ocean.getHeightAt(camera.position.x, camera.position.z) ? 1 : 0
    );
    sound.update({
      windKn: wind.speedKnotsActual,
      // Where is the EAR? On board, the boat is the soundstage; zoomed out
      // it recedes and dulls (see the boatBus in SoundSystem).
      camDist: camera.position.distanceTo(boatState.position),
      // Sea rumble follows the MEASURED significant wave height, not the
      // wind: a big sea left over after the wind eases (or cranked up with
      // the sliders) sounds like the water that is actually out there.
      seaState: THREE.MathUtils.clamp((ocean.fft.Hs || 0) / 9, 0, 1),
      rainI,
      sog: boatState.sog,
      heel: boatState.heel,
      time: elapsed,
      dt: frameDt,
      // Rig voice: flogging while luffing, winch pawls while sheeting in.
      luffing: boat.physics.lastAero.luffing,
      sheetDeg: helm.state.sheetMaxDeg,
    });

    // Keep the sun's shadow frustum on the boat; drift the clouds downwind.
    sky.trackShadowTarget(boatState.position);
    sky.updateClouds(frameDt, _windVec);

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
    // Persistent curved wake trail (world-space). Dropped at the TRANSOM
    // (~3 m aft of the body origin), not the boat centre — foam is churned
    // where the hull leaves the water, and a centre-dropped trail visibly
    // painted white water forward of amidships.
    ocean.updateWake(
      boatState.position.x - (_fwd.x / fwdLen) * 3,
      boatState.position.z - (_fwd.z / fwdLen) * 3,
      boatState.sog * 0.514444,
      frameDt
    );
    ocean.updateShadow(sky.sunLight);

    // Underwater veil: armed whenever the camera is NEAR the surface; the
    // shader's per-pixel waterline decides which part of the frame is
    // actually submerged, so a half-dunked view splits along the water
    // instead of strobing between fully-dry and fully-drowned.
    const camWaterY = ocean.getHeightAt(camera.position.x, camera.position.z);
    const camRel = camera.position.y - camWaterY;
    const underTarget = camRel < 0.6 ? 1 : 0;
    underwaterAmt += (underTarget - underwaterAmt) * (1 - Math.exp(-frameDt * 10));
    const U = underwaterPass.uniforms;
    U.uAmount.value = underwaterAmt;
    U.uTime.value = elapsed;
    U.uCamRel.value = camRel;
    camera.getWorldDirection(U.uCamFwd.value);
    U.uCamUp.value.setFromMatrixColumn(camera.matrixWorld, 1);
    U.uCamRight.value.crossVectors(U.uCamFwd.value, U.uCamUp.value);
    U.uTanHalf.value = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    U.uAspect.value = camera.aspect;
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
      stepWalk(frameDt); // WASD deck walking / B below — slides the anchor
      // Below decks the ocean tile would render straight through the hull
      // (there's no stencil masking) — the saloon sole is under the
      // waterline, as on any real boat this size. Hide the sea while below;
      // the doorway view is sky and cockpit anyway.
      ocean.mesh.visible = ocean.skirtMesh.visible = !fpWalk.below;
      fpSeat.getWorldPosition(camera.position);
      fpSeat.getWorldQuaternion(_seatQ);
      _lookQ.setFromEuler(_lookEuler.set(fpLook.pitch, fpLook.yaw, 0, 'YXZ'));
      camera.quaternion.copy(_seatQ).multiply(_lookQ);
    } else {
      controls.enabled = true;
      ocean.mesh.visible = ocean.skirtMesh.visible = true; // back on the sea
      // Chase target: keep orbiting around the boat as it drifts/sails.
      if (cameraState.followBoat && poseOk) {
        controls.target.lerp(
          { x: boatState.position.x, y: boatState.position.y + 1, z: boatState.position.z },
          0.08
        );
      }
    }

    // Debug-harness camera override (?debug only): DBG.camOverride =
    // {pos: Vector3, look: Vector3} pins the camera AFTER all camera logic —
    // OrbitControls' damping glides a hand-set position back within a frame,
    // which has repeatedly sabotaged screenshot verification of waterline /
    // underwater states. This hook wins unconditionally; clear it to null
    // to hand control back.
    if (window.DBG && window.DBG.camOverride) {
      camera.position.copy(window.DBG.camOverride.pos);
      camera.lookAt(window.DBG.camOverride.look);
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

    // Planar reflection: mirror the above-water world into the ocean surface
    // (water + its own spray excluded so it doesn't reflect into itself).
    reflection.render(renderer, scene, camera, [
      ocean.mesh, ocean.skirtMesh, spray.points, runoff.points, rain.lines, spindrift.points,
      breakers.points,
    ]);
    ocean.setReflection(reflection.rt.texture, reflection.textureMatrix);

    composer.render();
  }

  animate();

  // Dev aid: `?debug` in the URL exposes live handles for console poking and
  // screenshot-harness bisection (used to crack the foam-stripe bug). Inert
  // in normal use.
  if (new URLSearchParams(location.search).has('debug')) {
    window.DBG = {
      scene, camera, controls, ocean, boat, sky, reflection, renderer,
      composer, bloom, smaa, wind, cameraState, spray, runoff, rain,
      spindrift, breakers, birds, marineLife, thunderstorm, rig, THREE,
    };
  }

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
