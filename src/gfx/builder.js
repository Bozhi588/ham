import * as THREE from 'three';
import { hashFloat } from '../util/rng.js';

// ---------------------------------------------------------------------------
// Unit icosphere (cached per detail level) used for rocks and foliage blobs.
// ---------------------------------------------------------------------------
const icoCache = new Map();
function icosphere(detail) {
  if (icoCache.has(detail)) return icoCache.get(detail);
  const t = (1 + Math.sqrt(5)) / 2;
  let verts = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map((v) => {
    const l = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / l, v[1] / l, v[2] / l];
  });
  let faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  for (let d = 0; d < detail; d++) {
    const cache = new Map();
    const mid = (a, b) => {
      const key = a < b ? a * 65536 + b : b * 65536 + a;
      let idx = cache.get(key);
      if (idx === undefined) {
        const va = verts[a];
        const vb = verts[b];
        const m = [(va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2, (va[2] + vb[2]) / 2];
        const l = Math.hypot(m[0], m[1], m[2]);
        verts.push([m[0] / l, m[1] / l, m[2] / l]);
        idx = verts.length - 1;
        cache.set(key, idx);
      }
      return idx;
    };
    const next = [];
    for (const [a, b, c] of faces) {
      const ab = mid(a, b);
      const bc = mid(b, c);
      const ca = mid(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = next;
  }
  const out = { verts, faces };
  icoCache.set(detail, out);
  return out;
}

const _shade = { r: 1, g: 1, b: 1 };
const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();

/**
 * Accumulates flat-shaded, vertex-coloured triangles into one BufferGeometry.
 * With a Lighting object the sun/sky light is baked into the colours; without
 * one the raw albedo is stored (for materials lit by real lights).
 * Each vertex can also carry a "sway" weight used by the wind shader.
 */
export class MeshBuilder {
  constructor(lighting = null) {
    this.lighting = lighting;
    this.pos = [];
    this.col = [];
    this.sway = [];
    this.matrix = null;
    this.unlit = false; // set true to skip baked lighting (glowing things)
  }

  /** Apply a THREE.Matrix4 to everything added until it is cleared with null. */
  setMatrix(m) {
    this.matrix = m;
    return this;
  }

  get triangleCount() {
    return this.pos.length / 9;
  }

  /** p0..p2 are [x,y,z]; color is {r,g,b}; sway/ao are optional per-vertex arrays. */
  tri(p0, p1, p2, color, sway = null, ao = null) {
    let a = p0;
    let b = p1;
    let c = p2;
    if (this.matrix) {
      _v.set(a[0], a[1], a[2]).applyMatrix4(this.matrix);
      a = [_v.x, _v.y, _v.z];
      _v.set(b[0], b[1], b[2]).applyMatrix4(this.matrix);
      b = [_v.x, _v.y, _v.z];
      _v.set(c[0], c[1], c[2]).applyMatrix4(this.matrix);
      c = [_v.x, _v.y, _v.z];
    }
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) return;
    nx /= len;
    ny /= len;
    nz /= len;
    let r = color.r;
    let g = color.g;
    let bl = color.b;
    if (this.lighting && !this.unlit) {
      this.lighting.shade(nx, ny, nz, _shade);
      r *= _shade.r;
      g *= _shade.g;
      bl *= _shade.b;
    }
    const pts = [a, b, c];
    for (let i = 0; i < 3; i++) {
      const p = pts[i];
      this.pos.push(p[0], p[1], p[2]);
      const k = ao ? ao[i] : 1;
      this.col.push(r * k, g * k, bl * k);
      this.sway.push(sway ? sway[i] : 0);
    }
  }

  /** Triangle with pre-lit per-vertex colours (smooth shading); no lighting applied. */
  triColors(p0, p1, p2, c0, c1, c2, sway = null) {
    let pts = [p0, p1, p2];
    if (this.matrix) {
      pts = pts.map((p) => {
        _v.set(p[0], p[1], p[2]).applyMatrix4(this.matrix);
        return [_v.x, _v.y, _v.z];
      });
    }
    const cols = [c0, c1, c2];
    for (let i = 0; i < 3; i++) {
      this.pos.push(pts[i][0], pts[i][1], pts[i][2]);
      this.col.push(cols[i].r, cols[i].g, cols[i].b);
      this.sway.push(sway ? sway[i] : 0);
    }
  }

  quad(a, b, c, d, color, sway = null, ao = null) {
    this.tri(a, b, c, color, sway && [sway[0], sway[1], sway[2]], ao && [ao[0], ao[1], ao[2]]);
    this.tri(a, c, d, color, sway && [sway[0], sway[2], sway[3]], ao && [ao[0], ao[2], ao[3]]);
  }

  /** Axis-aligned box. `aoBottom` darkens the lower vertices (contact shadow). */
  box(cx, cy, cz, sx, sy, sz, color, aoBottom = 1) {
    const x0 = cx - sx / 2, x1 = cx + sx / 2;
    const y0 = cy - sy / 2, y1 = cy + sy / 2;
    const z0 = cz - sz / 2, z1 = cz + sz / 2;
    const lo = aoBottom;
    // +y, -y, +x, -x, +z, -z (counter-clockwise seen from outside)
    this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], color);
    this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], color);
    this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], color, null, [lo, lo, 1, 1]);
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], color, null, [lo, lo, 1, 1]);
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], color, null, [lo, lo, 1, 1]);
    this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], color, null, [lo, lo, 1, 1]);
  }

  /**
   * Lumpy ellipsoid for rocks and foliage.
   * opts: detail, jitter, seed, colorVar, swayFn(y)->weight, underDark
   */
  blob(cx, cy, cz, rx, ry, rz, color, opts = {}) {
    const { detail = 1, jitter = 0.18, seed = 0, colorVar = 0.12, swayFn = null, underDark = 0.65 } = opts;
    const { verts, faces } = icosphere(detail);
    const pts = new Array(verts.length);
    const aos = new Array(verts.length);
    for (let i = 0; i < verts.length; i++) {
      const v = verts[i];
      const k = 1 + (hashFloat(seed, i, 7) - 0.5) * 2 * jitter;
      pts[i] = [cx + v[0] * rx * k, cy + v[1] * ry * k, cz + v[2] * rz * k];
      aos[i] = underDark + (1 - underDark) * (v[1] * 0.5 + 0.5);
    }
    const tmp = { r: 0, g: 0, b: 0 };
    for (let f = 0; f < faces.length; f++) {
      const [a, b, c] = faces[f];
      const kv = 1 + (hashFloat(seed, f, 13) - 0.5) * 2 * colorVar;
      tmp.r = color.r * kv;
      tmp.g = color.g * kv;
      tmp.b = color.b * kv;
      const sw = swayFn ? [swayFn(pts[a][1]), swayFn(pts[b][1]), swayFn(pts[c][1])] : null;
      this.tri(pts[a], pts[b], pts[c], tmp, sw, [aos[a], aos[b], aos[c]]);
    }
  }

  /** Smooth-shaded lumpy ellipsoid (pre-lit per vertex): used for clouds. */
  blobSmooth(cx, cy, cz, rx, ry, rz, color, opts = {}) {
    const { detail = 2, jitter = 0.1, seed = 0, underDark = 0.6, bright = 1 } = opts;
    const { verts, faces } = icosphere(detail);
    const pts = [];
    const cols = [];
    const sh = { r: 1, g: 1, b: 1 };
    for (let i = 0; i < verts.length; i++) {
      const v = verts[i];
      const k = 1 + (hashFloat(seed, i, 7) - 0.5) * 2 * jitter;
      pts.push([cx + v[0] * rx * k, cy + v[1] * ry * k, cz + v[2] * rz * k]);
      let nx = v[0] / rx;
      let ny = v[1] / ry;
      let nz = v[2] / rz;
      const nl = Math.hypot(nx, ny, nz);
      nx /= nl;
      ny /= nl;
      nz /= nl;
      if (this.lighting) this.lighting.shade(nx, ny, nz, sh);
      const ao = (underDark + (1 - underDark) * (v[1] * 0.5 + 0.5)) * bright;
      cols.push({ r: color.r * sh.r * ao, g: color.g * sh.g * ao, b: color.b * sh.b * ao });
    }
    for (const [a, b, c] of faces) this.triColors(pts[a], pts[b], pts[c], cols[a], cols[b], cols[c]);
  }

  /**
   * Tapered tube along a polyline. points: [[x,y,z]...], radii: number[].
   * swayFn(y) gives the wind weight for a ring at height y.
   */
  tube(points, radii, sides, color, opts = {}) {
    const { swayFn = null, capTop = true, capBottom = false, colorVar = 0.08, seed = 0, twist = 0 } = opts;
    const rings = [];
    const t = new THREE.Vector3();
    const u = new THREE.Vector3();
    const w = new THREE.Vector3();
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const prev = points[Math.max(0, i - 1)];
      const next = points[Math.min(points.length - 1, i + 1)];
      t.set(next[0] - prev[0], next[1] - prev[1], next[2] - prev[2]).normalize();
      if (Math.abs(t.y) > 0.95) u.set(1, 0, 0);
      else u.set(0, 1, 0);
      u.cross(t).normalize();
      w.crossVectors(t, u).normalize();
      const ring = [];
      for (let s = 0; s < sides; s++) {
        const ang = (s / sides) * Math.PI * 2 + i * twist;
        const cs = Math.cos(ang) * radii[i];
        const sn = Math.sin(ang) * radii[i];
        ring.push([p[0] + u.x * cs + w.x * sn, p[1] + u.y * cs + w.y * sn, p[2] + u.z * cs + w.z * sn]);
      }
      rings.push(ring);
    }
    const tmp = { r: 0, g: 0, b: 0 };
    for (let i = 0; i < rings.length - 1; i++) {
      for (let s = 0; s < sides; s++) {
        const s2 = (s + 1) % sides;
        const a = rings[i][s];
        const b = rings[i][s2];
        const c = rings[i + 1][s2];
        const d = rings[i + 1][s];
        const kv = 1 + (hashFloat(seed, i * 31 + s, 3) - 0.5) * 2 * colorVar;
        tmp.r = color.r * kv;
        tmp.g = color.g * kv;
        tmp.b = color.b * kv;
        const sw = swayFn ? [swayFn(a[1]), swayFn(b[1]), swayFn(c[1]), swayFn(d[1])] : null;
        const lo = 0.75 + 0.25 * (i / Math.max(1, rings.length - 1));
        const hi = 0.75 + 0.25 * ((i + 1) / Math.max(1, rings.length - 1));
        this.quad(a, b, c, d, tmp, sw && [sw[0], sw[1], sw[2], sw[3]], [lo, lo, hi, hi]);
      }
    }
    // rings run counter-clockwise seen from the tip of the tube
    const cap = (ring, center, flip) => {
      for (let s = 0; s < sides; s++) {
        const s2 = (s + 1) % sides;
        if (flip) this.tri(center, ring[s2], ring[s], color);
        else this.tri(center, ring[s], ring[s2], color);
      }
    };
    if (capTop) {
      const last = rings.length - 1;
      cap(rings[last], points[last], false);
    }
    if (capBottom) cap(rings[0], points[0], true);
  }

  cylinder(cx, cy, cz, r, h, sides, color, opts = {}) {
    this.tube(
      [
        [cx, cy, cz],
        [cx, cy + h, cz],
      ],
      [r, opts.rTop ?? r],
      sides,
      color,
      { capTop: true, capBottom: true, ...opts },
    );
  }

  /** Hexagonal crystal with a pointed tip. Negative `h` makes it hang downward. */
  crystal(cx, cy, cz, r, h, color, tilt = [0, 0], sides = 6) {
    const tx = tilt[0];
    const tz = tilt[1];
    const flip = h < 0;
    const ring = (y, rr) => {
      const out = [];
      for (let s = 0; s < sides; s++) {
        const a = (s / sides) * Math.PI * 2;
        out.push([cx + Math.cos(a) * rr + tx * y, cy + y, cz + Math.sin(a) * rr + tz * y]);
      }
      return out;
    };
    const base = ring(0, r);
    const mid = ring(h * 0.7, r * 0.9);
    const tip = [cx + tx * h * 1.05, cy + h * 1.1, cz + tz * h * 1.05];
    for (let s = 0; s < sides; s++) {
      const s2 = (s + 1) % sides;
      if (!flip) {
        this.quad(base[s], mid[s], mid[s2], base[s2], color, null, [0.6, 1, 1, 0.6]);
        this.tri(mid[s], tip, mid[s2], color, null, [1, 1.25, 1]);
      } else {
        this.quad(base[s2], mid[s2], mid[s], base[s], color, null, [0.6, 1, 1, 0.6]);
        this.tri(mid[s2], tip, mid[s], color, null, [1, 1.25, 1]);
      }
    }
  }

  /** Returns a BufferGeometry (non-indexed). Pass { normals: true } for lit materials. */
  build({ normals = false, sway = true } = {}) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    if (sway) g.setAttribute('aSway', new THREE.Float32BufferAttribute(this.sway, 1));
    if (normals) g.computeVertexNormals();
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}
