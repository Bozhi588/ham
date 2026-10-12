import * as THREE from 'three';

/**
 * Interface every explorable place implements (the base room, hills, islands...).
 * Worlds own their scene content (`group`), their collision, and their doors.
 */
export class World {
  constructor(game) {
    this.game = game;
    this.group = new THREE.Group();
    this.fog = { color: 0x000000, near: 10, far: 100 };
    this.exposure = 1;
    this.killY = -Infinity;
    this.windLevel = 0.2; // 0..1, drives the wind ambience
    this.ambience = 'wind'; // 'wind' | 'room'
    this.surfaceType = 'grass';
    this.sky = null;
  }

  /** Doors currently loaded (the game checks these for interaction). */
  get doors() {
    return [];
  }

  /** Build whatever must exist before the player appears. Yield to keep the UI alive. */
  async preload(/* onProgress */) {}

  update(/* dt, time, player, camera */) {}

  /** Highest standable surface at (x,z) at or below y, or -Infinity. */
  ground(/* x, z, y */) {
    return -Infinity;
  }

  /** Push the player out of solid things. */
  collide(/* player */) {}

  /** Lowest ceiling above the player's head, if any. */
  ceiling(/* player */) {
    return Infinity;
  }

  /** Is this a good place to respawn the player after a fall? */
  isSafe(/* x, y, z */) {
    return false;
  }

  surface(/* x, z */) {
    return this.surfaceType;
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose();
      if (o.material && !o.material.userData.shared) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((m) => m.dispose());
      }
    });
  }
}
