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
    // BASE wind — what the GUI sliders set, and what the sea state follows
    // (waves respond to the mean wind, not to individual gusts).
    this.speedKnots = speedKnots;
    this.directionDeg = directionDeg; // FROM-direction, compass degrees

    // ACTUAL wind — base plus gust/shift turbulence, updated by update(t).
    // Physics and instruments read this; with gusts off (or in headless
    // tests, which never call update) actual === base.
    this.speedKnotsActual = speedKnots;
    this.directionDegActual = directionDeg;
    this.gustsEnabled = true;
    this.gustiness = 0.22; // gust amplitude as a fraction of base speed
    this.shiftRange = 8; // direction oscillation, ± degrees

    this._listeners = new Set();
    this._vector = new THREE.Vector3();
  }

  get speedMs() {
    return this.speedKnotsActual * KNOTS_TO_MS;
  }

  /**
   * Advance the turbulence model. Gusts and shifts are sums of
   * incommensurate sines — smooth, never repeating on human timescales,
   * and fully deterministic (same run, same weather). Periods: gust cells
   * ~30 s with ~8 s sub-structure; direction swings over ~1–4 min, the way
   * a real breeze "clocks" back and forth.
   */
  update(t) {
    if (!this.gustsEnabled) {
      this.speedKnotsActual = this.speedKnots;
      this.directionDegActual = this.directionDeg;
      return;
    }
    const gust =
      0.55 * Math.sin(0.21 * t + 1.7) +
      0.30 * Math.sin(0.767 * t + 0.3) +
      0.15 * Math.sin(1.93 * t + 4.2);
    const shift =
      0.6 * Math.sin(0.026 * t + 2.9) +
      0.4 * Math.sin(0.081 * t + 0.8);
    this.speedKnotsActual = Math.max(0, this.speedKnots * (1 + this.gustiness * gust));
    this.directionDegActual =
      (this.directionDeg + this.shiftRange * shift + 360) % 360;
  }

  setSpeedKnots(v) {
    this.speedKnots = v;
    this.speedKnotsActual = v; // update(t) re-applies turbulence next frame
    this._emit();
  }

  setDirectionDeg(v) {
    // normalize into [0, 360)
    this.directionDeg = ((v % 360) + 360) % 360;
    this.directionDegActual = this.directionDeg;
    this._emit();
  }

  /**
   * ACTUAL air velocity in world space (m/s), gusts included. Reused
   * vector — copy if you keep it. A wind FROM bearing θ moves TOWARDS
   * bearing θ+180: world x = sin(toRad)·speed, world z = −cos(toRad)·speed
   */
  getWindVector() {
    const toRad = THREE.MathUtils.degToRad(this.directionDegActual + 180);
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
