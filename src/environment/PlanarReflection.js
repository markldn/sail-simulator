/**
 * PlanarReflection.js — mirror the world in the water surface.
 *
 * The ocean shader only reflected an analytic sky, so the boat cast no
 * reflection. This renders the scene from a camera mirrored across the water
 * plane (y = 0) into a texture; the ocean shader then projects that texture
 * onto the surface (distorted by the wave normal), blended in by the fresnel
 * term — so the hull, rig and sails ripple back off the water.
 *
 * Mirror-camera math follows three's Reflector; a y=0 clip plane keeps
 * below-water geometry (the keel) out of the reflection.
 */

import * as THREE from 'three';

export class PlanarReflection {
  constructor(size = 512) {
    this.rt = new THREE.WebGLRenderTarget(size, size, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      type: THREE.HalfFloatType,
      depthBuffer: true,
    });
    this.virtualCamera = new THREE.PerspectiveCamera();
    this.textureMatrix = new THREE.Matrix4();
    this.clipPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0.0);

    this._normal = new THREE.Vector3(0, 1, 0);
    this._reflectorPos = new THREE.Vector3(0, 0, 0);
    this._view = new THREE.Vector3();
    this._camPos = new THREE.Vector3();
    this._target = new THREE.Vector3();
    this._lookAt = new THREE.Vector3();
    this._rot = new THREE.Matrix4();
    this._up = new THREE.Vector3();
  }

  /**
   * Render the reflection for this frame.
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Scene} scene
   * @param {THREE.PerspectiveCamera} camera main camera
   * @param {THREE.Object3D[]} hide objects to exclude (the water + its spray)
   */
  render(renderer, scene, camera, hide) {
    const vc = this.virtualCamera;
    const n = this._normal;

    // --- mirror the camera across the water plane (y = 0) -----------------
    this._camPos.setFromMatrixPosition(camera.matrixWorld);
    this._view.subVectors(this._reflectorPos, this._camPos);
    this._view.reflect(n).negate().add(this._reflectorPos); // virtual position

    this._rot.extractRotation(camera.matrixWorld);
    this._lookAt.set(0, 0, -1).applyMatrix4(this._rot).add(this._camPos);
    this._target.subVectors(this._reflectorPos, this._lookAt);
    this._target.reflect(n).negate().add(this._reflectorPos);

    vc.position.copy(this._view);
    this._up.set(0, 1, 0).applyMatrix4(this._rot).reflect(n);
    vc.up.copy(this._up);
    vc.lookAt(this._target);
    vc.near = camera.near;
    vc.far = camera.far;
    vc.aspect = camera.aspect;
    vc.fov = camera.fov;
    vc.updateProjectionMatrix();
    vc.updateMatrixWorld();

    // texture matrix: world → reflection UV (bias · proj · viewInverse)
    this.textureMatrix.set(
      0.5, 0.0, 0.0, 0.5,
      0.0, 0.5, 0.0, 0.5,
      0.0, 0.0, 0.5, 0.5,
      0.0, 0.0, 0.0, 1.0
    );
    this.textureMatrix.multiply(vc.projectionMatrix);
    this.textureMatrix.multiply(vc.matrixWorldInverse);

    // --- render the above-water world into the reflection target ----------
    for (let i = 0; i < hide.length; i++) hide[i].visible = false;
    const prevRT = renderer.getRenderTarget();
    const prevClip = renderer.clippingPlanes;
    const prevShadow = renderer.shadowMap.enabled;
    renderer.clippingPlanes = [this.clipPlane];
    renderer.shadowMap.enabled = false; // shadows already baked; skip in mirror
    renderer.setRenderTarget(this.rt);
    renderer.clear();
    renderer.render(scene, vc);
    renderer.setRenderTarget(prevRT);
    renderer.clippingPlanes = prevClip;
    renderer.shadowMap.enabled = prevShadow;
    for (let i = 0; i < hide.length; i++) hide[i].visible = true;
  }
}
