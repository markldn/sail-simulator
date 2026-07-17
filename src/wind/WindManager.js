/**
 * WindManager.js — the global true-wind state.
 *
 * Conventions (nautical/meteorological — worth being pedantic about now,
 * because every aerodynamic formula in Phase 3 builds on them):
 *
 * - TWD (True Wind Direction) is the compass bearing the wind blows FROM.
 *   TWD 0° = a northerly (blowing from N towards S). This matches how
 *   sailors, forecasts and instruments report wind.
 * - Compass → world mapping (three.js right-handed, Y up):
 *       North = −Z,  East = +X,  South = +Z,  West = −X
 * - getWindVector() returns the AIR VELOCITY vector — i.e. pointing in the
 *   direction the air is MOVING (TWD + 180°), in m/s. That is the vector
 *   you subtract boat velocity from to get apparent wind in Phase 3:
 *       apparentWind = trueWindVelocity − boatVelocity
 */

import * as THREE from 'three';

export const KNOTS_TO_MS = 0.514444;
export const MS_TO_KNOTS = 1 / KNOTS_TO_MS;

export class WindManager {
  constructor({ speedKnots = 12, directionDeg = 315 } = {}) {
    this.speedKnots = speedKnots;
    this.directionDeg = directionDeg; // FROM-direction, compass degrees
    this._listeners = new Set();
    this._vector = new THREE.Vector3();
  }

  get speedMs() {
    return this.speedKnots * KNOTS_TO_MS;
  }

  setSpeedKnots(v) {
    this.speedKnots = v;
    this._emit();
  }

  setDirectionDeg(v) {
    // normalize into [0, 360)
    this.directionDeg = ((v % 360) + 360) % 360;
    this._emit();
  }

  /**
   * Air velocity in world space (m/s). Reused vector — copy if you keep it.
   * A wind FROM bearing θ moves TOWARDS bearing θ+180:
   *   world x = sin(toRad) * speed, world z = -cos(toRad) * speed
   */
  getWindVector() {
    const toRad = THREE.MathUtils.degToRad(this.directionDeg + 180);
    return this._vector.set(
      Math.sin(toRad) * this.speedMs,
      0,
      -Math.cos(toRad) * this.speedMs
    );
  }

  /** Subscribe to wind changes (HUD, and later the sail physics). */
  onChange(fn) {
    this._listeners.add(fn);
    fn(this); // fire immediately so subscribers initialise
    return () => this._listeners.delete(fn);
  }

  _emit() {
    for (const fn of this._listeners) fn(this);
  }
}
