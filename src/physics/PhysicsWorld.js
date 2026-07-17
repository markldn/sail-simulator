/**
 * PhysicsWorld.js — Rapier (WASM) initialisation and fixed-step driver.
 *
 * Phase 1 only creates the world and steps it (empty) with a proper
 * fixed-timestep accumulator, so the simulation loop architecture is
 * already correct when the boat rigid body arrives in Phase 2.
 *
 * Why fixed timestep: buoyancy/hydrodynamic forces are stiff — integrating
 * them with a variable dt (raw requestAnimationFrame delta) makes the boat's
 * behaviour depend on framerate and can explode on frame hitches. We step
 * physics at a constant 60 Hz and let rendering interpolate later if needed.
 */

import RAPIER from '@dimforge/rapier3d-compat';

export const FIXED_DT = 1 / 60; // physics step, seconds
const MAX_SUBSTEPS = 5; // cap catch-up work after a long frame hitch

export class PhysicsWorld {
  /** Use PhysicsWorld.create() — Rapier's WASM must be awaited. */
  constructor(world) {
    this.world = world;
    this.world.timestep = FIXED_DT;
    this._accumulator = 0;
    /**
     * Callbacks run before every physics substep, receiving (world, dt).
     * Phase 2 registers buoyancy force application here so forces are
     * applied per-substep (correct), not per-render-frame (wrong).
     */
    this.preStepHooks = [];
  }

  static async create() {
    await RAPIER.init(); // compiles/instantiates the embedded WASM blob
    const world = new RAPIER.World({ x: 0.0, y: -9.81, z: 0.0 });
    return new PhysicsWorld(world);
  }

  /** Rapier module, for constructing bodies/colliders in later phases. */
  get RAPIER() {
    return RAPIER;
  }

  /**
   * Advance the simulation by real elapsed time `frameDt`, in fixed
   * substeps. Returns the number of substeps taken (0 is normal on very
   * fast frames).
   */
  step(frameDt) {
    // Clamp pathological deltas (tab was backgrounded, debugger pause…)
    this._accumulator += Math.min(frameDt, 0.25);
    let substeps = 0;
    while (this._accumulator >= FIXED_DT && substeps < MAX_SUBSTEPS) {
      for (const hook of this.preStepHooks) hook(this.world, FIXED_DT);
      this.world.step();
      this._accumulator -= FIXED_DT;
      substeps++;
    }
    // If we hit MAX_SUBSTEPS the sim runs slightly slower than real time
    // for a frame — preferable to a death-spiral of ever-longer frames.
    if (substeps === MAX_SUBSTEPS) this._accumulator = 0;
    return substeps;
  }
}
