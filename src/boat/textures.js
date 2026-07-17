/**
 * textures.js — procedural canvas textures for the boat.
 *
 * Everything is generated at load: no downloads, no asset pipeline, and the
 * whole simulator stays a single self-contained bundle. A seeded PRNG keeps
 * the "random" grain identical run to run.
 *
 * (Browser-only: uses <canvas>. The headless physics tests never import
 * this module — keep it that way.)
 */

import * as THREE from 'three';
import { HULL } from './HullSpec.js';

/** Tiny deterministic PRNG (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvasTexture(w, h, draw) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  draw(canvas.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** Laid teak deck: planks, grain streaks, black caulking seams. */
export function makeTeakTexture() {
  const tex = canvasTexture(512, 512, (ctx, w, h) => {
    const rand = rng(1337);
    const plank = 40;
    for (let x = 0; x < w; x += plank) {
      // per-plank tonal variation
      const light = 52 + Math.floor(rand() * 14);
      ctx.fillStyle = `hsl(33, 32%, ${light}%)`;
      ctx.fillRect(x, 0, plank, h);
      // grain: wavy translucent streaks
      for (let g = 0; g < 22; g++) {
        const gx = x + 3 + rand() * (plank - 6);
        ctx.strokeStyle = `rgba(60, 38, 18, ${0.05 + rand() * 0.1})`;
        ctx.lineWidth = 0.6 + rand() * 1.2;
        ctx.beginPath();
        ctx.moveTo(gx, 0);
        for (let y = 0; y <= h; y += 32) {
          ctx.lineTo(gx + Math.sin(y * 0.02 + rand() * 6) * 2.5, y);
        }
        ctx.stroke();
      }
      // butt joints at staggered heights
      const joint = Math.floor(rand() * h);
      ctx.fillStyle = 'rgba(20, 14, 8, 0.55)';
      ctx.fillRect(x, joint, plank, 2);
      // caulking seam
      ctx.fillStyle = '#14100c';
      ctx.fillRect(x + plank - 3, 0, 3, h);
    }
  });
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** Woven dacron sailcloth: panel seams, tabling at the edges, fibre noise. */
export function makeSailclothTexture() {
  return canvasTexture(512, 512, (ctx, w, h) => {
    const rand = rng(4242);
    ctx.fillStyle = '#f2efe6';
    ctx.fillRect(0, 0, w, h);
    // fibre speckle
    for (let i = 0; i < 5200; i++) {
      ctx.fillStyle = `rgba(120, 116, 104, ${0.02 + rand() * 0.05})`;
      ctx.fillRect(rand() * w, rand() * h, 1.4, 1.4);
    }
    // horizontal panel seams (broadseamed cloth): double stitch lines
    for (let y = 54; y < h; y += 54) {
      ctx.fillStyle = 'rgba(105, 100, 88, 0.45)';
      ctx.fillRect(0, y, w, 1.6);
      ctx.fillStyle = 'rgba(150, 145, 130, 0.35)';
      ctx.fillRect(0, y + 4, w, 1.2);
    }
    // tabling (reinforced edge) along luff (u=0) and leech (u=1)
    ctx.fillStyle = 'rgba(140, 135, 120, 0.30)';
    ctx.fillRect(0, 0, 10, h);
    ctx.fillRect(w - 12, 0, 12, h);
  });
}

/**
 * Hull side "paint job" as a vertical gradient keyed to hull height:
 * antifoul below the waterline, a navy boot-top stripe at it, white
 * topsides, and a gold cove stripe under the sheer. The hull mesh's
 * v-coordinate is (y + bottom)/(sheer + bottom), computed in BoatModel —
 * the same constants are used here so the stripes land exactly on the DWL.
 */
export function makeHullTexture() {
  const span = HULL.sheer + HULL.bottom;
  const vWater = HULL.bottom / span; // v of y=0 (design waterline)
  const tex = canvasTexture(64, 1024, (ctx, w, h) => {
    const rand = rng(777);
    const yOf = (v) => Math.round((1 - v) * h); // canvas y grows downward
    // topsides
    ctx.fillStyle = '#eef1f1';
    ctx.fillRect(0, 0, w, h);
    // faint vertical weathering streaks on the topsides
    for (let i = 0; i < 40; i++) {
      ctx.fillStyle = `rgba(160, 170, 175, ${0.03 + rand() * 0.05})`;
      ctx.fillRect(rand() * w, 0, 1 + rand() * 2, yOf(vWater));
    }
    // antifoul below the waterline
    ctx.fillStyle = '#5e2020';
    ctx.fillRect(0, yOf(vWater + 0.012), w, h);
    // boot-top stripe riding just above the DWL
    ctx.fillStyle = '#16283f';
    ctx.fillRect(0, yOf(vWater + 0.052), w, yOf(vWater + 0.012) - yOf(vWater + 0.052));
    // gold cove stripe under the sheer
    ctx.fillStyle = '#b8912f';
    ctx.fillRect(0, yOf(0.955), w, yOf(0.94) - yOf(0.955));
  });
  tex.wrapS = THREE.RepeatWrapping; // u repeats around the hull
  return tex;
}
