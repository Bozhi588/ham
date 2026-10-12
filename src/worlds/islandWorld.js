import * as THREE from 'three';
import { World } from './world.js';
import { Noise } from '../util/noise.js';
import { mulberry32, hashInts, hashFloat, clamp, lerp, smoothstep, TAU, weightedPick } from '../util/rng.js';
import { Lighting } from '../gfx/lighting.js';
import { MeshBuilder } from '../gfx/builder.js';
import { createWind, makePropMaterial, makeGrassMaterial, makeSkyMaterial, makeParticles, getBladeGeometry } from '../gfx/materials.js';
import { puffTree, rock, flowerHead, crystalCluster, cloudBank } from '../gfx/props.js';
import { Door } from '../door.js';
import { circle, resolveColliders, topAt } from '../colliders.js';
import { BIOME_DATA, pickDestination } from './biomeData.js';
import { QUALITY } from '../quality.js';

const CELL = 38; // lattice spacing between island centres
const NS = 48; // angular samples around each island
const SEA_Y = -75; // altitude of the cloud sea

const col = (h) => new THREE.Color(h);
const P = {
  grassLo: col(0x4d9a3a),
  grassHi: col(0x92d24c),
  rim: col(0xb6dc72),
  rockA: col(0xa8998a),
  rockB: col(0x8a7c70),
  soil: col(0x7a5a3c),
  moss: col(0x5e8f46),
  root: col(0x5b4630),
  white: col(0xffffff),
  leaves: [0x5ab24c, 0x70c957, 0x49a35e, 0x86cf5a, 0xf0a65a].map(col),
  bark: col(0x6d5238),
  rocks: col(0x9a948c),
  crystals: [0x66e8ff, 0x8aa8ff, 0xff8ad8, 0x9affc8].map(col),
  flowers: [0xffffff, 0xffe066, 0xff8fb0, 0xb99cff, 0xff9a5c, 0x8fe6ff].map(col),
};

const CONFIG = {
  wind: { angle: 0.4, strength: 0.55 },
  fog: { color: 0xdcecff, near: 90, far: 285 },
  sunDir: (() => {
    const az = (215 * Math.PI) / 180;
    const el = (52 * Math.PI) / 180;
    return [Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)];
  })(),
};

const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * Floating islands over a sea of clouds. Islands sit on a jittered lattice
 * with stepping stones bridging wide gaps, so the world is endless and every
 * island is reachable by jumping and gliding.
 */
export class IslandWorld extends World {
  constructor(game, seed, opts = {}) {
    super(game);
    this.seed = seed;
    this.biomeId = 'islands';
    this.windLevel = 0.45;
    this.surfaceType = 'grass';
    this.quality = opts.quality ?? QUALITY[2];
    this.view = this.quality.islandView; // cell radius kept loaded
    this.highRing = this.quality.highRing; // cells within this ring get full detail
    const far = Math.min(CONFIG.fog.far, this.view * CELL * 0.95);
    this.fog = { color: CONFIG.fog.color, near: Math.min(CONFIG.fog.near, far * 0.35), far };
    this.killY = SEA_Y - 40;
    this.backLook = opts.backLook ?? { glow: 0xffc27a, horizon: 0x3a2c20, zenith: 0x0c0907 };
    this.spawnOverride = opts.spawn ?? null;

    this.noise = new Noise(seed * 7 + 3);
    this.palNoise = new Noise(seed * 11 + 9);
    this.lighting = new Lighting({ sunDir: CONFIG.sunDir, sunColor: 0xfff2d8, skyColor: 0xb4d4f6, groundColor: 0xc5d9ee, sunK: 0.78, ambK: 0.62 });
    this.wind = createWind(CONFIG.wind.angle, CONFIG.wind.strength);

    this.solidMat = makePropMaterial(null);
    this.propMat = makePropMaterial(this.wind);
    this.grassMat = makeGrassMaterial(this.wind, { baseMul: [0.52, 0.64, 0.42], tipMul: [1.2, 1.32, 0.85], fadeNear: 42, fadeFar: 88 });

    this.sky = new THREE.Mesh(
      new THREE.SphereGeometry(1, 40, 20),
      makeSkyMaterial({
        zenith: 0x2f78e0,
        horizon: 0xdcecff,
        sunDir: CONFIG.sunDir,
        sunColor: 0xfff4dc,
        cloudLight: 0xffffff,
        cloudDark: 0xa8bfdc,
        cover: 0.45,
        sunSize: 0.9994,
        seaY: SEA_Y,
      }),
    );
    this.sky.scale.setScalar(900);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -100;
    this.group.add(this.sky);

    this.particles = [
      makeParticles({ count: 260, box: 90, color: 0xfff8e0, size: 0.07, drift: [0.5, 0.25, 0.2], speed: 2.5, bob: 1.5, additive: true, opacity: 0.8, wind: this.wind }),
    ];
    this.particles.forEach((p) => this.group.add(p));

    this.recCache = new Map();
    this.baseCache = new Map();
    this.cells = new Map();
    this.queue = [];
    this.pci = null;
    this.pcj = null;
    this._doors = [];
    this._doorsDirty = false;
    this.safeRec = null;

    const rnd = mulberry32(hashInts(seed, 23));
    this.spawnYaw = rnd() * TAU;
    // the first portal always lives on an orthogonal neighbour, which is guaranteed to be linked
    this.forceEast = ![[1, 0], [-1, 0], [0, 1], [0, -1]].some(([a, b]) => mulberry32(hashInts(seed, a, b, 555))() < 0.82);
    this.starter = this._pickStarter();
  }

