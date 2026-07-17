/**
 * Sails.js — mainsail + jib as continuously-living cloth.
 *
 * The cloth is CPU vertex displacement over dense grids (22×14), driven by
 * the live aero solution every frame. What moves, and why — each effect is
 * a real sail behaviour, not decoration:
 *
 *   camber      the belly, bulging to LEEWARD, deeper the harder the sail
 *               works — and it BREATHES: gusts (Phase 5) raise apparent
 *               wind, the draft visibly deepens, and eases again in lulls.
 *   twist       the head sags off to leeward relative to the foot (upper
 *               cloth is less constrained by the boom); grows as the sheet
 *               is eased. Look up the leech and it spirals — like a photo.
 *   leech flutter  permanent high-frequency trembling of the trailing
 *               edge, stronger aloft and with wind speed. The "alive"
 *               tell — a real leech is never perfectly still.
 *   luff bubble at small angles of attack (pinching) the front third
 *               backwinds softly — a slow inverted bubble — BEFORE the
 *               whole sail breaks into flogging below ~2° attack.
 *   flogging    full luffing chaos when driving force collapses.
 *
 * Also owned here: the boom (swings with trim), the mainsheet (a real
 * line from boom end to traveler, re-rigged every frame), and reefing /
 * furling visuals (main drops its head, jib rolls onto the forestay).
 */

import * as THREE from 'three';
import { HULL } from './HullSpec.js';
import { makeSailclothTexture } from './textures.js';

const SEGS_UP = 22; // vertices up the luff
const SEGS_AFT = 14; // vertices along the chord

const SAIL_MATERIAL = new THREE.MeshStandardMaterial({
  map: makeSailclothTexture(),
  roughness: 0.78,
  metalness: 0.0,
  side: THREE.DoubleSide,
  shadowSide: THREE.DoubleSide, // cloth must self-shadow from either face
});

/**
 * Triangular sail grid with UVs (u = chord, v = height) for the cloth
 * texture. base[] keeps the undeformed layout for the deformer.
 */
