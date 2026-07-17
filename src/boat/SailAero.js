/**
 * SailAero.js — aerodynamic coefficient curves for soft sails.
 *
 * A sail is modelled as a cambered foil with angle of attack α = the angle
 * between the apparent-wind flow and the boom/chord line:
 *
 *   α ≈ |AWA| − β        (β = boom angle from centreline, limited by sheet)
 *
 * The three regimes every sailor knows fall straight out of the CL curve:
 *   α < ~2°   luffing  — flow attached to neither side, no force, flogging
 *   α ≈ 26°   powered  — peak lift; what auto-trim aims for
 *   α > ~30°  stalling — lift collapses, drag balloons: the "sheeted in too
 *             tight" failure the simulator must reproduce (lots of heel, no
 *             drive). Running dead downwind is the deep-stall limit where
 *             the sail is pure drag — which is exactly correct physically.
 *
 * Curves are piecewise fits to published soft-sail wind-tunnel polars
 * (Marchaj-style): CL peaks ≈ 1.5 near α = 25–30°, CD ≈ 0.1 attached
 * rising to ≈ 1.2 as a flat plate at α = 90°.
 */

export const RHO_AIR = 1.225; // kg/m³ at sea level
export const ALPHA_OPT_DEG = 26; // angle of attack auto-trim targets
export const SHEET_MIN_DEG = 8; // boom can never be sheeted dead-centre
export const SHEET_MAX_DEG = 88; // …or eased past the shrouds

/** Lift coefficient vs angle of attack (degrees). */
export function sailCL(alphaDeg) {
  const a = Math.abs(alphaDeg);
  if (a <= 2) return 0; // luffing
  if (a <= 27) {
    // attached flow: smooth rise to CLmax = 1.5
    return 1.5 * Math.sin(((a - 2) / 25) * (Math.PI / 2));
  }
  // post-stall decay, floored — even a stalled sail keeps some lift
  return Math.max(1.5 - (a - 27) * 0.016, 0.45);
}

/** Drag coefficient vs angle of attack (degrees). */
export function sailCD(alphaDeg) {
  const a = Math.min(Math.abs(alphaDeg), 90);
  const s = Math.sin((a * Math.PI) / 180);
  return 0.08 + 1.15 * s * s; // parasitic + induced/separated
}
