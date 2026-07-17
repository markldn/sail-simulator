/**
 * SimRope.js — a simulated rope: the 1-D sibling of ClothSail.
 *
 * A chain of Verlet particles pinned at both ends, with gravity and
 * distance constraints. Give it more length than the straight-line span
 * and it hangs in a natural catenary; equal length and it pulls taut.
 * That one `length` parameter is the whole language of running rigging:
 * a hardened mainsheet is straight, an eased one sags, and the lazy jib
 * sheet droops across the foredeck until the next tack loads it.
 *
 * Rendered as an InstancedMesh of cylinders re-posed each frame — no
 * per-frame geometry allocation.
 */

import * as THREE from 'three';

const GRAVITY = -9.81;
const DAMPING = 0.96;
const ITERATIONS = 5;

export class SimRope {
  constructor(parent, { segments = 8, radius = 0.008, color = 0x8a2f2f } = {}) {
    this.segments = segments;
    this.n = segments + 1;
    this.pos = new Float32Array(this.n * 3);
    this.prev = new Float32Array(this.n * 3);
    this._laidOut = false;

    this.mesh = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(radius, radius, 1, 5),
      new THREE.MeshStandardMaterial({ color, roughness: 0.88, metalness: 0 }),
      segments
    );
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false; // the chain moves; static AABB lies
    parent.add(this.mesh);

    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._mid = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._scale = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
  }

  set visible(v) {
    this.mesh.visible = v;
  }

  /**
   * Simulate one frame and re-pose the cylinders.
   * @param {number} dt      frame delta (clamped internally)
   * @param {THREE.Vector3} a fixed end (boat frame)
   * @param {THREE.Vector3} b fixed end (boat frame)
   * @param {number} length  physical rope length; > |b−a| sags, ≈ taut
   */
  update(dt, a, b, length) {
    const { pos, prev, n } = this;
    if (!this._laidOut) {
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        const k = i * 3;
        pos[k] = a.x + (b.x - a.x) * t;
        pos[k + 1] = a.y + (b.y - a.y) * t;
        pos[k + 2] = a.z + (b.z - a.z) * t;
      }
      prev.set(pos);
      this._laidOut = true;
    }

    // pin the ends
    const e = (n - 1) * 3;
    pos[0] = prev[0] = a.x;
    pos[1] = prev[1] = a.y;
    pos[2] = prev[2] = a.z;
    pos[e] = prev[e] = b.x;
    pos[e + 1] = prev[e + 1] = b.y;
    pos[e + 2] = prev[e + 2] = b.z;

    // Verlet interior
    const h = Math.min(dt, 1 / 30);
    const h2 = h * h;
    for (let i = 1; i < n - 1; i++) {
      const k = i * 3;
      for (let d = 0; d < 3; d++) {
        const x = pos[k + d];
        pos[k + d] = x + (x - prev[k + d]) * DAMPING + (d === 1 ? GRAVITY * h2 : 0);
        prev[k + d] = x;
      }
    }

    // distance constraints (soft on compression so slack rope folds)
    const rest = Math.max(length, 0.02) / this.segments;
    for (let it = 0; it < ITERATIONS; it++) {
      for (let i = 0; i < n - 1; i++) {
        const ka = i * 3;
        const kb = ka + 3;
        const dx = pos[kb] - pos[ka];
        const dy = pos[kb + 1] - pos[ka + 1];
        const dz = pos[kb + 2] - pos[ka + 2];
        const dist = Math.hypot(dx, dy, dz);
        if (dist < 1e-9) continue;
        const k = dist < rest ? 0.15 : 1.0;
        const diff = ((dist - rest) / dist) * k;
        const endA = i === 0;
        const endB = i === n - 2;
        if (endA && endB) continue;
        const wa = endA ? 0 : endB ? 1 : 0.5;
        const wb = endB ? 0 : endA ? 1 : 0.5;
        pos[ka] += dx * diff * wa;
        pos[ka + 1] += dy * diff * wa;
        pos[ka + 2] += dz * diff * wa;
        pos[kb] -= dx * diff * wb;
        pos[kb + 1] -= dy * diff * wb;
        pos[kb + 2] -= dz * diff * wb;
      }
    }

    if (!Number.isFinite(pos[4])) {
      this._laidOut = false; // NaN watchdog: re-lay straight next frame
      return;
    }

    // re-pose the instanced cylinders
    for (let i = 0; i < this.segments; i++) {
      const ka = i * 3;
      const kb = ka + 3;
      this._dir.set(pos[kb] - pos[ka], pos[kb + 1] - pos[ka + 1], pos[kb + 2] - pos[ka + 2]);
      const len = Math.max(this._dir.length(), 1e-4);
      this._mid.set((pos[ka] + pos[kb]) / 2, (pos[ka + 1] + pos[kb + 1]) / 2, (pos[ka + 2] + pos[kb + 2]) / 2);
      this._q.setFromUnitVectors(this._up, this._dir.normalize());
      this._m.compose(this._mid, this._q, this._scale.set(1, len, 1));
      this.mesh.setMatrixAt(i, this._m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
