/**
 * BoatModel.js — procedural three.js mesh of the sloop described in
 * HullSpec.js. No external assets: the hull surface is lofted directly
 * from the same section curves the physics samples, so what floats is
 * what you see.
 *
 * Materials are PBR (MeshStandardMaterial) lit by the SkySystem's PMREM
 * environment. Colors are plausible flat values for now; swapping in real
 * texture sets (teak grain, carbon weave, gelcoat clearcoat) is a
 * graphics-polish task — the material slots are already separated so that
 * will be a drop-in change.
 */

import * as THREE from 'three';
import {
  HULL,
  halfBreadth,
  canoeDepth,
  stationX,
  sectionY,
  sectionZ,
} from './HullSpec.js';

const STATIONS = 28; // longitudinal resolution of the loft
const SECTIONS = 24; // points per section, port sheer → keel → stbd sheer

// --- materials --------------------------------------------------------------
const MATERIALS = {
  topsides: new THREE.MeshStandardMaterial({
    color: 0xe6eaea, // white gelcoat (kept a touch under pure white so the
    roughness: 0.22, //  sunlit side doesn't clip straight to bloom)
    metalness: 0.0,
  }),
  antifoul: new THREE.MeshStandardMaterial({
    color: 0x6e2323, // underwater antifouling paint
    roughness: 0.55,
    metalness: 0.0,
  }),
  deck: new THREE.MeshStandardMaterial({
    color: 0xd9c49a, // teak-ish
    roughness: 0.78,
    metalness: 0.0,
  }),
  cabin: new THREE.MeshStandardMaterial({
    color: 0xe8eaea,
    roughness: 0.4,
    metalness: 0.0,
  }),
  spar: new THREE.MeshStandardMaterial({
    color: 0xcfd4d8, // anodised aluminium
    roughness: 0.35,
    metalness: 0.85,
  }),
};

/**
 * Loft the hull shell (+ transom cap) as one indexed BufferGeometry.
 * Grid: STATIONS × SECTIONS, u swept via sin(φ) so vertices crowd near the
 * bilge turn where curvature is highest.
 */
function buildHullGeometry() {
  const positions = [];
  const indices = [];

  const vid = (i, j) => i * SECTIONS + j;

  for (let i = 0; i < STATIONS; i++) {
    const t = i / (STATIONS - 1);
    const x = stationX(t);
    for (let j = 0; j < SECTIONS; j++) {
      const phi = -Math.PI / 2 + (Math.PI * j) / (SECTIONS - 1);
      const u = Math.sin(phi);
      positions.push(x, sectionY(t, u), sectionZ(t, u));
    }
  }

  // Shell quads. Winding chosen so normals point OUTWARD (verified by hand:
  // at the keel line, (Δstation × Δsection) = x̂ × ẑ = -ŷ, i.e. downward).
  for (let i = 0; i < STATIONS - 1; i++) {
    for (let j = 0; j < SECTIONS - 1; j++) {
      const a = vid(i, j);
      const b = vid(i + 1, j);
      const c = vid(i + 1, j + 1);
      const d = vid(i, j + 1);
      indices.push(a, b, c, a, c, d);
    }
  }

  // Transom cap (station t=0): triangle fan from the section centroid,
  // ordered so it faces aft (-X).
  const centroidIndex = positions.length / 3;
  let cy = 0;
  for (let j = 0; j < SECTIONS; j++) cy += positions[vid(0, j) * 3 + 1];
  positions.push(stationX(0), cy / SECTIONS, 0);
  for (let j = 0; j < SECTIONS - 1; j++) {
    indices.push(centroidIndex, vid(0, j), vid(0, j + 1));
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/** Flat deck ribbon spanning sheer to sheer along the whole hull. */
function buildDeckGeometry() {
  const positions = [];
  const indices = [];
  for (let i = 0; i < STATIONS; i++) {
    const t = i / (STATIONS - 1);
    const x = stationX(t);
    const hb = halfBreadth(t);
    positions.push(x, HULL.sheer, -hb); // port
    positions.push(x, HULL.sheer, +hb); // starboard
  }
  for (let i = 0; i < STATIONS - 1; i++) {
    const p0 = i * 2;
    const s0 = i * 2 + 1;
    const p1 = (i + 1) * 2;
    const s1 = (i + 1) * 2 + 1;
    indices.push(p0, s0, s1, p0, s1, p1); // ẑ × x̂ = +ŷ → faces up
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Assemble the full boat as a Group whose origin/axes ARE the physics body
 * frame (+X bow, +Y up, y=0 at design waterline) — Boat.js copies the rigid
 * body transform straight onto this group.
 */
export function createBoatModel() {
  const boat = new THREE.Group();
  boat.name = 'boat';

  // Single white shell; the dark antifoul + boot-top stripe below the
  // waterline needs either clipping planes or textures — polish phase.
  const hull = new THREE.Mesh(buildHullGeometry(), MATERIALS.topsides);
  boat.add(hull);

  const deck = new THREE.Mesh(buildDeckGeometry(), MATERIALS.deck);
  boat.add(deck);

  // Cabin trunk — a low box with rounded look left for the polish phase.
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.5, 1.5), MATERIALS.cabin);
  cabin.position.set(-0.5, HULL.sheer + 0.25, 0);
  boat.add(cabin);

  // Fin keel + ballast bulb (dark antifoul).
  const keelFin = new THREE.Mesh(
    new THREE.BoxGeometry(1.4, HULL.keelDepth + 0.15, 0.11),
    MATERIALS.antifoul
  );
  keelFin.position.set(HULL.keelX, -(canoeDepth(0.5) + HULL.keelDepth / 2), 0);
  boat.add(keelFin);

  const bulb = new THREE.Mesh(
    new THREE.CylinderGeometry(0.14, 0.14, 1.1, 16),
    MATERIALS.antifoul
  );
  bulb.rotation.z = Math.PI / 2; // lie along X
  bulb.position.set(HULL.keelX, -(canoeDepth(0.5) + HULL.keelDepth), 0);
  boat.add(bulb);

  // Rudder blade.
  const rudder = new THREE.Mesh(new THREE.BoxGeometry(0.24, 1.0, 0.05), MATERIALS.antifoul);
  rudder.position.set(HULL.rudderX, -0.55, 0);
  rudder.name = 'rudder'; // Phase 3 rotates this with helm input
  boat.add(rudder);

  // Mast. (The boom lives in Sails.js — it swings with the mainsail.)
  const mast = new THREE.Mesh(
    new THREE.CylinderGeometry(0.055, 0.075, HULL.mastHeight, 12),
    MATERIALS.spar
  );
  mast.position.set(HULL.mastX, HULL.sheer + HULL.mastHeight / 2, 0);
  mast.name = 'mast';
  boat.add(mast);

  // Self-shadowing (boom on deck, hull shading) is most of what makes the
  // boat read as solid instead of washed-out under the bright sky.
  boat.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });

  return boat;
}
