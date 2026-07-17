/**
 * BoatPhysics.js — rigid-body dynamics, buoyancy and hydrodynamic drag.
 *
 * ── Buoyancy model: sampled pressure columns ────────────────────────────
 * The hull underside is covered with a grid of sample points generated from
 * the SAME parametric surface as the visual mesh (HullSpec.js). Each point
 * represents a vertical water column of area `a` capped at deck height.
 * Every physics substep, for each point:
 *
 *   depth  = clamp(waveHeight(x,z) − pointY, 0, columnHeight)
 *   F_buoy = ρ · g · a · depth              (upward, applied AT the point)
 *
 * Because forces are applied at the points, everything emerges naturally:
 * heel one way and the leeward columns deepen → righting moment; a wave
 * lifts the bow columns first → pitch; a quartering sea loads one corner →
 * combined roll+pitch. No hand-authored "wave response" needed.
 * waveHeight() is Ocean.getHeightAt() — the CPU mirror of the vertex
 * shader, so the boat floats on the *rendered* water.
 *
 * ── Damping / drag ──────────────────────────────────────────────────────
 * 1. Heave damping, per column, against the water's OWN vertical motion
 *    (water surface velocity estimated per-column by differencing wave
 *    height between substeps). Damping against relative velocity is what
 *    lets the boat FOLLOW waves instead of fighting them.
 * 2. Anisotropic hull drag: quadratic+linear, weak along +X (forward,
 *    slippery hull) applied at the hydro centre.
 * 3. Keel lateral drag: strong, applied AT the keel's centre of effort,
 *    below the roll axis — resists leeway and damps roll, exactly like the
 *    real foil. Phase 3's sail forces push against this.
 * 4. Rotational damping (roll/pitch/yaw) in the body frame.
 *
 * All magic-number coefficients are collected in TUNING with real-world
 * justifications; expect to nudge them by eye once sailing.
 *
 * ── Mass properties ─────────────────────────────────────────────────────
 * Two colliders: a light hull box and a small, very dense keel box. Rapier
 * derives mass, centre of mass (~0.33 m BELOW the waterline) and inertia
 * from them — the low CoM is the ballast righting moment.
 */

import * as THREE from 'three';
import { HULL, halfBreadth, stationX, sectionY } from './HullSpec.js';

const RHO_WATER = 1025; // kg/m³, salt water
const G = 9.81;

// Buoyancy sample grid resolution (samples = NX × NU).
const NX = 8; // stations along the hull
const NU = 4; // columns across each station
const U_SPAN = 0.88; // keep samples inboard of the sheer edge

export const TUNING = {
  // Heave (vertical) damping per m² of column area, vs water-relative
  // velocity. Sized for ~0.3 of critical damping of the heave oscillator
  // (k = ρ·g·A_wp ≈ 100 kN/m, m = 2.5 t → c_crit ≈ 31 kN·s/m).
  heaveLin: 900, // N·s/m per m²
  heaveQuad: 1200, // N·s²/m² per m²

  // Forward drag (skin friction + residuary), F = -(lin + quad·|v|)·v.
  // ≈ 1.1 kN at 6 kn — plausible for a 7.4 m displacement hull.
  fwdLin: 60,
  fwdQuad: 90,

  // Keel + hull lateral resistance, applied at the keel centre of effort.
  latLin: 400,
  latQuad: 1800,
  keelCenter: new THREE.Vector3(HULL.keelX, -0.9, 0), // body frame

  // Body-frame rotational damping, N·m·s/rad.
  rollDamp: 2500,
  yawDamp: 2500,
  pitchDamp: 8000,
};

