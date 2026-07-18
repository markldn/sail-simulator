/**
 * Spray.js — bow-spray particles.
 *
 * A fixed-size ring buffer of point sprites driven by the slam detector in
 * BoatPhysics (a forward buoyancy station hitting the water hard). No
 * timers, no fakery: spray happens exactly when and where the hull slams,
 * so beating into a chop throws sheets to leeward while a downwind run
 * stays dry — same as the real thing.
 *
 * Rendering: real thrown spray is a sheet of small droplets that read as
 * thin MOTION STREAKS, not round puffs — so each sprite is drawn as a
 * capsule stretched along its own screen-space velocity, with per-droplet
 * random size, a hard cap on point size (an uncapped 52/z blew a droplet
 * near the camera up into a giant white blob), and a fade-out when a drop
 * gets within arm's reach of the camera.
 */

import * as THREE from 'three';

const MAX_PARTICLES = 1500;
const LIFE_SECONDS = 1.05;

const VERT = /* glsl */ `
  attribute float aLife;
  attribute float aSeed;
  attribute vec3  aVel;
  varying float vLife;
  varying float vSeed;
  varying float vNear;
  varying vec2  vDir;   // screen-space motion direction (pointCoord frame)
  varying float vHalf;  // streak half-length in pointCoord units
  void main() {
    vLife = aLife;
    vSeed = aSeed;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    // Motion over ~a frame, in view space → the streak the eye would see.
    vec4 mv2 = modelViewMatrix * vec4(position + aVel * 0.016, 1.0);
    vec2 d = mv2.xy - mv.xy;
    float dl = length(d);
    // pointCoord y runs DOWN the sprite, view-space y runs up — flip it.
    vDir = dl > 1e-5 ? vec2(d.x, -d.y) / dl : vec2(0.0, 1.0);
    vHalf = clamp(dl * 30.0 / max(-mv.z, 1.0), 0.05, 0.40);
    // Droplets that drift right up to the lens must dissolve, not fill it.
    vNear = smoothstep(0.7, 2.2, -mv.z);
    float px = (1.2 + 1.8 * aSeed) * (52.0 / max(-mv.z, 1.0));
    gl_PointSize = clamp(px, 1.0, 14.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */ `
  varying float vLife;
  varying float vSeed;
  varying float vNear;
  varying vec2  vDir;
  varying float vHalf;
  void main() {
    // Capsule: distance to a segment through the sprite centre along the
    // droplet's own motion — a falling drop draws as a thin streak.
    vec2 pc = gl_PointCoord - 0.5;
    float along = clamp(dot(pc, vDir), -vHalf, vHalf);
    float d = length(pc - vDir * along);
    float w = 0.10 + 0.07 * vSeed;
    float a = smoothstep(w, w * 0.3, d) * vLife * 0.38 * vNear;
    if (a < 0.02) discard;
    gl_FragColor = vec4(0.92, 0.96, 1.0, a); // linear HDR; OutputPass tonemaps
  }
`;

export class Spray {
  constructor(scene) {
    this.positions = new Float32Array(MAX_PARTICLES * 3);
    this.velocities = new Float32Array(MAX_PARTICLES * 3);
    this.life = new Float32Array(MAX_PARTICLES); // 1 → 0
    this.seeds = new Float32Array(MAX_PARTICLES);
    for (let i = 0; i < MAX_PARTICLES; i++) this.seeds[i] = Math.random();

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('aLife', new THREE.BufferAttribute(this.life, 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(this.seeds, 1));
    geo.setAttribute('aVel', new THREE.BufferAttribute(this.velocities, 3));

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
    // A sheet of many small droplets, not a handful of big puffs. Sized so a
    // real slam reads as a proper burst of white water off the bow, not a
    // polite sneeze — the clash of hull and wave is the moment to spend
    // particles on.
    const count = Math.min(140, Math.floor(24 + intensity * 45));
    const kick = Math.min(intensity, 4);
    for (let n = 0; n < count; n++) {
      const i = this._cursor;
      this._cursor = (this._cursor + 1) % MAX_PARTICLES;
      const i3 = i * 3;
      // Start on the hull flank, spread along it so the burst is a SHEET,
      // not a clump (a tight cluster of overlapping sprites reads as one
      // cotton-wool blob however small the individual drops are).
      this.positions[i3] = pos.x + (Math.random() - 0.5) * 1.6;
      this.positions[i3 + 1] = pos.y + 0.15;
      this.positions[i3 + 2] = pos.z + (Math.random() - 0.5) * 1.6;
      // Up-and-outward cone, inheriting most of the boat's motion
      this.velocities[i3] = boatVel.x * 0.75 + (Math.random() - 0.5) * (2.6 + kick);
      this.velocities[i3 + 1] = 1.6 + Math.random() * (1.2 + kick * 1.1);
      this.velocities[i3 + 2] = boatVel.z * 0.75 + (Math.random() - 0.5) * (2.6 + kick);
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
      // A droplet ending its flight = a splashdown. main.js hands the count
      // to SoundSystem.patter(), so the patter you hear IS these particles
      // landing — same source, same timing, same density.
      if (this.life[i] === 0) this.splashdowns = (this.splashdowns || 0) + 1;
    }
    if (any) {
      this.points.geometry.attributes.position.needsUpdate = true;
      this.points.geometry.attributes.aLife.needsUpdate = true;
      this.points.geometry.attributes.aVel.needsUpdate = true;
    }
  }
}
