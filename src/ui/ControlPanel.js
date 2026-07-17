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
 * @param {{visible: boolean}}                           deps.probes debug buoyancy probes group
 */
export function createControlPanel({ wind, ocean, sky, renderer, probes }) {
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
  // Ranges chosen so choppiness × total steepness stays below the Gerstner
  // self-intersection limit at max height; push both sliders to the top and
  // crests will just begin to show curl-over artifacts — that's the physical
  // limit of the wave model, not a bug.
  const seaFolder = gui.addFolder('Sea state');
  seaFolder
    .add(ocean, 'heightScale', 0, 2, 0.01)
    .name('Wave height ×')
    .onChange((v) => ocean.setHeightScale(v));
  seaFolder
    .add(ocean, 'choppiness', 0, 1.2, 0.01)
    .name('Choppiness')
    .onChange((v) => ocean.setChoppiness(v));

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

  // --- Debug ---------------------------------------------------------------------
  const debugFolder = gui.addFolder('Debug');
  debugFolder.add(probes, 'visible').name('Buoyancy probes');
  debugFolder
    .add(ocean.material, 'wireframe')
    .name('Ocean wireframe');
  debugFolder.close();

  return gui;
}