  // ------------------------------------------------------------------ layout
  /** The raw island of a lattice cell (no door yet), or null. */
  baseRec(i, j) {
    const key = i + ',' + j;
    if (this.baseCache.has(key)) return this.baseCache.get(key);
    const rnd = mulberry32(hashInts(this.seed, i, j, 555));
    const e = rnd();
    const jx = rnd();
    const jz = rnd();
    const rr = rnd();
    const yy = rnd();
    const dd = rnd();
    const ds = rnd();
    const spawn = i === 0 && j === 0;
    let rec = null;
    if (spawn || e < 0.82 || (this.forceEast && i === 1 && j === 0)) {
      const R = spawn ? 12.5 : lerp(6, 14.5, rr ** 1.15);
      rec = {
        kind: 'main',
        i,
        j,
        k: 0,
        cx: spawn ? 0 : (i + (jx - 0.5) * 0.4) * CELL,
        cz: spawn ? 0 : (j + (jz - 0.5) * 0.4) * CELL,
        y: spawn ? 0 : this.noise.noise2(i * 0.35 + 11, j * 0.35 - 7) * 6 + (yy - 0.5) * 3.5,
        R,
        D: R * lerp(0.95, 1.7, dd),
        dome: lerp(0.8, 2.2, ds) * (R / 10),
        door: null,
        spawn,
      };
      this._shape(rec);
    }
    this.baseCache.set(key, rec);
    return rec;
  }

  /** Fill in the radius table that makes each island's outline irregular. */
  _shape(rec, roughness = 1) {
    rec.rth = new Float32Array(NS);
    let max = 0;
    for (let s = 0; s < NS; s++) {
      const a = -Math.PI + (TAU * s) / NS;
      const f =
        1 +
        0.2 * roughness * this.noise.noise2(Math.cos(a) * 1.1 + rec.cx * 0.31 + 50, Math.sin(a) * 1.1 + rec.cz * 0.31) +
        0.07 * roughness * this.noise.noise2(Math.cos(a) * 3.3 + rec.cx * 0.2, Math.sin(a) * 3.3 + rec.cz * 0.2 + 9);
      rec.rth[s] = rec.R * clamp(f, 0.72, 1.28);
      if (rec.rth[s] > max) max = rec.rth[s];
    }
    rec.Rmax = max;
  }

  _finalize(rec) {
    rec.rimY = new Float32Array(NS);
    for (let s = 0; s < NS; s++) {
      const a = -Math.PI + (TAU * s) / NS;
      rec.rimY[s] = this.topRaw(rec, rec.cx + Math.cos(a) * rec.rth[s], rec.cz + Math.sin(a) * rec.rth[s]);
    }
  }