export class BoatPhysics {
  /**
   * @param {import('../physics/PhysicsWorld.js').PhysicsWorld} physicsWorld
   * @param {import('../ocean/Ocean.js').Ocean} ocean (or any {getHeightAt})
   */
  constructor(physicsWorld, ocean) {
    this.ocean = ocean;
    const RAPIER = physicsWorld.RAPIER;

    // ---- rigid body ------------------------------------------------------
    this.spawn = new THREE.Vector3(0, ocean.getHeightAt(0, 0) + 0.35, 0);
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(this.spawn.x, this.spawn.y, this.spawn.z)
      // Tiny built-in damping as a numerical safety net only — real
      // hydrodynamic damping is applied explicitly below.
      .setLinearDamping(0.02)
      .setAngularDamping(0.05);
    this.body = physicsWorld.world.createRigidBody(bodyDesc);

    // ---- colliders / mass distribution ------------------------------------
    // Hull box: matches the hull's bounding volume; density set to hit
    // HULL.hullMass. (Collision shape barely matters in open water — it
    // exists to define mass/inertia and for future dock/ground contact.)
    const hullHalf = { x: 3.4, y: 0.57, z: 1.15 };
    const hullVol = 8 * hullHalf.x * hullHalf.y * hullHalf.z;
    physicsWorld.world.createCollider(
      RAPIER.ColliderDesc.cuboid(hullHalf.x, hullHalf.y, hullHalf.z)
        .setTranslation(0, 0.05, 0)
        .setDensity(HULL.hullMass / hullVol),
      this.body
    );

    // Keel box: small volume, huge density → drags the CoM ~0.33 m below
    // the waterline. This IS the ballast righting moment.
    const keelHalf = { x: 0.7, y: 0.55, z: 0.055 };
    const keelVol = 8 * keelHalf.x * keelHalf.y * keelHalf.z;
    physicsWorld.world.createCollider(
      RAPIER.ColliderDesc.cuboid(keelHalf.x, keelHalf.y, keelHalf.z)
        .setTranslation(HULL.keelX, -1.0, 0)
        .setDensity(HULL.ballastMass / keelVol),
      this.body
    );

    // ---- buoyancy sample grid ---------------------------------------------
    // Points ON the parametric hull surface, each owning an equal share of
    // its station's waterplane strip.
    this.samples = [];
    const stationLen = HULL.length / NX;
    for (let ix = 0; ix < NX; ix++) {
      const t = (ix + 0.5) / NX;
      const hb = halfBreadth(t);
      const area = (stationLen * (2 * hb * U_SPAN)) / NU;
      for (let iu = 0; iu < NU; iu++) {
        const u = (-1 + (2 * (iu + 0.5)) / NU) * U_SPAN;
        const y = sectionY(t, u);
        this.samples.push({
          local: new THREE.Vector3(stationX(t), y, hb * u),
          area,
          columnHeight: HULL.sheer - y, // column caps at the deck
        });
      }
    }

    // Per-sample state: previous water height (for surface velocity) and
    // last submersion depth (for the debug markers).
    this.prevWaterH = new Array(this.samples.length).fill(null);
    this.lastDepth = new Float32Array(this.samples.length);

    // Preallocated temporaries — this code runs 60×/s, zero per-step GC.
    this._q = new THREE.Quaternion();
    this._pos = new THREE.Vector3();
    this._linvel = new THREE.Vector3();
    this._angvel = new THREE.Vector3();
    this._worldP = new THREE.Vector3();
    this._r = new THREE.Vector3();
    this._vPoint = new THREE.Vector3();
    this._axis = new THREE.Vector3();
    this._force = new THREE.Vector3();
    this._torque = new THREE.Vector3();

    // Register with the fixed-step driver.
    physicsWorld.preStepHooks.push((world, dt) => this.applyForces(dt));
  }

