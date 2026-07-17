/**
 * Sails.js — mainsail + jib as deforming cloth meshes, plus the boom.
 *
 * Deformation is CPU vertex displacement (the grids are tiny — 14×10),
 * recomputed every frame from the live aero solution in BoatPhysics.lastAero:
 *
 *   - The boom/main swing to the solved sail angle β (smoothed, so tacks
 *     and gybes read as a swing rather than a teleport).
 *   - Camber (the "belly") bulges to LEEWARD, deeper the harder the sail
 *     is loaded (draft ≈ 6 % of chord unloaded → ~14 % fully powered).
 *   - When the angle of attack drops below the luffing threshold the cloth
 *     flutters: a travelling ripple strongest at the luff edge, exactly
 *     where real sails start to flog.
 *
 * Geometry lives in local "rig groups" that pivot around the mast (main)
 * and the tack (jib), so trim is a cheap rotation and only the camber
 * offsets touch vertex data.
 */

import * as THREE from 'three';
import { HULL } from './HullSpec.js';

const MAIN_SEGS_UP = 14; // vertices up the luff
const MAIN_SEGS_AFT = 10; // vertices along the chord

const SAIL_MATERIAL = new THREE.MeshStandardMaterial({
  color: 0xf7f5ee, // dacron
  roughness: 0.82,
  metalness: 0.0,
  side: THREE.DoubleSide,
});

/**
 * Build a triangular sail grid. Rows shrink linearly towards the head.
 * Returns { mesh, base } where base holds the undeformed local positions
 * plus per-vertex (sFrac, cFrac, chordLen) used by the deformer.
 */
function buildSailGrid(luffFn, chordDirX, chordLenFn) {
  const positions = [];
  const base = [];
  const indices = [];
  const vid = (i, j) => i * MAIN_SEGS_AFT + j;

  for (let i = 0; i < MAIN_SEGS_UP; i++) {
    const s = i / (MAIN_SEGS_UP - 1);
    const luff = luffFn(s); // point on the luff (mast/forestay) at height s
    const chord = chordLenFn(s);
    for (let j = 0; j < MAIN_SEGS_AFT; j++) {
      const c = j / (MAIN_SEGS_AFT - 1);
      const x = luff.x + chordDirX * c * chord;
      const y = luff.y;
      positions.push(x, y, 0);
      base.push({ x, y, s, c, chord });
    }
  }
  for (let i = 0; i < MAIN_SEGS_UP - 1; i++) {
    for (let j = 0; j < MAIN_SEGS_AFT - 1; j++) {
      indices.push(vid(i, j), vid(i + 1, j), vid(i + 1, j + 1));
      indices.push(vid(i, j), vid(i + 1, j + 1), vid(i, j + 1));
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, SAIL_MATERIAL);
  mesh.castShadow = true;
  return { mesh, base };
}

export class Sails {
  /** @param {THREE.Group} boatGroup the boat model root (body frame) */
  constructor(boatGroup) {
    const gooseneckY = HULL.sheer + 0.9;
    const mastTopY = HULL.sheer + HULL.mastHeight * 0.95;

    // ---- main: pivots about the mast axis at the gooseneck ----------------
    this.boomGroup = new THREE.Group();
    this.boomGroup.position.set(HULL.mastX, gooseneckY, 0);
    boatGroup.add(this.boomGroup);

    const boom = new THREE.Mesh(
      new THREE.CylinderGeometry(0.045, 0.045, HULL.boomLength, 12),
      boatGroup.getObjectByName('mast').material
    );
    boom.rotation.z = Math.PI / 2; // axis along X
    boom.position.x = -HULL.boomLength / 2; // extends aft of the mast
    boom.castShadow = true;
    this.boomGroup.add(boom);

    const mainHeight = mastTopY - gooseneckY;
    const mainFoot = HULL.boomLength - 0.25;
    const main = buildSailGrid(
      (s) => ({ x: 0, y: s * mainHeight }), // luff = straight up the mast
      -1, // chord runs aft
      (s) => mainFoot * (1 - 0.97 * s) // near-triangular planform
    );
    this.mainMesh = main.mesh;
    this.mainBase = main.base;
    this.boomGroup.add(this.mainMesh);

    // ---- jib: pivots about the forestay at the stem fitting ---------------
    const tack = new THREE.Vector3(HULL.length / 2 - 0.1, HULL.sheer + 0.15, 0);
    const head = new THREE.Vector3(HULL.mastX, mastTopY, 0);
    this.jibGroup = new THREE.Group();
    this.jibGroup.position.copy(tack);
    boatGroup.add(this.jibGroup);

    const luffVec = head.clone().sub(tack); // up & aft along the forestay
    const jibFoot = 2.7;
    const jib = buildSailGrid(
      (s) => ({ x: luffVec.x * s, y: luffVec.y * s }),
      -1, // clew trails aft
      (s) => jibFoot * (1 - 0.97 * s)
    );
    this.jibMesh = jib.mesh;
    this.jibBase = jib.base;
    this.jibGroup.add(this.jibMesh);

    this._side = 1; // last tack, so a becalmed sail keeps its side
  }

  /**
   * @param {object} aero  BoatPhysics.lastAero
   * @param {number} time  simulation clock (flutter phase)
   * @param {number} dt    frame delta (swing smoothing)
   */
  update(aero, time, dt) {
    if (Math.abs(aero.awaDeg) > 1) this._side = aero.awaDeg >= 0 ? 1 : -1;
    const side = this._side;

    // Smooth boom/jib swing (≈ e-fold in 1/6 s — a sheet, not a servo).
    const k = 1 - Math.exp(-dt * 6);
    const mainTarget = -side * THREE.MathUtils.degToRad(aero.mainBetaDeg);
    const jibTarget = -side * THREE.MathUtils.degToRad(aero.jibBetaDeg);
    this.boomGroup.rotation.y += (mainTarget - this.boomGroup.rotation.y) * k;
    this.jibGroup.rotation.y += (jibTarget - this.jibGroup.rotation.y) * k;

    // Camber depth follows loading: alpha near optimum → full draft.
    const load = THREE.MathUtils.clamp(aero.mainAlphaDeg / 26, 0, 1);
    const draft = 0.06 + 0.08 * load; // fraction of chord
    const flutter = aero.luffing ? 1 : 0;

    this._deform(this.mainMesh, this.mainBase, side, draft, flutter, time, 0);
    this._deform(this.jibMesh, this.jibBase, side, draft, flutter, time, 2.1);
  }

  /** Write camber (+ luff flutter) into the z of every sail vertex. */
  _deform(mesh, base, side, draft, flutter, time, phase) {
    const pos = mesh.geometry.attributes.position;
    for (let i = 0; i < base.length; i++) {
      const v = base[i];
      // Belly: half-sine across the chord, bulging to leeward (-side),
      // tapering towards the head where the sail is flatter.
      let z = -side * draft * v.chord * Math.sin(Math.PI * v.c) * (1 - 0.35 * v.s);
      // Flogging: travelling wave, strongest at the luff, zero at the leech.
      if (flutter > 0) {
        z +=
          0.055 *
          v.chord *
          (1 - v.c) *
          Math.sin(22 * time + v.s * 13 + v.c * 5 + phase) *
          flutter;
      }
      pos.setZ(i, z);
    }
    pos.needsUpdate = true;
    mesh.geometry.computeVertexNormals();
  }
}
