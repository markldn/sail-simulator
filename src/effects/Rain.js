/**
 * Rain.js — wind-driven rain for heavy weather.
 *
 * A box of streak segments that follows the camera; each drop falls and is
 * slanted by the wind, and recycles to the top of the box when it drops out
 * the bottom. Intensity (opacity + fall speed) is driven by wind strength, so
 * rain fades in around gale force and lashes down in a storm. Cheap: one
 * LineSegments object, positions updated in place, no per-frame allocation.
 */

import * as THREE from 'three';

const COUNT = 6500; // streaks
const BOX = 30; // half-extent of the rain volume around the camera (m)

export class Rain {
  constructor(scene) {
    this.positions = new Float32Array(COUNT * 2 * 3); // 2 endpoints per streak
    // random offsets inside the box (relative to camera), re-centred each frame
    this._ox = new Float32Array(COUNT);
    this._oy = new Float32Array(COUNT);
    this._oz = new Float32Array(COUNT);
    for (let i = 0; i < COUNT; i++) {
      this._ox[i] = (Math.random() - 0.5) * 2 * BOX;
      this._oy[i] = Math.random() * 2 * BOX; // 0 … 2·BOX above the box floor
      this._oz[i] = (Math.random() - 0.5) * 2 * BOX;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.material = new THREE.LineBasicMaterial({
      color: 0xbfd0dc,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    this.lines = new THREE.LineSegments(geo, this.material);
    this.lines.frustumCulled = false;
    this.lines.visible = false;
    scene.add(this.lines);

    this._fall = 0; // phase so the whole sheet descends smoothly
  }

  /**
   * @param {number} dt        frame delta
   * @param {THREE.Vector3} camPos camera world position (rain follows it)
   * @param {{x,y,z}} windVec  wind velocity (m/s) — slants the streaks
   * @param {number} intensity 0 (dry) … 1 (storm)
   */
  update(dt, camPos, windVec, intensity) {
    this.material.opacity = 0.55 * intensity;
    this.lines.visible = intensity > 0.02;
    if (!this.lines.visible) return;

    // Streak vector: gravity plus a slice of the wind, so rain drives sideways
    // in a blow. Longer + faster streaks the harder it rains.
    const speed = 22 + 26 * intensity;
    this._fall = (this._fall + speed * dt) % (2 * BOX);
    const len = 0.6 + 1.4 * intensity;
    let sx = windVec.x * 0.10;
    let sy = -1.0;
    let sz = windVec.z * 0.10;
    const sl = Math.hypot(sx, sy, sz) || 1;
    sx = (sx / sl) * len;
    sy = (sy / sl) * len;
    sz = (sz / sl) * len;

    const p = this.positions;
    const cx = camPos.x;
    const cy = camPos.y;
    const cz = camPos.z;
    for (let i = 0; i < COUNT; i++) {
      // descend + wrap within the box; wind drifts the column
      let y = this._oy[i] - this._fall;
      y = ((y % (2 * BOX)) + 2 * BOX) % (2 * BOX); // wrap 0…2·BOX
      const x = cx + this._ox[i] + windVec.x * 0.04 * y;
      const wy = cy + y - BOX; // centre the box on the camera
      const z = cz + this._oz[i] + windVec.z * 0.04 * y;
      const k = i * 6;
      p[k] = x; p[k + 1] = wy; p[k + 2] = z;
      p[k + 3] = x + sx; p[k + 4] = wy + sy; p[k + 5] = z + sz;
    }
    this.lines.geometry.attributes.position.needsUpdate = true;
  }
}
