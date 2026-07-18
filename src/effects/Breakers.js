/**
 * Breakers.js — white water erupting at the moment a wave actually breaks.
 *
 * The surface shader can only PAINT foam; the instant of breaking is a 3D
 * event — an aerated burst thrown up and forward off the collapsing crest.
 * The FFT field gives us the exact trigger for free: the Jacobian of the
 * summed horizontal displacement drops toward/below zero precisely where the
 * surface is folding (including where two wave trains collide). This system
 * scans the water around the camera for those folds each frame and spawns
 * short-lived white-water puffs there, launched with the water's own orbital
 * velocity plus a crest kick, tumbling under gravity back into the sea.
 *
 * Rendering: soft round sprites that EXPAND and fade as they age — aerated
 * water bursts outward and dissolves, unlike spray streaks (Spindrift.js).
 */

import * as THREE from 'three';

const MAX = 1800;
const LIFE = 1.15; // s — a burst is violent and brief
const RADIUS = 90; // scan/spawn radius around the camera (m)
const CANDIDATES = 300; // fold-scan samples per frame
const J_SPAWN = 0.55; // folding onset: below this J a burst may fire

const VERT = /* glsl */ `
  attribute float aLife;
  attribute float aSeed;
  varying float vLife;
  varying float vSeed;
  varying float vNear;
  void main() {
    vLife = aLife;
    vSeed = aSeed;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNear = smoothstep(0.8, 3.0, -mv.z);
    // Puffs EXPAND as they age (aeration bursting outward): size grows with
    // (1 - life) while alpha falls, the classic explosion-sprite envelope.
    float grow = 1.0 + 2.6 * (1.0 - vLife);
    float px = (5.0 + 6.0 * aSeed) * grow * (60.0 / max(-mv.z, 1.0));
    gl_PointSize = clamp(px, 1.5, 42.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */ `
  varying float vLife;
  varying float vSeed;
  varying float vNear;
  // SMOOTH value noise for the ragged edge. A floor()-cell hash renders each
  // cell as a constant block — the puffs read as clusters of big square
  // pixels. Bilinear interpolation between cell hashes is what makes the
  // boil look like vapour instead of minecraft.
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i),              hash(i + vec2(1, 0)), u.x),
               mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }
  void main() {
    vec2 pc = gl_PointCoord - 0.5;
    float d = length(pc);
    // Edge raggedness + interior mottling, both from smooth noise; the puff
    // expands over its life (vertex), so drift the noise with age too and
    // the lumps appear to tumble as the burst grows.
    float age = 1.0 - vLife;
    float rag = 0.30 + 0.17 * vnoise(pc * 4.5 + vSeed * 61.0 + age * 1.5);
    float body = smoothstep(rag, rag * 0.3, d);
    body *= 0.7 + 0.4 * vnoise(pc * 9.0 - vSeed * 17.0 + age * 2.0);
    // Bright while fresh (entrained air scatters everything), dying to mist.
    float a = body * vLife * vLife * 0.55 * vNear;
    if (a < 0.02) discard;
    gl_FragColor = vec4(0.97, 0.99, 1.0, a);
  }
`;

export class Breakers {
  constructor(scene) {
    this.positions = new Float32Array(MAX * 3);
    this.velocities = new Float32Array(MAX * 3);
    this.life = new Float32Array(MAX);
    this.seeds = new Float32Array(MAX);
    for (let i = 0; i < MAX; i++) this.seeds[i] = Math.random();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('aLife', new THREE.BufferAttribute(this.life, 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(this.seeds, 1));
    this.points = new THREE.Points(
      geo,
      new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false })
    );
    this.points.frustumCulled = false;
    scene.add(this.points);
    this._cursor = 0;
    this._vel = new THREE.Vector3();
  }

  /**
   * @param {number} dt
   * @param {THREE.Vector3} camPos
   * @param {import('../ocean/Ocean.js').Ocean} ocean
   * @param {{x,y,z}} windVec  wind velocity (m/s), for the crest kick heading
   * @param {number} intensity 0 … 1 (wind-driven spawn budget)
   */
  update(dt, camPos, ocean, windVec, intensity) {
    if (intensity > 0.02 && dt > 0) {
      const wLen = Math.hypot(windVec.x, windVec.z) || 1;
      const wx = windVec.x / wLen;
      const wz = windVec.z / wLen;
      for (let c = 0; c < CANDIDATES; c++) {
        const x = camPos.x + (Math.random() - 0.5) * 2 * RADIUS;
        const z = camPos.z + (Math.random() - 0.5) * 2 * RADIUS;
        const J = ocean.fft.jacobianAt(x, z);
        if (J >= J_SPAWN) continue;
        // Deeper fold → more likely, bigger burst. Budget scales with wind.
        // Normalized to the J range that actually occurs (p1 ≈ 0.45 in a
        // gale — J rarely goes near 0), else bursts are homeopathic.
        const fold = Math.min((J_SPAWN - J) / 0.35, 1);
        if (Math.random() > fold * intensity * 0.25) continue;
        const h = ocean.getHeightAt(x, z);
        ocean.getWaterVelocityAt(x, z, this._vel);
        // Tell the listener (main.js → SoundSystem.wash): a crest is
        // collapsing HERE — audible breaking synced to the visible burst.
        if (this.onBurst) {
          this.onBurst(fold, Math.hypot(x - camPos.x, z - camPos.z), x, z);
        }
        const n = 5 + Math.floor(fold * 9);
        for (let e = 0; e < n; e++) {
          const i = this._cursor;
          this._cursor = (this._cursor + 1) % MAX;
          const i3 = i * 3;
          this.positions[i3] = x + (Math.random() - 0.5) * 1.6;
          this.positions[i3 + 1] = h + 0.1 + Math.random() * 0.3;
          this.positions[i3 + 2] = z + (Math.random() - 0.5) * 1.6;
          // The collapsing crest hands the burst its own orbital surge, plus
          // a forward-and-up kick along the wave's travel (downwind).
          const kick = 1.2 + 2.2 * fold;
          this.velocities[i3] = this._vel.x + wx * kick * 0.8 + (Math.random() - 0.5) * 1.2;
          this.velocities[i3 + 1] = Math.max(this._vel.y, 0) + kick * (0.5 + Math.random() * 0.7);
          this.velocities[i3 + 2] = this._vel.z + wz * kick * 0.8 + (Math.random() - 0.5) * 1.2;
          this.life[i] = 0.75 + Math.random() * 0.25;
        }
      }
    }

    const p = this.positions;
    const v = this.velocities;
    let any = false;
    for (let i = 0; i < MAX; i++) {
      if (this.life[i] <= 0) continue;
      any = true;
      const i3 = i * 3;
      v[i3 + 1] -= 8.5 * dt; // aerated water: gravity, mildly drag-reduced
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