function buildSailGrid(luffFn, chordDirX, chordLenFn) {
  const positions = [];
  const uvs = [];
  const base = [];
  const indices = [];
  const vid = (i, j) => i * SEGS_AFT + j;

  for (let i = 0; i < SEGS_UP; i++) {
    const s = i / (SEGS_UP - 1);
    const luff = luffFn(s);
    const chord = chordLenFn(s);
    for (let j = 0; j < SEGS_AFT; j++) {
      const c = j / (SEGS_AFT - 1);
      positions.push(luff.x + chordDirX * c * chord, luff.y, 0);
      uvs.push(c, s);
      base.push({ luffX: luff.x, y: luff.y, s, c, chord, chordDirX });
    }
  }
  for (let i = 0; i < SEGS_UP - 1; i++) {
    for (let j = 0; j < SEGS_AFT - 1; j++) {
      indices.push(vid(i, j), vid(i + 1, j), vid(i + 1, j + 1));
      indices.push(vid(i, j), vid(i + 1, j + 1), vid(i, j + 1));
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, SAIL_MATERIAL);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
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

    const sparMaterial = boatGroup.getObjectByName('mast').material;
    const boom = new THREE.Mesh(
      new THREE.CylinderGeometry(0.045, 0.045, HULL.boomLength, 12),
      sparMaterial
    );
    boom.rotation.z = Math.PI / 2;
    boom.position.x = -HULL.boomLength / 2;
    boom.castShadow = true;
    this.boomGroup.add(boom);

    const mainHeight = mastTopY - gooseneckY;
    const mainFoot = HULL.boomLength - 0.25;
    const main = buildSailGrid(
      (s) => ({ x: 0, y: s * mainHeight }),
      -1,
      (s) => mainFoot * (1 - 0.97 * s)
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

    const luffVec = head.clone().sub(tack);
    const jibFoot = 2.7;
    const jib = buildSailGrid(
      (s) => ({ x: luffVec.x * s, y: luffVec.y * s }),
      -1,
      (s) => jibFoot * (1 - 0.97 * s)
    );
    this.jibMesh = jib.mesh;
    this.jibBase = jib.base;
    this.jibGroup.add(this.jibMesh);

    // ---- mainsheet: boom end → traveler, re-rigged every frame ------------
    // Unit cylinder with its TOP at the origin so position+scale+aim is
    // enough to stretch it between two points.
    const sheetGeo = new THREE.CylinderGeometry(0.009, 0.009, 1, 5);
    sheetGeo.translate(0, -0.5, 0);
    this.sheetMesh = new THREE.Mesh(
      sheetGeo,
      new THREE.MeshStandardMaterial({ color: 0x9a3030, roughness: 0.85 })
    );
    boatGroup.add(this.sheetMesh);
    this._traveler = new THREE.Vector3(-2.9, HULL.sheer + 0.06, 0);
    this._boomEnd = new THREE.Vector3();
    this._sheetDir = new THREE.Vector3();
    this._yDown = new THREE.Vector3(0, -1, 0);

    this._side = 1; // last tack, so a becalmed sail keeps its side
    this._draft = 0.08; // smoothed camber depth (gust breathing state)
  }

  /**
   * @param {object} aero  BoatPhysics.lastAero
   * @param {number} time  simulation clock
   * @param {number} dt    frame delta
   * @param {{main:number, jib:number}} plan hoisted fraction per sail
   */
  update(aero, time, dt, plan = { main: 1, jib: 1 }) {
    if (Math.abs(aero.awaDeg) > 1) this._side = aero.awaDeg >= 0 ? 1 : -1;
    const side = this._side;

    // Hoist visuals: main reefs downward, jib rolls onto the forestay.
    this.mainMesh.visible = plan.main > 0.02;
    this.mainMesh.scale.y = Math.max(plan.main, 0.05);
    this.jibMesh.visible = plan.jib > 0.02;
    const jibChord = Math.max(plan.jib, 0.05);

    // Boom/jib swing, smoothed (a sheet, not a servo).
    const k = 1 - Math.exp(-dt * 6);
    const mainTarget = -side * THREE.MathUtils.degToRad(aero.mainBetaDeg);
    const jibTarget = -side * THREE.MathUtils.degToRad(aero.jibBetaDeg);
    this.boomGroup.rotation.y += (mainTarget - this.boomGroup.rotation.y) * k;
    this.jibGroup.rotation.y += (jibTarget - this.jibGroup.rotation.y) * k;

    // ---- cloth state, all derived from the live aero solution ------------
    const alpha = aero.mainAlphaDeg;
    const aws = aero.awsKn;

    // Gust breathing: target draft deepens with attack AND wind pressure;
    // smoothed so a passing gust visibly swells the belly, then eases.
    const load = THREE.MathUtils.clamp(alpha / 26, 0, 1) * THREE.MathUtils.clamp(aws / 14, 0.25, 1.15);
    const targetDraft = 0.055 + 0.095 * load;
    this._draft += (targetDraft - this._draft) * (1 - Math.exp(-dt * 2.2));

    // Twist: head falls off to leeward, more with the sheet eased.
    const twist = THREE.MathUtils.degToRad(
      5 + 10 * THREE.MathUtils.clamp(aero.mainBetaDeg / 70, 0, 1)
    );

    // Leech flutter: ever-present, scales with wind, strongest aloft.
    const leechAmp = 0.012 * THREE.MathUtils.smoothstep(aws, 3, 14);

    // Partial backwinding (pinching) vs full flogging.
    const bubble = THREE.MathUtils.smoothstep(8 - alpha, 0, 6); // α 8→2 ramps 0→1
    const flog = aero.luffing ? 1 : 0;

    const P = { side, draft: this._draft, twist, leechAmp, bubble, flog, time };
    if (this.mainMesh.visible) this._deform(this.mainMesh, this.mainBase, P, 0, 1);
    if (this.jibMesh.visible) this._deform(this.jibMesh, this.jibBase, P, 2.1, jibChord);

    // ---- re-rig the mainsheet between boom end and traveler ---------------
    const rot = this.boomGroup.rotation.y;
    this._boomEnd.set(
      HULL.mastX - HULL.boomLength * Math.cos(rot),
      this.boomGroup.position.y - 0.06,
      HULL.boomLength * Math.sin(rot)
    );
    this._sheetDir.subVectors(this._traveler, this._boomEnd);
    const len = this._sheetDir.length();
    this.sheetMesh.position.copy(this._boomEnd);
    this.sheetMesh.scale.set(1, len, 1);
    this.sheetMesh.quaternion.setFromUnitVectors(this._yDown, this._sheetDir.normalize());
  }

  /** Write the full cloth solution into every vertex of one sail. */
  _deform(mesh, base, P, phase, chordScale) {
    const pos = mesh.geometry.attributes.position;
    const { side, draft, twist, leechAmp, bubble, flog, time } = P;
    for (let i = 0; i < base.length; i++) {
      const v = base[i];
      const chord = v.chord * chordScale;
      pos.setX(i, v.luffX + v.chordDirX * v.c * chord);

      // camber: half-sine belly to leeward, flatter towards the head
      let z = -side * draft * chord * Math.sin(Math.PI * v.c) * (1 - 0.35 * v.s);

      // twist: upper chords rotate to leeward about the luff
      z += -side * Math.sin(twist) * Math.pow(v.s, 1.6) * v.c * chord;

      // leech flutter: travelling tremble confined to the trailing edge
      const leechW = Math.pow(THREE.MathUtils.smoothstep(v.c, 0.55, 1.0), 2);
      z += leechAmp * chord * leechW * (0.4 + 0.6 * v.s)
         * Math.sin(21 * time - v.c * 9 + v.s * 7 + phase);

      // luff bubble: slow soft backwinding of the front third when pinching
      if (bubble > 0) {
        z += side * bubble * 0.07 * chord
           * Math.pow(1 - v.c, 1.5) * Math.sin(Math.PI * v.c)
           * (0.55 + 0.45 * Math.sin(2.6 * time + v.s * 2.2 + phase));
      }

      // full flog: violent travelling wave from the luff
      if (flog > 0) {
        z += 0.055 * chord * (1 - v.c)
           * Math.sin(22 * time + v.s * 13 + v.c * 5 + phase);
      }

      pos.setZ(i, z);
    }
    pos.needsUpdate = true;
    mesh.geometry.computeVertexNormals();
  }
}
