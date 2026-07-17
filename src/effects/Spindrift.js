/**
 * Spindrift.js — spray torn off the wave crests and driven downwind.
 *
 * In a strong blow the tops of the waves are ripped off into streaming spray.
 * This emits short-lived droplets from the sea surface around the camera —
 * preferentially where the water is high (crests) — and blows them downwind,
 * low over the water. Intensity ramps with wind, like the rain. A ring buffer
 * of point sprites, gravity + wind integrated.
 */

import * as THREE from 'three';

const MAX = 2600;
const LIFE = 1.0;
const RADIUS = 55; // emit within this radius of the camera (m)

const VERT = /* glsl */ `
  attribute float aLife;
  varying float vLife;
  void main() {
    vLife = aLife;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = (4.0 + 9.0 * (1.0 - aLife)) * (55.0 / max(-mv.z, 1.0));
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */ `
  varying float vLife;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.12, d) * vLife * 0.5;
    if (a < 0.02) discard;
    gl_FragColor = vec4(0.92, 0.96, 1.0, a);
  }
`;

export class Spindrift {
  constructor(scene) {
    this.positions = new Float32Array(MAX * 3);
    this.velocities = new Float32Array(MAX * 3);
    this.life = new Float32Array(MAX);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('aLife', new THREE.BufferAttribute(this.life, 1));
    this.points = new THREE.Points(
      geo,
      new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false })
    );
    this.points.frustumCulled = false;
    scene.add(this.points);
    this._cursor = 0;
    this._acc = 0;
  }

  /**
   * @param {number} dt
   * @param {THREE.Vector3} camPos
   * @param {import('../ocean/Ocean.js').Ocean} ocean  for surface height
   * @param {{x,y,z}} windVec  wind velocity (m/s)
   * @param {number} intensity 0 … 1 (wind-driven)
   */
  update(dt, camPos, ocean, windVec, intensity) {
    if (intensity > 0.02) {
      this._acc += intensity * 2400 * dt; // droplets/s at full blow
      let n = Math.min(120, Math.floor(this._acc));
      this._acc -= n;
      // Only spawn from the upper part of the wave field (crests) — bias by
      // sampling the surface and rejecting troughs.
      for (let e = 0; e < n; e++) {
        const x = camPos.x + (Math.random() - 0.5) * 2 * RADIUS;
        const z = camPos.z + (Math.random() - 0.5) * 2 * RADIUS;
        const h = ocean.getHeightAt(x, z);
        if (h < 0.12) continue; // troughs don't spray
        const i = this._cursor;
        this._cursor = (this._cursor + 1) % MAX;
        const i3 = i * 3;
        this.positions[i3] = x;
        this.positions[i3 + 1] = h + 0.15;
        this.positions[i3 + 2] = z;
        // torn downwind + a little up; the crest hands it its own speed
        this.velocities[i3] = windVec.x * 0.55 + (Math.random() - 0.5);
        this.velocities[i3 + 1] = 0.6 + Math.random() * 1.4;
        this.velocities[i3 + 2] = windVec.z * 0.55 + (Math.random() - 0.5);
        this.life[i] = 1;
      }
    }

    const p = this.positions;
    const v = this.velocities;
    let any = false;
    for (let i = 0; i < MAX; i++) {
      if (this.life[i] <= 0) continue;
      any = true;
      const i3 = i * 3;
      v[i3 + 1] -= 7.0 * dt; // gravity (mist, drag-reduced)
      p[i3] += v[i3] * dt;
      p[i3 + 1] += v[i3 + 1] * dt;
      p[i3 + 2] += v[i3 + 2] * dt;
      this.life[i] = Math.max(0, this.life[i] - dt / LIFE);
    }
    if (any) {
      this.points.geometry.attributes.position.needsUpdate = true;
      this.points.geometry.attributes.aLife.needsUpdate = true;
    }
  }
}
