/**
 * Sails.js — simulated cloth sails + simulated running rigging.
 *
 * Cloth (ClothSail.js): main pinned mast+boom; jib luff on the forestay
 * with the clew held ONLY by its sheet. Cloth collides with the mast and
 * the cap shrouds, so an eased main presses against the rigging and a
 * tacking jib drags across the mast instead of ghosting through.
 *
 * Running rigging (SimRope.js), all live:
 *   mainsheet   boom end → traveler; straightens as it loads
 *   vang        boom → mast base
 *   halyard     masthead → head of the main; watch it pay out as you reef
 *   jib sheets  BOTH: working sheet taut to the leeward lead, lazy sheet
 *               drooped across the foredeck — they swap every tack
 *
 * Two-way coupling: each cloth reports its integrated pressure force,
 * torque and centre of pressure (CP). Those go to BoatPhysics, which
 * applies its validated sail polars AT the live cloth CP (so reef, twist
 * and flogging move the heel arm for real) and blends in the RAW cloth
 * force where the polar model has no answer (luffing/flogging — pressure
 * chaos shaking the rig). Why not raw cloth force everywhere: a
 * pressure-only membrane model has no leading-edge suction, so it
 * underestimates attached-flow lift several-fold — the boat would barely
 * beat upwind on it. The polars stay authoritative for attached flow.
 */

