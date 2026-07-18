/**
 * RigInteract.js — grab the running rigging with the mouse.
 *
 *   drag a SHEET (mainsheet red, jib sheets tan) up/down  → trim / ease
 *     (turns auto-trim off, exactly like touching the ↑/↓ keys)
 *   drag the HALYARD (cream, along the mast) up/down      → hoist / reef main
 *   click the companionway washboards                     → open / close
 *
 * Ropes are verlet polylines a centimetre thick — mesh raycasting would need
 * pixel-perfect aim, so picking is done by ray-to-segment distance against
 * the rope's actual simulated points (grab radius ~15 cm). Hovering shows a
 * grab cursor so the interactive lines are discoverable.
 */

import * as THREE from 'three';

const GRAB_RADIUS = 0.16; // metres from the rope's centreline

export class RigInteract {
  /**
   * @param {HTMLElement} dom      renderer canvas
   * @param {THREE.Camera} camera
   * @param {import('../boat/Boat.js').Boat} boat
   * @param {{state:{sheetMaxDeg:number, autoTrim:boolean}}} helm
   * @param {{enabled:boolean}} controls orbit controls to freeze while dragging
   */
  constructor(dom, camera, boat, helm, controls) {
    this.dom = dom;
    this.camera = camera;
    this.boat = boat;
    this.helm = helm;
    this.controls = controls;

    this.doorOpen = false;
    this._doorGroup = boat.model.getObjectByName('doorBoards');
    this._doorSlide = 0; // 0 closed … 1 open

    this._ray = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();
    this._a = new THREE.Vector3();
    this._b = new THREE.Vector3();
    this._drag = null; // { target, py }
    this._hover = false;

    const sheetAction = (dy) => {
      const s = this.helm.state;
      s.autoTrim = false;
      s.sheetMaxDeg = THREE.MathUtils.clamp(s.sheetMaxDeg + dy * 0.25, 8, 88);
    };
    const halyardAction = (dy) => {
      const p = this.boat.physics.sailPlan;
      p.main = THREE.MathUtils.clamp(p.main - dy * 0.004, 0, 1);
    };
    const sails = boat.sails;
    this._targets = [
      { rope: sails.ropeMainsheet, act: sheetAction, label: 'mainsheet' },
      { rope: sails.ropeJibActive, act: sheetAction, label: 'jib sheet' },
      { rope: sails.ropeJibLazy, act: sheetAction, label: 'jib sheet' },
      { rope: sails.ropeHalyard, act: halyardAction, label: 'halyard' },
    ];

    dom.addEventListener('pointermove', (e) => this._onMove(e));
    window.addEventListener('pointerup', () => this._release());
  }

  /** Called from main.js pointerdown BEFORE the FP-look handler.
   *  @returns {boolean} true if the click grabbed rigging (skip look-drag). */
  tryGrab(e) {
    const hit = this._pick(e);
    if (!hit) return false;
    if (hit.door) {
      this.doorOpen = !this.doorOpen;
      return true;
    }
    this._drag = { target: hit, py: e.clientY };
    if (this.controls) this._controlsWere = this.controls.enabled;
    if (this.controls) this.controls.enabled = false;
    this.dom.style.cursor = 'ns-resize';
    return true;
  }

  _release() {
    if (this._drag && this.controls) this.controls.enabled = this._controlsWere;
    this._drag = null;
    this.dom.style.cursor = this._hover ? 'grab' : '';
  }

  _onMove(e) {
    if (this._drag) {
      const dy = e.clientY - this._drag.py;
      this._drag.py = e.clientY;
      this._drag.target.act(dy);
      return;
    }
    // Hover feedback, throttled — a full pick is a handful of segment tests.
    if ((e.timeStamp | 0) % 3 !== 0) return;
    const hit = this._pick(e);
    this._hover = !!hit;
    this.dom.style.cursor = hit ? 'grab' : '';
  }

  _pick(e) {
    const r = this.dom.getBoundingClientRect();
    this._ndc.set(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1
    );
    this._ray.setFromCamera(this._ndc, this.camera);
    const ray = this._ray.ray;
    const boatM = this.boat.model.matrixWorld;

    // Door first (plain mesh raycast — the boards are a big easy box).
    if (this._doorGroup) {
      const hits = this._ray.intersectObject(this._doorGroup, true);
      if (hits.length && hits[0].distance < 30) return { door: true };
    }

    let best = null;
    let bestD = GRAB_RADIUS * GRAB_RADIUS;
    for (const t of this._targets) {
      const rope = t.rope;
      if (!rope || !rope.mesh.visible) continue;
      const pos = rope.pos;
      for (let i = 0; i < rope.n - 1; i++) {
        this._a.fromArray(pos, i * 3).applyMatrix4(boatM);
        this._b.fromArray(pos, (i + 1) * 3).applyMatrix4(boatM);
        const d2 = ray.distanceSqToSegment(this._a, this._b);
        if (d2 < bestD) {
          bestD = d2;
          best = t;
        }
      }
    }
    return best;
  }

  /** Per-frame: animate the companionway washboards sliding open/shut. */
  update(dt) {
    const goal = this.doorOpen ? 1 : 0;
    if (Math.abs(this._doorSlide - goal) > 0.001 && this._doorGroup) {
      const k = 1 - Math.exp(-dt * 7);
      this._doorSlide += (goal - this._doorSlide) * k;
      this._doorGroup.position.y = -0.52 * this._doorSlide;
    }
  }
}
