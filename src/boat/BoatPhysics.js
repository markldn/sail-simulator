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
import { MS_TO_KNOTS } from '../wind/WindManager.js';
import {
  RHO_AIR,
  ALPHA_OPT_DEG,
  SHEET_MIN_DEG,
  SHEET_MAX_DEG,
  sailCL,
  sailCD,
} from './SailAero.js';

const RHO_WATER = 1025; // kg/m³, salt water
const G = 9.81;

// Buoyancy sample grid resolution (samples = NX × NU).
const NX = 8; // stations along the hull
const NU = 4; // columns across each station
const U_SPAN = 0.88; // keep samples inboard of the sheer edge

// Reserve buoyancy: real hulls keep displacing water ABOVE the sheer line
// (flared topsides, coamings, the cabin, the enclosed hull volume), which
// is what shoulders a boat up out of a crest instead of letting it sail
// cleanly through one. Columns keep generating force this far above deck.
const RESERVE_BUOYANCY = 0.45; // m

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

  // Rudder: a small balanced spade, F = ½·ρ·A·CL(2α)·U² at the blade.
  rudderArea: 0.32, // m²
  rudderCL: 1.3,
  rudderMaxDeg: 32,
  rudderCenter: new THREE.Vector3(HULL.rudderX, -0.55, 0), // body frame

  // Windage: air drag on hull, cabin and rig. This is why a boat with
  // flogging sails still drifts downwind.
  windageArea: 3.5, // m² frontal-ish
  windageCd: 0.85,
  windageCenter: new THREE.Vector3(0, 0.8, 0), // deck level, body frame
};

/**
 * Sail plan: area and centre of effort (body frame) per sail. CE height is
 * what converts sail force into heel moment — no hand-tuned "heel factor"
 * anywhere, it is just addForceAtPoint doing its job.
 * sheetFactor: the jib is trimmed slightly tighter than the main.
 */
const SAILS = [
  { name: 'main', area: 15, ce: new THREE.Vector3(HULL.mastX - 1.4, 4.0, 0), sheetFactor: 1.0 },
  { name: 'jib', area: 10, ce: new THREE.Vector3(2.3, 3.2, 0), sheetFactor: 0.92 },
];

