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

export class Boat {
  /**
   * @param {THREE.Scene} scene
   * @param {import('../physics/PhysicsWorld.js').PhysicsWorld} physicsWorld
   * @param {import('../ocean/Ocean.js').Ocean} ocean
   */
  constructor(scene, physicsWorld, ocean) {
    this.model = createBoatModel();
    scene.add(this.model);

    this.physics = new BoatPhysics(physicsWorld, ocean);
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
    this._colSub = new THREE.Color(0x33ff66);
    this._colDry = new THREE.Color(0x556066);
  }

  /** Copy the physics transform onto the mesh; refresh debug markers. */
  updateVisuals() {
    const s = this.physics.getState(this._state);
    this.model.position.copy(s.position);
    this.model.quaternion.copy(s.quaternion);

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

  reset() {
    this.physics.reset();
  }
}
