/**
 * Boat.js — binds the visual model (BoatModel) to the rigid body
 * (BoatPhysics) and owns the debug visualisation of the buoyancy samples.
 *
 * The physics body is the single source of truth for the transform; the
 * mesh group is snapped to it after every physics step. (If we later add
 * render interpolation between fixed steps, it happens here and only here.)
 */

import * as THREE from 'three';
import { createBoatModel } from './BoatModel.js';
import { BoatPhysics } from './BoatPhysics.js';
import { Sails } from './Sails.js';

export class Boat {
  /**
   * @param {THREE.Scene} scene
   * @param {import('../physics/PhysicsWorld.js').PhysicsWorld} physicsWorld
   * @param {import('../ocean/Ocean.js').Ocean} ocean
   * @param {import('../wind/WindManager.js').WindManager} wind
   * @param {{rudderDeg:number, sheetMaxDeg:number, autoTrim:boolean}} helmState
   * @param {import('../environment/SkySystem.js').SkySystem} [sky] for the
   *        sail backlight fake (see Sails._applyBacklight) — optional so
   *        headless/test construction still works without a sky.
   */
  constructor(scene, physicsWorld, ocean, wind, helmState, sky = null) {
    this.model = createBoatModel();
    scene.add(this.model);

    this.helmState = helmState;
    this.ocean = ocean; // for wet-sail submersion queries
    this.sky = sky;
    this.physics = new BoatPhysics(physicsWorld, ocean, wind, helmState);
    this.sails = new Sails(this.model);
    // Two-way coupling: cloth pressure/CP feeds back into hull forces.
    this.sails.onClothAero = (data) => this.physics.setClothAero(data);
    this._rudderGroup = this.model.getObjectByName('rudder');
    this._windex = this.model.getObjectByName('windex');
    this._compassCard = this.model.getObjectByName('compassCard');
    this._tiller = this.model.getObjectByName('tiller');
    this._wheelHelm = this.model.getObjectByName('wheelHelm');
    this._wheelSpin = this.model.getObjectByName('wheelSpin');
    this._state = {};

    // --- debug: buoyancy sample markers ------------------------------------
    // One instanced sphere per sample; green = submerged (pushing), grey =
    // dry. Watching these while waves roll under the hull is the quickest
    // way to sanity-check the whole buoyancy model.
    const n = this.physics.samples.length;
    this.sampleMarkers = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.07, 8, 6),
      new THREE.MeshBasicMaterial({ depthTest: false, transparent: true, opacity: 0.9 }),
      n
    );
    this.sampleMarkers.visible = false; // toggle in the Debug GUI folder
    this.sampleMarkers.renderOrder = 10;
    scene.add(this.sampleMarkers);

    this._m4 = new THREE.Matrix4();
    this._v3 = new THREE.Vector3();
    this._vWater = new THREE.Vector3(); // scratch: sail water-current velocity
    this._qInv = new THREE.Quaternion(); // scratch: inverse hull orientation
    this._colSub = new THREE.Color(0x33ff66);
    this._colDry = new THREE.Color(0x556066);
    this._sunState = this.sky ? { dirWorld: new THREE.Vector3(), color: new THREE.Color(), quaternion: new THREE.Quaternion() } : null;
  }

  /**
   * Copy the physics transform onto the mesh; pose sails and rudder;
   * refresh debug markers.
   * @param {number} time simulation clock (sail flutter phase)
   * @param {number} dt   frame delta (boom swing smoothing)
   */
  updateVisuals(time = 0, dt = 1 / 60) {
    const s = this.physics.getState(this._state);
    this.model.position.copy(s.position);
    this.model.quaternion.copy(s.quaternion);

    // Wet sails: find which cloth particles are under the wave surface and,
    // for those, the local water-current velocity (boat frame) that will
    // advect them. Feeds cloth hydrodynamics + material darkening. (Uses last
    // frame's cloth positions with this frame's hull pose — invisible lag.)
    const mainSub = this._updateSailWater(this.sails.main, s);
    const jibSub = this._updateSailWater(this.sails.jib, s);
    this.sails.setWetness(mainSub, jibSub, dt);
    if (this._sunState) {
      this._sunState.dirWorld.copy(this.sky.sunDir);
      this._sunState.color.copy(this.sky.sunColor);
      this._sunState.quaternion.copy(s.quaternion);
    }
    this.sails.update(this.physics.lastAero, time, dt, this.physics.sailPlan, this._sunState);
    // +rudderDeg = bow to starboard: blade trailing edge swings starboard,
    // tiller sweeps to port — matching real tiller geometry.
    this._rudderGroup.rotation.y = THREE.MathUtils.degToRad(this.helmState.rudderDeg);
    // Masthead windex points INTO the apparent wind.
    this._windex.rotation.y = -THREE.MathUtils.degToRad(this.physics.lastAero.awaDeg);
    // Compass card: cancel the hull's rotation so the card stays level and
    // north-aligned in the world — gimbal and magnet in one line. The boat
    // (and its fixed red lubber line) turns AROUND the card, exactly like
    // the real instrument.
    if (this._compassCard) {
      this._compassCard.quaternion.copy(s.quaternion).invert();
    }
    // Wheel helm (if selected): spin with the rudder, ~2.5 turns lock-to-lock.
    if (this._wheelSpin && this._wheelHelm.visible) {
      this._wheelSpin.rotation.x = -THREE.MathUtils.degToRad(this.helmState.rudderDeg) * 2.5;
    }

    if (this.sampleMarkers.visible) {
      const { samples, lastDepth } = this.physics;
      for (let i = 0; i < samples.length; i++) {
        this._v3.copy(samples[i].local).applyQuaternion(s.quaternion).add(s.position);
        this._m4.setPosition(this._v3);
        this.sampleMarkers.setMatrixAt(i, this._m4);
        this.sampleMarkers.setColorAt(i, lastDepth[i] > 0.005 ? this._colSub : this._colDry);
      }
      this.sampleMarkers.instanceMatrix.needsUpdate = true;
      this.sampleMarkers.instanceColor.needsUpdate = true;
    }
    return s; // heading/heel/sog etc. for the HUD and chase camera
  }

  /**
   * Build a sail's hydrodynamic water field for this frame and return its
   * submerged fraction. For each cloth particle it computes the world depth
   * below the wave surface; submerged particles get a subWeight (0..1) and the
   * local water-current velocity in BOAT frame (so ClothSail can drag them
   * along with the flow). A cheap min-height reject skips all the ocean
   * sampling in the common case where the sail is well clear of the water.
   * @param {import('./ClothSail.js').ClothSail} cloth
   * @param {{position:THREE.Vector3, quaternion:THREE.Quaternion}} s hull pose
   * @returns {number} submerged fraction, 0 … 1
   */
  _updateSailWater(cloth, s) {
    const sw = cloth.subWeight;
    if (!cloth.mesh.visible) {
      cloth.submerged = false;
      sw.fill(0);
      return 0;
    }
    const pos = cloth.pos;
    const q = s.quaternion;
    const px = s.position.x;
    const py = s.position.y;
    const pz = s.position.z;

    // Cheap reject: lowest cloth point vs the surface near the boat. Sails ride
    // metres up, so this early-outs every normal frame with one height query.
    let minY = Infinity;
    for (let p = 0; p < cloth.n; p++) {
      const k = p * 3;
      this._v3.set(pos[k], pos[k + 1], pos[k + 2]).applyQuaternion(q);
      const wy = this._v3.y + py;
      if (wy < minY) minY = wy;
    }
    if (minY > this.ocean.getHeightAt(px, pz) + 1.5) {
      cloth.submerged = false;
      sw.fill(0);
      return 0;
    }

    // Full pass: per-particle depth, submersion weight, and boat-frame current.
    this._qInv.copy(q).conjugate();
    const wv = cloth.waterVel;
    let below = 0;
    let anySub = false;
    for (let p = 0; p < cloth.n; p++) {
      const k = p * 3;
      this._v3.set(pos[k], pos[k + 1], pos[k + 2]).applyQuaternion(q);
      const wx = this._v3.x + px;
      const wy = this._v3.y + py;
      const wz = this._v3.z + pz;
      const depth = this.ocean.getHeightAt(wx, wz) - wy;
      if (depth > 0) {
        anySub = true;
        below++;
        sw[p] = depth > 0.3 ? 1 : depth / 0.3; // ramp in over the top 0.3 m
        this.ocean.getSubsurfaceVelocityAt(wx, wz, depth, this._vWater);
        this._vWater.applyQuaternion(this._qInv); // world → boat frame
        wv[k] = this._vWater.x;
        wv[k + 1] = this._vWater.y;
        wv[k + 2] = this._vWater.z;
      } else {
        sw[p] = 0;
        wv[k] = wv[k + 1] = wv[k + 2] = 0;
      }
    }
    cloth.submerged = anySub;
    return below / cloth.n;
  }

  /** Swap the cockpit between tiller and wheel steering (GUI "Helm style"). */
  setHelmStyle(style) {
    const wheel = style === 'wheel';
    if (this._tiller) this._tiller.visible = !wheel;
    if (this._wheelHelm) this._wheelHelm.visible = wheel;
  }

  reset() {
    this.physics.reset();
    this.sails.resetCloth();
  }
}