export class BoatPhysics {
  /**
   * @param {import('../physics/PhysicsWorld.js').PhysicsWorld} physicsWorld
   * @param {import('../ocean/Ocean.js').Ocean} ocean (or any {getHeightAt})
   * @param {import('../wind/WindManager.js').WindManager} [wind]
   *        omit (e.g. in buoyancy-only tests) to disable aero forces
   * @param {{rudderDeg:number, sheetMaxDeg:number, autoTrim:boolean}} [helm]
   *        live control state, written by ui/Helm.js
   */
  constructor(physicsWorld, ocean, wind = null, helm = null) {
    this.ocean = ocean;
    this.wind = wind;
    this.helm = helm ?? { rudderDeg: 0, sheetMaxDeg: 40, autoTrim: true };

    // Sail plan: hoisted fraction per sail (1 = full sail, 0.4 = reefed,
    // 0 = doused). GUI sliders write here; physics and visuals both read it.
    this.sailPlan = { main: 1, jib: 1 };

    // Two-way cloth coupling (fed by Sails via setClothAero):
    // - forces are applied at the cloth's LIVE centre of pressure, so reef,
    //   twist and flogging genuinely move the heel/yaw arms;
    // - during luffing the raw integrated cloth force is blended in (the
    //   polar model is out of its envelope there; pressure chaos is not).
    // Attached-flow magnitude still comes from the validated polars — a
    // pressure-only membrane has no leading-edge suction and would
    // underestimate upwind lift several-fold.
    // Falls back to the fixed-CE analytic model when no cloth data arrives
    // (headless tests, cloth disabled) via the freshness age below.
    this.clothCouplingEnabled = true;
    this._cloth = {
      age: Infinity,
      main: { force: new THREE.Vector3(), cp: new THREE.Vector3() },
      jib: { force: new THREE.Vector3(), cp: new THREE.Vector3() },
    };

    const RAPIER = physicsWorld.RAPIER;

    // Instrument/visual readout of the last aero solution, refreshed every
    // substep. Sails.js reads it to pose the boom and shape the cloth.
    this.lastAero = {
      awaDeg: 0, // signed: + = wind over starboard
      awsKn: 0,
      mainBetaDeg: 0, // boom angle off centreline
      jibBetaDeg: 0,
      mainAlphaDeg: 0,
      luffing: false,
      awBody: new THREE.Vector3(), // apparent wind, BODY frame, m/s (cloth sim)
    };

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
          // Column caps a little ABOVE the deck — see RESERVE_BUOYANCY.
          columnHeight: HULL.sheer - y + RESERVE_BUOYANCY,
        });
      }
    }

    // Last submersion depth per sample (for the debug markers).
    this.lastDepth = new Float32Array(this.samples.length);

    // Bow-slam detector, consumed by the spray effect: the hardest
    // downward water impact seen at a forward station since the last time
    // main.js read it and zeroed it.
    this.slamIntensity = 0; // m/s of impact beyond the spray threshold
    this.slamPoint = new THREE.Vector3();

    // Preallocated temporaries — this code runs 60×/s, zero per-step GC.
    this._q = new THREE.Quaternion();
    this._invQ = new THREE.Quaternion();
    this._aw = new THREE.Vector3();
    this._waterVel = new THREE.Vector3(); // per-sample orbital velocity
    this._waterVelC = new THREE.Vector3(); // …at the hull centre
    this._vRel = new THREE.Vector3();
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
    this._cloth.age += dt;

    this._pos.set(tr.x, tr.y, tr.z);
    this._q.set(rot.x, rot.y, rot.z, rot.w);
    this._invQ.copy(this._q).invert();
    const lv = b.linvel();
    const av = b.angvel();
    this._linvel.set(lv.x, lv.y, lv.z);
    this._angvel.set(av.x, av.y, av.z);

    // Orbital water velocity at the hull centre — every hull/keel/rudder
    // drag below is computed RELATIVE to the moving water, which is how
    // waves surge and carry the boat (Stokes drift comes out for free).
    this._waterVelocityAt(tr.x, tr.z, this._waterVelC);

    // ---- 1. buoyancy + heave damping, per column -------------------------
    for (let i = 0; i < this.samples.length; i++) {
      const s = this.samples[i];
      const wp = this._worldP.copy(s.local).applyQuaternion(this._q).add(this._pos);

      const waterH = this.ocean.getHeightAt(wp.x, wp.z);
      const depth = THREE.MathUtils.clamp(waterH - wp.y, 0, s.columnHeight);
      this.lastDepth[i] = depth;
      if (depth <= 0) continue;

      // Velocity of the hull at this point (v + ω × r), minus the water's
      // own analytic orbital velocity: the column damps RELATIVE motion.
      this._waterVelocityAt(wp.x, wp.z, this._waterVel);
      this._r.copy(wp).sub(this._pos);
      this._vPoint.copy(this._angvel).cross(this._r).add(this._linvel);
      const relVy = this._vPoint.y - this._waterVel.y;

      // Slam detection: a forward station driving down into the water
      // faster than ~1.3 m/s relative throws spray (read by main.js).
      if (s.local.x > 1.6 && depth < 0.6) {
        const impact = -relVy - 1.3;
        if (impact > this.slamIntensity) {
          this.slamIntensity = impact;
          this.slamPoint.copy(wp);
        }
      }

      const fBuoy = RHO_WATER * G * s.area * depth;
      const fDamp = -s.area * (TUNING.heaveLin + TUNING.heaveQuad * Math.abs(relVy)) * relVy;

      b.addForceAtPoint({ x: 0, y: fBuoy + fDamp, z: 0 }, wp, true);
    }

    // ---- 2. forward hull drag (vs the water, not the world) ---------------
    const fwd = this._axis.set(1, 0, 0).applyQuaternion(this._q);
    const vFwd = this._vRel.copy(this._linvel).sub(this._waterVelC).dot(fwd);
    const fFwd = -(TUNING.fwdLin + TUNING.fwdQuad * Math.abs(vFwd)) * vFwd;
    this._force.copy(fwd).multiplyScalar(fFwd);
    b.addForce(this._force, true);

    // ---- 3. keel lateral drag (at the keel's centre of effort) ------------
    const keelWP = this._worldP.copy(TUNING.keelCenter).applyQuaternion(this._q).add(this._pos);
    this._r.copy(keelWP).sub(this._pos);
    this._vPoint.copy(this._angvel).cross(this._r).add(this._linvel).sub(this._waterVelC);
    const lat = this._axis.set(0, 0, 1).applyQuaternion(this._q);
    const vLat = this._vPoint.dot(lat);
    const fLat = -(TUNING.latLin + TUNING.latQuad * Math.abs(vLat)) * vLat;
    this._force.copy(lat).multiplyScalar(fLat);
    b.addForceAtPoint(this._force, keelWP, true);

    // ---- 4. sails + rudder (Phase 3) --------------------------------------
    if (this.wind) {
      this._applyAeroForces();
      this._applyRudderForce();
    }

    // ---- 5. rotational damping (body frame) -------------------------------
    // ω in body frame: roll about X, yaw about Y, pitch about Z.
    const wBody = this._torque.copy(this._angvel).applyQuaternion(this._invQ);
    wBody.set(
      -TUNING.rollDamp * wBody.x,
      -TUNING.yawDamp * wBody.y,
      -TUNING.pitchDamp * wBody.z
    );
    wBody.applyQuaternion(this._q); // back to world
    b.addTorque(wBody, true);
  }

  /**
   * Sail lift & drag from the apparent wind, one force per sail applied at
   * its centre of effort. Everything downstream is emergent: heel (CE is
   * high), weather helm (CEs are off the yaw axis), the no-go zone (close
   * to the wind, lift points sideways and drag aft), and the oversheeted
   * stall (α huge → CL collapses, CD balloons → heel without drive).
   */
  _applyAeroForces() {
    const aero = this.lastAero;

    // Apparent wind = air velocity − boat velocity (world frame).
    // (Wind gradient with height ignored for now.)
    this._aw.copy(this.wind.getWindVector()).sub(this._linvel);

    // Hull/rig windage — plain air drag at deck level, independent of sail
    // trim. A boat with flogging sails still gets blown downwind.
    const awH = Math.hypot(this._aw.x, this._aw.z);
    if (awH > 0.1) {
      const f = 0.5 * RHO_AIR * TUNING.windageCd * TUNING.windageArea * awH;
      this._force.set(this._aw.x * f, 0, this._aw.z * f);
      const deckWP = this._worldP
        .copy(TUNING.windageCenter)
        .applyQuaternion(this._q)
        .add(this._pos);
      this.body.addForceAtPoint(this._force, deckWP, true);
    }

    // …then the sails, in the body frame.
    this._aw.applyQuaternion(this._invQ);
    aero.awBody.copy(this._aw); // cloth sim blows with exactly this wind
    const aws = Math.hypot(this._aw.x, this._aw.z);
    aero.awsKn = aws * MS_TO_KNOTS;
    if (aws < 0.2) {
      aero.luffing = true;
      return; // becalmed
    }

    // Direction air MOVES (flow) and the signed apparent wind angle.
    const flowX = this._aw.x / aws;
    const flowZ = this._aw.z / aws;
    const awaRad = Math.atan2(-flowZ, -flowX); // angle of the FROM-direction
    const awaDeg = THREE.MathUtils.radToDeg(awaRad);
    const absAwa = Math.abs(awaDeg);
    const side = awaDeg >= 0 ? 1 : -1; // +1: wind over starboard
    aero.awaDeg = awaDeg;

    // Heeling de-powers the rig (projected area shrinks).
    const stbdY = this._axis.set(0, 0, 1).applyQuaternion(this._q).y;
    const cosHeel = Math.sqrt(Math.max(1 - stbdY * stbdY, 0.05));

    // Lift is perpendicular to the flow, rotated towards the bow — the
    // rotation sign flips with tack. rot(v,θ): x' = x·c − z·s, z' = x·s + z·c
    const th = (side * Math.PI) / 2;
    const c = Math.cos(th);
    const s = Math.sin(th);
    const liftX = flowX * c - flowZ * s;
    const liftZ = flowX * s + flowZ * c;

    for (const sail of SAILS) {
      // Hoisted fraction: scales the area, and lowers the centre of effort
      // (a reefed main loses its TOP, which is exactly why reefing tames
      // heel far more than the area reduction alone suggests).
      const hoist = this.sailPlan[sail.name] ?? 1;
      if (hoist < 0.02) {
        if (sail.name === 'main') {
          aero.mainBetaDeg = 0;
          aero.mainAlphaDeg = 0;
          aero.luffing = false;
        } else {
          aero.jibBetaDeg = 0;
        }
        continue;
      }

      // Sheet geometry: the boom weathervanes out to the sheet limit but
      // can never be pushed windward of the apparent wind (it would flog).
      const betaMax = this.helm.autoTrim
        ? THREE.MathUtils.clamp(absAwa - ALPHA_OPT_DEG, SHEET_MIN_DEG, SHEET_MAX_DEG)
        : THREE.MathUtils.clamp(
            this.helm.sheetMaxDeg * sail.sheetFactor,
            SHEET_MIN_DEG,
            SHEET_MAX_DEG
          );
      const beta = Math.min(betaMax, absAwa);
      const alpha = absAwa - beta;

      const q = 0.5 * RHO_AIR * aws * aws * sail.area * hoist * cosHeel;
      const L = q * sailCL(alpha);
      const D = q * sailCD(alpha);

      const cloth =
        this.clothCouplingEnabled && this._cloth.age < 0.25
          ? this._cloth[sail.name]
          : null;

      this._force.set(liftX * L + flowX * D, 0, liftZ * L + flowZ * D);
      // Luffing/flogging: polars say ~zero, the cloth knows better — blend
      // in its raw integrated pressure force (body frame).
      if (cloth && alpha < 6) {
        const wLuff = 1 - THREE.MathUtils.clamp((alpha - 2) / 4, 0, 1);
        this._force.addScaledVector(cloth.force, wLuff);
      }
      this._force.applyQuaternion(this._q);

      // Application point: live cloth centre of pressure when available.
      const ceWorld = cloth
        ? this._worldP.copy(cloth.cp)
        : this._worldP.set(sail.ce.x, sail.ce.y * (0.35 + 0.65 * hoist), sail.ce.z);
      ceWorld.applyQuaternion(this._q).add(this._pos);
      this.body.addForceAtPoint(this._force, ceWorld, true);

      if (sail.name === 'main') {
        aero.mainBetaDeg = beta;
        aero.mainAlphaDeg = alpha;
        aero.luffing = alpha < 4 && aws > 1;
      } else {
        aero.jibBetaDeg = beta;
      }
    }
  }

  /**
   * The rudder is a lifting foil in the local water flow. Force scales with
   * flow speed SQUARED → no boat speed, no steering. Because the flow used
   * is the blade's own velocity (v + ω×r), the rudder also naturally damps
   * yaw and weathervanes the stern into any leeway.
   */
  _applyRudderForce() {
    const wp = this._worldP
      .copy(TUNING.rudderCenter)
      .applyQuaternion(this._q)
      .add(this._pos);

    // Water flow relative to the blade (orbital velocity included), body frame.
    this._r.copy(wp).sub(this._pos);
    this._vPoint.copy(this._angvel).cross(this._r).add(this._linvel).sub(this._waterVelC);
    this._aw.copy(this._vPoint).multiplyScalar(-1).applyQuaternion(this._invQ);
    const U = Math.hypot(this._aw.x, this._aw.z);
    if (U < 0.05) return;

    // Flow angle off dead-aft, and the blade's resulting angle of attack.
    const gamma = Math.atan2(this._aw.z, -this._aw.x);
    const rudderRad = THREE.MathUtils.degToRad(
      THREE.MathUtils.clamp(this.helm.rudderDeg, -TUNING.rudderMaxDeg, TUNING.rudderMaxDeg)
    );
    const alphaR = THREE.MathUtils.clamp(rudderRad - gamma, -Math.PI / 4, Math.PI / 4);

    // Side force in body +Z; sign: +rudder → stern pushed to port → bow
    // yaws to STARBOARD (verified in the headless sailing test).
    const F = -0.5 * RHO_WATER * TUNING.rudderArea * TUNING.rudderCL * Math.sin(2 * alphaR) * U * U;
    this._force.set(0, 0, F).applyQuaternion(this._q);
    this.body.addForceAtPoint(this._force, wp, true);
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
  }

  /**
   * Two-way coupling input from the cloth simulation (body frame).
   * @param {{main:{force,cp}, jib:{force,cp}}} data smoothed by Sails
   */
  setClothAero(data) {
    this._cloth.main.force.copy(data.main.force);
    this._cloth.main.cp.copy(data.main.cp);
    this._cloth.jib.force.copy(data.jib.force);
    this._cloth.jib.cp.copy(data.jib.cp);
    this._cloth.age = 0;
  }

  /** Orbital water velocity, or zero for oceans that don't provide it
   *  (flat-water test stubs). */
  _waterVelocityAt(x, z, out) {
    if (this.ocean.getWaterVelocityAt) return this.ocean.getWaterVelocityAt(x, z, out);
    return out.set(0, 0, 0);
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
    out.sog = Math.hypot(lv.x, lv.z) * MS_TO_KNOTS;
    // Signed speed along the bow — negative when making sternway. The
    // honest "am I actually beating upwind?" number (SOG counts drift).
    out.fwdKn = (lv.x * fwd.x + lv.y * fwd.y + lv.z * fwd.z) * MS_TO_KNOTS;
    out.heading = ((THREE.MathUtils.radToDeg(Math.atan2(fwd.x, -fwd.z)) % 360) + 360) % 360;
    out.heel = -THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(stbd.y, -1, 1)));
    out.pitch = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(fwd.y, -1, 1)));
    return out;
  }
}
