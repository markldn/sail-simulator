/**
 * ControlPanel.js — lil-gui panel for live-tuning the environment.
 *
 * (lil-gui is the maintained successor to dat.GUI with the same API.)
 * Every control writes straight into the owning system — no polling.
 */

import GUI from 'lil-gui';

/**
 * @param {object} deps
 * @param {import('../wind/WindManager.js').WindManager} deps.wind
 * @param {import('../ocean/Ocean.js').Ocean}            deps.ocean
 * @param {import('../environment/SkySystem.js').SkySystem} deps.sky
 * @param {THREE.WebGLRenderer}                          deps.renderer
 * @param {{visible: boolean}}                           deps.probes debug wave-height probes group
 * @param {import('../boat/Boat.js').Boat}               deps.boat
 * @param {{followBoat: boolean}}                        deps.cameraState
 * @param {import('./Helm.js').Helm}                     deps.helm
 */
export function createControlPanel({ wind, ocean, sky, renderer, probes, boat, cameraState, helm }) {
  const gui = new GUI({ title: 'Environment' });

  const _tmpState = {};

  // --- Wind -----------------------------------------------------------------
  // .listen() on the sliders keeps them honest when the point-of-sail
  // buttons or scenario presets change the wind programmatically.
  const windFolder = gui.addFolder('Wind');
  windFolder
    .add(wind, 'speedKnots', 0, 64, 0.5)
    .name('Speed (kn)')
    .listen()
    .onChange((v) => wind.setSpeedKnots(v));
  windFolder
    .add(wind, 'directionDeg', 0, 360, 1)
    .name('Direction (° FROM)')
    .listen()
    .onChange((v) => wind.setDirectionDeg(v));
  windFolder.add(wind, 'gustsEnabled').name('Gusts & shifts');
  windFolder.add(wind, 'gustiness', 0, 0.5, 0.01).name('Gust strength');
  windFolder.add(wind, 'shiftRange', 0, 25, 1).name('Shift range (±°)');

  // Point-of-sail buttons: set the wind RELATIVE to the boat's current
  // heading, to study how the rig behaves on each point of sail.
  const relWind = (relDeg) => {
    const h = boat.physics.getState(_tmpState).heading;
    wind.setDirectionDeg(Math.round(h + relDeg + 360) % 360);
  };
  const pos = windFolder.addFolder('Point of sail (vs boat)');
  pos.add({ f: () => relWind(0) }, 'f').name('⇧ On the nose (no-go)');
  pos.add({ f: () => relWind(-45) }, 'f').name('⬉ Close-hauled (port)');
  pos.add({ f: () => relWind(-90) }, 'f').name('⬅ Beam reach (port)');
  pos.add({ f: () => relWind(90) }, 'f').name('➡ Beam reach (stbd)');
  pos.add({ f: () => relWind(135) }, 'f').name('⬊ Broad reach');
  pos.add({ f: () => relWind(180) }, 'f').name('⇩ Dead run');
  pos.close();

  // --- Rig ------------------------------------------------------------------
  // Physics reads sailPlan live; reefing also lowers the centre of effort,
  // so less heel per m² — watch HEEL while dragging these in a blow.
  const rigFolder = gui.addFolder('Rig');
  rigFolder.add(boat.physics.sailPlan, 'main', 0, 1, 0.05).name('Mainsail hoist').listen();
  rigFolder.add(boat.physics.sailPlan, 'jib', 0, 1, 0.05).name('Jib (furler)').listen();

  // --- Sea state --------------------------------------------------------------
  // With "Sea follows wind" on (default) the sliders are read-only displays
  // of the wind-driven sea; turn it off for manual control. Ranges chosen so
  // choppiness × total steepness stays below the Gerstner self-intersection
  // limit; maxed-out crests will just begin to curl over — that's the
  // physical limit of the wave model, not a bug.
  const seaFolder = gui.addFolder('Sea state');
  const heightCtrl = seaFolder
    .add(ocean, 'heightScale', 0, 2.4, 0.01)
    .name('Wave height ×')
    .listen()
    .onChange((v) => ocean.setHeightScale(v));
  const chopCtrl = seaFolder
    .add(ocean, 'choppiness', 0, 1.2, 0.01)
    .name('Choppiness')
    .listen()
    .onChange((v) => ocean.setChoppiness(v));
  const syncSeaMode = (auto) => {
    heightCtrl.enable(!auto);
    chopCtrl.enable(!auto);
  };
  seaFolder
    .add(ocean, 'seaFollowsWind')
    .name('Sea follows wind')
    .listen()
    .onChange(syncSeaMode);
  syncSeaMode(ocean.seaFollowsWind);

  // --- Sky / sun ----------------------------------------------------------------
  const applySun = () => {
    sky.setSun(sky.elevationDeg, sky.azimuthDeg);
    ocean.applySkyState(sky.getOceanState());
  };
  const skyFolder = gui.addFolder('Sun & sky');
  skyFolder.add(sky, 'elevationDeg', 0.5, 89, 0.5).name('Sun elevation (°)').onChange(applySun);
  skyFolder.add(sky, 'azimuthDeg', 0, 360, 1).name('Sun azimuth (°)').onChange(applySun);
  skyFolder.add(sky, 'overcast', 0, 1, 0.01).name('Overcast').listen().onChange(applySun);
  skyFolder
    .add(renderer, 'toneMappingExposure', 0.1, 2, 0.01)
    .name('Exposure')
    .listen();

  // --- Scenarios --------------------------------------------------------------
  // One-click situations. Fields left undefined keep their current value;
  // swell.bearingRel aims the event wave relative to the boat's heading at
  // the moment you press the button.
  const PRESETS = {
    '⛵ Fair sailing': {
      windKn: 12, windDir: 315, sunElev: 32, sunAz: 155, turbidity: 6,
      rayleigh: 1.8, fog: 0.0016, exposure: 0.5, main: 1, jib: 1, overcast: 0,
    },
    '🌅 Calm dawn': {
      windKn: 3, sunElev: 7, sunAz: 95, turbidity: 4, rayleigh: 2.2,
      fog: 0.0022, exposure: 0.55, main: 1, jib: 1, overcast: 0.05,
    },
    '💨 Fresh breeze': {
      windKn: 18, sunElev: 48, turbidity: 5, rayleigh: 1.6,
      fog: 0.0014, exposure: 0.5, main: 1, jib: 1, overcast: 0.15,
    },
    '🌫 Fog bank': {
      windKn: 7, sunElev: 22, turbidity: 9, fog: 0.012, exposure: 0.46,
      main: 1, jib: 1, overcast: 0.55,
    },
    // Reefed main, no jib — the seamanlike gale rig. Try full sail here
    // and watch the knockdowns. Gloom comes from the overcast factor, not
    // turbidity (high Preetham turbidity BRIGHTENS the sky — wrong tool).
    '⛈ Gale': {
      windKn: 34, sunElev: 18, turbidity: 8, rayleigh: 0.8,
      fog: 0.005, exposure: 0.42, main: 0.4, jib: 0, overcast: 0.8,
    },
    // Storm canvas only. Survival conditions — expect to get rolled if
    // you present the beam to the seas.
    '🌀 Hurricane': {
      windKn: 55, sunElev: 14, turbidity: 10, rayleigh: 0.7,
      fog: 0.008, exposure: 0.36, main: 0.15, jib: 0, overcast: 0.92,
    },
    // 300 m / 8 m event wave aimed at the bow. Deep-water tsunami — long
    // and fast (~40 kn) rather than a breaking wall (that's a shoaling
    // effect we don't model without a seabed).
    '🌊 Tsunami': {
      swell: { bearingRel: 180, wavelength: 300, amplitude: 8 },
    },
    // Shorter, steeper, from the quarter — the nasty one.
    '👹 Rogue wave': {
      swell: { bearingRel: 140, wavelength: 140, amplitude: 6 },
    },
  };

  const applyPreset = (p) => {
    sky.overcast = p.overcast ?? 0;
    if (p.windKn != null) wind.setSpeedKnots(p.windKn);
    if (p.windDir != null) wind.setDirectionDeg(p.windDir);
    if (p.main != null) boat.physics.sailPlan.main = p.main;
    if (p.jib != null) boat.physics.sailPlan.jib = p.jib;
    if (p.turbidity != null || p.rayleigh != null) sky.setAtmosphere(p.turbidity, p.rayleigh);
    if (p.fog != null) sky.fogDensity = p.fog;
    if (p.exposure != null) renderer.toneMappingExposure = p.exposure;
    if (p.sunElev != null) sky.elevationDeg = p.sunElev;
    if (p.sunAz != null) sky.azimuthDeg = p.sunAz;
    ocean.seaFollowsWind = true;
    syncSeaMode(true);
    applySun(); // rebake sky/env + push colors & fog to the ocean
    if (p.swell) {
      const h = boat.physics.getState(_tmpState).heading;
      ocean.setSwell({
        bearingDeg: (h + p.swell.bearingRel + 360) % 360,
        wavelength: p.swell.wavelength,
        amplitude: p.swell.amplitude,
      });
    } else {
      ocean.clearSwell();
    }
  };

  const scenarioFolder = gui.addFolder('Scenarios');
  for (const [name, p] of Object.entries(PRESETS)) {
    scenarioFolder.add({ f: () => applyPreset(p) }, 'f').name(name);
  }

  // --- Sailing ---------------------------------------------------------------------
  // .listen() keeps the widgets live when the keyboard (Helm.js) changes
  // the same state object.
  const sailFolder = gui.addFolder('Sailing');
  sailFolder.add(helm.state, 'autoTrim').name('Auto-trim (T)').listen();
  sailFolder
    .add(boat.physics, 'clothCouplingEnabled')
    .name('Cloth-coupled forces');
  sailFolder.add(helm.state, 'sheetMaxDeg', 8, 88, 1).name('Sheet (↑ in / ↓ out)').listen();
  sailFolder.add(helm.state, 'rudderDeg', -32, 32, 1).name('Rudder (← / →)').listen();

  // --- Boat -----------------------------------------------------------------------
  const boatFolder = gui.addFolder('Boat');
  boatFolder.add(cameraState, 'followBoat').name('Camera follows boat');
  boatFolder.add(cameraState, 'firstPerson').name('First-person view (C)').listen();
  boatFolder.add({ reset: () => boat.reset() }, 'reset').name('Reset boat ⟲ (R)');

  // --- Debug ---------------------------------------------------------------------
  const debugFolder = gui.addFolder('Debug');
  debugFolder.add(boat.sampleMarkers, 'visible').name('Buoyancy samples');
  debugFolder.add(probes, 'visible').name('Wave-height probes');
  debugFolder
    .add(ocean.material, 'wireframe')
    .name('Ocean wireframe');
  debugFolder.close();

  return gui;
}
