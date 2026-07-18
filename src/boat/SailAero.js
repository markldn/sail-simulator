/**
 * SailAero.js — aerodynamic coefficient curves for soft sails.
 *
 * A sail is modelled as a cambered foil with angle of attack α = the angle
 * between the apparent-wind flow and the boom/chord line:
 *
 *   α ≈ |AWA| − β        (β = boom angle from centreline, limited by sheet)
 *
 * A sail is a highly cambered foil (~8-12% draft), so unlike a flat plate it
 * generates substantial lift at zero chord incidence (CL0 ≈ 0.85) and only
 * luffs once the flow attacks the LEE side — α ≈ −4° or lower — not at α = 0.
 * The three regimes every sailor knows fall straight out of the CL curve:
 *   α < −4°   luffing  — flow attacks the lee side, no force, flogging
 *   α ≈ 22°   powered  — peak lift; what auto-trim aims for on a reach
 *   α > ~26°  stalling — lift collapses, drag balloons: the "sheeted in too
 *             tight" failure the simulator must reproduce (lots of heel, no
 *             drive). Running dead downwind is the deep-stall limit where
 *             the sail is pure drag — which is exactly correct physically.
 *
 * Curves are piecewise fits to published soft-sail wind-tunnel polars
 * (Marchaj-style): CL peaks ≈ 1.55 near α = 22°, CD ≈ 0.1 attached
 * rising to ≈ 1.2 as a flat plate at α = 90°.
 */

export const RHO_AIR = 1.225; // kg/m³ at sea level
export const SHEET_MIN_DEG = 8; // boom can never be sheeted dead-centre
export const SHEET_MAX_DEG = 88; // …or eased past the shrouds

/** Lift coefficient vs angle of attack (degrees). Sign matters: negative α
 *  means the apparent wind has swung onto the lee side of the chord. */
export function sailCL(alphaDeg) {
  if (alphaDeg < -4) return 0; // flow on the lee side: luffing
  const a = Math.abs(alphaDeg);
  if (a <= 22) {
    // attached, cambered: CL0 ≈ 0.85 at zero incidence, rising to
    // CLmax ≈ 1.55 near 22° — real sails pull hard well before a flat
    // plate's zero-lift angle.
    return 0.85 + 0.70 * Math.sin(((alphaDeg + 4) / 26) * (Math.PI / 2));
  }
  // post-stall decay, floored — even a stalled sail keeps some lift
  return Math.max(1.55 - (a - 22) * 0.016, 0.45);
}

/** Drag coefficient vs angle of attack (degrees). */
export function sailCD(alphaDeg) {
  const a = Math.min(Math.abs(alphaDeg), 90);
  const s = Math.sin((a * Math.PI) / 180);
  return 0.08 + 1.15 * s * s; // parasitic + induced/separated
}
