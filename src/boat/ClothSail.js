/**
 * ClothSail.js — a real cloth simulation for sails.
 *
 * Position-Based Dynamics (Verlet integration + iterative distance
 * constraints), the standard real-time cloth method. Per substep:
 *
 *   1. Wind pressure per TRIANGLE:  F = ½·ρ·Cd·A·(v_rel·n̂)·|v_rel·n̂|·n̂
 *      where v_rel = wind − cloth velocity. Using the cloth's own velocity
 *      gives aerodynamic damping for free: a filled sail is pressed still,
 *      an edge-on sail flogs chaotically — no scripted "flutter modes".
 *   2. Gravity (sail cloth is light, ~0.28 kg/m², so a becalmed sail sags
 *      and hangs — also for free).
 *   3. Verlet integrate, then N iterations of distance constraints:
 *      structural (warp/weft), shear (diagonals), bending (skip-one, soft).
 *   4. Rope constraints: one-sided — a sheet can PULL its corner but never
 *      push (this is what makes the jib fly across on a tack).
 *
 * Rest lengths carry separate x/y components scaled by (sx, sy) at solve
 * time — that's how reefing (sy: main drops its head) and furling (sx: jib
 * rolls up) reshape the cloth smoothly instead of teleporting vertices.
 *
 * The inflow gets a small deterministic turbulence component. Honest
 * physics: real apparent wind is never laminar, and it is exactly that
 * unsteadiness that keeps a trimmed leech alive.
 *
 * Pure math + three.js containers — runs headless (see test-cloth.mjs).
 */

import * as THREE from 'three';

const AIR_RHO = 1.225;
const WATER_RHO = 1025; // seawater — ~840× air, so submerged cloth is water-led
const WATER_CD = 0.9;
const PRESSURE_CD = 1.15;
const GRAVITY = -9.81;
const DAMPING = 0.985; // velocity retained per substep
const ITERATIONS = 5;
const MAX_FORCE_ACC = 450; // m/s² clamp — belt & braces against blow-ups