  _pickStarter() {
    const fwd = { x: Math.sin(this.spawnYaw + Math.PI), z: Math.cos(this.spawnYaw + Math.PI) };
    let best = null;
    let bestScore = Infinity;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const r = this.baseRec(di, dj);
      if (!r) continue;
      const dist = Math.hypot(r.cx, r.cz);
      const dot = (r.cx * fwd.x + r.cz * fwd.z) / dist;
      // prefer big islands that lie ahead of the spawn point
      const score = dist - 22 * dot - (r.R >= 7.5 ? 25 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = [di, dj];
      }
    }
    return best ?? [1, 0];
  }

  /** Island records (main island + owned stepping stones) of a cell, with doors resolved. */
  cellRecs(i, j) {
    const key = i + ',' + j;
    if (this.recCache.has(key)) return this.recCache.get(key);
    const out = [];
    const main = this.baseRec(i, j);
    if (main) {
      this._assignDoor(main);
      this._finalize(main);
      out.push(main);
      // stepping stones toward the +x and +z neighbours when the gap is wide
      for (const [di, dj, tag] of [[1, 0, 1], [0, 1, 2], [1, 1, 3]]) {
        const other = this.baseRec(i + di, j + dj);
        if (!other) continue;
        const dx = other.cx - main.cx;
        const dz = other.cz - main.cz;
        const dist = Math.hypot(dx, dz);
        const gap = dist - main.R * 0.85 - other.R * 0.85;
        const rise = Math.abs(other.y - main.y);
        // bridge wide gaps and big height differences with small stepping stones
        const byGap = gap >= 13 ? Math.ceil(gap / 11) - 1 : 0;
        const byRise = rise > 2.2 ? Math.ceil(rise / 1.8) - 1 : 0;
        const n = Math.max(byGap, byRise);
        if (n < 1 || (tag === 3 && gap < 22 && rise < 4)) continue;
        const ux = dx / dist;
        const uz = dz / dist;
        const rnd = mulberry32(hashInts(this.seed, i, j, 900 + tag));
        for (let s = 0; s < n; s++) {
          const t = (s + 1) / (n + 1);
          const along = main.R * 0.85 + gap * t;
          const side = (rnd() - 0.5) * 3.5;
          const R = lerp(1.8, 3.3, rnd());
          const stone = {
            kind: 'stone',
            i,
            j,
            k: tag * 10 + s + 1,
            cx: main.cx + ux * along - uz * side,
            cz: main.cz + uz * along + ux * side,
            y: lerp(main.y, other.y, t) + (rnd() - 0.5) * 0.6,
            R,
            D: R * 2.2,
            dome: 0.35,
            door: null,
          };
          this._shape(stone, 1.2);
          this._finalize(stone);
          out.push(stone);
        }
      }
    }
    this.recCache.set(key, out);
    return out;
  }

  _assignDoor(rec) {
    if (rec.doorDone) return;
    rec.doorDone = true;
    const rnd = mulberry32(hashInts(this.seed, rec.i, rec.j, 909));
    let site = null;
    if (rec.spawn) {
      site = { kind: 'return', k: 0, x: 0, z: 0, yaw: this.spawnYaw };
    } else if (rec.i === this.starter[0] && rec.j === this.starter[1]) {
      site = { kind: 'portal', k: 1 };
    } else if (rec.R >= 7.5 && rnd() < 0.2) {
      site = { kind: 'portal', k: 0 };
    }
    if (!site) return;
    if (site.kind === 'portal') {
      const a = rnd() * TAU;
      const d = rec.R * lerp(0.3, 0.5, rnd());
      site.x = rec.cx + Math.cos(a) * d;
      site.z = rec.cz + Math.sin(a) * d;
      site.yaw = Math.atan2(rec.cx - site.x, rec.cz - site.z); // face the island centre
    }
    site.y = this.topBase(rec, site.x, site.z);
    rec.door = site;
  }

  // ------------------------------------------------------------------ geometry maths
  radiusAt(rec, th) {
    let f = ((th + Math.PI) / TAU) * NS;
    let i0 = Math.floor(f);
    const t = f - i0;
    i0 = ((i0 % NS) + NS) % NS;
    return rec.rth[i0] * (1 - t) + rec.rth[(i0 + 1) % NS] * t;
  }

  rimYAt(rec, th) {
    let f = ((th + Math.PI) / TAU) * NS;
    let i0 = Math.floor(f);
    const t = f - i0;
    i0 = ((i0 % NS) + NS) % NS;
    return rec.rimY[i0] * (1 - t) + rec.rimY[(i0 + 1) % NS] * t;
  }

  /** Top surface without door flattening. */
  topBase(rec, x, z) {
    const dx = x - rec.cx;
    const dz = z - rec.cz;
    const Rt = this.radiusAt(rec, Math.atan2(dz, dx));
    const d = Math.min(Math.hypot(dx, dz) / Rt, 1.25);
    const drop = 1.5 * smoothstep(0.78, 1.0, d) + Math.max(d - 1, 0) * 6;
    return rec.y + rec.dome * (1 - d * d) + this.noise.fbm2(x / 12, z / 12, 2) * 0.9 + this.noise.noise2(x / 3.1, z / 3.1) * 0.12 - drop;
  }

  topRaw(rec, x, z) {
    let h = this.topBase(rec, x, z);
    const door = rec.door;
    if (door) {
      const ds = Math.hypot(x - door.x, z - door.z);
      if (ds < 6) h += (door.y - h) * smoothstep(5.8, 3.2, ds);
    }
    return h;
  }

  /** Top surface or -Infinity outside the island outline. */
  topClipped(rec, x, z) {
    const dx = x - rec.cx;
    const dz = z - rec.cz;
    if (dx * dx + dz * dz > rec.Rmax * rec.Rmax) return -Infinity;
    const Rt = this.radiusAt(rec, Math.atan2(dz, dx));
    if (dx * dx + dz * dz > Rt * Rt) return -Infinity;
    return this.topRaw(rec, x, z);
  }

  // ------------------------------------------------------------------ doors
  _makeDoor(rec) {
    const s = rec.door;
    let dest;
    let look;
    if (s.kind === 'return') {
      dest = { kind: 'back' };
      look = this.backLook;
    } else {
      const d = pickDestination('islands', this.seed, rec.i, rec.j, s.k);
      dest = { kind: 'world', biome: d.biome, seed: d.seed };
      look = BIOME_DATA[d.biome];
    }
    const style = weightedPick(BIOME_DATA.islands.door, hashFloat(this.seed, rec.i, rec.j, s.k + 9));
    return new Door({
      id: `${rec.i},${rec.j},${s.k}`,
      x: s.x,
      y: s.y,
      z: s.z,
      yaw: s.yaw,
      dest,
      glow: look.glow,
      horizon: look.horizon,
      zenith: look.zenith,
      style,
      lighting: this.lighting,
      material: this.solidMat,
      plinth: true,
      beam: true,
    });
  }

  get doors() {
    if (this._doorsDirty) {
      this._doors = [];
      for (const c of this.cells.values()) this._doors.push(...c.doors);
      this._doorsDirty = false;
    }
    return this._doors;
  }

  // ------------------------------------------------------------------ building
  _topColor(x, z, d, nx, ny, nz, out) {
    const n = this.palNoise.fbm2(x / 9, z / 9, 2);
    out.copy(P.grassLo).lerp(P.grassHi, clamp(0.5 + n, 0, 1));
    out.lerp(P.rim, smoothstep(0.8, 0.98, d) * 0.7);
    const sh = this.lighting.shade(nx, ny, nz, { r: 1, g: 1, b: 1 });
    out.r *= sh.r;
    out.g *= sh.g;
    out.b *= sh.b;
    return out;
  }

  _rockColor(x, y, z, t, out) {
    const n = this.noise.noise3(x * 0.08, y * 0.35, z * 0.08);
    const band = 0.5 + 0.5 * Math.sin(y * 1.7 + n * 2.5);
    out.copy(P.rockA).lerp(P.rockB, band);
    out.lerp(P.soil, (1 - smoothstep(0, 0.16, t)) * 0.85);
    out.lerp(P.moss, clamp(n * 0.6 + 0.1, 0, 1) * (1 - smoothstep(0.1, 0.5, t)) * 0.5);
    out.multiplyScalar(1 - 0.4 * t);
    return out;
  }

  buildCell(i, j, detail) {
    const recs = this.cellRecs(i, j);
    const key = i + ',' + j;
    const cell = { i, j, key, recs, detail, group: new THREE.Group(), doors: [], colliders: [], geos: [], grass: null };
    if (recs.length) {
      const b = new MeshBuilder(this.lighting);
      const blades = { off: [], par: [], tnt: [] };
      for (const rec of recs) this._addIsland(rec, detail, b, cell, blades);
      const geo = b.build();
      const mesh = new THREE.Mesh(geo, this.propMat);
      mesh.matrixAutoUpdate = false;
      cell.group.add(mesh);
      cell.geos.push(geo);
      if (blades.par.length) this._addGrass(cell, blades);
      this.group.add(cell.group);
    }
    this.cells.set(key, cell);
    this._doorsDirty = true;
    return cell;
  }

  _addGrass(cell, blades) {
    const n = blades.par.length / 4;
    const geo = new THREE.InstancedBufferGeometry();
    const base = getBladeGeometry();
    geo.index = base.index;
    geo.setAttribute('position', base.attributes.position);
    geo.setAttribute('aOff', new THREE.InstancedBufferAttribute(new Float32Array(blades.off), 3));
    geo.setAttribute('aParam', new THREE.InstancedBufferAttribute(new Float32Array(blades.par), 4));
    geo.setAttribute('aTint', new THREE.InstancedBufferAttribute(new Float32Array(blades.tnt), 3));
    geo.instanceCount = n;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let k = 0; k < n; k++) {
      const x = blades.off[k * 3], y = blades.off[k * 3 + 1], z = blades.off[k * 3 + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    const c = new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
    geo.boundingSphere = new THREE.Sphere(c, Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2 + 2);
    const mesh = new THREE.Mesh(geo, this.grassMat);
    mesh.matrixAutoUpdate = false;
    cell.group.add(mesh);
    cell.grass = mesh;
    cell.geos.push(geo);
  }

  _addIsland(rec, detail, b, cell, blades) {
    const rnd = mulberry32(hashInts(this.seed, rec.i, rec.j, rec.k * 131 + 777));
    const stone = rec.kind === 'stone';
    const stepS = detail && !stone ? 1 : 2;
    const NSd = NS / stepS;
    const NR = stone ? 3 : detail ? clamp(Math.round(rec.R * 0.75), 5, 10) : 3;
    const ND = stone ? 5 : detail ? 8 : 4;
    const tmp = new THREE.Color();
    const e = 0.5;

    // ---- top surface (smooth shaded) ------------------------------------------
    const vert = (x, z, d) => {
      const y = this.topRaw(rec, x, z);
      const nx = (y - this.topRaw(rec, x + e, z)) / e;
      const nz = (y - this.topRaw(rec, x, z + e)) / e;
      const nl = Math.hypot(nx, 1, nz);
      this._topColor(x, z, d, nx / nl, 1 / nl, nz / nl, tmp);
      return { p: [x, y, z], c: { r: tmp.r, g: tmp.g, b: tmp.b } };
    };
    const rings = [];
    for (let k = 1; k <= NR; k++) {
      const d = Math.pow(k / NR, 0.9);
      const arr = [];
      for (let s = 0; s < NSd; s++) {
        const si = s * stepS;
        const th = -Math.PI + (TAU * si) / NS;
        arr.push(vert(rec.cx + Math.cos(th) * d * rec.rth[si], rec.cz + Math.sin(th) * d * rec.rth[si], d));
      }
      rings.push(arr);
    }
    const centre = vert(rec.cx, rec.cz, 0);
    const addTop = (a, bb, c) => {
      const ux = bb.p[0] - a.p[0], uz = bb.p[2] - a.p[2];
      const vx = c.p[0] - a.p[0], vz = c.p[2] - a.p[2];
      // y component of the cross product decides which way the triangle faces
      if (uz * vx - ux * vz > 0) b.triColors(a.p, bb.p, c.p, a.c, bb.c, c.c);
      else b.triColors(a.p, c.p, bb.p, a.c, c.c, bb.c);
    };
    for (let s = 0; s < NSd; s++) addTop(centre, rings[0][s], rings[0][(s + 1) % NSd]);
    for (let k = 0; k < NR - 1; k++) {
      for (let s = 0; s < NSd; s++) {
        const s2 = (s + 1) % NSd;
        addTop(rings[k][s], rings[k][s2], rings[k + 1][s2]);
        addTop(rings[k][s], rings[k + 1][s2], rings[k + 1][s]);
      }
    }

    // ---- rocky underside (flat shaded) -----------------------------------------
    const rim = rings[NR - 1];
    const body = [rim.map((v) => v.p)];
    let meanRim = 0;
    for (const v of rim) meanRim += v.p[1];
    meanRim /= NSd;
    const tip = [rec.cx, meanRim - rec.D * (1.08 + rnd() * 0.12), rec.cz];
    for (let m = 1; m < ND; m++) {
      const t = m / ND;
      const arr = [];
      for (let s = 0; s < NSd; s++) {
        const si = s * stepS;
        const th = -Math.PI + (TAU * si) / NS;
        let rr = rec.rth[si] * Math.pow(1 - t, 0.65);
        const y = rim[s].p[1] - rec.D * t * (1 + 0.05 * t);
        const bump = Math.abs(this.noise.noise3((rec.cx + Math.cos(th) * rr) * 0.13, y * 0.17, (rec.cz + Math.sin(th) * rr) * 0.13));
        rr *= 1 - 0.22 * bump * smoothstep(0, 0.25, t);
        arr.push([rec.cx + Math.cos(th) * rr, y, rec.cz + Math.sin(th) * rr]);
      }
      body.push(arr);
    }
    const addBody = (p0, p1, p2) => {
      const cxm = (p0[0] + p1[0] + p2[0]) / 3;
      const cym = (p0[1] + p1[1] + p2[1]) / 3;
      const czm = (p0[2] + p1[2] + p2[2]) / 3;
      const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
      const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
      const nx = uy * vz - uz * vy;
      const nz = ux * vy - uy * vx;
      const out = nx * (cxm - rec.cx) + nz * (czm - rec.cz);
      const t = clamp((meanRim - cym) / rec.D, 0, 1);
      this._rockColor(cxm, cym, czm, t, tmp);
      const c = { r: tmp.r, g: tmp.g, b: tmp.b };
      if (out >= 0) b.tri(p0, p1, p2, c);
      else b.tri(p0, p2, p1, c);
    };
    for (let m = 0; m < ND - 1; m++) {
      for (let s = 0; s < NSd; s++) {
        const s2 = (s + 1) % NSd;
        addBody(body[m][s], body[m][s2], body[m + 1][s2]);
        addBody(body[m][s], body[m + 1][s2], body[m + 1][s]);
      }
    }
    for (let s = 0; s < NSd; s++) addBody(body[ND - 1][s], body[ND - 1][(s + 1) % NSd], tip);

    if (!detail) {
      this._addDoor(rec, cell);
    } else {
      this._decorate(rec, rnd, b, cell, blades, body, ND, NSd, stepS);
    }
    if (rec.kind === 'main') this._addClouds(rec, rnd, b, detail);
  }

  /** Drifting cloud banks around and below an island, some poking up from the sea. */
  _addClouds(rec, rnd, b, detail) {
    const n = 1 + Math.floor(rnd() * 2);
    for (let i = 0; i < n; i++) {
      const a = rnd() * TAU;
      const dist = rec.R * lerp(0.4, 2.2, rnd());
      const y = lerp(rec.y - rec.D - 28, SEA_Y + 14, rnd());
      cloudBank(b, rnd, rec.cx + Math.cos(a) * dist, y, rec.cz + Math.sin(a) * dist, lerp(7, 14, rnd()), P.white, 1);
    }
  }

  _addDoor(rec, cell) {
    if (!rec.door) return;
    const door = this._makeDoor(rec);
    cell.group.add(door.group);
    cell.doors.push(door);
    cell.colliders.push(...door.colliders);
  }

  _decorate(rec, rnd, b, cell, blades, body, ND, NSd, stepS) {
    const occupied = [];
    const main = rec.kind === 'main';

    // door
    if (rec.door) {
      const door = this._makeDoor(rec);
      cell.group.add(door.group);
      cell.doors.push(door);
      cell.colliders.push(...door.colliders);
      occupied.push({ x: rec.door.x, z: rec.door.z, r: 3.6 });
    }

    const spot = (maxD, radius) => {
      for (let t = 0; t < 12; t++) {
        const a = rnd() * TAU;
        const Rt = this.radiusAt(rec, a);
        const d = Math.sqrt(rnd()) * maxD;
        const x = rec.cx + Math.cos(a) * d * Rt;
        const z = rec.cz + Math.sin(a) * d * Rt;
        let ok = true;
        for (const o of occupied) {
          if ((x - o.x) ** 2 + (z - o.z) ** 2 < (radius + o.r) ** 2) {
            ok = false;
            break;
          }
        }
        if (rec.spawn && x * x + z * z < 36) ok = false;
        if (ok) return { x, z, y: this.topRaw(rec, x, z) };
      }
      return null;
    };
    const add = (x, y, z, info, top) => {
      cell.colliders.push(circle(x, z, info.radius, y - 1.5, y + info.height, top));
      occupied.push({ x, z, r: info.radius + 0.3 });
    };

    if (main) {
      // trees
      const nTrees = Math.floor((rec.R / 4.2) * (0.4 + rnd() * 1.0));
      for (let n = 0; n < nTrees; n++) {
        const pt = spot(0.78, 1.8);
        if (!pt) continue;
        const info = puffTree(b, rnd, pt.x, pt.y, pt.z, { height: [2.8, 5.2], bark: P.bark, leaves: [P.leaves[Math.floor(rnd() * 3.99)], P.leaves[Math.floor(rnd() * 4.99)]] });
        add(pt.x, pt.y, pt.z, { radius: 0.32, height: info.height }, false);
      }
      // rocks
      const nRocks = Math.floor(rnd() * 3.2);
      for (let n = 0; n < nRocks; n++) {
        const size = lerp(0.5, 1.5, rnd());
        const pt = spot(0.85, size);
        if (!pt) continue;
        const info = rock(b, rnd, pt.x, pt.y, pt.z, size, P.rocks, { cluster: 1 });
        add(pt.x, pt.y, pt.z, info, true);
      }
      // crystals on top
      if (rnd() < 0.3) {
        const pt = spot(0.7, 1.2);
        if (pt) {
          crystalCluster(b, rnd, pt.x, pt.y - 0.05, pt.z, { colors: P.crystals, scale: 1.2 });
          add(pt.x, pt.y, pt.z, { radius: 0.6, height: 1.6 }, false);
        }
      }
      // flowers
      const nFlowers = Math.floor(rec.R * rec.R * 0.15);
      for (let n = 0; n < nFlowers; n++) {
        const pt = spot(0.92, 0.3);
        if (!pt) continue;
        flowerHead(b, pt.x, pt.y + 0.28 + rnd() * 0.28, pt.z, P.flowers[Math.floor(rnd() * P.flowers.length)]);
      }
    }

    // hanging roots + crystals on the underside
    const nRoots = main ? 5 + Math.floor(rnd() * 6) : 2;
    for (let n = 0; n < nRoots; n++) {
      const s = Math.floor(rnd() * NSd);
      const m = 1 + Math.floor(rnd() * 3);
      const p0 = body[Math.min(m, ND - 1)][s];
      const L = lerp(2.5, 9, rnd()) * (main ? 1 : 0.6);
      const pts = [];
      for (let q = 0; q < 4; q++) {
        const f = q / 3;
        pts.push([p0[0] + Math.sin(f * 4 + n) * 0.25, p0[1] - L * f, p0[2] + Math.cos(f * 3 + n) * 0.25]);
      }
      b.tube(pts, [0.09, 0.06, 0.035, 0.012], 4, P.root, {
        capTop: false,
        swayFn: (yy) => Math.pow(clamp((p0[1] - yy) / L, 0, 1), 1.2) * 0.9,
      });
    }
    if (main && rnd() < 0.55) {
      const s = Math.floor(rnd() * NSd);
      const p = body[Math.floor(ND * 0.55)][s];
      crystalCluster(b, rnd, p[0], p[1], p[2], { colors: P.crystals, scale: 1.4, dir: -1 });
    }

    // grass
    const density = main ? 4.6 : 3.5;
    const count = Math.floor(Math.PI * rec.R * rec.R * 0.85 * density * this.quality.grass);
    const tint = new THREE.Color();
    const e = 0.5;
    for (let n = 0; n < count; n++) {
      const a = rnd() * TAU;
      const Rt = this.radiusAt(rec, a);
      const d = Math.sqrt(rnd()) * 0.965;
      const x = rec.cx + Math.cos(a) * d * Rt;
      const z = rec.cz + Math.sin(a) * d * Rt;
      const hRnd = rnd();
      const wRnd = rnd();
      const yaw = rnd() * TAU;
      const r = rnd();
      let blocked = false;
      for (const o of occupied) {
        if ((x - o.x) ** 2 + (z - o.z) ** 2 < o.r * o.r) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      const y = this.topRaw(rec, x, z);
      const nx = (y - this.topRaw(rec, x + e, z)) / e;
      const nz = (y - this.topRaw(rec, x, z + e)) / e;
      const nl = Math.hypot(nx, 1, nz);
      this._topColor(x, z, d, nx / nl, 1 / nl, nz / nl, tint);
      blades.off.push(x, y - 0.02, z);
      blades.par.push(yaw, lerp(0.35, 0.78, hRnd), lerp(0.06, 0.1, wRnd), r);
      blades.tnt.push(tint.r, tint.g, tint.b);
    }
  }

  disposeCell(cell) {
    this.group.remove(cell.group);
    for (const g of cell.geos) g.dispose();
    for (const d of cell.doors) d.dispose();
    this.cells.delete(cell.key);
    this._doorsDirty = true;
  }

  // ------------------------------------------------------------------ streaming
  _plan(pci, pcj) {
    this.pci = pci;
    this.pcj = pcj;
    const tasks = [];
    const VIEW = this.view;
    for (let dj = -VIEW; dj <= VIEW; dj++) {
      for (let di = -VIEW; di <= VIEW; di++) {
        const ring = Math.max(Math.abs(di), Math.abs(dj));
        const i = pci + di;
        const j = pcj + dj;
        const cell = this.cells.get(i + ',' + j);
        const want = ring <= this.highRing ? 1 : 0;
        if (!cell || cell.detail < want) tasks.push({ i, j, detail: want, key: Math.hypot(di, dj) });
      }
    }
    tasks.sort((a, b) => a.key - b.key);
    this.queue = tasks;
    for (const cell of [...this.cells.values()]) {
      if (Math.max(Math.abs(cell.i - pci), Math.abs(cell.j - pcj)) > VIEW + 1) this.disposeCell(cell);
    }
  }

  _runTask(t) {
    const old = this.cells.get(t.i + ',' + t.j);
    if (old) {
      if (old.detail >= t.detail) return;
      this.disposeCell(old);
    }
    this.buildCell(t.i, t.j, t.detail);
  }

  stream(px, pz, budgetMs) {
    const pci = Math.floor(px / CELL + 0.5);
    const pcj = Math.floor(pz / CELL + 0.5);
    if (pci !== this.pci || pcj !== this.pcj) this._plan(pci, pcj);
    const t0 = performance.now();
    while (this.queue.length && performance.now() - t0 < budgetMs) this._runTask(this.queue.shift());
  }

  async preload(onProgress) {
    const sp = this.spawn();
    this._plan(Math.floor(sp.x / CELL + 0.5), Math.floor(sp.z / CELL + 0.5));
    const total = this.queue.length;
    let done = 0;
    while (this.queue.length) {
      this._runTask(this.queue.shift());
      done++;
      if (done % 3 === 0) {
        onProgress?.(done / total);
        await tick();
      }
    }
    onProgress?.(1);
  }

  spawn() {
    if (this.spawnOverride) {
      const s = this.spawnOverride;
      return { x: s.x, y: s.y, z: s.z, yaw: s.yaw };
    }
    const main = this.cellRecs(0, 0)[0];
    const x = Math.sin(this.spawnYaw) * 3.2;
    const z = Math.cos(this.spawnYaw) * 3.2;
    return { x, y: this.topRaw(main, x, z), z, yaw: this.spawnYaw + Math.PI };
  }

  // ------------------------------------------------------------------ per frame
  update(dt, time, player, camera) {
    this.wind.uTime.value = time;
    this.sky.position.copy(camera.position);
    this.sky.material.uniforms.uTime.value = time;
    this.sky.material.uniforms.uCam.value.copy(camera.position);
    this.stream(player.feet.x, player.feet.z, 7);
    for (const d of this.doors) d.update(dt, time, player.feet);
    const scale = this.game.pointScale;
    for (const p of this.particles) p.material.uniforms.uScale.value = scale;
  }

  _nearbyCells(x, z, fn) {
    const ci = Math.floor(x / CELL + 0.5);
    const cj = Math.floor(z / CELL + 0.5);
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const cell = this.cells.get(ci + di + ',' + (cj + dj));
        if (cell) fn(cell);
      }
    }
  }

  ground(x, z, y) {
    let best = -Infinity;
    this._nearbyCells(x, z, (cell) => {
      for (const rec of cell.recs) {
        const t = this.topClipped(rec, x, z);
        if (t <= y && t > best) best = t;
      }
      const t = topAt(cell.colliders, x, z, y);
      if (t > best) best = t;
    });
    return best;
  }

  collide(player) {
    const p = player.feet;
    this._nearbyCells(p.x, p.z, (cell) => {
      resolveColliders(cell.colliders, player);
      for (const rec of cell.recs) this._hullPush(rec, player);
    });
  }

  /** Islands are solid below their top surface: slide off cliffs instead of walking through. */
  _hullPush(rec, player) {
    const p = player.feet;
    const dx = p.x - rec.cx;
    const dz = p.z - rec.cz;
    const r = Math.hypot(dx, dz);
    if (r > rec.Rmax + 1) return;
    const th = Math.atan2(dz, dx);
    const Rt = this.radiusAt(rec, th);
    if (r > Rt + 1) return;
    const top = this.topRaw(rec, p.x, p.z);
    if (p.y >= top - 0.6) return;
    const rimY = this.rimYAt(rec, th);
    const ym = p.y + 0.9;
    let Rh = Rt;
    if (ym < rimY) {
      const t = (rimY - ym) / rec.D;
      if (t >= 1) return;
      Rh = Rt * Math.pow(1 - t, 0.65);
    }
    const need = Rh + player.radius;
    if (r < need) {
      const nx = r > 1e-4 ? dx / r : 1;
      const nz = r > 1e-4 ? dz / r : 0;
      p.x = rec.cx + nx * need;
      p.z = rec.cz + nz * need;
      const into = player.vel.x * nx + player.vel.z * nz;
      if (into < 0) {
        player.vel.x -= nx * into;
        player.vel.z -= nz * into;
      }
    }
  }

  ceiling(player) {
    const p = player.feet;
    let best = Infinity;
    this._nearbyCells(p.x, p.z, (cell) => {
      for (const rec of cell.recs) {
        const dx = p.x - rec.cx;
        const dz = p.z - rec.cz;
        const th = Math.atan2(dz, dx);
        const Rt = this.radiusAt(rec, th);
        const d = Math.hypot(dx, dz) / Rt;
        if (d >= 1) continue;
        const yb = this.rimYAt(rec, th) - rec.D * (1 - Math.pow(d, 1.538));
        if (yb >= p.y + 0.2 && yb < best) best = yb;
      }
    });
    return best;
  }

  isSafe(x, y, z) {
    let safe = false;
    this._nearbyCells(x, z, (cell) => {
      for (const rec of cell.recs) {
        if (rec.kind !== 'main') continue;
        const dx = x - rec.cx;
        const dz = z - rec.cz;
        const Rt = this.radiusAt(rec, Math.atan2(dz, dx));
        if (Math.hypot(dx, dz) < Rt * 0.65 && Math.abs(this.topRaw(rec, x, z) - y) < 0.5) safe = true;
      }
    });
    return safe;
  }

  surface(x, z) {
    return 'grass';
  }
}
