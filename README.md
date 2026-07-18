# ⛵ Sailboat Simulator

A high-fidelity, browser-based sailboat simulator built with **Three.js** (WebGL)
and **Rapier** (WASM rigid-body physics). It models an ocean with real FFT
wave spectra, a sailing hull with sampled-column buoyancy and cloth sails, and
a physically-based sky with dynamic weather — all running in real time in the
browser, no install or asset downloads required.

> Private repository. Built and run locally with [Vite](https://vitejs.dev/).

---

## Features

- **FFT ocean** — multi-cascade Gerstner/FFT wave field with a real-time CPU
  height query so the boat actually rides the same surface the GPU renders.
  Whitecap foam is driven by physical breaking mechanisms (bubble rafts,
  windrows, decaying foam memory) rather than noise blobs.
- **Boat physics** — rigid-body hull with sampled-column buoyancy, hydrodynamic
  drag, wave-making resistance, and wind shear. Knockdowns, slamming, and
  capsize containment are all handled.
- **Cloth sails** — the main and jib are true position-based-dynamics cloth,
  aerodynamically loaded so they luff, flap, and fill correctly. Trim is
  coupled back into the forces (two-way cloth ↔ physics coupling).
- **Dynamic weather** — physically-based sky (Rayleigh + Mie single scattering),
  fractal procedural clouds, rain, thunderstorms with lightning and
  distance-delayed thunder.
- **Effects** — bow spray, deck runoff, spindrift torn off the crests, breaking
  waves, birds, and marine life (dolphins, sharks, whales).
- **Procedural audio** — wind, sea, hull rush, rain, rig creaks, slam impacts,
  gull cries, and thunder, all synthesised live.
- **First-person helm** — walk the deck (WASD), sit in the helm seat, and **drag
  the running rigging** with the mouse to trim sheets and hoist/reef the main.
- **Planar reflections** — the boat and sky mirror in the water surface.
- **Scenarios** — one-click presets: Fair sailing, Calm dawn, Fresh breeze,
  Fog bank, Gale, Hurricane, Tsunami, Rogue wave.

---

## Controls

| Key | Action |
| --- | --- |
| `←` / `→` | Rudder (self-centres on release) |
| `↑` / `↓` | Sheet in / ease out (manual trim) |
| `T` | Toggle auto-trim |
| `C` | Toggle first-person (helm-seat) camera |
| `F` | Toggle clean full-screen view (hide overlays) |
| `R` | Reset the boat |
| Mouse drag | Grab sheets / halyard in first-person to trim & reef |
| Mouse | Orbit / zoom in chase view |

A live control panel (top-right) exposes wind, sun, sky, sail, and scenario
controls, plus debug visualisations.

---

## Running locally

```bash
npm install
npm run dev        # dev server with hot-reload
```

Then open the printed `http://localhost:5173` URL.

To serve a production build:

```bash
npm run build
npm run preview
```

### Running the test suite

```bash
npm test
```

Runs buoyancy, sailing, cloth, and FFT sanity checks.

---

## Project structure

```
src/
  main.js              bootstrap + render loop, post-processing, HDR/ACES
  ocean/               FFT + Gerstner wave fields, foam, reflections
  boat/                hull, physics, cloth sails, rigging, textures
  effects/             spray, runoff, spindrift, breakers, birds, marine life
  environment/         sky/atmosphere, clouds, planar reflection, thunderstorm
  wind/                wind field + direction
  audio/               procedural sound synthesis
  ui/                  control panel, HUD, helm, rig interaction
  physics/             Rapier world wrapper
scripts/               node test harnesses
```

---

## Tech

- [Three.js](https://threejs.org/) — WebGL rendering, post-processing
- [@dimforge/rapier3d-compat](https://rapier.rs/) — rigid-body physics (WASM)
- [Vite](https://vitejs.dev/) — dev server & bundler
- [lil-gui](https://lil-gui.georgealways.com/) — debug/control panel
