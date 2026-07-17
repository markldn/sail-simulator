/**
 * Sails.js — mainsail + jib as TRUE simulated cloth (see ClothSail.js).
 *
 * Rigging model:
 *   main  luff pinned up the mast, foot pinned along the boom (boom-groove
 *         + outhaul). The boom itself stays kinematic, driven by the solved
 *         trim angle — it represents where the mainsheet holds it.
 *   jib   luff pinned to the forestay; the clew is held ONLY by its sheet —
 *         a one-sided rope constraint to the leeward sheet lead. Cloth +
 *         sheet tension shape the sail, exactly like the real foredeck.
 *
 * Consequences (all emergent, no scripted deformation left):
 *   - camber/draft from pressure; deepens in gusts, eases in lulls
 *   - twist: the unsupported upper leech falls off to leeward
 *   - leech flutter from unsteady inflow; backwinding when pinched;
 *     full flogging in the no-go zone
 *   - becalmed, the cloth sags under its own weight
 *   - through a tack the jib collapses, blows across, and fills on the
 *     new sheet — watch the foredeck when you put the helm over
 *
 * Boat FORCES still come from the validated SailAero model; the cloth is a
 * simulation driven by the same apparent wind (standard practice — keeps
 * the tested dynamics decoupled from visual cloth stability).
 */

import * as THREE from 'three';
import { HULL } from './HullSpec.js';
import { ClothSail } from './ClothSail.js';
import { makeSailclothTexture } from './textures.js';

const CLOTH_SUBSTEPS = 3;

const SAIL_MATERIAL = new THREE.MeshStandardMaterial({
  map: makeSailclothTexture(),
  roughness: 0.78,
  metalness: 0.0,
  side: THREE.DoubleSide,
  shadowSide: THREE.DoubleSide,
});

export class Sails {
  /** @param {THREE.Group} boatGroup the boat model root (body frame) */
  constructor(boatGroup) {
    this.gooseneckY = HULL.sheer + 0.9;
    const mastTopY = HULL.sheer + HULL.mastHeight * 0.95;
    this.mainHeight = mastTopY - this.gooseneckY;
    this.mainFoot = HULL.boomLength - 0.25;

    // ---- boom (kinematic, carries the main's foot) -------------------------
    this.boomGroup = new THREE.Group();
    this.boomGroup.position.set(HULL.mastX, this.gooseneckY, 0);
    boatGroup.add(this.boomGroup);
    const boom = new THREE.Mesh(
      new THREE.CylinderGeometry(0.045, 0.045, HULL.boomLength, 12),
      boatGroup.getObjectByName('mast').material
    );
    boom.rotation.z = Math.PI / 2;
    boom.position.x = -HULL.boomLength / 2;
    boom.castShadow = true;
    this.boomGroup.add(boom);

    // ---- mainsail cloth ------------------------------------------------------
    this.main = new ClothSail(boatGroup, {
      rows: 20,
      cols: 13,
      layout: (s, c) => [
        HULL.mastX - c * this.mainFoot * (1 - 0.97 * s),
        this.gooseneckY + s * this.mainHeight,
      ],
      material: SAIL_MATERIAL,
      broadseam: 0.035,
    });

    // ---- jib cloth -------------------------------------------------------------
    this.tack = new THREE.Vector3(HULL.length / 2 - 0.1, HULL.sheer + 0.15, 0);
    this.jibLuff = new THREE.Vector3(HULL.mastX, mastTopY, 0).sub(this.tack);
    this.jibFoot = 2.7;
    this.jib = new ClothSail(boatGroup, {
      rows: 16,
      cols: 11,
      layout: (s, c) => [
        this.tack.x + this.jibLuff.x * s - c * this.jibFoot * (1 - 0.97 * s),
        this.tack.y + this.jibLuff.y * s,
      ],
      material: SAIL_MATERIAL,
      broadseam: 0.035,
    });
    this.jibClewIndex = this.jib.id(0, this.jib.cols - 1);
    this.jib.ropes.push({ index: this.jibClewIndex, ax: 0, ay: 0, az: 0, rest: 10 });

    // ---- running rigging visuals (re-rigged every frame) -----------------------
    const ropeMat = new THREE.MeshStandardMaterial({ color: 0x9a3030, roughness: 0.85 });
    const ropeGeo = new THREE.CylinderGeometry(0.009, 0.009, 1, 5);
    ropeGeo.translate(0, -0.5, 0); // top end at origin: position+scale+aim
    this.mainsheetMesh = new THREE.Mesh(ropeGeo, ropeMat);
    this.jibsheetMesh = new THREE.Mesh(ropeGeo.clone(), ropeMat);
    boatGroup.add(this.mainsheetMesh, this.jibsheetMesh);

    this._side = 1;
    this._a = new THREE.Vector3();
    this._b = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._yDown = new THREE.Vector3(0, -1, 0);
  }