  /** Called before EVERY physics substep (fixed dt) by PhysicsWorld. */
  applyForces(dt) {
    const b = this.body;

    const tr = b.translation();
    const rot = b.rotation();
    // NaN guard: if a force blew up (bad tuning while experimenting),
    // respawn rather than filling the scene with NaNs.
    if (!Number.isFinite(tr.x + tr.y + tr.z)) {
      this.reset();
      return;
    }

    b.resetForces(true);
    b.resetTorques(true);

    this._pos.set(tr.x, tr.y, tr.z);
    this._q.set(rot.x, rot.y, rot.z, rot.w);
    const lv = b.linvel();
    const av = b.angvel();
    this._linvel.set(lv.x, lv.y, lv.z);
    this._angvel.set(av.x, av.y, av.z);

    // ---- 1. buoyancy + heave damping, per column -------------------------
    for (let i = 0; i < this.samples.length; i++) {
      const s = this.samples[i];
      const wp = this._worldP.copy(s.local).applyQuaternion(this._q).add(this._pos);

      const waterH = this.ocean.getHeightAt(wp.x, wp.z);
      const depth = THREE.MathUtils.clamp(waterH - wp.y, 0, s.columnHeight);
      this.lastDepth[i] = depth;

      // Water surface vertical velocity at this column (finite difference
      // between substeps) — what the column damps against.
      const prev = this.prevWaterH[i];
      const waterVy = prev === null ? 0 : (waterH - prev) / dt;
      this.prevWaterH[i] = waterH;

      if (depth <= 0) continue;

      // Velocity of the hull at this point: v + ω × r
      this._r.copy(wp).sub(this._pos);
      this._vPoint.copy(this._angvel).cross(this._r).add(this._linvel);
      const relVy = this._vPoint.y - waterVy;

      const fBuoy = RHO_WATER * G * s.area * depth;
      const fDamp = -s.area * (TUNING.heaveLin + TUNING.heaveQuad * Math.abs(relVy)) * relVy;

      b.addForceAtPoint({ x: 0, y: fBuoy + fDamp, z: 0 }, wp, true);
    }

    // ---- 2. forward hull drag ---------------------------------------------
    const fwd = this._axis.set(1, 0, 0).applyQuaternion(this._q);
    const vFwd = this._linvel.dot(fwd);
    const fFwd = -(TUNING.fwdLin + TUNING.fwdQuad * Math.abs(vFwd)) * vFwd;
    this._force.copy(fwd).multiplyScalar(fFwd);
    b.addForce(this._force, true);

    // ---- 3. keel lateral drag (at the keel's centre of effort) ------------
    const keelWP = this._worldP.copy(TUNING.keelCenter).applyQuaternion(this._q).add(this._pos);
    this._r.copy(keelWP).sub(this._pos);
    this._vPoint.copy(this._angvel).cross(this._r).add(this._linvel);
    const lat = this._axis.set(0, 0, 1).applyQuaternion(this._q);
    const vLat = this._vPoint.dot(lat);
    const fLat = -(TUNING.latLin + TUNING.latQuad * Math.abs(vLat)) * vLat;
    this._force.copy(lat).multiplyScalar(fLat);
    b.addForceAtPoint(this._force, keelWP, true);

    // ---- 4. rotational damping (body frame) -------------------------------
    // ω in body frame: roll about X, yaw about Y, pitch about Z.
    const invQ = this._q.clone().invert(); // one small alloc; acceptable
    const wBody = this._torque.copy(this._angvel).applyQuaternion(invQ);
    wBody.set(
      -TUNING.rollDamp * wBody.x,
      -TUNING.yawDamp * wBody.y,
      -TUNING.pitchDamp * wBody.z
    );
    wBody.applyQuaternion(this._q); // back to world
    b.addTorque(wBody, true);
  }

  /** Respawn upright at the origin (GUI button / NaN recovery). */
  reset() {
    this.body.setTranslation(
      { x: this.spawn.x, y: this.ocean.getHeightAt(0, 0) + 0.35, z: this.spawn.z },
      true
    );
    this.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.prevWaterH.fill(null);
  }

  /**
   * Instrument readout for the HUD / camera. Angles in degrees:
   *   sog     speed over ground, knots (horizontal plane)
   *   heading compass bearing of the bow (0 = N = world −Z)
   *   heel    + = heeled to starboard
   *   pitch   + = bow up
   */
  getState(out = {}) {
    const tr = this.body.translation();
    const rot = this.body.rotation();
    const lv = this.body.linvel();
    this._q.set(rot.x, rot.y, rot.z, rot.w);

    const fwd = this._axis.set(1, 0, 0).applyQuaternion(this._q);
    const stbd = this._force.set(0, 0, 1).applyQuaternion(this._q);

    out.position = this._pos.set(tr.x, tr.y, tr.z);
    out.quaternion = this._q;
    out.sog = Math.hypot(lv.x, lv.z) * (1 / 0.514444);
    out.heading = ((THREE.MathUtils.radToDeg(Math.atan2(fwd.x, -fwd.z)) % 360) + 360) % 360;
    out.heel = -THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(stbd.y, -1, 1)));
    out.pitch = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(fwd.y, -1, 1)));
    return out;
  }
}
