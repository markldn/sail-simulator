/**
 * Thunderstorm.js — lightning strikes with distance-delayed thunder.
 *
 * Active when the sky is heavily overcast AND the wind is up (or forced via
 * the GUI). Each strike:
 *   - picks a random azimuth and distance (0.6–7 km) around the camera,
 *   - renders a jagged multi-segment bolt (additive, camera-facing spread)
 *     that flickers over ~0.25 s with 2-3 restrikes, like the real thing,
 *   - throws a brief cold directional flash over the whole scene,
 *   - schedules thunder through SoundSystem at the true sound-travel delay
 *     (~2.9 s per km) — count the seconds, divide by three, that's miles.
 */

import * as THREE from 'three';

const FLICKER = [1.0, 0.25, 0.8, 0.15, 0.45]; // restrike envelope, ~50 ms steps

export class Thunderstorm {
  constructor(scene, sound) {
    this.scene = scene;
    this.sound = sound;
    this.intensity = 0; // 0 = clear … 1 = full storm (set from main.js)

    // Cold blue-white flash light; intensity 0 when idle.
    this.flash = new THREE.DirectionalLight(0xcdd8ff, 0);
    scene.add(this.flash);
    scene.add(this.flash.target);

    // Bolt: one LineSegments rebuilt per strike.
    this.boltMat = new THREE.LineBasicMaterial({
      color: 0xe8ecff,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.bolt = new THREE.LineSegments(new THREE.BufferGeometry(), this.boltMat);
    this.bolt.frustumCulled = false;
    this.bolt.visible = false;
    scene.add(this.bolt);

    this._nextStrike = 8 + Math.random() * 10;
    this._strikeT = -1; // <0 idle; else seconds since strike began
    // Squall: each strike dumps a burst of rain that decays over ~15 s.
    // main.js folds this into the rain intensity, so lightning brings the
    // gust-front downpour with it.
    this.squall = 0;
  }

  /** Build a jagged bolt from `top` down to the sea, with a few branches. */
  _buildBolt(top) {
    const pts = [];
    const addPath = (from, toY, spread, segs) => {
      let p = from.clone();
      for (let i = 0; i < segs; i++) {
        const q = p.clone();
        q.y = from.y + ((toY - from.y) * (i + 1)) / segs;
        q.x += (Math.random() - 0.5) * spread;
        q.z += (Math.random() - 0.5) * spread;
        pts.push(p.clone(), q.clone());
        // occasional short branch
        if (i > 1 && i < segs - 2 && Math.random() < 0.3) {
          const b = q.clone();
          b.x += (Math.random() - 0.5) * spread * 3;
          b.y -= 30 + Math.random() * 60;
          b.z += (Math.random() - 0.5) * spread * 3;
          pts.push(q.clone(), b);
        }
        p = q;
      }
    };
    addPath(top, 0, 55, 14);
    this.bolt.geometry.dispose();
    this.bolt.geometry = new THREE.BufferGeometry().setFromPoints(pts);
  }

  update(dt, camPos, time) {
    this.squall *= Math.exp(-dt / 15);
    // Ongoing strike: run the flicker envelope.
    if (this._strikeT >= 0) {
      this._strikeT += dt;
      const step = Math.floor(this._strikeT / 0.05);
      if (step < FLICKER.length) {
        const f = FLICKER[step];
        this.flash.intensity = 2.6 * f * this._near;
        this.boltMat.opacity = f;
        this.bolt.visible = true;
      } else {
        this.flash.intensity = 0;
        this.bolt.visible = false;
        this._strikeT = -1;
      }
    }

    if (this.intensity <= 0.02) return;
    this._nextStrike -= dt * this.intensity;
    if (this._nextStrike > 0) return;

    // --- fire a strike ----------------------------------------------------
    this._nextStrike = 3 + Math.random() * 12; // scaled by intensity above
    const az = Math.random() * Math.PI * 2;
    const distKm = 0.6 + Math.random() * 6.4;
    const d = distKm * 1000;
    const top = new THREE.Vector3(
      camPos.x + Math.sin(az) * d,
      420 + Math.random() * 300,
      camPos.z + Math.cos(az) * d
    );
    this._near = Math.max(0.25, 1 - distKm / 8);
    this._buildBolt(top);
    // Flash comes FROM the strike bearing so deck shadows kick that way.
    this.flash.position.set(top.x, top.y, top.z);
    this.flash.target.position.set(camPos.x, 0, camPos.z);
    this._strikeT = 0;
    this.squall = Math.min(1, this.squall + 0.45 + 0.5 * this._near);
    if (this.sound) this.sound.thunder(distKm);
  }
}
