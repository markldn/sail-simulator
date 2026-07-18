/**
 * Birds.js — a small flock of gulls wheeling over the sea.
 *
 * Each gull is a tiny two-wing model that banks around a slowly drifting
 * orbit centre near the boat, flapping in bursts and gliding between them
 * (real gulls flap-flap-glide; constant flapping reads as a wind-up toy).
 * When a gull's orbit drifts too far from the camera it is respawned ahead,
 * so there are always a few in view without ever simulating hundreds.
 */

import * as THREE from 'three';

const COUNT = 8;
const RESPAWN_DIST = 320;

export class Birds {
  constructor(scene) {
    this.group = new THREE.Group();
    scene.add(this.group);
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0xe8e9ea, roughness: 0.9 });
    const tipMat = new THREE.MeshStandardMaterial({ color: 0x3a3d40, roughness: 0.9 });
    this.birds = [];
    for (let i = 0; i < COUNT; i++) {
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.035, 0.22, 3, 6), bodyMat);
      body.rotation.z = Math.PI / 2;
      g.add(body);
      const wings = [];
      for (const side of [-1, 1]) {
        const wing = new THREE.Group();
        const inner = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.008, 0.32), bodyMat);
        inner.position.z = side * 0.16;
        wing.add(inner);
        const tip = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.007, 0.24), tipMat);
        tip.position.z = side * 0.42;
        wing.add(tip);
        g.add(wing);
        wings.push(wing);
      }
      this.group.add(g);
      this.birds.push({
        g,
        wings,
        centre: new THREE.Vector3(),
        radius: 12 + Math.random() * 30,
        height: 6 + Math.random() * 18,
        ang: Math.random() * Math.PI * 2,
        angVel: (0.15 + Math.random() * 0.25) * (Math.random() < 0.5 ? -1 : 1),
        phase: Math.random() * 10,
        // flap-burst clock: > 0 while flapping, < 0 while gliding
        flapT: Math.random() * 3,
        seed: Math.random(),
      });
      this._spawn(this.birds[i], new THREE.Vector3(), true);
    }
    this._v = new THREE.Vector3();
  }

  _spawn(b, camPos, anywhere = false) {
    const a = Math.random() * Math.PI * 2;
    const d = anywhere ? 30 + Math.random() * 120 : 120 + Math.random() * 80;
    b.centre.set(camPos.x + Math.cos(a) * d, 0, camPos.z + Math.sin(a) * d);
    b.height = 6 + Math.random() * 18;
    b.radius = 12 + Math.random() * 30;
  }

  update(dt, camPos, windVec, time) {
    for (const b of this.birds) {
      // The orbit centre drifts downwind a little (gulls work the gusts).
      b.centre.x += windVec.x * 0.04 * dt;
      b.centre.z += windVec.z * 0.04 * dt;
      if (b.centre.distanceTo(camPos) > RESPAWN_DIST) this._spawn(b, camPos);

      b.ang += b.angVel * dt;
      const px = b.centre.x + Math.cos(b.ang) * b.radius;
      const pz = b.centre.z + Math.sin(b.ang) * b.radius;
      const py = b.height + Math.sin(time * 0.31 + b.phase) * 1.6;
      b.g.position.set(px, py, pz);

      // Face along the direction of travel; bank into the turn.
      const heading = b.ang + (b.angVel > 0 ? Math.PI / 2 : -Math.PI / 2);
      b.g.rotation.set(0, -heading, 0);
      b.g.rotateX(-0.35 * Math.sign(b.angVel));

      // Flap-flap-glide: bursts of flapping, then wings held in a shallow V.
      b.flapT -= dt;
      if (b.flapT < -1.4 - b.seed * 2.5) b.flapT = 1.0 + b.seed * 1.2; // next burst
      const flapping = b.flapT > 0;
      const w = flapping
        ? Math.sin(time * 11 + b.phase * 7) * 0.75
        : 0.18; // glide dihedral (both wings held slightly up)
      b.wings[0].rotation.x = w;
      b.wings[1].rotation.x = -w;
    }
  }
}
