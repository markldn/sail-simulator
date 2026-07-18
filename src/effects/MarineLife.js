/**
 * MarineLife.js — living things in the water, on an event scheduler.
 *
 * Every 25–70 s one encounter spawns near the boat and plays out over
 * ~20-60 s, then despawns. Three encounter types, weighted by rarity:
 *
 *   dolphins  (common) a pod of 3, porpoising in staggered arcs across the
 *             boat's course — body follows a sine dive path, only meaningful
 *             above/near the surface, classic dorsal-arc silhouette
 *   shark     (uncommon) a single fin cruising a lazy S, wake-less and
 *             ominous, never leaves the water
 *   whale     (rare) a long dark back surfacing parallel to the boat with a
 *             white spout burst, two slow breaths, then gone
 *
 * All bodies ride the real wave surface (ocean.getHeightAt) so they stay in
 * the water on any sea state.
 */

import * as THREE from 'three';

export class MarineLife {
  constructor(scene, ocean) {
    this.ocean = ocean;
    this.group = new THREE.Group();
    scene.add(this.group);
    this._nextEvent = 15 + Math.random() * 20; // first visitor comes soonish
    this._event = null;

    this._matBody = new THREE.MeshStandardMaterial({ color: 0x3d4750, roughness: 0.35 });
    this._matBelly = new THREE.MeshStandardMaterial({ color: 0x9fb2b8, roughness: 0.5 });
    this._matWhale = new THREE.MeshStandardMaterial({ color: 0x2b3238, roughness: 0.55 });

    // Spout: a tiny burst of white sprites, reused per whale breath.
    this._spout = new THREE.Points(
      new THREE.BufferGeometry().setAttribute(
        'position',
        new THREE.BufferAttribute(new Float32Array(60 * 3), 3)
      ),
      new THREE.PointsMaterial({
        color: 0xf2f7fa, size: 0.35, transparent: true, opacity: 0, depthWrite: false,
      })
    );
    this._spout.frustumCulled = false;
    this.group.add(this._spout);
  }

