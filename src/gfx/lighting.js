import * as THREE from 'three';

/**
 * Outdoor worlds have one sun and one hemisphere of sky light, both static, so
 * we bake the lighting straight into vertex colours. Terrain, props, grass and
 * doors then all use cheap unlit materials and always agree with each other.
 */
export class Lighting {
  constructor({ sunDir, sunColor, skyColor, groundColor, sunK = 1, ambK = 1 }) {
    this.sunDir = new THREE.Vector3(...sunDir).normalize();
    this.sun = new THREE.Color(sunColor).multiplyScalar(sunK);
    this.sky = new THREE.Color(skyColor).multiplyScalar(ambK);
    this.ground = new THREE.Color(groundColor).multiplyScalar(ambK);
  }

  /** Writes the light multiplier for a surface normal into `out` ({r,g,b}). */
  shade(nx, ny, nz, out) {
    const L = this.sunDir;
    const ndl = nx * L.x + ny * L.y + nz * L.z;
    const sun = Math.max(0, (ndl + 0.15) / 1.15);
    const h = ny * 0.5 + 0.5;
    out.r = this.sky.r * h + this.ground.r * (1 - h) + this.sun.r * sun;
    out.g = this.sky.g * h + this.ground.g * (1 - h) + this.sun.g * sun;
    out.b = this.sky.b * h + this.ground.b * (1 - h) + this.sun.b * sun;
    return out;
  }
}
