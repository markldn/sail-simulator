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
  // Close the mouth of the ∪-section: the fan wraps port sheer → bottom →
  // starboard sheer, but the straight run back across the top deck edge is
  // left open (a see-through V-notch in the transom). This final triangle
  // caps it, so the stern reads as solid planking instead of a hole.
  indices.push(centroidIndex, vid(0, SECTIONS - 1), vid(0, 0));

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
  // UV in WORLD units, not normalized fraction: a normalized "u across the
  // beam" maps a straight plank seam onto the tapering deck, so the seam kinks
  // at every station (a zigzag). Keying u to world-z instead makes each seam a
  // constant-z line — straight, parallel planks laid fore-and-aft as on a real
  // teak deck. (~56 mm planks; v scaled so the grain runs the right way.)
  const uScale = 1.4; // texture repeats per metre across the beam
  const vScale = 0.4; // grain repeats per metre along the length
  for (let i = 0; i < STATIONS; i++) {
    const t = i / (STATIONS - 1);
    const x = stationX(t);
    const hb = halfBreadth(t);
    positions.push(x, HULL.sheer, -hb, x, HULL.sheer, hb);
    uvs.push(-hb * uScale, x * vScale, hb * uScale, x * vScale);
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

/**
 * Rounded-corner, bevel-topped slab — the cabin trunk. A sharp BoxGeometry
 * trunk reads as a shipping container; real coachroofs have radiused corners
 * and a cambered top edge. Footprint w (fore-aft) × d (beam), height h,
 * corner radius r; the extrude bevel rounds the top rim.
 */
function roundedSlab(w, d, h, r) {
  const hw = w / 2 - r;
  const hd = d / 2 - r;
  const shape = new THREE.Shape();
  shape.absarc(hw, hd, r, 0, Math.PI / 2);
  shape.absarc(-hw, hd, r, Math.PI / 2, Math.PI);
  shape.absarc(-hw, -hd, r, Math.PI, Math.PI * 1.5);
  shape.absarc(hw, -hd, r, Math.PI * 1.5, Math.PI * 2);
  const bevel = Math.min(0.09, h * 0.4);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: h - bevel,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel * 0.9,
    bevelSegments: 3,
    curveSegments: 10,
  });
  geo.rotateX(-Math.PI / 2); // extrude along +Y (up)
  return geo;
}

/**
 * Cabin wall ring: a single extruded outline that traces the rounded outer
 * footprint, walks IN through the companionway gap, and returns around the
 * inner face — hollow walls with a genuine doorway, no CSG needed.
 * w×d footprint, corner radius r, wall thickness t, doorway half-width
 * doorHalf (on the aft edge), wall height h.
 */
function cabinWallGeometry(w, d, r, t, doorHalf, h) {
  const hw = w / 2;
  const hd = d / 2;
  const iw = hw - t;
  const id = hd - t;
  const s = new THREE.Shape();
  s.moveTo(-hw, -doorHalf);
  s.lineTo(-hw, -(hd - r));
  s.quadraticCurveTo(-hw, -hd, -(hw - r), -hd);
  s.lineTo(hw - r, -hd);
  s.quadraticCurveTo(hw, -hd, hw, -(hd - r));
  s.lineTo(hw, hd - r);
  s.quadraticCurveTo(hw, hd, hw - r, hd);
  s.lineTo(-(hw - r), hd);
  s.quadraticCurveTo(-hw, hd, -hw, hd - r);
  s.lineTo(-hw, doorHalf);
  s.lineTo(-iw, doorHalf); // through the door jamb
  s.lineTo(-iw, id);
  s.lineTo(iw, id);
  s.lineTo(iw, -id);
  s.lineTo(-iw, -id);
  s.lineTo(-iw, -doorHalf);
  s.closePath();
  const geo = new THREE.ExtrudeGeometry(s, { depth: h, bevelEnabled: false, curveSegments: 8 });
  geo.rotateX(-Math.PI / 2);
  return geo;
}

