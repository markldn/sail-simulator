/**
 * Spray.js — bow-spray particles.
 *
 * A fixed-size ring buffer of point sprites driven by the slam detector in
 * BoatPhysics (a forward buoyancy station hitting the water hard). No
 * timers, no fakery: spray happens exactly when and where the hull slams,
 * so beating into a chop throws sheets to leeward while a downwind run
 * stays dry — same as the real thing.
 *
 * Rendering: custom points shader — each droplet cluster expands and fades
 * over its ~1 s life, with gravity and a touch of wind carry.
 */

import * as THREE from 'three';

const MAX_PARTICLES = 600;
const LIFE_SECONDS = 1.05;

const VERT = /* glsl */ `
  attribute float aLife;
  varying float vLife;
  void main() {
    vLife = aLife;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    // puffs EXPAND as they age (1-aLife grows), shrink with distance
    gl_PointSize = (5.0 + 11.0 * (1.0 - aLife)) * (52.0 / max(-mv.z, 1.0));
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */ `
  varying float vLife;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.12, d) * vLife * 0.7;
    if (a < 0.02) discard;
    gl_FragColor = vec4(0.92, 0.96, 1.0, a); // linear HDR; OutputPass tonemaps
  }
`;

export class Spray {
  constructor(scene) {
    this.positions = new Float32Array(MAX_PARTICLES * 3);
    this.velocities = new Float32Array(MAX_PARTICLES * 3);
    this.life = new Float32Array(MAX_PARTICLES); // 1 → 0

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('aLife', new THREE.BufferAttribute(this.life, 1));

    this.points = new THREE.Points(
      geo,
      new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false, // droplets shouldn't z-fight each other
      })
    );
    this.points.frustumCulled = false;
    scene.add(this.points);

    this._cursor = 0;
  }

  /**
   * Emit a burst at a slam point.
   * @param {THREE.Vector3} pos       world impact point (hull surface)
   * @param {{x,y,z}}       boatVel   boat velocity (spray inherits it)
   * @param {number}        intensity slam m/s beyond threshold (≈0–4)
   */
  burst(pos, boatVel, intensity) {
    const count = Math.min(26, Math.floor(6 + intensity * 12));
    const kick = Math.min(intensity, 3);
    for (let n = 0; n < count; n++) {
      const i = this._cursor;
      this._cursor = (this._cursor + 1) % MAX_PARTICLES;
      const i3 = i * 3;
      // Start on the hull flank, slightly spread
      this.positions[i3] = pos.x + (Math.random() - 0.5) * 0.9;
      this.positions[i3 + 1] = pos.y + 0.15;
      this.positions[i3 + 2] = pos.z + (Math.random() - 0.5) * 0.9;
      // Up-and-outward cone, inheriting most of the boat's motion
      this.velocities[i3] = boatVel.x * 0.75 + (Math.random() - 0.5) * (1.6 + kick);
      this.velocities[i3 + 1] = 1.6 + Math.random() * (1.2 + kick * 1.1);
      this.velocities[i3 + 2] = boatVel.z * 0.75 + (Math.random() - 0.5) * (1.6 + kick);
      this.life[i] = 1;
    }
  }

  /** Integrate droplets: gravity (drag-reduced — it's mist, not shot). */
  update(dt) {
    const p = this.positions;
    const v = this.velocities;
    let any = false;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (this.life[i] <= 0) continue;
      any = true;
      const i3 = i * 3;
      v[i3 + 1] -= 6.5 * dt; // ~0.66 g effective: air drag on droplets
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
