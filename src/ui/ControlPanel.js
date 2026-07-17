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

  // --- Wind -----------------------------------------------------------------
  const windFolder = gui.addFolder('Wind');
  windFolder
    .add(wind, 'speedKnots', 0, 40, 0.5)
    .name('Speed (kn)')
    .onChange((v) => wind.setSpeedKnots(v));
  windFolder
    .add(wind, 'directionDeg', 0, 360, 1)
    .name('Direction (° FROM)')
    .onChange((v) => wind.setDirectionDeg(v));

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
  seaFolder.add(ocean, 'seaFollowsWind').name('Sea follows wind').onChange(syncSeaMode);
  syncSeaMode(ocean.seaFollowsWind);

  // --- Sky / sun ----------------------------------------------------------------
  const applySun = () => {
    sky.setSun(sky.elevationDeg, sky.azimuthDeg);
    ocean.applySkyState(sky.getOceanState());
  };
  const skyFolder = gui.addFolder('Sun & sky');
  skyFolder.add(sky, 'elevationDeg', 0.5, 89, 0.5).name('Sun elevation (°)').onChange(applySun);
  skyFolder.add(sky, 'azimuthDeg', 0, 360, 1).name('Sun azimuth (°)').onChange(applySun);
  skyFolder
    .add(renderer, 'toneMappingExposure', 0.1, 2, 0.01)
    .name('Exposure');

  // --- Sailing ---------------------------------------------------------------------
  // .listen() keeps the widgets live when the keyboard (Helm.js) changes
  // the same state object.
  const sailFolder = gui.addFolder('Sailing');
  sailFolder.add(helm.state, 'autoTrim').name('Auto-trim (T)').listen();
  sailFolder.add(helm.state, 'sheetMaxDeg', 8, 88, 1).name('Sheet (↑ in / ↓ out)').listen();
  sailFolder.add(helm.state, 'rudderDeg', -32, 32, 1).name('Rudder (← / →)').listen();

  // --- Boat -----------------------------------------------------------------------
  const boatFolder = gui.addFolder('Boat');
  boatFolder.add(cameraState, 'followBoat').name('Camera follows boat');
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
