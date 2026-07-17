/**
 * Runoff.js — water running and dripping off the boat.
 *
 * When the hull throws spray or buries a rail, the decks and topsides are left
 * streaming. This drips that water back off: a wetness value (fed from slams
 * and green water in main.js) drives a steady rain of droplets falling from
 * anchor points along both toe rails and the sheer. Wetness decays over a few
 * seconds, so the boat "dries" after it comes clear of the sea.
 *
 * A fixed ring buffer of point sprites, gravity-integrated, ~1.5 s life — the
 * same cheap approach as Spray, tuned smaller, slower and more translucent so
 * it reads as runoff rather than thrown spray.
 */

import * as THREE from 'three';
import { HULL, halfBreadth, stationX } from '../boat/HullSpec.js';

const MAX_DROPS = 500;
const LIFE_SECONDS = 1.5;

const VERT = /* glsl */ `
  attribute float aLife;
  varying float vLife;
  void main() {
    vLife = aLife;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = (3.0 + 4.0 * vLife) * (52.0 / max(-mv.z, 1.0));
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */ `
  varying float vLife;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.1, d) * vLife * 0.7;
    if (a < 0.02) discard;
    gl_FragColor = vec4(0.85, 0.92, 1.0, a); // linear HDR; OutputPass tonemaps
  }
`;

export class Runoff {
  constructor(scene) {
    this.positions = new Float32Array(MAX_DROPS * 3);
    this.velocities = new Float32Array(MAX_DROPS * 3);
    this.life = new Float32Array(MAX_DROPS);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('aLife', new THREE.BufferAttribute(this.life, 1));

    this.points = new THREE.Points(
      geo,
      new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
      })
    );
    this.points.frustumCulled = false;
    scene.add(this.points);

    this._cursor = 0;
    this._emitAcc = 0;

    // Anchor points in BOAT frame: along both toe rails (sheer edge) plus a
    // lower band on the topsides, so water sheets off the deck AND the hull.
    this._anchors = [];
    for (const side of [-1, 1]) {
      for (let k = 0; k <= 11; k++) {
        const t = 0.06 + (k / 11) * 0.88;
        const z = side * (halfBreadth(t) - 0.04);
        this._anchors.push(new THREE.Vector3(stationX(t), HULL.sheer + 0.02, z));
        // a lower drip band on the topsides
        this._anchors.push(new THREE.Vector3(stationX(t), HULL.sheer - 0.28, z * 1.02));
      }
    }
    this._w = new THREE.Vector3(); // scratch: anchor in world
  }

  /**
   * @param {number} dt        frame delta
   * @param {{position:THREE.Vector3, quaternion:THREE.Quaternion}} pose hull pose
   * @param {{x,y,z}} boatVel   boat velocity (drips inherit a little)
   * @param {number} wetness    0 (dry) … 1 (streaming) — sets the drip rate
   */
  update(dt, pose, boatVel, wetness) {
    // ---- emit from the rails at a rate set by wetness ----------------------
    if (wetness > 0.01) {
      this._emitAcc += wetness * 130 * dt; // drops/second at full wetness
      let n = Math.floor(this._emitAcc);
      this._emitAcc -= n;
      n = Math.min(n, 40);
      for (let e = 0; e < n; e++) {
        const a = this._anchors[(Math.random() * this._anchors.length) | 0];
        this._w.copy(a).applyQuaternion(pose.quaternion).add(pose.position);
        const i = this._cursor;
        this._cursor = (this._cursor + 1) % MAX_DROPS;
        const i3 = i * 3;
        this.positions[i3] = this._w.x;
        this.positions[i3 + 1] = this._w.y;
        this.positions[i3 + 2] = this._w.z;
        // mostly just let go and fall, with a touch of outboard drift + the
        // boat's own motion so drips trail slightly aft.
        const out = Math.sign(a.z) || 1;
        this.velocities[i3] = boatVel.x * 0.3 + (Math.random() - 0.5) * 0.4;
        this.velocities[i3 + 1] = -0.2 - Math.random() * 0.4;
        this.velocities[i3 + 2] = boatVel.z * 0.3 + out * (0.1 + Math.random() * 0.3);
        this.life[i] = 1;
      }
    }

    // ---- integrate droplets (gravity) --------------------------------------
    const p = this.positions;
    const v = this.velocities;
    let any = false;
    for (let i = 0; i < MAX_DROPS; i++) {
      if (this.life[i] <= 0) continue;
      any = true;
      const i3 = i * 3;
      v[i3 + 1] -= 9.0 * dt;
      p[i3] += v[i3] * dt;
      p[i3 + 1] += v[i3 + 1] * dt;
      p[i3 + 2] += v[i3 + 2] * dt;
      this.life[i] = Math.max(0, this.life[i] - dt / LIFE_SECONDS);
    }
    if (any) {
      this.points.geometry.attributes.position.needsUpdate = true;
      this.points.geometry.attributes.aLife.needsUpdate = true;
    }
  }
}