  _dolphinMesh() {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.16, 1.15, 4, 8), this._matBody);
    body.rotation.z = Math.PI / 2;
    g.add(body);
    const fin = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.3, 6), this._matBody);
    fin.position.set(-0.1, 0.25, 0);
    fin.rotation.z = 0.5;
    g.add(fin);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.03, 0.5), this._matBody);
    tail.position.set(-0.8, 0.02, 0);
    g.add(tail);
    return g;
  }

  _spawn(camPos, boatHeading) {
    const roll = Math.random();
    const type =
      roll < 0.3 ? 'fish' : roll < 0.65 ? 'dolphins' : roll < 0.88 ? 'shark' : 'whale';
    const ev = { type, t: 0, actors: [] };
    // Path: crosses the area ahead-ish of the camera.
    const az = Math.random() * Math.PI * 2;
    const ox = camPos.x + Math.sin(az) * (35 + Math.random() * 40);
    const oz = camPos.z + Math.cos(az) * (35 + Math.random() * 40);
    const dir = Math.random() * Math.PI * 2;
    ev.origin = new THREE.Vector2(ox, oz);
    ev.dir = new THREE.Vector2(Math.sin(dir), Math.cos(dir));

    if (type === 'fish') {
      // A school of silver darts just under the surface, close aboard — the
      // classic flash of bait fish scattering near the bow.
      ev.dur = 26;
      ev.speed = 2.3;
      ev.origin.set(
        camPos.x + Math.sin(az) * (12 + Math.random() * 18),
        camPos.z + Math.cos(az) * (12 + Math.random() * 18)
      );
      if (!this._matFish) {
        this._matFish = new THREE.MeshStandardMaterial({
          color: 0xd8e4e8, metalness: 0.85, roughness: 0.25,
        });
      }
      for (let i = 0; i < 7; i++) {
        const f = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.035, 0.05), this._matFish);
        this.group.add(f);
        ev.actors.push({ m: f, lag: Math.random() * 0.6, side: (Math.random() - 0.5) * 2.4, ph: Math.random() * 7 });
      }
    } else if (type === 'dolphins') {
      ev.dur = 38;
      ev.speed = 4.2;
      for (let i = 0; i < 3; i++) {
        const m = this._dolphinMesh();
        this.group.add(m);
        ev.actors.push({ m, lag: i * 3.1, side: (i % 2 ? 1 : -1) * (0.8 + i * 0.5) });
      }
    } else if (type === 'shark') {
      ev.dur = 45;
      ev.speed = 1.6;
      const fin = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.5, 3), this._matBody);
      fin.scale.x = 0.35;
      this.group.add(fin);
      ev.actors.push({ m: fin, lag: 0, side: 0 });
    } else {
      ev.dur = 55;
      ev.speed = 1.1;
      const whale = new THREE.Group();
      const back = new THREE.Mesh(new THREE.CapsuleGeometry(0.9, 6.5, 6, 10), this._matWhale);
      back.rotation.z = Math.PI / 2;
      whale.add(back);
      const fin = new THREE.Mesh(new THREE.ConeGeometry(0.35, 0.7, 6), this._matWhale);
      fin.position.set(-2.2, 0.75, 0);
      fin.rotation.z = 0.4;
      whale.add(fin);
      this.group.add(whale);
      ev.actors.push({ m: whale, lag: 0, side: 0 });
      ev.breaths = [8, 26]; // seconds at which it surfaces and blows
    }
    this._event = ev;
  }

  _despawn() {
    for (const a of this._event.actors) this.group.remove(a.m);
    this._spout.material.opacity = 0;
    this._event = null;
    this._nextEvent = 25 + Math.random() * 45;
  }

  _blow(x, y, z) {
    const pos = this._spout.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      pos.setXYZ(
        i,
        x + (Math.random() - 0.5) * 0.5,
        y + Math.random() * 2.2,
        z + (Math.random() - 0.5) * 0.5
      );
    }
    pos.needsUpdate = true;
    this._spout.material.opacity = 0.85;
  }

  update(dt, camPos, boatHeading) {
    if (!this._event) {
      this._nextEvent -= dt;
      if (this._nextEvent <= 0) this._spawn(camPos, boatHeading);
      return;
    }
    const ev = this._event;
    ev.t += dt;
    if (ev.t > ev.dur || ev.origin.distanceTo(new THREE.Vector2(camPos.x, camPos.z)) > 400) {
      this._despawn();
      return;
    }
    this._spout.material.opacity *= Math.exp(-dt * 1.8); // spout dissolves

    for (const a of ev.actors) {
      const t = ev.t - a.lag;
      if (t < 0) { a.m.visible = false; continue; }
      a.m.visible = true;
      const along = t * ev.speed;
      const x = ev.origin.x + ev.dir.x * along - ev.dir.y * a.side;
      const z = ev.origin.y + ev.dir.y * along + ev.dir.x * a.side;
      const surf = this.ocean.getHeightAt(x, z);
      const heading = Math.atan2(ev.dir.x, ev.dir.y);

      if (ev.type === 'fish') {
        // Darting zigzag just under the surface; the flat flanks catch the
        // light as they roll — the "flash".
        const zig = Math.sin(t * 3.1 + a.ph) * 1.1;
        const fx = x + ev.dir.y * zig;
        const fz = z - ev.dir.x * zig;
        a.m.position.set(fx, this.ocean.getHeightAt(fx, fz) - 0.12 - 0.06 * Math.sin(t * 5 + a.ph), fz);
        a.m.rotation.set(Math.sin(t * 5.3 + a.ph) * 0.6, Math.PI / 2 - heading - Math.cos(t * 3.1 + a.ph) * 0.5, 0);
      } else if (ev.type === 'dolphins') {
        // Porpoising: sine dive, ~3.2 s period; body pitches along the arc.
        const ph = (t / 3.2) * Math.PI * 2;
        const y = surf + Math.sin(ph) * 0.85 - 0.35;
        a.m.position.set(x, y, z);
        a.m.rotation.set(0, Math.PI / 2 - heading, Math.cos(ph) * 0.55);
      } else if (ev.type === 'shark') {
        // Fin just proud of the surface, lazy S-curve wander.
        const s = Math.sin(t * 0.4) * 2.5;
        a.m.position.set(x + ev.dir.y * s, surf + 0.18, z - ev.dir.x * s);
        a.m.rotation.y = -heading + Math.cos(t * 0.4) * 0.3;
      } else {
        // Whale: mostly just under; rises for each breath, blows, sinks.
        let lift = -2.2;
        for (const b of ev.breaths) {
          const dtb = ev.t - b;
          if (dtb > -4 && dtb < 6) lift = Math.max(lift, -2.2 + 2.6 * Math.exp(-(dtb * dtb) / 6));
          if (dtb > 0 && dtb < dt) this._blow(x, surf + 0.7, z); // breach moment
        }
        a.m.position.set(x, surf + lift, z);
        a.m.rotation.y = Math.PI / 2 - heading;
      }
    }
  }
}
