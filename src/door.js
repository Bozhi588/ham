import * as THREE from 'three';
import { MeshBuilder } from './gfx/builder.js';
import { makePortalMaterial, makeBeamMaterial } from './gfx/materials.js';

export const DOOR_W = 1.2;
export const DOOR_H = 2.3;
const OPEN_ANGLE = THREE.MathUtils.degToRad(104);

const portalGeo = new THREE.PlaneGeometry(DOOR_W + 0.08, DOOR_H + 0.02);
portalGeo.translate(0, DOOR_H / 2, 0);
const beamGeo = new THREE.CylinderGeometry(0.5, 0.95, 90, 18, 1, true);
beamGeo.translate(0, 45, 0);

const col = (hex) => new THREE.Color(hex);

export const DOOR_STYLES = {
  wood: { frame: col(0x5a3d28), leaf: col(0x7a5133), panel: col(0x654126), metal: col(0xc9a24a), stone: col(0x8a8680) },
  stone: { frame: col(0x8d8a82), leaf: col(0x4b3b30), panel: col(0x3c2f27), metal: col(0x2c2c30), stone: col(0x9a978e) },
  dark: { frame: col(0x2a2622), leaf: col(0x3a2e27), panel: col(0x2c231e), metal: col(0x9c8a5c), stone: col(0x4a4742) },
};

/**
 * A freestanding (or wall-mounted) doorway with a swinging leaf, a glowing
 * portal behind it and, outdoors, a tall beam of light so it can be spotted
 * from far away. The local +Z axis is the door's "front".
 */
export class Door {
  /**
   * o: { id, x, y, z, yaw, dest, glow, horizon, zenith, style, lighting, material,
   *      depth, plinth, beam }
   */
  constructor(o) {
    this.id = o.id;
    this.dest = o.dest;
    this.x = o.x;
    this.y = o.y;
    this.z = o.z;
    this.yaw = o.yaw ?? 0;
    this.c = Math.cos(this.yaw);
    this.s = Math.sin(this.yaw);
    this.normal = new THREE.Vector3(this.s, 0, this.c);
    this.glow = new THREE.Color(o.glow);
    this.state = 'closed';
    this.t = 0; // 0 closed .. 1 open
    this.swing = 1;
    this.group = new THREE.Group();
    this.group.position.set(this.x, this.y, this.z);
    this.group.rotation.y = this.yaw;
    this.center = new THREE.Vector3(this.x, this.y + DOOR_H * 0.5, this.z);
    this._disposables = [];

    const style = DOOR_STYLES[o.style] || DOOR_STYLES.wood;
    const depth = o.depth ?? 0.36;
    const solid = o.material;

    // --- static frame (+ plinth) -------------------------------------------
    const b = new MeshBuilder(o.lighting);
    const pw = o.style === 'stone' ? 0.3 : 0.2;
    const lt = o.style === 'stone' ? 0.32 : 0.22;
    const hw = DOOR_W / 2;
    b.box(-(hw + pw / 2), (DOOR_H + lt) / 2, 0, pw, DOOR_H + lt, depth, style.frame, 0.7);
    b.box(hw + pw / 2, (DOOR_H + lt) / 2, 0, pw, DOOR_H + lt, depth, style.frame, 0.7);
    b.box(0, DOOR_H + lt / 2, 0, DOOR_W + pw * 2, lt, depth + 0.06, style.frame);
    if (o.style === 'stone') {
      b.box(0, DOOR_H + lt + 0.09, 0, DOOR_W + pw * 2 + 0.24, 0.18, depth + 0.2, style.stone);
      b.box(-(hw + pw / 2), 0.14, 0, pw + 0.16, 0.28, depth + 0.16, style.stone);
      b.box(hw + pw / 2, 0.14, 0, pw + 0.16, 0.28, depth + 0.16, style.stone);
    }
    // threshold
    b.box(0, 0.02, 0, DOOR_W + 0.04, 0.05, depth, style.stone);
    if (o.plinth) {
      b.cylinder(0, -0.6, 0, 2.3, 0.6 + 0.012, 18, style.stone, { colorVar: 0.1 });
      b.cylinder(0, -0.6, 0, 1.7, 0.6 + 0.045, 16, style.stone.clone().multiplyScalar(0.82), { colorVar: 0.12 });
    }
    const staticGeo = b.build({ normals: !o.lighting, sway: false });
    this.staticMesh = new THREE.Mesh(staticGeo, solid);
    this.group.add(this.staticMesh);
    this._disposables.push(staticGeo);

    // --- leaf, pivoting around its hinge -----------------------------------
    const LW = DOOR_W - 0.04;
    const lb = new MeshBuilder(o.lighting);
    lb.box(LW / 2, DOOR_H / 2 - 0.01, 0, LW, DOOR_H - 0.03, 0.07, style.leaf);
    for (const side of [1, -1]) {
      for (const px of [0.27, 0.73]) {
        for (const py of [0.25, 0.72]) {
          const ph = py < 0.5 ? DOOR_H * 0.3 : DOOR_H * 0.34;
          lb.box(LW * px, DOOR_H * py, side * 0.04, LW * 0.36, ph, 0.03, style.panel);
        }
      }
      lb.box(LW * 0.88, DOOR_H * 0.46, side * 0.075, 0.07, 0.07, 0.07, style.metal);
      lb.box(LW * 0.88, DOOR_H * 0.46 - 0.12, side * 0.05, 0.03, 0.2, 0.025, style.metal);
    }
    for (const hy of [0.22, 1.1, 2.0]) lb.box(0.05, hy, 0, 0.1, 0.12, 0.1, style.metal);
    const leafGeo = lb.build({ normals: !o.lighting, sway: false });
    this.pivot = new THREE.Group();
    this.pivot.position.set(-hw + 0.02, 0, 0);
    this.leafMesh = new THREE.Mesh(leafGeo, solid);
    this.pivot.add(this.leafMesh);
    this.group.add(this.pivot);
    this._disposables.push(leafGeo);

    // --- portal + beam -----------------------------------------------------
    this.portalMat = makePortalMaterial({ horizon: o.horizon, zenith: o.zenith, glow: o.glow });
    this.portal = new THREE.Mesh(portalGeo, this.portalMat);
    this.group.add(this.portal);
    this._disposables.push(this.portalMat);
    if (o.beam) {
      this.beamMat = makeBeamMaterial(o.glow);
      this.beamMat.uniforms.uBase.value = this.y;
      this.beam = new THREE.Mesh(beamGeo, this.beamMat);
      this.beam.frustumCulled = false;
      this.beam.renderOrder = 5;
      this.group.add(this.beam);
      this._disposables.push(this.beamMat);
    }

    // --- colliders (world space oriented boxes) ----------------------------
    const y0 = this.y - 0.5;
    const y1 = this.y + DOOR_H + 0.3;
    this.jambs = [-(hw + pw / 2), hw + pw / 2].map((lx) => this._box(lx, 0, pw / 2, depth / 2, y0, y1));
    this.leafCollider = this._box(0, 0, hw, 0.08, y0, y1);
    this.colliders = [...this.jambs, this.leafCollider];
  }