  /** Stretch a rope mesh between two points. */
  _rigRope(mesh, from, to) {
    this._dir.subVectors(to, from);
    const len = this._dir.length();
    mesh.position.copy(from);
    mesh.scale.set(1, Math.max(len, 0.01), 1);
    mesh.quaternion.setFromUnitVectors(this._yDown, this._dir.normalize());
  }

  /**
   * @param {object} aero  BoatPhysics.lastAero (incl. awBody wind vector)
   * @param {number} time  simulation clock
   * @param {number} dt    frame delta
   * @param {{main:number, jib:number}} plan hoisted fraction per sail
   */
  update(aero, time, dt, plan = { main: 1, jib: 1 }) {
    if (Math.abs(aero.awaDeg) > 1) this._side = aero.awaDeg >= 0 ? 1 : -1;
    const side = this._side;
    const hoist = Math.max(plan.main, 0.05);
    const furl = Math.max(plan.jib, 0.05);
    this.main.mesh.visible = plan.main > 0.02;
    this.jib.mesh.visible = plan.jib > 0.02;

    // Boom swings to the solved trim (smoothed — it's a sheet, not a servo).
    const k = 1 - Math.exp(-dt * 6);
    const boomTarget = -side * THREE.MathUtils.degToRad(aero.mainBetaDeg);
    this.boomGroup.rotation.y += (boomTarget - this.boomGroup.rotation.y) * k;
    const theta = this.boomGroup.rotation.y;
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);

    // ---- pins: main luff up the mast (reef-scaled), foot along the boom ----
    const m = this.main;
    for (let i = 0; i < m.rows; i++) {
      const s = i / (m.rows - 1);
      m.pin(i, 0, HULL.mastX, this.gooseneckY + s * this.mainHeight * hoist, 0);
    }
    for (let j = 1; j < m.cols; j++) {
      const d = (j / (m.cols - 1)) * this.mainFoot;
      m.pin(0, j, HULL.mastX - d * cosT, this.gooseneckY, d * sinT);
    }

    // ---- pins: jib luff down the forestay; clew flown from the sheet --------
    const jb = this.jib;
    for (let i = 0; i < jb.rows; i++) {
      const s = i / (jb.rows - 1);
      jb.pin(i, 0, this.tack.x + this.jibLuff.x * s, this.tack.y + this.jibLuff.y * s, 0);
    }
    // Sheet lead on the LEEWARD side deck; rest length places the clew at
    // the solved trim angle. One-sided: the clew can luff up freely.
    const lead = this._a.set(-1.95, HULL.sheer + 0.12, -side * 0.78);
    const jTheta = -side * THREE.MathUtils.degToRad(aero.jibBetaDeg);
    const f = this.jibFoot * furl;
    const clewTarget = this._b.set(
      this.tack.x - f * Math.cos(jTheta),
      this.tack.y,
      f * Math.sin(jTheta)
    );
    const rope = jb.ropes[0];
    rope.ax = lead.x;
    rope.ay = lead.y;
    rope.az = lead.z;
    rope.rest = clewTarget.distanceTo(lead) * 1.02;

    // ---- simulate --------------------------------------------------------------
    const wind = aero.awBody;
    const sdt = Math.min(dt, 1 / 30) / CLOTH_SUBSTEPS;
    for (let ss = 0; ss < CLOTH_SUBSTEPS; ss++) {
      const t = time + ss * sdt;
      if (this.main.mesh.visible) this.main.step(sdt, wind, 1, hoist, t);
      if (this.jib.mesh.visible) this.jib.step(sdt, wind, furl, 1, t + 2.1);
    }
    if (this.main.isBroken()) this.main.reset();
    if (this.jib.isBroken()) this.jib.reset();
    if (this.main.mesh.visible) this.main.commit();
    if (this.jib.mesh.visible) this.jib.commit();

    // ---- running rigging visuals -------------------------------------------------
    this._b.set(
      HULL.mastX - HULL.boomLength * cosT,
      this.gooseneckY - 0.06,
      HULL.boomLength * sinT
    );
    this._a.set(-2.9, HULL.sheer + 0.06, 0); // traveler
    this._rigRope(this.mainsheetMesh, this._b, this._a);

    const ck = this.jibClewIndex * 3;
    this._b.set(jb.pos[ck], jb.pos[ck + 1], jb.pos[ck + 2]);
    this._a.set(-1.95, HULL.sheer + 0.12, -side * 0.78);
    this.jibsheetMesh.visible = this.jib.mesh.visible;
    this._rigRope(this.jibsheetMesh, this._b, this._a);
  }
}
