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
  SHEET_MIN_DEG,
  SHEET_MAX_DEG,
  sailCL,
  sailCD,
} from './SailAero.js';

const RHO_WATER = 1025; // kg/m³, salt water
const G = 9.81;

/**
 * Generic lifting-foil CL curve, shared by the keel and rudder (findings #1
 * and #6 of the physics review): linear attached flow up to stall, blending
 * over ~6° into the post-stall flat-plate cross-flow regime CL ≈ k·sinβ·cosβ.
 * Odd function of betaRad (a keel/rudder is symmetric port/starboard).
 */
function foilCL(betaRad, clAlpha, betaStallRad, crossFlowK = 1.1) {
  const sign = betaRad < 0 ? -1 : 1;
  const b = Math.abs(betaRad);
  const clStall = clAlpha * betaStallRad;
  if (b <= betaStallRad) return sign * clAlpha * b;
  const blendEnd = betaStallRad + THREE.MathUtils.degToRad(6);
  const blend = THREE.MathUtils.smoothstep(b, betaStallRad, blendEnd);
  const flatPlate = crossFlowK * Math.sin(b) * Math.cos(b);
  return sign * THREE.MathUtils.lerp(clStall, Math.max(flatPlate, 0), blend);
}

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
  // Retuned up from 900/1200 for added mass (finding #3): the heave
  // oscillator's effective inertia roughly doubles (m + m_a), so its
  // critical damping grows by √(m_a-inclusive/m) ≈ 1.4× — scale the damping
  // coefficients by the same factor to keep the same ~0.3-critical feel
  // rather than suddenly going underdamped. Nudge by eye once sailing.
  heaveLin: 1270, // N·s/m per m²
  heaveQuad: 1560, // N·s²/m² per m²
  // Added-mass coefficient (finding #3): a beamy semi-submerged canoe body
  // accelerating vertically must also accelerate water around it. Ca ≈ 1.0
  // for a semicircular section; this hull runs a little flatter aft.
  addedMassCa: 0.9,

  // Forward drag (skin friction + residuary), F = -(lin + quad·|v|)·v.
  // ≈ 1.1 kN at 6 kn — plausible for a 7.4 m displacement hull.
  fwdLin: 60,
  fwdQuad: 90,

  // Wave-making resistance: real displacement hulls hit a soft wall near
  // "hull speed" (classic estimate V(kn) ≈ 1.34·√LWL(ft), which is just the
  // statement that the boat's own bow-to-stern wave reaches Froude number
  // Fn = V/√(g·LWL) ≈ 0.4 at that speed — the hull is trying to climb its
  // own bow wave, and resistance rises steeply). fwdQuad alone has no such
  // hump — it would let the boat accelerate past hull speed under sail
  // about as easily as below it, which no real displacement hull does. This
  // extra term is ~zero below Fn≈0.30, then ramps in as a cubic in Fn (not a
  // hard cap — real boats CAN push past hull speed with enough power, just
  // at fast-rising cost): at Fn=0.40 (hull speed) it adds roughly as much
  // drag as fwdQuad alone at that speed; by Fn=0.45 (~12% over) it's ~4x
  // that, a real wall without being an absolute limit.
  waveMakingCoeff: 280, // N·s²/m² once the ramp is fully engaged
  waveMakingFnStart: 0.30,
  waveMakingFnSpan: 0.15,

  // Keel: a lifting foil (finding #1), not a damper — a real keel's side
  // force scales with forward speed² × leeway angle, not lateral speed²
  // alone, so it stays powerful at cruise speed and goes slack near a stop.
  // Fin ~1.15 m span × 1.4 m chord ≈ 1.6 m²; the hull acts as a mirror
  // plane → effective AR ≈ 2·span²/A ≈ 1.65, CLα = 2π/(1+2/AR) ≈ 2.8/rad.
  // Stalls ~13° (CL ≈ 0.63), then decays toward the flat-plate cross-flow
  // regime.
  keelArea: 1.6, // m²
  keelCLalpha: 2.8, // /rad
  keelStallDeg: 13,
  keelAR: 1.65,
  keelCD0: 0.008,
  // Residual damping: ~20% of the old pure-damping model, kept as a stand-in
  // for hull sideways drag and roll-induced sway damping that the foil above
  // doesn't cover, and to keep zero-forward-speed leeway from being
  // frictionless (a stalled/near-stationary keel still has SOME resistance).
  latLin: 80,
  latQuad: 360,
  keelCenter: new THREE.Vector3(HULL.keelX, -0.9, 0), // body frame

  // Body-frame rotational damping, N·m·s/rad (roll: c1 + c2·|ω|, finding
  // #10 — real roll damping is quadratic vortex shedding off the keel and
  // bilges: small rolls (at anchor) are lightly damped, big storm rolls
  // heavily damped. Tuned so a 15° free roll decays in ~4-6 cycles).
  rollDampLin: 800,
  rollDampQuad: 4000,
  yawDamp: 2500,
  // Retuned up alongside heaveLin/Quad for added mass (finding #3) — see
  // note there.
  pitchDamp: 16200, // calms wave-driven plunge cycles (~10% critical)

  // Rudder: a small balanced spade foil (finding #6) — same lift-curve
  // treatment as the keel, so it actually stalls instead of being strongest
  // at 45°. AR ≈ 2·(0.9²)/0.32 ≈ 5 (deep narrow spade under the hull) →
  // CLα = 2π/(1+2/5) ≈ 4.5/rad. Stalls ~18° (CL ≈ 1.4).
  rudderArea: 0.32, // m²
  rudderCLalpha: 4.5, // /rad
  rudderStallDeg: 18,
  rudderAR: 5,
  rudderCD0: 0.015,
  rudderMaxDeg: 32,
  rudderCenter: new THREE.Vector3(HULL.rudderX, -0.55, 0), // body frame

  // Windage: air drag on hull, cabin and rig. This is why a boat with
  // flogging sails still drifts downwind. windageArea is the BROADSIDE
  // (beam-on) reference area; finding #11 scales it down toward the bow-on
  // frontal area (~45% of broadside) as AWA swings forward, and adds the
  // heeled rig's own presented area on top.
  windageArea: 3.5, // m² frontal-ish
  windageCd: 0.85,
  windageCenter: new THREE.Vector3(0, 0.8, 0), // deck level, body frame
  windageMastArea: 2.2, // m² — mast/rigging/furled-sail area a knocked-down rig presents

  // Submersion realism follow-up: when a wave buries the whole hull, the
  // deck/cabin/topsides drag through water like any bluff body (not just
  // air-drag windage, which fades out as the exposed area shrinks — see
  // TUNING.windage* above and _hullSubmersion). Cd ~1.0 is a generic bluff
  // shape; area is the deckhouse+topsides cross-section a buried hull
  // presents.
  hullAwashArea: 3.2, // m²
  hullAwashCd: 1.0,
  // A submerged sail is wet cloth dragged through water, not flying in air
  // — Cd matches ClothSail.js's own WATER_CD for the same material.
  sailWaterCd: 0.9,
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
        // Slightly aft mass centre: the waterplane is fullest aft of
        // midships, so a centred mass floats bow-down. Tuned against the
        // flat-water test for level static trim.
        .setTranslation(-0.25, 0.05, 0)
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
        const x = stationX(t);
        this.samples.push({
          local: new THREE.Vector3(x, y, hb * u),
          area,
          // Column caps a little ABOVE the deck — see RESERVE_BUOYANCY.
          columnHeight: HULL.sheer - y + RESERVE_BUOYANCY,
          // Bow flare: forward sections WIDEN above the waterline on a real
          // hull, so immersing the bow generates rapidly growing lift — the
          // anti-nosedive reserve a fine entry otherwise lacks. Effective
          // column area grows with depth, ramping in over the fore third.
          flare: x > 1.4 ? (1.2 * (x - 1.4)) / (HULL.length / 2 - 1.4) : 0,
        });
      }
    }

    // Last submersion depth per sample (for the debug markers).
    this.lastDepth = new Float32Array(this.samples.length);
    // Previous substep's water-relative vertical velocity per sample, for
    // the added-mass finite difference (finding #3) — and whether that
    // sample was wet last substep, so a fresh dry→wet transition doesn't
    // diff against a stale/zeroed value and spike.
    this.prevRelVy = new Float32Array(this.samples.length);
    this._wasWet = new Uint8Array(this.samples.length);
    // Per-sample cooldown gate for the breaking-wave impulse (finding #13) —
    // rate-limits repeat hits so a persistently-folding patch under one
    // column doesn't fire every single 60 Hz substep.
    this.breakerCooldown = new Float32Array(this.samples.length);
    // How buried the hull is (0 dry deck … 1 fully awash) — drives hull
    // water-drag in and windage out as a wave buries the boat. Also read by
    // main.js to drive the deck-wetness visual (Runoff/material sheen).
    this._hullSubmersion = 0;

    // Bow-slam detector, consumed by the spray effect: the hardest
    // downward water impact seen at a forward station since the last time
    // main.js read it and zeroed it.
    this.slamIntensity = 0; // m/s of impact beyond the spray threshold
    this.slamPoint = new THREE.Vector3();

    // Preallocated temporaries — this code runs 60×/s, zero per-step GC.
    this._q = new THREE.Quaternion();
    this._invQ = new THREE.Quaternion();
    this._aw = new THREE.Vector3();
    this._awSail = new THREE.Vector3(); // per-sail wind-shear-adjusted apparent wind
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
    this._fwdAxis = new THREE.Vector3(); // world-frame body +X, held alongside _axis (lat)
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

    // Heel, shared by several drag/force terms below (findings #10, #11, #14).
    const stbdY = this._axis.set(0, 0, 1).applyQuaternion(this._q).y;
    const sinHeel = Math.abs(stbdY);

    // Hull submersion (0 dry deck … 1 fully awash), from how deep the deck
    // centre sits below the local water surface. Drives hull water-drag in
    // and windage out as a wave buries the boat (submersion realism
    // follow-up — previously nothing changed when the whole hull went
    // under: windage kept blowing air on a hull that was now underwater,
    // and there was no extra resistance for shoving a buried deck/cabin
    // through water).
    const deckWP = this._worldP.set(0, HULL.sheer, 0).applyQuaternion(this._q).add(this._pos);
    const deckWaterH = this.ocean.getHeightAt(deckWP.x, deckWP.z);
    this._hullSubmersion = THREE.MathUtils.clamp(deckWaterH - deckWP.y, 0, 1);

    // ---- 1. buoyancy + heave damping, per column -------------------------
    for (let i = 0; i < this.samples.length; i++) {
      const s = this.samples[i];
      const wp = this._worldP.copy(s.local).applyQuaternion(this._q).add(this._pos);

      this.breakerCooldown[i] = Math.max(0, this.breakerCooldown[i] - dt);

      const waterH = this.ocean.getHeightAt(wp.x, wp.z);
      const depth = THREE.MathUtils.clamp(waterH - wp.y, 0, s.columnHeight);
      this.lastDepth[i] = depth;
      if (depth <= 0) {
        this._wasWet[i] = 0;
        continue;
      }

      // Velocity of the hull at this point (v + ω × r), minus the water's
      // own analytic orbital velocity: the column damps RELATIVE motion.
      this._waterVelocityAt(wp.x, wp.z, this._waterVel);
      this._r.copy(wp).sub(this._pos);
      this._vPoint.copy(this._angvel).cross(this._r).add(this._linvel);
      const relVy = this._vPoint.y - this._waterVel.y;

      // Slam detection: a forward station driving down into the water
      // faster than ~1.3 m/s relative throws spray (read by main.js).
      if (s.local.x > 1.6 && depth < 0.6) {
        // Threshold 1.3 → 0.5 m/s (measured: bow-vs-water p20 ≈ 0.45 m/s in
        // a 26-kn sea). Driving through chop is a constant string of small
        // impacts and they should ALL throw some water — the burst size
        // already scales with intensity, so light contact = light spray and
        // the hardest slams still dominate. The old gate fired so rarely the
        // bow read as dry.
        const impact = -relVy - 0.5;
        if (impact > this.slamIntensity) {
          this.slamIntensity = impact;
          this.slamPoint.copy(wp);
        }
      }

      const areaEff = s.area * (1 + s.flare * Math.min(depth / 0.55, 1));

      // Smith effect (finding #8): the wave-varying part of subsurface
      // pressure decays with depth — using the full instantaneous crest
      // height as hydrostatic-everywhere over-excites the hull in the
      // short-wave band a 2.5 t hull should barely notice. Falls back to
      // the plain surface height for ocean stand-ins that don't implement it
      // (e.g. the flat-water test stub).
      const effH = this.ocean.effectiveHeightAt
        ? this.ocean.effectiveHeightAt(wp.x, wp.z, depth)
        : waterH;
      const pressureDepth = THREE.MathUtils.clamp(effH - wp.y, 0, s.columnHeight);
      const fBuoy = RHO_WATER * G * areaEff * pressureDepth;

      // The quadratic heave term is sized for ~1 m/s relative motion. In a
      // violent short-crested sea (directionality δ→0, storm wind) a pyramid
      // peak can rise under the hull at 6-8 m/s; unclamped, the v² term then
      // fires the boat clear of the water like a catapult — and catches it
      // again on the way down, a floaty stair-step descent. Real water
      // doesn't push harder than it can before it sprays/ventilates: cap the
      // damping velocity, let genuine slams go to the slam detector above.
      const relVyD = THREE.MathUtils.clamp(relVy, -4, 4);
      const fDamp = -areaEff * (TUNING.heaveLin + TUNING.heaveQuad * Math.abs(relVyD)) * relVyD;

      // Added mass (finding #3): the hull must accelerate the water around
      // it too — a reaction force opposing the RELATIVE VERTICAL
      // ACCELERATION (not velocity), estimated by differencing relVyD across
      // substeps. This is what stops the boat reacting to short chop like a
      // cork; the swell still moves it (accel is small and slow there).
      //
      // Two safety nets against the finite difference "flying" the boat in
      // steep/large seas (this DID happen without them — a fresh dry→wet
      // transition or a relVyD swing across its ±4 clamp produces a huge,
      // physically-meaningless spike; naive differencing is not guaranteed
      // energy-conserving under clamping and repeated spikes in the same
      // direction net-launch the hull over many substeps):
      //   1. skip the accel term entirely on the FIRST wet substep after a
      //      dry one — there is no valid "previous" sample to diff against.
      //   2. bound the resulting force to a multiple of this column's own
      //      buoyancy, so it can influence but never dominate/overpower the
      //      force actually holding the boat up.
      let fAddedMass = 0;
      if (this._wasWet[i]) {
        const relAccel = THREE.MathUtils.clamp((relVyD - this.prevRelVy[i]) / dt, -8, 8);
        fAddedMass = THREE.MathUtils.clamp(
          -RHO_WATER * TUNING.addedMassCa * areaEff * depth * relAccel,
          -1.2 * fBuoy - 100,
          1.2 * fBuoy + 100
        );
      }
      this.prevRelVy[i] = relVyD;
      this._wasWet[i] = 1;

      // Buoyancy slope tilt (finding #2): hydrostatic force acts along the
      // local pressure gradient, which tilts with the wave surface slope —
      // this is the force that makes a boat surf down a wave face and shoves
      // it sideways on a beam crest, instead of only ever bobbing straight
      // up. Central-differenced from the ACTUAL (unattenuated) surface, same
      // as what's rendered. Clamped: a folding crest can be locally
      // near-vertical, and real water that steep is breaking, not surfable
      // (see the breaker impulse below).
      const GRAD_EPS = 1.0; // m
      let slopeX =
        (this.ocean.getHeightAt(wp.x + GRAD_EPS, wp.z) -
          this.ocean.getHeightAt(wp.x - GRAD_EPS, wp.z)) /
        (2 * GRAD_EPS);
      let slopeZ =
        (this.ocean.getHeightAt(wp.x, wp.z + GRAD_EPS) -
          this.ocean.getHeightAt(wp.x, wp.z - GRAD_EPS)) /
        (2 * GRAD_EPS);
      const slopeMag = Math.hypot(slopeX, slopeZ);
      const SLOPE_CLAMP = 0.35;
      if (slopeMag > SLOPE_CLAMP) {
        const sc = SLOPE_CLAMP / slopeMag;
        slopeX *= sc;
        slopeZ *= sc;
      }

      b.addForceAtPoint(
        { x: -fBuoy * slopeX, y: fBuoy + fDamp + fAddedMass, z: -fBuoy * slopeZ },
        wp,
        true
      );

      // Breaking-wave impulse (finding #13): near the surface, a folding
      // crest (Jacobian → 0) shoves the hull bodily along the wave's
      // propagation direction — the mechanism behind real small-yacht
      // capsizes in survival conditions, and previously entirely absent (the
      // Jacobian breaking detector only drove foam/visuals). Approximates
      // "phase speed" from the finest cascade (the scale that's actually
      // folding here) and "propagation direction" from the local orbital
      // velocity (which points along-crest at a breaking peak). Rate-limited
      // per column so a persistently-folding patch doesn't fire every
      // substep — the cooldown IS the "clamp total impulse per event".
      if (this.breakerCooldown[i] <= 0 && depth < 0.5 && this.ocean.fft?.jacobianAt) {
        const J = this.ocean.fft.jacobianAt(wp.x, wp.z);
        const severity = Math.min(0.3 - J, 0.5);
        if (severity > 0) {
          const dirLen = Math.hypot(this._waterVel.x, this._waterVel.z);
          if (dirLen > 0.1) {
            const fine = this.ocean.fft.cascades[this.ocean.fft.cascades.length - 1];
            const c = Math.sqrt(G / Math.max(fine.kMin, 0.05));
            const mag = Math.min(RHO_WATER * 0.5 * severity * c * areaEff, 2500);
            this._force
              .set(this._waterVel.x / dirLen, 0, this._waterVel.z / dirLen)
              .multiplyScalar(mag);
            b.addForceAtPoint(this._force, wp, true);
            this.breakerCooldown[i] = 0.12; // ~one chop-crest cadence
          }
        }
      }
    }

    // ---- 2. forward hull drag (vs the water, not the world) ---------------
    const fwd = this._fwdAxis.set(1, 0, 0).applyQuaternion(this._q);
    const vFwd = this._vRel.copy(this._linvel).sub(this._waterVelC).dot(fwd);
    const speed = Math.abs(vFwd);
    // Wave-making resistance is governed by WATERLINE length, not LOA — the
    // bow/stern overhangs don't carry the hull's own wave (finding #7).
    const froude = speed / Math.sqrt(G * HULL.lwl);
    const wmRamp = THREE.MathUtils.clamp(
      (froude - TUNING.waveMakingFnStart) / TUNING.waveMakingFnSpan,
      0,
      2.5 // let it keep climbing well past hull speed rather than plateau
    );
    const waveMakingQuad = TUNING.waveMakingCoeff * wmRamp * wmRamp * wmRamp;
    // A heeled hull drags substantially more: asymmetric wetted shape, rail
    // immersed, rudder dragged at an angle (finding #14).
    const heelDragMult = 1 + 0.6 * sinHeel * sinHeel;
    const fFwd =
      -(TUNING.fwdLin + (TUNING.fwdQuad * heelDragMult + waveMakingQuad) * speed) * vFwd;
    this._force.copy(fwd).multiplyScalar(fFwd);
    b.addForce(this._force, true);

    // ---- 3. keel: lifting foil + residual damping (finding #1) ------------
    // A real keel is a lifting foil: side force scales with forward speed²
    // × leeway angle, not lateral speed² alone (the old pure-damping model),
    // so it stays powerful at cruise speed and goes slack near a stop —
    // exactly backwards from the old law.
    const keelWP = this._worldP.copy(TUNING.keelCenter).applyQuaternion(this._q).add(this._pos);
    this._r.copy(keelWP).sub(this._pos);
    this._vPoint.copy(this._angvel).cross(this._r).add(this._linvel).sub(this._waterVelC);
    const lat = this._axis.set(0, 0, 1).applyQuaternion(this._q);
    const vLat = this._vPoint.dot(lat);
    const vFwdKeel = this._vPoint.dot(fwd);
    const U2keel = vFwdKeel * vFwdKeel + vLat * vLat;
    const Ukeel = Math.sqrt(U2keel);

    this._force.set(0, 0, 0);
    if (Ukeel > 0.05) {
      // Leeway angle off the keel chord (fore-aft): the boat's own velocity
      // relative to water, NOT negated — positive vLat (drifting to
      // starboard) is a positive β.
      const beta = THREE.MathUtils.clamp(
        Math.atan2(vLat, Math.abs(vFwdKeel)),
        -Math.PI / 4,
        Math.PI / 4
      );
      const CL = foilCL(beta, TUNING.keelCLalpha, THREE.MathUtils.degToRad(TUNING.keelStallDeg));
      const CDi = (CL * CL) / (Math.PI * TUNING.keelAR);
      const q = 0.5 * RHO_WATER * TUNING.keelArea * U2keel;
      // Flow direction (unit, body XZ) arriving at the foil — same
      // "flow = −relative velocity" convention the rudder uses below.
      const flowFwd = -vFwdKeel / Ukeel;
      const flowLat = -vLat / Ukeel;
      const liftFwd = -flowLat;
      const liftLat = flowFwd;
      const Flift = q * CL;
      const Fdrag = q * (TUNING.keelCD0 + CDi);
      this._force.addScaledVector(fwd, liftFwd * Flift + flowFwd * Fdrag);
      this._force.addScaledVector(lat, liftLat * Flift + flowLat * Fdrag);
    }
    // Residual damping (see the TUNING.latLin/latQuad comment) — keeps
    // near-zero-speed leeway from being frictionless and stands in for hull
    // sideways drag the foil model above doesn't cover.
    this._force.addScaledVector(lat, -(TUNING.latLin + TUNING.latQuad * Math.abs(vLat)) * vLat);
    b.addForceAtPoint(this._force, keelWP, true);

    // ---- 3b. hull water drag when awash ------------------------------------
    // A wave burying the deck doesn't just stop windage from having anything
    // to push on (finding #11's fade) — the deck/cabin/topsides now drag
    // through WATER like any bluff body, ~800× the resistance of the air
    // that was there a moment ago. Applied at the CoM (approximate — this is
    // a coarse "how buried is the boat" correction, not a per-panel model).
    if (this._hullSubmersion > 0.02) {
      this._vRel.copy(this._linvel).sub(this._waterVelC);
      const relSpeed = this._vRel.length();
      if (relSpeed > 0.05) {
        const areaWet = TUNING.hullAwashArea * this._hullSubmersion;
        const dragMag = 0.5 * RHO_WATER * TUNING.hullAwashCd * areaWet * relSpeed;
        this._force.copy(this._vRel).multiplyScalar(-dragMag);
        b.addForce(this._force, true);
      }
    }

    // ---- 4. sails + rudder (Phase 3) --------------------------------------
    if (this.wind) {
      this._applyAeroForces();
      this._applyRudderForce();
    }

    // ---- 4b. turtle recovery ----------------------------------------------
    // An inverted hull is raft-stable in the column buoyancy model (wide flat
    // deck down, ballast balanced exactly overhead) — the boat could sit
    // turtled forever in a calm. A real capsized yacht doesn't: the cabin
    // floods, the deck loses buoyancy, and the smallest asymmetry lets the
    // keel lever it back over. Model that as a steady righting torque about
    // the roll axis whenever the masthead points below the horizon, in the
    // direction the boat is already leaning (or to port at dead-even).
    const upWorldY = 1 - 2 * (this._q.x * this._q.x + this._q.z * this._q.z); // body +Y in world, y component
    if (upWorldY < -0.2) {
      const fwdW = this._axis.set(1, 0, 0).applyQuaternion(this._q);
      // Which way is it leaning? Sign of the starboard axis' world height.
      const stbdW = this._force.set(0, 0, 1).applyQuaternion(this._q);
      const lean = stbdW.y >= 0 ? 1 : -1;
      // ~ ballast weight × 3 m lever. Must beat the inverted hull's raft
      // stability (waterplane stiffness of the wide flat deck ≈ 70 kN·m/rad)
      // long enough to roll past ~60°, where the keel takes over naturally.
      const T = HULL.ballastMass * G * 3.0 * lean;
      this._torque.copy(fwdW).multiplyScalar(T);
      b.addTorque(this._torque, true);
    }

    // ---- 5. rotational damping (body frame) -------------------------------
    // ω in body frame: roll about X, yaw about Y, pitch about Z.
    const wBody = this._torque.copy(this._angvel).applyQuaternion(this._invQ);
    // Roll damping is dominated by quadratic vortex shedding off the keel
    // and bilges, not one linear rate (finding #10): small rolls (a boat
    // rocking at anchor) are lightly damped, big storm rolls heavily damped.
    const rollTorque = -(TUNING.rollDampLin + TUNING.rollDampQuad * Math.abs(wBody.x)) * wBody.x;
    wBody.set(rollTorque, -TUNING.yawDamp * wBody.y, -TUNING.pitchDamp * wBody.z);
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

    // Heeling de-powers the rig (projected area shrinks) and swings the rig
    // itself into the wind's path (the mast windage term just below).
    const stbdY = this._axis.set(0, 0, 1).applyQuaternion(this._q).y;
    const sinHeel = Math.abs(stbdY);
    const cosHeel = Math.sqrt(Math.max(1 - stbdY * stbdY, 0.05));

    // Hull/rig windage — plain air drag at deck level, independent of sail
    // trim. A boat with flogging sails still gets blown downwind.
    const awH = Math.hypot(this._aw.x, this._aw.z);
    if (awH > 0.1) {
      // Bow-on frontal area is much less than beam-on broadside area
      // (finding #11): scale windageArea by how square-on the wind is to
      // the boat. Computed directly from the world-frame wind/heading angle
      // — the body-frame AWA isn't resolved until after the sail loop below.
      const fwdW = this._fwdAxis; // set this substep in applyForces' section 2
      const fwdXZ = Math.hypot(fwdW.x, fwdW.z) || 1;
      const sinAWA = Math.abs((this._aw.x * fwdW.z - this._aw.z * fwdW.x) / (awH * fwdXZ));
      const hullArea = TUNING.windageArea * (0.45 + 0.55 * sinAWA);
      // A knocked-down rig adds huge presented area: the mast/rigging swing
      // from edge-on (upright) to broadside-on (heeled over) as sinHeel
      // grows — why a boat lying a-hull under bare poles still drifts fast.
      const mastArea = TUNING.windageMastArea * sinHeel;
      // Fade to zero as the hull goes under (submersion realism follow-up):
      // a buried deck has no exposed area left for the wind to push on —
      // the hull water-drag term (applyForces §3b) takes over instead.
      const exposedFrac = 1 - this._hullSubmersion;
      const f = 0.5 * RHO_AIR * TUNING.windageCd * (hullArea + mastArea) * exposedFrac * awH;
      this._force.set(this._aw.x * f, 0, this._aw.z * f);
      const deckWP = this._worldP
        .copy(TUNING.windageCenter)
        .applyQuaternion(this._q)
        .add(this._pos);
      this.body.addForceAtPoint(this._force, deckWP, true);
    }

    // …then the sails, in the body frame. This "reference" apparent wind
    // (unsheared, deck-ish height) is what the HUD and the cloth sim see —
    // deliberately NOT the per-sail sheared value computed inside the loop
    // below, so instrument readouts and the cloth's own driving wind stay
    // exactly as they were.
    this._aw.applyQuaternion(this._invQ);
    aero.awBody.copy(this._aw); // cloth sim blows with exactly this wind
    const aws = Math.hypot(this._aw.x, this._aw.z);
    aero.awsKn = aws * MS_TO_KNOTS;
    if (aws < 0.2) {
      aero.luffing = true;
      return; // becalmed
    }
    aero.awaDeg = THREE.MathUtils.radToDeg(Math.atan2(-this._aw.z / aws, -this._aw.x / aws));

    // True wind, world frame — re-scaled per sail below by height (wind
    // shear), so captured once here rather than inside the loop.
    const trueWindWorld = this.wind.getWindVector();
    const trueWindX = trueWindWorld.x;
    const trueWindZ = trueWindWorld.z;

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

      // Live cloth centre of pressure, when fresh — resolved up front
      // because the wind-shear step just below needs its WORLD-frame
      // height (finding #12).
      const cloth =
        this.clothCouplingEnabled && this._cloth.age < 0.25 ? this._cloth[sail.name] : null;
      const ceWorld = cloth
        ? this._worldP.copy(cloth.cp)
        : this._worldP.set(sail.ce.x, sail.ce.y * (0.35 + 0.65 * hoist), sail.ce.z);
      ceWorld.applyQuaternion(this._q).add(this._pos);

      // Wind shear: real wind speed grows with height above the sea
      // (roughly a power law over open water), so the masthead genuinely
      // sees more breeze than the boom — real sails are cut with "twist"
      // for exactly this reason. Applied here as a height-dependent
      // apparent-wind recompute per sail (not just a visual twist — this is
      // the actual DRIVE force each sail's polar solve uses), referenced to
      // the standard 10 m meteorological height so wind.speedKnots means
      // what it always meant. Exponent 0.12 is a typical open-water value
      // (rougher terrain runs higher, ~0.14-0.4). Uses the CE's WORLD-frame
      // height (finding #12): a boat heeled 45° has its masthead measurably
      // lower in the real wind gradient — real sailors exploit exactly this
      // ("heeled boats feel less wind aloft") — which the old body-frame
      // sail.ce.y ignored entirely.
      const heightAboveSea = Math.max(ceWorld.y, 0.5);
      const shear = Math.pow(heightAboveSea / 10, 0.12);
      this._awSail.set(trueWindX * shear, 0, trueWindZ * shear).sub(this._linvel);
      this._awSail.applyQuaternion(this._invQ);
      const awsS = Math.hypot(this._awSail.x, this._awSail.z);
      if (awsS < 0.2) continue; // this sail specifically is becalmed

      const flowXs = this._awSail.x / awsS;
      const flowZs = this._awSail.z / awsS;
      const awaDegS = THREE.MathUtils.radToDeg(Math.atan2(-flowZs, -flowXs));
      const absAwa = Math.abs(awaDegS);
      const side = awaDegS >= 0 ? 1 : -1; // +1: wind over starboard

      // Lift is perpendicular to the flow, rotated towards the bow — the
      // rotation sign flips with tack. rot(v,θ): x'=x·c−z·s, z'=x·s+z·c
      const th = (side * Math.PI) / 2;
      const c = Math.cos(th);
      const s = Math.sin(th);
      const liftX = flowXs * c - flowZs * s;
      const liftZ = flowXs * s + flowZs * c;

      // Auto-trim target angle of attack (finding #4): 26° is CL-max, the
      // right target on a reach where lift points mostly forward — but
      // close-hauled, lift points mostly SIDEWAYS, so what matters is
      // drive-to-heel and lift-to-drag, both of which peak much lower
      // (≈13° for a soft rig). Sheeting to CL-max upwind is the classic
      // "sheeted in hard and going sideways" beginner error, here
      // institutionalised in the old fixed-α trimmer. Also eases further as
      // heel builds past ~25° — how a real trimmer de-powers a gust, giving
      // correct gust response for free (gust → heel builds → auto-ease →
      // boat stands up) instead of translating gusts straight into
      // knockdown.
      const alphaTarget =
        THREE.MathUtils.lerp(13, 26, THREE.MathUtils.smoothstep(absAwa, 35, 90)) -
        5 * THREE.MathUtils.smoothstep(sinHeel, 0.42, 0.7); // ~25°→45° heel

      // Sheet geometry: the boom weathervanes out to the sheet limit but
      // can never be pushed far windward of the apparent wind (it would
      // flog) — eased 4° past dead-on-the-wind for camber (finding #5): a
      // cambered sail doesn't luff until the flow attacks the LEE side, not
      // at literal zero incidence, so alpha is allowed to go slightly
      // negative before sailCL cuts it to zero.
      const betaMax = this.helm.autoTrim
        ? THREE.MathUtils.clamp(absAwa - alphaTarget, SHEET_MIN_DEG, SHEET_MAX_DEG)
        : THREE.MathUtils.clamp(
            this.helm.sheetMaxDeg * sail.sheetFactor,
            SHEET_MIN_DEG,
            SHEET_MAX_DEG
          );
      const beta = Math.min(betaMax, absAwa + 4);
      const alpha = absAwa - beta;

      // Past ~60° of heel the rig stops being a wing: flow separates off the
      // near-horizontal sail, the cloth blows out of shape, and by ~85° the
      // canvas is on the water. cosHeel alone bottoms out at 22% — at storm
      // apparent winds (force ∝ v²) that residual still dragged a capsized
      // boat through the sea like a kite. Smoothly kill drive across 60→85°.
      const knockdown = 1 - THREE.MathUtils.smoothstep(sinHeel, 0.87, 0.996);
      const q = 0.5 * RHO_AIR * awsS * awsS * sail.area * hoist * cosHeel * knockdown;
      const L = q * sailCL(alpha);
      const D = q * sailCD(alpha);

      this._force.set(liftX * L + flowXs * D, 0, liftZ * L + flowZs * D);
      // Luffing/flogging: polars say ~zero, the cloth knows better — blend
      // in its raw integrated pressure force (body frame).
      if (cloth && alpha < 6) {
        const wLuff = 1 - THREE.MathUtils.clamp((alpha - 2) / 4, 0, 1);
        this._force.addScaledVector(cloth.force, wLuff);
      }
      this._force.applyQuaternion(this._q);

      // A sail whose centre of effort is UNDER the sea surface is not flying
      // in air — it is wet cloth dragged through water (submersion realism
      // follow-up: this used to just vanish the force, silently, entirely —
      // now it's a real drag term against the local relative flow, same
      // physical picture as ClothSail.js's own submerged-particle drag,
      // just felt by the rigid body instead of only the visual mesh).
      if (ceWorld.y < this.ocean.getHeightAt(ceWorld.x, ceWorld.z)) {
        this._waterVelocityAt(ceWorld.x, ceWorld.z, this._waterVel);
        this._r.copy(ceWorld).sub(this._pos);
        this._vPoint.copy(this._angvel).cross(this._r).add(this._linvel).sub(this._waterVel);
        const relSpeed = this._vPoint.length();
        if (relSpeed > 0.05) {
          const dragMag = 0.5 * RHO_WATER * TUNING.sailWaterCd * sail.area * hoist * relSpeed;
          this._force.copy(this._vPoint).multiplyScalar(-dragMag);
          this.body.addForceAtPoint(this._force, ceWorld, true);
        }
        continue;
      }
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
   * The rudder is a lifting foil in the local water flow (finding #6): it
   * STALLS like the keel does, instead of being strongest at 45° (the old
   * CL·sin(2α) law). Force scales with flow speed SQUARED → no boat speed,
   * no steering. Because the flow used is the blade's own velocity
   * (v + ω×r), the rudder also naturally damps yaw and weathervanes the
   * stern into any leeway.
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
    const alphaR = THREE.MathUtils.clamp(rudderRad - gamma, -Math.PI / 2, Math.PI / 2);

    const CL = foilCL(alphaR, TUNING.rudderCLalpha, THREE.MathUtils.degToRad(TUNING.rudderStallDeg));
    const CDi = (CL * CL) / (Math.PI * TUNING.rudderAR);
    const q = 0.5 * RHO_WATER * TUNING.rudderArea * U * U;

    // Ventilation: as heel exceeds ~40° the blade nears the surface and
    // starts drawing air, losing bite. Pairs with the buoyancy slope force
    // (finding #2) to produce honest broaches instead of a rudder that
    // keeps steering a boat flat on its ear.
    const stbdY = this._axis.set(0, 0, 1).applyQuaternion(this._q).y;
    const heelFade = 1 - THREE.MathUtils.smoothstep(Math.abs(stbdY), 0.64, 0.9); // ~40°→64°

    // Lift ⟂ flow, drag ‖ flow, both in the body XZ plane. Flow direction is
    // (this._aw.x, this._aw.z)/U (already the "flow = −relative velocity"
    // convention above); rotate -90° for lift so a positive CL at positive
    // alphaR pushes the stern to port, matching the old sign convention
    // (verified: +rudder → stern to port → bow yaws to STARBOARD).
    const flowX = this._aw.x / U;
    const flowZ = this._aw.z / U;
    const liftX = -flowZ;
    const liftZ = flowX;
    const Flift = q * CL * heelFade;
    const Fdrag = q * (TUNING.rudderCD0 + CDi) * heelFade;
    this._force.set(liftX * Flift + flowX * Fdrag, 0, liftZ * Flift + flowZ * Fdrag);
    this._force.applyQuaternion(this._q);
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
    // Reject anything non-finite at the boundary: a poisoned frame is
    // simply dropped, the age grows stale, and the analytic fallback takes
    // over until the cloth recovers.
    const sum =
      data.main.force.x + data.main.force.y + data.main.force.z +
      data.jib.force.x + data.jib.force.y + data.jib.force.z +
      data.main.cp.x + data.main.cp.y + data.main.cp.z +
      data.jib.cp.x + data.jib.cp.y + data.jib.cp.z;
    if (!Number.isFinite(sum)) return;
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