export class ClothSail {
  /**
   * @param {THREE.Object3D|null} parent scene-graph parent (null = headless)
   * @param {object} opts
   *   rows, cols   grid resolution (rows = up the luff, cols = aft)
   *   layout(s,c)  → [x, y]: the FLAT cut of the sail in boat frame (z=0);
   *                rest lengths and masses derive from this
   *   material     THREE.Material for the mesh
   *   clothDensity kg/m²
   */
  /**
   * broadseam: extra chordwise girth built into the cut (real sails are not
   * flat panels — the sailmaker adds cloth so the sail takes a cambered
   * flying shape). 0.035 ≈ a moderate cruising cut.
   */
  constructor(parent, { rows, cols, layout, material, clothDensity = 0.28, broadseam = 0 }) {
    this.rows = rows;
    this.cols = cols;
    this.n = rows * cols;
    this.layout = layout;

    this.pos = new Float32Array(this.n * 3);
    this.prev = new Float32Array(this.n * 3);
    this.force = new Float32Array(this.n * 3);
    this.invMass = new Float32Array(this.n);
    this.pinned = new Uint8Array(this.n);
    this.ropes = []; // {index, ax, ay, az, rest} — set each frame by Sails

    // Aerodynamic drive scale: 1 in air, ~0 once the cloth is in the water.
    // A submerged sail is not filled by wind — it goes limp and drifts with
    // the boat/water instead of holding a flying shape (set by Sails).
    this.windScale = 1;

    // Hydrodynamic advection (set per-frame by Boat when a sail touches the
    // sea): submerged particles are driven by WATER drag toward the local
    // orbital current velocity, in boat frame. subWeight ∈ [0,1] per particle
    // gates wind out and water in, so a half-dipped sail is handled correctly.
    this.submerged = false;
    this.subWeight = new Float32Array(this.n); // 0 dry … 1 fully underwater
    this.waterVel = new Float32Array(this.n * 3); // boat-frame water velocity

    // Capsule colliders (rigging): {ax,ay,az, bx,by,bz, r} segments the
    // cloth may not penetrate — mast, shrouds. Set once by Sails.
    this.colliders = [];

    // Integrated aero state, refreshed every step() — the two-way coupling
    // channel: total pressure force, torque about the body origin, and the
    // |F|-weighted centre of pressure.
    this.aeroForce = new THREE.Vector3();
    this.aeroTorque = new THREE.Vector3();
    this.pressureCentroid = new THREE.Vector3();
    this.pressureWeight = 0;

    const id = (i, j) => i * cols + j;
    this.id = id;

    // --- particles from the flat cut ---------------------------------------
    // Millimetre-scale deterministic z imperfection: perfectly planar cloth
    // is a symmetric unstable equilibrium — it can never START to buckle or
    // sag. Real cloth is never flat; neither is ours.
    const uvs = [];
    for (let i = 0; i < rows; i++) {
      const s = i / (rows - 1);
      for (let j = 0; j < cols; j++) {
        const c = j / (cols - 1);
        const [x, y] = layout(s, c);
        const k = id(i, j) * 3;
        this.pos[k] = x;
        this.pos[k + 1] = y;
        this.pos[k + 2] = (((i * 31 + j * 17) % 13) / 13 - 0.5) * 0.004;
        uvs.push(c, s);
      }
    }
    this.prev.set(this.pos);

    // --- constraints ---------------------------------------------------------
    // {a, b, dx, dy, k}: dx/dy are the rest components in the flat cut so
    // (sx, sy) scaling at solve time reshapes for reef/furl.
    this.cons = [];
    const addCon = (a, b, stiff) => {
      // broadseam: chordwise rest lengths grow in the belly (mid-chord,
      // stronger low in the sail) so the minimal-energy shape is cambered.
      const ca = ((a % cols) + (b % cols)) / 2 / (cols - 1);
      const sa = (Math.floor(a / cols) + Math.floor(b / cols)) / 2 / (rows - 1);
      const seam = 1 + broadseam * Math.sin(Math.PI * ca) * (1 - 0.45 * sa);
      this.cons.push({
        a,
        b,
        dx: Math.abs(this.pos[a * 3] - this.pos[b * 3]) * seam,
        dy: Math.abs(this.pos[a * 3 + 1] - this.pos[b * 3 + 1]),
        k: stiff,
      });
    };
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        if (j < cols - 1) addCon(id(i, j), id(i, j + 1), 1.0); // structural →
        if (i < rows - 1) addCon(id(i, j), id(i + 1, j), 1.0); // structural ↑
        if (i < rows - 1 && j < cols - 1) {
          addCon(id(i, j), id(i + 1, j + 1), 0.9); // shear
          addCon(id(i + 1, j), id(i, j + 1), 0.9);
        }
        if (j < cols - 2) addCon(id(i, j), id(i, j + 2), 0.35); // bending
        if (i < rows - 2) addCon(id(i, j), id(i + 2, j), 0.35);
      }
    }

    // --- triangles (wind) + vertex masses ------------------------------------
    this.tris = [];
    const indices = [];
    const areaAcc = new Float32Array(this.n);
    for (let i = 0; i < rows - 1; i++) {
      for (let j = 0; j < cols - 1; j++) {
        const a = id(i, j);
        const b = id(i + 1, j);
        const c = id(i + 1, j + 1);
        const d = id(i, j + 1);
        indices.push(a, b, c, a, c, d);
        this.tris.push(a, b, c, a, c, d);
      }
    }
    for (let t = 0; t < this.tris.length; t += 3) {
      const [a, b, c] = [this.tris[t], this.tris[t + 1], this.tris[t + 2]];
      const ax = this.pos[a * 3];
      const ay = this.pos[a * 3 + 1];
      const area =
        Math.abs(
          (this.pos[b * 3] - ax) * (this.pos[c * 3 + 1] - ay) -
            (this.pos[c * 3] - ax) * (this.pos[b * 3 + 1] - ay)
        ) / 2;
      areaAcc[a] += area / 3;
      areaAcc[b] += area / 3;
      areaAcc[c] += area / 3;
    }
    for (let p = 0; p < this.n; p++) {
      this.invMass[p] = 1 / Math.max(clothDensity * areaAcc[p], 0.004);
    }
    this.pArea = areaAcc; // per-particle tributary area, reused for water drag

    // --- render mesh -----------------------------------------------------------
    this.geometry = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.pos, 3); // shared storage
    this.geometry.setAttribute('position', this.posAttr);
    this.geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    this.geometry.setIndex(indices);
    this.geometry.computeVertexNormals();
    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false; // cloth deforms; static AABB lies
    if (parent) parent.add(this.mesh);
  }

  /** Pin (i, j) at a position — call every frame for moving anchors (boom). */
  pin(i, j, x, y, z) {
    const p = this.id(i, j);
    const k = p * 3;
    this.pinned[p] = 1;
    this.pos[k] = x;
    this.pos[k + 1] = y;
    this.pos[k + 2] = z;
    this.prev[k] = x;
    this.prev[k + 1] = y;
    this.prev[k + 2] = z;
  }

  /**
   * One physics substep.
   * @param {number} dt    substep, seconds (≤ 1/90 recommended)
   * @param {{x,y,z}} wind apparent wind, boat frame, m/s
   * @param {number} sx    chord rest-length scale (jib furl)
   * @param {number} sy    luff rest-length scale (main reef)
   * @param {number} time  clock for the turbulence terms
   */
  step(dt, wind, sx, sy, time) {
    const { pos, prev, force, invMass, pinned, tris } = this;

    // ---- turbulent inflow ---------------------------------------------------
    const wmag = Math.hypot(wind.x, wind.z);
    const gust = 1 + 0.08 * Math.sin(6.7 * time) + 0.05 * Math.sin(17.3 * time + 1.3);
    const wx = wind.x * gust;
    const wy = wind.y;
    const wz = wind.z * gust + 0.07 * wmag * Math.sin(11.1 * time + 0.7);

    // ---- wind pressure per triangle ----------------------------------------
    force.fill(0);
    let sumFx = 0, sumFy = 0, sumFz = 0;
    let sumTx = 0, sumTy = 0, sumTz = 0;
    let sumW = 0, cenX = 0, cenY = 0, cenZ = 0;
    const invDt = 1 / dt;
    for (let t = 0; t < tris.length; t += 3) {
      const a3 = tris[t] * 3;
      const b3 = tris[t + 1] * 3;
      const c3 = tris[t + 2] * 3;
      const e1x = pos[b3] - pos[a3];
      const e1y = pos[b3 + 1] - pos[a3 + 1];
      const e1z = pos[b3 + 2] - pos[a3 + 2];
      const e2x = pos[c3] - pos[a3];
      const e2y = pos[c3 + 1] - pos[a3 + 1];
      const e2z = pos[c3 + 2] - pos[a3 + 2];
      let nx = e1y * e2z - e1z * e2y;
      let ny = e1z * e2x - e1x * e2z;
      let nz = e1x * e2y - e1y * e2x;
      const nlen = Math.hypot(nx, ny, nz);
      if (nlen < 1e-9) continue;
      const area = nlen / 2;
      nx /= nlen;
      ny /= nlen;
      nz /= nlen;
      // triangle velocity (average of its vertices, from Verlet history)
      const vx = ((pos[a3] - prev[a3]) + (pos[b3] - prev[b3]) + (pos[c3] - prev[c3])) * invDt / 3;
      const vy = ((pos[a3+1] - prev[a3+1]) + (pos[b3+1] - prev[b3+1]) + (pos[c3+1] - prev[c3+1])) * invDt / 3;
      const vz = ((pos[a3+2] - prev[a3+2]) + (pos[b3+2] - prev[b3+2]) + (pos[c3+2] - prev[c3+2])) * invDt / 3;
      const q = nx * (wx - vx) + ny * (wy - vy) + nz * (wz - vz);
      // Wind only acts on the part of the sail that is OUT of the water: the
      // submerged fraction of this triangle is driven by water drag instead.
      const airFrac =
        1 - (this.subWeight[tris[t]] + this.subWeight[tris[t + 1]] + this.subWeight[tris[t + 2]]) / 3;
      const f =
        (this.windScale * airFrac * 0.5 * AIR_RHO * PRESSURE_CD * area * q * Math.abs(q)) / 3;
      const fx = nx * f;
      const fy = ny * f;
      const fz = nz * f;
      force[a3] += fx; force[a3 + 1] += fy; force[a3 + 2] += fz;
      force[b3] += fx; force[b3 + 1] += fy; force[b3 + 2] += fz;
      force[c3] += fx; force[c3 + 1] += fy; force[c3 + 2] += fz;

      // integrate for the hull: whole-triangle force, torque, |F|-weighted CP
      const ftx = fx * 3, fty = fy * 3, ftz = fz * 3;
      const cx = (pos[a3] + pos[b3] + pos[c3]) / 3;
      const cy = (pos[a3 + 1] + pos[b3 + 1] + pos[c3 + 1]) / 3;
      const cz = (pos[a3 + 2] + pos[b3 + 2] + pos[c3 + 2]) / 3;
      sumFx += ftx; sumFy += fty; sumFz += ftz;
      sumTx += cy * ftz - cz * fty;
      sumTy += cz * ftx - cx * ftz;
      sumTz += cx * fty - cy * ftx;
      const w = Math.abs(f) * 3;
      sumW += w; cenX += cx * w; cenY += cy * w; cenZ += cz * w;
    }
    this.aeroForce.set(sumFx, sumFy, sumFz);
    this.aeroTorque.set(sumTx, sumTy, sumTz);
    this.pressureWeight = sumW;
    if (sumW > 1e-4) this.pressureCentroid.set(cenX / sumW, cenY / sumW, cenZ / sumW);

    // ---- hydrodynamic drag on submerged cloth --------------------------------
    // Each underwater particle is dragged toward the local water-particle
    // (orbital) velocity: F = ρ_w·Cd·A·(v_water − v_cloth)·|v_water − v_cloth|.
    // Seawater's density makes this dominate — the wet cloth is carried by the
    // water flow, which is exactly the "moves with the sea, not the wind"
    // behaviour of a sail dragged under in a knockdown. (Water drag does NOT
    // feed the hull aero coupling above — the hull has its own buoyancy.)
    if (this.submerged) {
      const wv = this.waterVel;
      const sw = this.subWeight;
      const pa = this.pArea;
      for (let p = 0; p < this.n; p++) {
        const s = sw[p];
        if (s <= 0 || pinned[p]) continue;
        const k = p * 3;
        const rx = wv[k] - (pos[k] - prev[k]) * invDt;
        const ry = wv[k + 1] - (pos[k + 1] - prev[k + 1]) * invDt;
        const rz = wv[k + 2] - (pos[k + 2] - prev[k + 2]) * invDt;
        const speed = Math.hypot(rx, ry, rz);
        const coef = WATER_RHO * WATER_CD * pa[p] * s * (0.4 + 0.6 * speed);
        force[k] += rx * coef;
        force[k + 1] += ry * coef;
        force[k + 2] += rz * coef;
      }
    }

    // ---- Verlet integration --------------------------------------------------
    const dt2 = dt * dt;
    for (let p = 0; p < this.n; p++) {
      if (pinned[p]) continue;
      const k = p * 3;
      const im = invMass[p];
      const ax = THREE.MathUtils.clamp(force[k] * im, -MAX_FORCE_ACC, MAX_FORCE_ACC);
      const ay = THREE.MathUtils.clamp(force[k + 1] * im + GRAVITY, -MAX_FORCE_ACC, MAX_FORCE_ACC);
      const az = THREE.MathUtils.clamp(force[k + 2] * im, -MAX_FORCE_ACC, MAX_FORCE_ACC);
      for (let d = 0; d < 3; d++) {
        const x = pos[k + d];
        const acc = d === 0 ? ax : d === 1 ? ay : az;
        // Per-substep travel cap (~70 m/s): violent flogging in storm winds
        // must saturate, not feed back through the constraint solver into a
        // numerical blow-up.
        let v = (x - prev[k + d]) * DAMPING;
        if (v > 0.4) v = 0.4;
        else if (v < -0.4) v = -0.4;
        pos[k + d] = x + v + acc * dt2;
        prev[k + d] = x;
      }
    }

    // ---- constraint solve ------------------------------------------------------
    for (let it = 0; it < ITERATIONS; it++) {
      for (let ci = 0; ci < this.cons.length; ci++) {
        const con = this.cons[ci];
        const a3 = con.a * 3;
        const b3 = con.b * 3;
        const rest = Math.hypot(con.dx * sx, con.dy * sy);
        const dx = pos[b3] - pos[a3];
        const dy = pos[b3 + 1] - pos[a3 + 1];
        const dz = pos[b3 + 2] - pos[a3 + 2];
        const dist = Math.hypot(dx, dy, dz);
        if (dist < 1e-9) continue;
        const pa = pinned[con.a];
        const pb = pinned[con.b];
        if (pa && pb) continue;
        // Cloth resists stretch hard but BUCKLES under compression — solve
        // compression softly or the sail stands like sheet metal and can
        // neither fold nor sag.
        const kEff = dist < rest ? con.k * 0.12 : con.k;
        const diff = ((dist - rest) / dist) * kEff;
        // distribute the correction away from pinned ends
        const wa = pa ? 0 : pb ? 1 : 0.5;
        const wb = pb ? 0 : pa ? 1 : 0.5;
        pos[a3] += dx * diff * wa;
        pos[a3 + 1] += dy * diff * wa;
        pos[a3 + 2] += dz * diff * wa;
        pos[b3] -= dx * diff * wb;
        pos[b3 + 1] -= dy * diff * wb;
        pos[b3 + 2] -= dz * diff * wb;
      }
      // rigging collision: push particles out of mast/shroud capsules
      for (let cl = 0; cl < this.colliders.length; cl++) {
        const col = this.colliders[cl];
        const ex = col.bx - col.ax;
        const ey = col.by - col.ay;
        const ez = col.bz - col.az;
        const ee = ex * ex + ey * ey + ez * ez;
        for (let p = 0; p < this.n; p++) {
          if (pinned[p]) continue;
          const k = p * 3;
          const rx = pos[k] - col.ax;
          const ry = pos[k + 1] - col.ay;
          const rz = pos[k + 2] - col.az;
          let tt = (rx * ex + ry * ey + rz * ez) / ee;
          tt = tt < 0 ? 0 : tt > 1 ? 1 : tt;
          const dx = rx - ex * tt;
          const dy = ry - ey * tt;
          const dz = rz - ez * tt;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 >= col.r * col.r || d2 < 1e-12) continue;
          const d = Math.sqrt(d2);
          const push = (col.r - d) / d;
          pos[k] += dx * push;
          pos[k + 1] += dy * push;
          pos[k + 2] += dz * push;
        }
      }

      // ropes: one-sided (pull only) — the sheet constraint
      for (let r = 0; r < this.ropes.length; r++) {
        const rope = this.ropes[r];
        const k = rope.index * 3;
        if (pinned[rope.index]) continue;
        const dx = pos[k] - rope.ax;
        const dy = pos[k + 1] - rope.ay;
        const dz = pos[k + 2] - rope.az;
        const dist = Math.hypot(dx, dy, dz);
        if (dist <= rope.rest || dist < 1e-9) continue;
        const pull = (dist - rope.rest) / dist;
        pos[k] -= dx * pull;
        pos[k + 1] -= dy * pull;
        pos[k + 2] -= dz * pull;
      }
    }
  }

  /** Push simulation state to the GPU. Call once per rendered frame. */
  commit() {
    this.posAttr.needsUpdate = true;
    this.geometry.computeVertexNormals();
  }

  /**
   * NaN watchdog — a blown-up sail is re-laid flat rather than left broken.
   * Checks a FREE interior particle plus the integrated force: the force is
   * a sum over every triangle, so any poisoned particle poisons it — this
   * catches blow-ups the old corner-particle check missed (corners can be
   * pinned, and pins are always finite).
   */
  isBroken() {
    const mid = (this.n >> 1) * 3;
    return !Number.isFinite(
      this.pos[mid] + this.pos[mid + 1] + this.pos[mid + 2] +
      this.aeroForce.x + this.aeroForce.y + this.aeroForce.z
    );
  }

  reset() {
    this.aeroForce.set(0, 0, 0);
    this.aeroTorque.set(0, 0, 0);
    this.pressureWeight = 0;
    for (let i = 0; i < this.rows; i++) {
      const s = i / (this.rows - 1);
      for (let j = 0; j < this.cols; j++) {
        const c = j / (this.cols - 1);
        const [x, y] = this.layout(s, c);
        const k = this.id(i, j) * 3;
        this.pos[k] = x;
        this.pos[k + 1] = y;
        this.pos[k + 2] = (((i * 31 + j * 17) % 13) / 13 - 0.5) * 0.004;
      }
    }
    this.prev.set(this.pos);
  }
}