/** Compass card: cream disc, 30° ticks, cardinal letters, north in red. */
function makeCompassCardTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#efe9da';
  g.beginPath();
  g.arc(64, 64, 63, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = '#2a2d31';
  g.lineWidth = 2;
  for (let d = 0; d < 360; d += 30) {
    const a = (d * Math.PI) / 180;
    g.beginPath();
    g.moveTo(64 + Math.sin(a) * 52, 64 - Math.cos(a) * 52);
    g.lineTo(64 + Math.sin(a) * 62, 64 - Math.cos(a) * 62);
    g.stroke();
  }
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = 'bold 26px sans-serif';
  const L = [['N', 0, '#c22020'], ['E', 90, '#2a2d31'], ['S', 180, '#2a2d31'], ['W', 270, '#2a2d31']];
  for (const [ch, d, col] of L) {
    const a = (d * Math.PI) / 180;
    g.fillStyle = col;
    g.fillText(ch, 64 + Math.sin(a) * 36, 64 - Math.cos(a) * 36);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  return tex;
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

  // --- cabin trunk: hollow walls + rounded roof + real doorway --------------
  // The trunk is a WALL RING (extruded outline that walks in through the
  // companionway gap and around the inner face) so the doorway is a genuine
  // opening into the cabin, not paint on a solid block. Rounded roof on top.
  const cabin = new THREE.Mesh(cabinWallGeometry(2.4, 1.46, 0.30, 0.10, 0.27, 0.40), M.cabin);
  cabin.position.set(-0.4, HULL.sheer - 0.02, 0);
  boat.add(cabin);
  const roof = new THREE.Mesh(roundedSlab(2.4, 1.46, 0.13, 0.30), M.cabin);
  roof.position.set(-0.4, HULL.sheer + 0.355, 0);
  boat.add(roof);

  // --- cabin interior --------------------------------------------------------
  // A furnished saloon under the trunk, enclosed in its own inward-facing
  // shell (the hull mesh is single-sided, so without the shell you'd see
  // ocean through the floor). Visible through the companionway; the warm
  // lamp is what sells it at dusk.
  {
    const interior = new THREE.Group();
    interior.name = 'cabinInterior';
    const wallMat = new THREE.MeshStandardMaterial({ color: 0xd9cdb8, roughness: 0.9, side: THREE.BackSide });
    const cushMat = new THREE.MeshStandardMaterial({ color: 0x37517a, roughness: 0.85 });
    // Tall enough to line the trunk from the inside (stops the sky showing
    // through the wall band above deck level) and long enough that its aft
    // face sits BEHIND the companionway plane — from inside, looking aft
    // through the open door, you see a plausible recess, not a sealed wall.
    const shell = new THREE.Mesh(new THREE.BoxGeometry(2.85, 1.76, 1.38), wallMat);
    shell.position.set(-0.32, HULL.sheer - 0.45, 0);
    interior.add(shell);
    const sole = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.03, 1.25), M.deck);
    sole.position.set(-0.35, HULL.sheer - 1.32, 0);
    interior.add(sole);
    for (const side of [-1, 1]) {
      const settee = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.30, 0.44), cushMat);
      settee.position.set(-0.25, HULL.sheer - 0.88, side * 0.42);
      interior.add(settee);
    }
    const tablePed = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.55, 8), M.spar);
    tablePed.position.set(-0.2, HULL.sheer - 1.02, 0);
    interior.add(tablePed);
    const tableTop = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.04, 0.46), M.teakTrim);
    tableTop.position.set(-0.2, HULL.sheer - 0.73, 0);
    interior.add(tableTop);
    // V-berth suggestion forward, companionway steps aft.
    const berth = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.24, 1.05), cushMat);
    berth.position.set(0.55, HULL.sheer - 0.95, 0);
    interior.add(berth);
    for (const [sy, sx] of [[-0.45, -1.42], [-0.85, -1.28]]) {
      const step = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.045, 0.5), M.teakTrim);
      step.position.set(sx, HULL.sheer + sy, 0);
      interior.add(step);
    }
    const lamp = new THREE.PointLight(0xffd9a8, 0.9, 6.5);
    lamp.position.set(-0.4, HULL.sheer + 0.2, 0);
    interior.add(lamp);
    boat.add(interior);
  }
  // The rounded trunk bulges to ~0.81 half-beam at mid-height (0.73 + bevel):
  // panes must sit PROUD of that or the curve swallows them whole.
  for (const side of [-1, 1]) {
    const win = new THREE.Mesh(new THREE.BoxGeometry(1.55, 0.16, 0.09), M.window);
    win.position.set(-0.35, HULL.sheer + 0.27, side * 0.795);
    boat.add(win);
  }
  // Front windows: two panes flanking the mast on the forward face, turned
  // slightly to follow the corner radius.
  for (const side of [-1, 1]) {
    const win = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.15, 0.44), M.window);
    win.position.set(0.845, HULL.sheer + 0.27, side * 0.30);
    win.rotation.y = side * 0.18;
    boat.add(win);
  }

  // --- companionway door on the aft face ------------------------------------
  // Teak-framed washboards with a smoked acrylic top light — the way into
  // the cabin. (The old flat hatch panel was swallowed by the rounded
  // trunk's aft bulge.)
  // Teak frame around the opening: two jambs + a header — NOT a solid slab
  // (a filled box here just re-blocks the doorway the wall ring opened up).
  for (const side of [-1, 1]) {
    const jamb = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.44, 0.05), M.teakTrim);
    jamb.position.set(-1.665, HULL.sheer + 0.20, side * 0.295);
    boat.add(jamb);
  }
  const header = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.05, 0.64), M.teakTrim);
  header.position.set(-1.665, HULL.sheer + 0.445, 0);
  boat.add(header);
  // Washboards + top light slide DOWN together when clicked (RigInteract
  // animates the 'doorBoards' group), opening the companionway to the saloon.
  const doorGroup = new THREE.Group();
  doorGroup.name = 'doorBoards';
  const doorBoards = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.30, 0.50), M.deck);
  doorBoards.position.set(-1.685, HULL.sheer + 0.17, 0);
  doorGroup.add(doorBoards);
  const doorLight = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.12, 0.50), M.window);
  doorLight.position.set(-1.685, HULL.sheer + 0.39, 0);
  doorGroup.add(doorLight);
  boat.add(doorGroup);
  // Sliding hatch garage on the cabin top over the companionway.
  const hatchSlide = new THREE.Mesh(roundedSlab(0.62, 0.62, 0.06, 0.08), M.cabin);
  hatchSlide.position.set(-1.28, HULL.sheer + 0.46, 0);
  boat.add(hatchSlide);

  // --- working bulkhead compass ---------------------------------------------
  // A gimballed card under a glass dome, offset to starboard of the door.
  // Boat.js cancels the hull's rotation on the 'compassCard' group every
  // frame, so the card stays level and north-aligned while the boat turns
  // and heels — read it against the fixed red lubber line, like the real
  // instrument. (Canvas card texture: N red, E/S/W + 30° ticks.)
  const compassZ = 0.52;
  const compassBase = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.09, 0.10, 12), M.spar);
  compassBase.position.set(-1.70, HULL.sheer + 0.36, compassZ);
  boat.add(compassBase);
  const card = new THREE.Group();
  card.name = 'compassCard';
  card.position.set(-1.70, HULL.sheer + 0.425, compassZ);
  const cardDisc = new THREE.Mesh(
    new THREE.CircleGeometry(0.055, 24).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: makeCompassCardTexture() })
  );
  card.add(cardDisc);
  boat.add(card);
  // Lubber line: fixed to the BOAT, points at the bow over the card's rim.
  const lubber = new THREE.Mesh(
    new THREE.BoxGeometry(0.03, 0.006, 0.006),
    new THREE.MeshBasicMaterial({ color: 0xd82020 })
  );
  lubber.position.set(-1.70 + 0.055, HULL.sheer + 0.432, compassZ);
  boat.add(lubber);
  const compassDome = new THREE.Mesh(
    new THREE.SphereGeometry(0.068, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshPhysicalMaterial({
      color: 0xdfeef4, transparent: true, opacity: 0.22,
      roughness: 0.05, clearcoat: 1.0,
    })
  );
  compassDome.position.set(-1.70, HULL.sheer + 0.42, compassZ);
  boat.add(compassDome);

  // --- pushpit (stern rail) and pulpit (bow rail) ---------------------------
  // Stainless tube frames closing the lifeline run at both ends — the stern
  // was bare before, so the cockpit read as open to the sea.
  {
    const railY = HULL.sheer + 0.60;
    const pushPts = [];
    for (const [t, side] of [[0.14, -1], [0.04, -1], [0.005, -0.55], [0.005, 0.55], [0.04, 1], [0.14, 1]]) {
      pushPts.push(new THREE.Vector3(stationX(t), railY, side * Math.max(halfBreadth(t) - 0.07, 0.12)));
    }
    addRailTube(boat, pushPts, 0.018, M.spar);
    for (const [t, side] of [[0.13, -1], [0.03, -1], [0.03, 1], [0.13, 1]]) {
      const z = side * (halfBreadth(t) - 0.07);
      addLine(
        boat,
        new THREE.Vector3(stationX(t), HULL.sheer + 0.02, z),
        new THREE.Vector3(stationX(t), railY, z),
        0.016,
        M.spar
      );
    }
    // Bow pulpit: lower hoop wrapping the stem.
    const pulY = HULL.sheer + 0.52;
    const pulPts = [];
    for (const [t, side] of [[0.86, -1], [0.94, -1], [0.985, -0.4], [0.985, 0.4], [0.94, 1], [0.86, 1]]) {
      pulPts.push(new THREE.Vector3(stationX(t), pulY, side * Math.max(halfBreadth(t) - 0.06, 0.05)));
    }
    addRailTube(boat, pulPts, 0.018, M.spar);
    for (const [t, side] of [[0.87, -1], [0.95, -1], [0.95, 1], [0.87, 1]]) {
      const z = side * (halfBreadth(t) - 0.06);
      addLine(
        boat,
        new THREE.Vector3(stationX(t), HULL.sheer + 0.02, z),
        new THREE.Vector3(stationX(t), pulY, z),
        0.016,
        M.spar
      );
    }
  }

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
  tiller.name = 'tiller';
  tiller.position.set(0.62, HULL.sheer + 0.12, 0);
  tiller.rotation.z = 0.12; // slight rise towards the grip
  rudderGroup.add(tiller);
  boat.add(rudderGroup);

  // --- wheel helm variant (hidden until selected in the GUI) ----------------
  // Binnacle pedestal + spoked wheel in the cockpit. Boat.js spins the
  // 'wheelSpin' group with the rudder (a few turns lock-to-lock); the GUI
  // "Helm style" control swaps tiller ↔ wheel visibility.
  {
    const wheelHelm = new THREE.Group();
    wheelHelm.name = 'wheelHelm';
    wheelHelm.visible = false;
    const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.08, 0.78, 10), M.spar);
    pedestal.position.set(-2.15, HULL.sheer + 0.39, 0);
    wheelHelm.add(pedestal);
    const spin = new THREE.Group();
    spin.name = 'wheelSpin';
    spin.position.set(-2.05, HULL.sheer + 0.86, 0);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.024, 8, 22), M.teakTrim);
    rim.rotation.y = Math.PI / 2; // wheel plane faces fore-aft
    spin.add(rim);
    for (let i = 0; i < 5; i++) {
      const spoke = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.62, 6), M.spar);
      spoke.rotation.x = (i * Math.PI) / 5;
      spin.add(spoke);
    }
    wheelHelm.add(spin);
    boat.add(wheelHelm);
  }

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