  _box(lx, lz, hx, hz, y0, y1) {
    // local (lx, lz) -> world: x axis = (c, -s), z axis = (s, c)
    return {
      kind: 1,
      x: this.x + lx * this.c + lz * this.s,
      z: this.z - lx * this.s + lz * this.c,
      hx,
      hz,
      c: this.c,
      s: this.s,
      y0,
      y1,
      top: false,
      enabled: true,
    };
  }

  /** Player position in the door's local frame. */
  toLocal(px, pz, out = {}) {
    const dx = px - this.x;
    const dz = pz - this.z;
    out.x = dx * this.c - dz * this.s;
    out.z = dx * this.s + dz * this.c;
    return out;
  }

  get isOpen() {
    return this.state === 'open';
  }

  /** Swing the leaf toward whichever side the player is standing on. */
  open(px, pz) {
    if (this.state === 'open' || this.state === 'opening') return false;
    const local = this.toLocal(px, pz);
    this.swing = local.z >= 0 ? -1 : 1;
    this.state = 'opening';
    return true;
  }

  /** Snap shut (used when the player re-enters a room). */
  reset() {
    this.state = 'closed';
    this.t = 0;
    this.pivot.rotation.y = 0;
    this.leafCollider.enabled = true;
    this.portalMat.uniforms.uOpen.value = 0;
  }

  close() {
    if (this.state === 'closed' || this.state === 'closing') return false;
    this.state = 'closing';
    return true;
  }

  update(dt, time, playerPos) {
    if (this.state === 'opening') {
      this.t = Math.min(1, this.t + dt / 0.85);
      if (this.t >= 1) this.state = 'open';
    } else if (this.state === 'closing') {
      this.t = Math.max(0, this.t - dt / 0.7);
      if (this.t <= 0) this.state = 'closed';
    } else if (this.state === 'open' && playerPos) {
      const d = Math.hypot(playerPos.x - this.x, playerPos.z - this.z);
      if (d > 16) this.close();
    }
    const e = this.t * this.t * (3 - 2 * this.t);
    this.pivot.rotation.y = this.swing * OPEN_ANGLE * e;
    this.leafCollider.enabled = this.t < 0.55;
    const u = this.portalMat.uniforms;
    u.uTime.value = time;
    u.uOpen.value = this.t;
    if (this.beamMat) this.beamMat.uniforms.uTime.value = time;
  }

  /** True when the player's movement this frame passed through the open doorway. */
  crossed(prev, curr) {
    if (this.t < 0.8) return false;
    const a = this.toLocal(prev.x, prev.z, { x: 0, z: 0 });
    const b = this.toLocal(curr.x, curr.z, { x: 0, z: 0 });
    if (a.z * b.z > 0) return false;
    if (Math.abs(a.z - b.z) < 1e-6 && Math.abs(b.z) > 0.2) return false;
    if (Math.abs(a.z) > 1.2 && Math.abs(b.z) > 1.2) return false;
    const t = a.z === b.z ? 0 : a.z / (a.z - b.z);
    const lx = a.x + (b.x - a.x) * t;
    const feet = curr.y - this.y;
    return Math.abs(lx) < DOOR_W / 2 + 0.15 && feet > -0.6 && feet < DOOR_H - 0.4;
  }

  /** Can the player press E on this door from here? */
  canInteract(pos, eye, forward) {
    if (this.state !== 'closed') return false;
    const dx = this.center.x - eye.x;
    const dy = this.center.y - eye.y;
    const dz = this.center.z - eye.z;
    const d = Math.hypot(dx, dy, dz);
    if (d > 4.0) return false;
    return (dx * forward.x + dy * forward.y + dz * forward.z) / Math.max(d, 1e-5) > 0.6;
  }

  dispose() {
    for (const d of this._disposables) d.dispose();
  }
}