import * as THREE from 'three';
import { HULL, halfBreadth } from './HullSpec.js';
import { ClothSail } from './ClothSail.js';
import { SimRope } from './SimRope.js';
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
    this.mastheadY = HULL.sheer + HULL.mastHeight;
    const sailTopY = HULL.sheer + HULL.mastHeight * 0.95;
    this.mainHeight = sailTopY - this.gooseneckY;
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

    // ---- cloth -----------------------------------------------------------------
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

    this.tack = new THREE.Vector3(HULL.length / 2 - 0.1, HULL.sheer + 0.15, 0);
    this.jibLuff = new THREE.Vector3(HULL.mastX, sailTopY, 0).sub(this.tack);
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

    // ---- rigging colliders (match the visual rigging in BoatModel) ---------
    const spreaderY = HULL.sheer + HULL.mastHeight * 0.55;
    const shrouds = [];
    for (const side of [-1, 1]) {
      const cpz = side * (halfBreadth(0.6) - 0.05);
      shrouds.push(
        { ax: HULL.mastX - 0.05, ay: HULL.sheer, az: cpz,
          bx: HULL.mastX, by: spreaderY, bz: side * 0.62, r: 0.035 },
        { ax: HULL.mastX, ay: spreaderY, az: side * 0.62,
          bx: HULL.mastX, by: this.mastheadY, bz: 0, r: 0.035 }
      );
    }
    this.main.colliders = shrouds; // main luff lives ON the mast — shrouds only
    this.jib.colliders = [
      ...shrouds,
      { ax: HULL.mastX, ay: HULL.sheer, az: 0,
        bx: HULL.mastX, by: this.mastheadY, bz: 0, r: 0.1 }, // the mast
    ];

    // ---- running rigging ---------------------------------------------------------
    this.ropeMainsheet = new SimRope(boatGroup, { radius: 0.01, color: 0x8a2f2f });
    this.ropeVang = new SimRope(boatGroup, { segments: 6, color: 0x4e5a48 });
    this.ropeHalyard = new SimRope(boatGroup, { segments: 6, radius: 0.006, color: 0xc9bfa8 });
    this.ropeJibActive = new SimRope(boatGroup, { color: 0xb59a6a });
    this.ropeJibLazy = new SimRope(boatGroup, { segments: 10, color: 0xb59a6a });

    // ---- coupling output (smoothed; flutter noise must not shake physics) --
    this.onClothAero = null; // Boat.js wires this to BoatPhysics.setClothAero
    this._out = {
      main: { force: new THREE.Vector3(), cp: new THREE.Vector3(HULL.mastX - 1.4, 4.0, 0) },
      jib: { force: new THREE.Vector3(), cp: new THREE.Vector3(2.3, 3.2, 0) },
    };

    this._side = 1;
    this._a = new THREE.Vector3();
    this._b = new THREE.Vector3();
    this._c = new THREE.Vector3();
    this._f = new THREE.Vector3();
  }

  /** Re-lay both cloths flat and zero coupling output (boat reset). */
  resetCloth() {
    this.main.reset();
    this.jib.reset();
    this._out.main.force.set(0, 0, 0);
    this._out.jib.force.set(0, 0, 0);
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

    // ---- pins ---------------------------------------------------------------
    const m = this.main;
    for (let i = 0; i < m.rows; i++) {
      const s = i / (m.rows - 1);
      m.pin(i, 0, HULL.mastX, this.gooseneckY + s * this.mainHeight * hoist, 0);
    }
    for (let j = 1; j < m.cols; j++) {
      const d = (j / (m.cols - 1)) * this.mainFoot;
      m.pin(0, j, HULL.mastX - d * cosT, this.gooseneckY, d * sinT);
    }
    const jb = this.jib;
    for (let i = 0; i < jb.rows; i++) {
      const s = i / (jb.rows - 1);
      jb.pin(i, 0, this.tack.x + this.jibLuff.x * s, this.tack.y + this.jibLuff.y * s, 0);
    }

    // Jib sheet constraint → leeward lead; rest length sets the trim.
    const leadZ = 0.78;
    const leadPos = this._a.set(-1.95, HULL.sheer + 0.12, -side * leadZ);
    const jTheta = -side * THREE.MathUtils.degToRad(aero.jibBetaDeg);
    const f = this.jibFoot * furl;
    const clewTarget = this._b.set(
      this.tack.x - f * Math.cos(jTheta),
      this.tack.y,
      f * Math.sin(jTheta)
    );
    const rope = jb.ropes[0];
    rope.ax = leadPos.x;
    rope.ay = leadPos.y;
    rope.az = leadPos.z;
    rope.rest = clewTarget.distanceTo(leadPos) * 1.02;

    // ---- simulate cloth, averaging the integrated aero over substeps -------
    const wind = aero.awBody;
    const sdt = Math.min(dt, 1 / 30) / CLOTH_SUBSTEPS;
    const Fm = this._f.set(0, 0, 0);
    let Fjx = 0, Fjy = 0, Fjz = 0;
    for (let ss = 0; ss < CLOTH_SUBSTEPS; ss++) {
      const t = time + ss * sdt;
      if (this.main.mesh.visible) {
        this.main.step(sdt, wind, 1, hoist, t);
        Fm.add(this.main.aeroForce);
      }
      if (this.jib.mesh.visible) {
        this.jib.step(sdt, wind, furl, 1, t + 2.1);
        Fjx += this.jib.aeroForce.x;
        Fjy += this.jib.aeroForce.y;
        Fjz += this.jib.aeroForce.z;
      }
    }
    const out = this._out;
    if (this.main.isBroken()) {
      this.main.reset();
      out.main.force.set(0, 0, 0); // a NaN in the smoothed lerp is forever
      Fm.set(0, 0, 0);
    }
    if (this.jib.isBroken()) {
      this.jib.reset();
      out.jib.force.set(0, 0, 0);
      Fjx = Fjy = Fjz = 0;
    }
    if (this.main.mesh.visible) this.main.commit();
    if (this.jib.mesh.visible) this.jib.commit();

    // Smooth force + CP and hand them to the physics (low-pass so cloth
    // flutter enlivens the readouts without shaking the rigid body).
    // Everything crossing into the physics is sanitized: finite or zero,
    // magnitude capped (20 kN — far above any sane sail load).
    const ka = 1 - Math.exp(-dt / 0.15);
    Fm.multiplyScalar(1 / CLOTH_SUBSTEPS);
    if (!Number.isFinite(Fm.x + Fm.y + Fm.z)) Fm.set(0, 0, 0);
    out.main.force.lerp(this.main.mesh.visible ? Fm : Fm.set(0, 0, 0), ka);
    if (out.main.force.lengthSq() > 4e8) out.main.force.setLength(20000);
    if (this.main.pressureWeight > 2) out.main.cp.lerp(this.main.pressureCentroid, ka);
    this._c.set(Fjx / CLOTH_SUBSTEPS, Fjy / CLOTH_SUBSTEPS, Fjz / CLOTH_SUBSTEPS);
    if (!Number.isFinite(this._c.x + this._c.y + this._c.z)) this._c.set(0, 0, 0);
    out.jib.force.lerp(this.jib.mesh.visible ? this._c : this._c.set(0, 0, 0), ka);
    if (out.jib.force.lengthSq() > 4e8) out.jib.force.setLength(20000);
    if (this.jib.pressureWeight > 2) out.jib.cp.lerp(this.jib.pressureCentroid, ka);
    this.onClothAero?.(out);

    // ---- running rigging ------------------------------------------------------
    const boomEnd = this._a.set(
      HULL.mastX - HULL.boomLength * cosT,
      this.gooseneckY - 0.06,
      HULL.boomLength * sinT
    );
    const traveler = this._b.set(-2.9, HULL.sheer + 0.06, 0);
    this.ropeMainsheet.update(dt, boomEnd, traveler, boomEnd.distanceTo(traveler) * 1.04);

    const vangBoom = this._a.set(
      HULL.mastX - 1.0 * cosT,
      this.gooseneckY - 0.05,
      1.0 * sinT
    );
    const mastBase = this._b.set(HULL.mastX - 0.02, HULL.sheer + 0.12, 0);
    this.ropeVang.update(dt, vangBoom, mastBase, vangBoom.distanceTo(mastBase) * 1.02);

    // Halyard: masthead down to the head of the main — reefing pays it out.
    const masthead = this._a.set(HULL.mastX, this.mastheadY - 0.05, 0.03);
    const mainHead = this._b.set(HULL.mastX, this.gooseneckY + this.mainHeight * hoist, 0.03);
    this.ropeHalyard.update(dt, masthead, mainHead, masthead.distanceTo(mainHead) * 1.005);

    // Jib sheets, working + lazy, from the live clew particle.
    const ck = this.jibClewIndex * 3;
    const clew = this._a.set(jb.pos[ck], jb.pos[ck + 1], jb.pos[ck + 2]);
    const active = this._b.set(-1.95, HULL.sheer + 0.12, -side * leadZ);
    const activeLen = clew.distanceTo(active);
    this.ropeJibActive.visible = this.jib.mesh.visible;
    this.ropeJibLazy.visible = this.jib.mesh.visible;
    this.ropeJibActive.update(dt, clew, active, activeLen * 1.02);
    const lazy = this._c.set(-1.95, HULL.sheer + 0.12, side * leadZ);
    this.ropeJibLazy.update(
      dt,
      clew,
      lazy,
      Math.max(clew.distanceTo(lazy) * 1.03, activeLen * 1.15)
    );
  }
}
