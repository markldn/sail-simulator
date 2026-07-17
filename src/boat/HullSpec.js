/**
 * HullSpec.js — the parametric definition of the hull, shared by:
 *   - BoatModel.js   → generates the visible mesh from these functions
 *   - BoatPhysics.js → generates buoyancy sample points from the SAME
 *                      functions, so the physics floats exactly the hull
 *                      the player sees (same trick as GerstnerWaves.js:
 *                      one source of truth, two consumers).
 *
 * Coordinate conventions (BODY frame, used everywhere boat-local):
 *   +X = forward (bow)      +Y = up      +Z = starboard
 *   y = 0 is the design waterline (DWL). The physics body origin sits here.
 *
 * The hull is described by classic naval-architecture curves:
 *   t ∈ [0, 1]  : station position along the hull (0 = transom, 1 = stem)
 *   u ∈ [-1, 1] : transverse position as a fraction of local half-breadth
 *                 (-1 = port sheer, 0 = centreline, +1 = starboard sheer)
 */

export const HULL = {
  length: 7.4, // LOA, metres
  beam: 2.48, // max beam
  sheer: 0.62, // deck edge above DWL (freeboard, roughly constant)
  bottom: 0.52, // max canoe-body depth below DWL (excl. keel fin)

  // Rig / appendages (visual + later aero). Positions in body frame.
  mastX: 0.75, // mast station, forward of midships
  mastHeight: 9.3, // above deck
  boomLength: 3.2,
  keelX: -0.05, // fin keel centre
  keelDepth: 1.15, // fin span below canoe body
  rudderX: -3.45,

  // Target displacement. A ~24 ft cruiser displaces roughly 2.5 t; split
  // between hull structure and keel ballast to put the centre of mass well
  // below the waterline (the righting moment in a knockdown).
  hullMass: 1600, // kg — hull, deck, rig
  ballastMass: 900, // kg — keel fin + bulb
};

/**
 * Half-breadth (half-width) of the deck at station t.
 * sin-power curve: pointed stem (t=1), moderately wide transom (t=0),
 * max beam ~40% forward of the transom.
 */
export function halfBreadth(t) {
  return (HULL.beam / 2) * Math.pow(Math.sin(Math.PI * (0.18 + 0.82 * t)), 0.9);
}

/**
 * Canoe-body depth below DWL at station t ("rocker" profile).
 * Shallow at the transom, deepest just aft of midships, zero at the stem.
 */
export function canoeDepth(t) {
  return HULL.bottom * Math.pow(Math.sin(Math.PI * (0.08 + 0.92 * t)), 0.7);
}

/** Longitudinal body-frame x of station t. */
export function stationX(t) {
  return (t - 0.5) * HULL.length;
}

/**
 * Vertical position of the hull SURFACE at (station t, transverse fraction u).
 * Section shape is a power ellipse: (1-u²)^0.4 gives full, round-bilged
 * midship sections that flatten towards a fine bow.
 * u = ±1 → deck edge (sheer); u = 0 → keel line (-canoeDepth).
 */
export function sectionY(t, u) {
  const d = canoeDepth(t);
  return HULL.sheer - (HULL.sheer + d) * Math.pow(Math.max(1 - u * u, 0), 0.4);
}

/** Transverse body-frame z of (t, u). */
export function sectionZ(t, u) {
  return halfBreadth(t) * u;
}
