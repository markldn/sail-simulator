/**
 * BoatModel.js — detailed procedural sloop, lofted from HullSpec.js.
 *
 * Still zero external assets: the hull is lofted from the same section
 * curves the physics samples, and all surface detail (teak, sailcloth,
 * paint stripes) is generated in textures.js. Detail inventory:
 *
 *   hull     clearcoat gelcoat (MeshPhysical), antifoul + boot-top + cove
 *            stripe via a height-keyed gradient texture
 *   deck     laid teak with caulking, toe rails along both sheers
 *   cabin    trunk with smoked side windows and companionway
 *   cockpit  two sheet winches, traveler bar, tiller on the rudder head
 *            (the tiller steers — Boat.js rotates the 'rudder' group, and
 *            the geometry is rigged so tiller-to-port = bow-to-starboard,
 *            like a real tiller)
 *   rig      mast with spreaders, forestay, backstay, cap shrouds led over
 *            the spreader tips, stanchions + lifelines both sides
 *   windex   masthead apparent-wind arrow (Boat.js aims it every frame)
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
import { makeTeakTexture, makeHullTexture } from './textures.js';

const STATIONS = 36; // longitudinal loft resolution
const SECTIONS = 28; // points per section

// --- materials --------------------------------------------------------------
function buildMaterials() {
  return {
    topsides: new THREE.MeshPhysicalMaterial({
      map: makeHullTexture(),
      roughness: 0.32,
      metalness: 0.0,
      clearcoat: 1.0, // gelcoat: hard glossy film over the pigment
      clearcoatRoughness: 0.12,
    }),
    antifoul: new THREE.MeshStandardMaterial({
      color: 0x5e2020,
      roughness: 0.6,
      metalness: 0.0,
    }),
    deck: new THREE.MeshStandardMaterial({
      map: makeTeakTexture(),
      roughness: 0.8,
      metalness: 0.0,
    }),
    cabin: new THREE.MeshPhysicalMaterial({
      color: 0xe9ecec,
      roughness: 0.35,
      clearcoat: 0.6,
      clearcoatRoughness: 0.2,
    }),
    window: new THREE.MeshPhysicalMaterial({
      color: 0x10181f, // smoked acrylic
      roughness: 0.08,
      metalness: 0.0,
      clearcoat: 1.0,
      clearcoatRoughness: 0.05,
    }),
    spar: new THREE.MeshStandardMaterial({
      color: 0xcfd4d8,
      roughness: 0.35,
      metalness: 0.85,
    }),
    rigging: new THREE.MeshStandardMaterial({
      color: 0x51565c, // 1×19 stainless wire
      roughness: 0.35,
      metalness: 0.9,
    }),
    teakTrim: new THREE.MeshStandardMaterial({
      color: 0x8a6a3c,
      roughness: 0.75,
      metalness: 0.0,
    }),
  };
}

/** Loft the hull shell + transom, with UVs keyed for the paint gradient. */
function buildHullGeometry() {
  const positions = [];
  const uvs = [];
  const indices = [];
  const span = HULL.sheer + HULL.bottom;
  const vid = (i, j) => i * SECTIONS + j;

  for (let i = 0; i < STATIONS; i++) {
    const t = i / (STATIONS - 1);
    const x = stationX(t);
    for (let j = 0; j < SECTIONS; j++) {
      const phi = -Math.PI / 2 + (Math.PI * j) / (SECTIONS - 1);
      const u = Math.sin(phi);
      const y = sectionY(t, u);
      positions.push(x, y, sectionZ(t, u));
      // u: along the hull (texture streaks repeat); v: height for stripes
      uvs.push(t * 5, (y + HULL.bottom) / span);
    }
  }
  for (let i = 0; i < STATIONS - 1; i++) {
    for (let j = 0; j < SECTIONS - 1; j++) {
      const a = vid(i, j);
      const b = vid(i + 1, j);
      const c = vid(i + 1, j + 1);
      const d = vid(i, j + 1);
      indices.push(a, b, c, a, c, d); // outward winding (checked Phase 2)
    }
  }
  // transom cap, facing aft
  const centroidIndex = positions.length / 3;
  let cy = 0;
  for (let j = 0; j < SECTIONS; j++) cy += positions[vid(0, j) * 3 + 1];
  positions.push(stationX(0), cy / SECTIONS, 0);
  uvs.push(0, (cy / SECTIONS + HULL.bottom) / span);
  for (let j = 0; j < SECTIONS - 1; j++) {
    indices.push(centroidIndex, vid(0, j), vid(0, j + 1));
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/** Teak deck ribbon, planks running fore-and-aft. */
function buildDeckGeometry() {
  const positions = [];
  const uvs = [];
  const indices = [];
  for (let i = 0; i < STATIONS; i++) {
    const t = i / (STATIONS - 1);
    const x = stationX(t);
    const hb = halfBreadth(t);
    positions.push(x, HULL.sheer, -hb, x, HULL.sheer, hb);
    uvs.push(0, t * 4, 1, t * 4); // planks run along the length
  }
  for (let i = 0; i < STATIONS - 1; i++) {
    const p0 = i * 2;
    const s0 = i * 2 + 1;
    indices.push(p0, s0, s0 + 2, p0, s0 + 2, p0 + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/** Cylinder strut from a to b — rigging wire, lifelines, rails. */
function addLine(parent, a, b, radius, material) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, len, 6), material);
  mesh.position.copy(a).addScaledVector(dir, 0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  parent.add(mesh);
  return mesh;
}

/** Smooth tube along deck-edge points — toe rails and lifelines. */
function addRailTube(parent, points, radius, material) {
  const curve = new THREE.CatmullRomCurve3(points);
  const mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, 48, radius, 6), material);
  parent.add(mesh);
  return mesh;
}

export function createBoatModel() {
  const boat = new THREE.Group();
  boat.name = 'boat';
  const M = buildMaterials();

  boat.add(new THREE.Mesh(buildHullGeometry(), M.topsides));
  boat.add(new THREE.Mesh(buildDeckGeometry(), M.deck));

  // --- toe rails, stanchions, lifelines along both sheers -------------------
  for (const side of [-1, 1]) {
    const railPts = [];
    const linePts = [];
    for (let k = 0; k <= 12; k++) {
      const t = 0.03 + (k / 12) * 0.94;
      const z = side * (halfBreadth(t) - 0.03);
      railPts.push(new THREE.Vector3(stationX(t), HULL.sheer + 0.03, z));
    }
    addRailTube(boat, railPts, 0.028, M.teakTrim);
    for (const t of [0.14, 0.32, 0.5, 0.68, 0.86]) {
      const z = side * (halfBreadth(t) - 0.07);
      const base = new THREE.Vector3(stationX(t), HULL.sheer + 0.02, z);
      const top = base.clone().setY(HULL.sheer + 0.58);
      addLine(boat, base, top, 0.013, M.rigging); // stanchion
      linePts.push(top);
    }
    // lifeline runs bow fitting → stanchion tops → stern fitting
    linePts.unshift(new THREE.Vector3(stationX(0.985), HULL.sheer + 0.45, side * 0.06));
    linePts.push(new THREE.Vector3(stationX(0.02), HULL.sheer + 0.5, side * (halfBreadth(0.02) - 0.07)));
    addRailTube(boat, linePts, 0.007, M.rigging);
  }

  // --- cabin trunk with windows and companionway ---------------------------
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.48, 1.46), M.cabin);
  cabin.position.set(-0.4, HULL.sheer + 0.24, 0);
  boat.add(cabin);
  for (const side of [-1, 1]) {
    const win = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.17, 0.02), M.window);
    win.position.set(-0.35, HULL.sheer + 0.3, side * 0.74);
    boat.add(win);
  }
  const hatch = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.34, 0.52), M.window);
  hatch.position.set(-1.62, HULL.sheer + 0.26, 0);
  boat.add(hatch);

  // --- cockpit hardware -----------------------------------------------------
  for (const side of [-1, 1]) {
    const winch = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.09, 0.12, 12), M.spar);
    winch.position.set(-1.95, HULL.sheer + 0.08, side * 0.72);
    boat.add(winch);
  }
  const traveler = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.04, 1.1), M.spar);
  traveler.position.set(-2.9, HULL.sheer + 0.04, 0);
  boat.add(traveler);

  // --- keel, bulb, rudder + tiller -----------------------------------------
  const keelFin = new THREE.Mesh(
    new THREE.BoxGeometry(1.4, HULL.keelDepth + 0.15, 0.11),
    M.antifoul
  );
  keelFin.position.set(HULL.keelX, -(canoeDepth(0.5) + HULL.keelDepth / 2), 0);
  boat.add(keelFin);
  const bulb = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 1.1, 16), M.antifoul);
  bulb.rotation.z = Math.PI / 2;
  bulb.position.set(HULL.keelX, -(canoeDepth(0.5) + HULL.keelDepth), 0);
  boat.add(bulb);

  // Rudder GROUP pivots at the stock; Boat.js sets rotation.y = +rudderDeg.
  // Blade aft of the stock, tiller forward — so tiller-to-port swings the
  // blade's trailing edge to starboard and the bow turns to starboard.
  const rudderGroup = new THREE.Group();
  rudderGroup.name = 'rudder';
  rudderGroup.position.set(HULL.rudderX, 0, 0);
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.24, 1.0, 0.05), M.antifoul);
  blade.position.set(-0.06, -0.55, 0);
  rudderGroup.add(blade);
  const tiller = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.035, 0.05), M.teakTrim);
  tiller.position.set(0.62, HULL.sheer + 0.12, 0);
  tiller.rotation.z = 0.12; // slight rise towards the grip
  rudderGroup.add(tiller);
  boat.add(rudderGroup);

  // --- mast, spreaders, standing rigging ------------------------------------
  const mast = new THREE.Mesh(
    new THREE.CylinderGeometry(0.055, 0.075, HULL.mastHeight, 12),
    M.spar
  );
  mast.position.set(HULL.mastX, HULL.sheer + HULL.mastHeight / 2, 0);
  mast.name = 'mast';
  boat.add(mast);

  const mastheadY = HULL.sheer + HULL.mastHeight;
  const spreaderY = HULL.sheer + HULL.mastHeight * 0.55;
  const spreaderTip = 0.62;
  for (const side of [-1, 1]) {
    // spreader bar
    addLine(
      boat,
      new THREE.Vector3(HULL.mastX, spreaderY, 0),
      new THREE.Vector3(HULL.mastX, spreaderY - 0.03, side * spreaderTip),
      0.02,
      M.spar
    );
    // cap shroud: chainplate → over spreader tip → masthead
    const chainplate = new THREE.Vector3(
      HULL.mastX - 0.05,
      HULL.sheer + 0.02,
      side * (halfBreadth(0.6) - 0.05)
    );
    const tip = new THREE.Vector3(HULL.mastX, spreaderY - 0.03, side * spreaderTip);
    addLine(boat, chainplate, tip, 0.008, M.rigging);
    addLine(boat, tip, new THREE.Vector3(HULL.mastX, mastheadY, 0), 0.008, M.rigging);
  }
  // forestay (the jib hoists on this) and backstay
  addLine(
    boat,
    new THREE.Vector3(HULL.length / 2 - 0.1, HULL.sheer + 0.12, 0),
    new THREE.Vector3(HULL.mastX, mastheadY, 0),
    0.008,
    M.rigging
  );
  addLine(
    boat,
    new THREE.Vector3(-HULL.length / 2 + 0.06, HULL.sheer + 0.1, 0),
    new THREE.Vector3(HULL.mastX, mastheadY, 0),
    0.008,
    M.rigging
  );

  // --- masthead windex (Boat.js points it into the apparent wind) ----------
  const windex = new THREE.Group();
  windex.name = 'windex';
  windex.position.set(HULL.mastX, mastheadY + 0.18, 0);
  const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.28, 8), M.rigging);
  arrow.rotation.z = -Math.PI / 2; // point along +X (rotated to AWA later)
  arrow.position.x = 0.1;
  windex.add(arrow);
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.09, 0.008), M.rigging);
  fin.position.x = -0.12;
  windex.add(fin);
  boat.add(windex);

  // Self-shadowing sells all of this detail; thin rigging both casts and
  // receives so the shroud shadows rake across the deck.
  boat.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });

  return boat;
}
