import * as THREE from 'three';
import { World } from './world.js';
import { Noise } from '../util/noise.js';
import { mulberry32, hashInts, hashFloat, clamp, lerp, smoothstep, TAU, weightedPick } from '../util/rng.js';
import { Lighting } from '../gfx/lighting.js';
import { MeshBuilder } from '../gfx/builder.js';
import {
  createWind,
  makeTerrainMaterial,
  makePropMaterial,
  makeGrassMaterial,
  makeSkyMaterial,
  makeParticles,
  getBladeGeometry,
} from '../gfx/materials.js';
import { windTree, pineTree, rock, monolith, cactus, deadTree, flowerHead } from '../gfx/props.js';
import { Door } from '../door.js';
import { circle, resolveColliders, topAt } from '../colliders.js';
import { BIOME_DATA, pickDestination } from './biomeData.js';

export const CHUNK = 64; // metres per chunk side
const SEG = 48; // quads per chunk side
const STEP = CHUNK / SEG;
const B = 2; // border of extra samples used for normals and ambient occlusion
const G = SEG + 1 + B * 2;
const N1 = SEG + 1;
const REGION = 96; // door cell size
const FLAT_IN = 3.6; // terrain is flattened around doors
const FLAT_OUT = 15;
const VIEW = 3; // chunk radius that is kept loaded
const GRASS_RING = 2; // chunk radius that gets grass

let sharedIndex = null;
function getIndex() {
  if (sharedIndex) return sharedIndex;
  const idx = new Uint16Array(SEG * SEG * 6);
  let k = 0;
  for (let j = 0; j < SEG; j++) {
    for (let i = 0; i < SEG; i++) {
      const a = j * N1 + i;
      const b = (j + 1) * N1 + i;
      const c = a + 1;
      const d = b + 1;
      idx[k++] = a;
      idx[k++] = b;
      idx[k++] = c;
      idx[k++] = c;
      idx[k++] = b;
      idx[k++] = d;
    }
  }
  sharedIndex = new THREE.BufferAttribute(idx, 1);
  return sharedIndex;
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const toColors = (arr) => arr.map((h) => new THREE.Color(h));

/**
 * An endless, chunk-streamed landscape: heightfield terrain, wind-bent grass,
 * scenery and doors, all derived deterministically from the seed.
 */
export class TerrainWorld extends World {
  /**
   * @param cfg   entry of TERRAIN_CONFIGS
   * @param seed  integer seed
   * @param opts  { spawn: {x,z,yaw}, backLook: {glow,horizon,zenith} }
   */
  constructor(game, cfg, seed, opts = {}) {
    super(game);
    this.cfg = cfg;
    this.seed = seed;
    this.biomeId = cfg.id;
    this.windLevel = cfg.windLevel;
    this.surfaceType = cfg.surface;
    this.fog = cfg.fog;
    this.exposure = cfg.exposure ?? 1;
    this.backLook = opts.backLook ?? { glow: 0xffc27a, horizon: 0x3a2c20, zenith: 0x0c0907 };
    this.spawnOverride = opts.spawn ?? null;

    this.noise = new Noise(seed * 7 + 1);
    this.palNoise = new Noise(seed * 13 + 5);
    const base = cfg.height(this.noise);
    // Slide the landscape so the spawn point (0,0) sits on a calm stretch of ground.
    const [ox, oz] = this._calmOffset(base);
    this.raw = (x, z) => base(x + ox, z + oz);
    this._base = base;
    this._off = [ox, oz];
    this.lighting = new Lighting(cfg.light);
    this.wind = createWind(cfg.wind.angle, cfg.wind.strength);
    this.windDir = { x: Math.cos(cfg.wind.angle), z: Math.sin(cfg.wind.angle) };

    const det = cfg.detail ?? { grain: 0.16, ripple: 0 };
    this.terrainMat = makeTerrainMaterial({ grain: det.grain, ripple: det.ripple, dirX: this.windDir.x, dirZ: this.windDir.z });
    this.solidMat = makePropMaterial(null);
    this.propMat = makePropMaterial(this.wind);
    this.grassMat = cfg.grass
      ? makeGrassMaterial(this.wind, { baseMul: cfg.grass.baseMul, tipMul: cfg.grass.tipMul, fadeNear: 55, fadeFar: 105 })
      : null;
    for (const m of [this.terrainMat, this.solidMat, this.propMat, this.grassMat]) if (m) m.userData.shared = true;

    this.props = cfg.props ?? {};
    this.treeCols = this.props.trees
      ? { bark: new THREE.Color(this.props.trees.bark), leaves: toColors(this.props.trees.leaves) }
      : null;

    this.sky = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 20), makeSkyMaterial({ ...cfg.sky, windX: cfg.sky.windX, windZ: cfg.sky.windZ }));
    this.sky.scale.setScalar(900);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -100;
    this.group.add(this.sky);

    this.particles = (cfg.particles ?? []).map((p) => {
      const pts = makeParticles({ ...p, wind: this.wind });
      this.group.add(pts);
      return pts;
    });

    this.chunks = new Map();
    this.siteCache = new Map();
    this._siteCell = null;
    this._siteList = [];
    this.queue = [];
    this.pcx = null;
    this.pcz = null;
    this._doors = [];
    this._doorsDirty = false;

    // The return door stands at the origin; the first portal is placed in view.
    const rnd = mulberry32(hashInts(seed, 17));
    this.spawnYaw = rnd() * TAU;
  }

  /** Relief (max - min height) in a disc of radius r around (x,z) of a raw height fn. */
  static relief(fn, x, z, r) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let a = 0; a < 8; a++) {
      for (const f of a === 0 ? [0] : [0.5, 1]) {
        const ang = (a / 8) * TAU;
        const h = fn(x + Math.cos(ang) * r * f, z + Math.sin(ang) * r * f);
        if (h < lo) lo = h;
        if (h > hi) hi = h;
      }
      const hc = fn(x, z);
      if (hc < lo) lo = hc;
      if (hc > hi) hi = hc;
    }
    return hi - lo;
  }

  _calmOffset(base) {
    const rnd = mulberry32(hashInts(this.seed, 71));
    let best = [0, 0];
    let bestScore = Infinity;
    for (let k = 0; k < 24; k++) {
      const ox = k === 0 ? 0 : (rnd() - 0.5) * 3000;
      const oz = k === 0 ? 0 : (rnd() - 0.5) * 3000;
      const score = TerrainWorld.relief((x, z) => base(x + ox, z + oz), 0, 0, 24) + TerrainWorld.relief((x, z) => base(x + ox, z + oz), 0, 0, 48) * 0.35;
      if (score < bestScore) {
        bestScore = score;
        best = [ox, oz];
      }
    }
    return best;
  }

  // ------------------------------------------------------------------ doors
  /** Door sites in region cell (i, j). Deterministic and cached. */
  sitesInCell(i, j) {
    const key = i + ',' + j;
    let list = this.siteCache.get(key);
    if (list) return list;
    list = [];
    const rnd = mulberry32(hashInts(this.seed, i, j, 4242));
    if (i === 0 && j === 0) {
      const sy = this.spawnYaw;
      list.push({ i, j, k: 0, kind: 'return', x: 0, z: 0, yaw: sy });
      // the first portal sits ahead of the spawn point, slightly off to one side
      const nx = Math.sin(sy);
      const nz = Math.cos(sy);
      const off = (rnd() < 0.5 ? -1 : 1) * lerp(0.3, 0.7, rnd());
      const dist = lerp(36, 46, rnd());
      const c = Math.cos(off);
      const s = Math.sin(off);
      const x = (nx * c - nz * s) * dist;
      const z = (nx * s + nz * c) * dist;
      const fx = (nx * 3.2 - x) / Math.hypot(nx * 3.2 - x, nz * 3.2 - z);
      const fz = (nz * 3.2 - z) / Math.hypot(nx * 3.2 - x, nz * 3.2 - z);
      list.push({ i, j, k: 1, kind: 'portal', x, z, yaw: Math.atan2(fx, fz) });
    } else if (rnd() < 0.8) {
      let best = null;
      let bestRelief = Infinity;
      for (let c = 0; c < 4; c++) {
        const x = (i + (rnd() - 0.5) * 0.6) * REGION;
        const z = (j + (rnd() - 0.5) * 0.6) * REGION;
        const rel = TerrainWorld.relief(this.raw, x, z, 9);
        if (rel < bestRelief) {
          bestRelief = rel;
          best = { x, z };
        }
      }
      list.push({ i, j, k: 0, kind: 'portal', x: best.x, z: best.z, yaw: rnd() * TAU });
    }
    for (const s of list) s.y = this.raw(s.x, s.z);
    this.siteCache.set(key, list);
    return list;
  }

  /** All door sites whose flattening could touch the given rectangle. */
  sitesNear(minX, minZ, maxX, maxZ) {
    const out = [];
    const i0 = Math.floor(minX / REGION + 0.5) - 1;
    const i1 = Math.floor(maxX / REGION + 0.5) + 1;
    const j0 = Math.floor(minZ / REGION + 0.5) - 1;
    const j1 = Math.floor(maxZ / REGION + 0.5) + 1;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        for (const s of this.sitesInCell(i, j)) {
          if (s.x > minX - FLAT_OUT && s.x < maxX + FLAT_OUT && s.z > minZ - FLAT_OUT && s.z < maxZ + FLAT_OUT) out.push(s);
        }
      }
    }
    return out;
  }

  heightWith(x, z, sites) {
    let h = this.raw(x, z);
    for (let k = 0; k < sites.length; k++) {
      const s = sites[k];
      const dx = x - s.x;
      const dz = z - s.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < FLAT_OUT * FLAT_OUT) {
        const t = smoothstep(FLAT_OUT, FLAT_IN, Math.sqrt(d2));
        h += (s.y - h) * t;
      }
    }
    return h;
  }

  /** Final terrain height at (x, z), including flattened door pads. */
  heightAt(x, z) {
    const ci = Math.floor(x / REGION + 0.5);
    const cj = Math.floor(z / REGION + 0.5);
    const key = ci * 100003 + cj;
    if (this._siteCell !== key) {
      this._siteCell = key;
      this._siteList = this.sitesNear(ci * REGION - REGION / 2, cj * REGION - REGION / 2, ci * REGION + REGION / 2, cj * REGION + REGION / 2);
    }
    return this.heightWith(x, z, this._siteList);
  }

  _makeDoor(site) {
    const cfg = this.cfg;
    let dest;
    let look;
    if (site.kind === 'return') {
      dest = { kind: 'back' };
      look = this.backLook;
    } else {
      const d = pickDestination(cfg.id, this.seed, site.i, site.j, site.k);
      dest = { kind: 'world', biome: d.biome, seed: d.seed };
      look = BIOME_DATA[d.biome];
    }
    const style = weightedPick(BIOME_DATA[cfg.id].door, hashFloat(this.seed, site.i, site.j, site.k + 9));
    return new Door({
      id: `${site.i},${site.j},${site.k}`,
      x: site.x,
      y: site.y,
      z: site.z,
      yaw: site.yaw,
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
      for (const ch of this.chunks.values()) this._doors.push(...ch.doors);
      this._doorsDirty = false;
    }
    return this._doors;
  }

  // ------------------------------------------------------------------ chunks
  _key(cx, cz) {
    return cx + ',' + cz;
  }

  _sampleGrid(ch, arr, x, z, stride = 1, border = 0) {
    // bilinear sample of a per-vertex array (N1 x N1)
    let fx = (x - ch.x0) / STEP;
    let fz = (z - ch.z0) / STEP;
    fx = clamp(fx, 0, SEG - 1e-4);
    fz = clamp(fz, 0, SEG - 1e-4);
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const tx = fx - i;
    const tz = fz - j;
    const a = j * N1 + i;
    return (
      (arr[a * stride] * (1 - tx) + arr[(a + 1) * stride] * tx) * (1 - tz) +
      (arr[(a + N1) * stride] * (1 - tx) + arr[(a + N1 + 1) * stride] * tx) * tz
    );
  }

  buildChunk(cx, cz) {
    const x0 = cx * CHUNK;
    const z0 = cz * CHUNK;
    const sites = this.sitesNear(x0, z0, x0 + CHUNK, z0 + CHUNK);
    const hs = new Float32Array(G * G);
    for (let j = 0; j < G; j++) {
      for (let i = 0; i < G; i++) hs[j * G + i] = this.heightWith(x0 + (i - B) * STEP, z0 + (j - B) * STEP, sites);
    }

    const pos = new Float32Array(N1 * N1 * 3);
    const col = new Float32Array(N1 * N1 * 3);
    const ny = new Float32Array(N1 * N1);
    const hh = new Float32Array(N1 * N1);
    const n3a = new Float32Array(N1 * N1);
    const ctx = { x: 0, z: 0, h: 0, ny: 0, n1: 0, n2: 0, n3: 0 };
    const tmp = new THREE.Color();
    const sh = { r: 1, g: 1, b: 1 };
    const pal = this.cfg.palette;
    let minH = Infinity;
    let maxH = -Infinity;
    for (let j = 0; j < N1; j++) {
      for (let i = 0; i < N1; i++) {
        const gi = (j + B) * G + (i + B);
        const h = hs[gi];
        let nx = (hs[gi - 1] - hs[gi + 1]) / (2 * STEP);
        let nz = (hs[gi - G] - hs[gi + G]) / (2 * STEP);
        const nl = Math.hypot(nx, 1, nz);
        nx /= nl;
        nz /= nl;
        const nyv = 1 / nl;
        const conc = (hs[gi - 2] + hs[gi + 2] + hs[gi - 2 * G] + hs[gi + 2 * G]) * 0.25 - h;
        const ao = clamp(1 - conc * 0.3, 0.62, 1.06);
        const x = x0 + i * STEP;
        const z = z0 + j * STEP;
        ctx.x = x;
        ctx.z = z;
        ctx.h = h;
        ctx.ny = nyv;
        ctx.n1 = this.palNoise.fbm2(x / 80, z / 80, 2);
        ctx.n2 = this.palNoise.noise2(x / 6, z / 6 + 100);
        ctx.n3 = clamp(0.5 + 0.65 * this.palNoise.fbm2(x / 45 - 50, z / 45 + 70, 2), 0, 1);
        pal(ctx, tmp);
        this.lighting.shade(nx, nyv, nz, sh);
        const k = j * N1 + i;
        pos[k * 3] = x;
        pos[k * 3 + 1] = h;
        pos[k * 3 + 2] = z;
        col[k * 3] = tmp.r * sh.r * ao;
        col[k * 3 + 1] = tmp.g * sh.g * ao;
        col[k * 3 + 2] = tmp.b * sh.b * ao;
        ny[k] = nyv;
        hh[k] = h;
        n3a[k] = ctx.n3;
        if (h < minH) minH = h;
        if (h > maxH) maxH = h;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(getIndex());
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.terrainMat);
    mesh.matrixAutoUpdate = false;

    const group = new THREE.Group();
    group.add(mesh);
    const ch = {
      cx,
      cz,
      x0,
      z0,
      group,
      hs: hh,
      ny,
      col,
      n3: n3a,
      minH,
      maxH,
      sites,
      colliders: [],
      occupied: [],
      doors: [],
      grass: null,
      geos: [geo],
    };

    this._populate(ch);
    this.group.add(group);
    this.chunks.set(this._key(cx, cz), ch);
    this._doorsDirty = true;
    return ch;
  }

  _populate(ch) {
    const rnd = mulberry32(hashInts(this.seed, ch.cx, ch.cz, 31337));
    const b = new MeshBuilder(this.lighting);
    const p = this.props;
    const x0 = ch.x0;
    const z0 = ch.z0;
    const wd = this.windDir;

    // doors that belong to this chunk
    for (const s of ch.sites) {
      if (s.x >= x0 && s.x < x0 + CHUNK && s.z >= z0 && s.z < z0 + CHUNK) {
        const door = this._makeDoor(s);
        ch.group.add(door.group);
        ch.doors.push(door);
        ch.colliders.push(...door.colliders);
        ch.occupied.push({ x: s.x, z: s.z, r: 3.4 });
      }
    }

    const place = (minNy, radius) => {
      for (let t = 0; t < 14; t++) {
        const x = x0 + rnd() * CHUNK;
        const z = z0 + rnd() * CHUNK;
        if (this._sampleGrid(ch, ch.ny, x, z) < minNy) continue;
        let ok = true;
        for (const s of ch.sites) {
          if ((x - s.x) ** 2 + (z - s.z) ** 2 < (radius + 5.5) ** 2) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        for (const o of ch.occupied) {
          if ((x - o.x) ** 2 + (z - o.z) ** 2 < (radius + o.r) ** 2) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        return { x, z, y: this._sampleGrid(ch, ch.hs, x, z) };
      }
      return null;
    };
    const count = (n) => Math.floor(n + rnd());
    const addCollider = (x, y, z, info, top) => {
      ch.colliders.push(circle(x, z, info.radius, y - 1.5, y + info.height, top));
      ch.occupied.push({ x, z, r: info.radius + 0.25 });
    };

    if (p.trees) {
      const t = p.trees;
      const kinds = t.kinds;
      for (let n = count(t.perChunk); n > 0; n--) {
        const pt = place(t.minNy, 1.8);
        if (!pt) continue;
        const kind = weightedPick(kinds, rnd());
        let info;
        if (kind === 'pine') {
          info = pineTree(b, rnd, pt.x, pt.y, pt.z, { height: t.pineHeight ?? t.height, wind: wd, bark: this.treeCols.bark, leaves: this.treeCols.leaves, lean: t.lean });
        } else {
          info = windTree(b, rnd, pt.x, pt.y, pt.z, { height: t.height, lean: t.lean, wind: wd, trunk: t.trunk, bark: this.treeCols.bark, leaves: this.treeCols.leaves });
        }
        addCollider(pt.x, pt.y, pt.z, { radius: 0.35, height: info.height }, false);
      }
    }
    if (p.rocks) {
      const r = p.rocks;
      const col = new THREE.Color(r.color);
      for (let n = count(r.perChunk); n > 0; n--) {
        const size = lerp(r.size[0], r.size[1], rnd() ** 1.8);
        const pt = place(0.7, size);
        if (!pt) continue;
        const info = rock(b, rnd, pt.x, pt.y, pt.z, size, col, { cluster: Math.floor(rnd() * (r.cluster + 1)) });
        addCollider(pt.x, pt.y, pt.z, info, true);
      }
    }
    if (p.boulders) {
      const r = p.boulders;
      const col = new THREE.Color(r.color);
      for (let n = count(r.perChunk); n > 0; n--) {
        const size = lerp(r.size[0], r.size[1], rnd());
        const pt = place(0.6, size);
        if (!pt) continue;
        const info = rock(b, rnd, pt.x, pt.y, pt.z, size, col, { cluster: 2, jitter: 0.22, detail: 2, sink: 0.4 });
        addCollider(pt.x, pt.y, pt.z, info, true);
      }
    }
    if (p.monoliths) {
      const r = p.monoliths;
      const col = new THREE.Color(r.color);
      const glow = r.glow ? new THREE.Color(r.glow) : null;
      for (let n = count(r.perChunk); n > 0; n--) {
        const pt = place(0.88, 2.5);
        if (!pt) continue;
        const info = monolith(b, rnd, pt.x, pt.y, pt.z, { height: r.height, color: col, glow });
        addCollider(pt.x, pt.y, pt.z, info, false);
      }
    }
    if (p.cacti) {
      const r = p.cacti;
      const col = new THREE.Color(r.color);
      for (let n = count(r.perChunk); n > 0; n--) {
        const pt = place(r.minNy, 1.4);
        if (!pt) continue;
        const info = cactus(b, rnd, pt.x, pt.y, pt.z, { color: col });
        addCollider(pt.x, pt.y, pt.z, info, false);
      }
    }
    if (p.deadTrees) {
      const r = p.deadTrees;
      const col = new THREE.Color(r.color);
      for (let n = count(r.perChunk); n > 0; n--) {
        const pt = place(r.minNy, 1.4);
        if (!pt) continue;
        const info = deadTree(b, rnd, pt.x, pt.y, pt.z, { color: col, wind: wd });
        addCollider(pt.x, pt.y, pt.z, info, false);
      }
    }
    if (p.flowers && this.cfg.grass) {
      const f = p.flowers;
      const cols = toColors(f.colors);
      const ctx = { ny: 1, n3: 0 };
      b.unlit = !!f.glow;
      for (let n = f.perChunk; n > 0; n--) {
        const x = x0 + rnd() * CHUNK;
        const z = z0 + rnd() * CHUNK;
        ctx.ny = this._sampleGrid(ch, ch.ny, x, z);
        ctx.n3 = this._sampleGrid(ch, ch.n3, x, z);
        if (ctx.ny < f.minNy || this.cfg.grass.mask(ctx) < 0.6) continue;
        let near = false;
        for (const s of ch.sites) if ((x - s.x) ** 2 + (z - s.z) ** 2 < 25) near = true;
        if (near) continue;
        const y = this._sampleGrid(ch, ch.hs, x, z);
        flowerHead(b, x, y + 0.3 + rnd() * 0.3, z, cols[Math.floor(rnd() * cols.length)]);
      }
      b.unlit = false;
    }

    if (b.triangleCount > 0) {
      const geo = b.build();
      const mesh = new THREE.Mesh(geo, this.propMat);
      mesh.matrixAutoUpdate = false;
      ch.group.add(mesh);
      ch.geos.push(geo);
    }
  }

  buildGrass(ch) {
    const g = this.cfg.grass;
    if (!g || g.density <= 0 || ch.grass) return;
    const rnd = mulberry32(hashInts(this.seed, ch.cx, ch.cz, 991));
    const spacing = 1 / Math.sqrt(g.density);
    const per = Math.ceil(CHUNK / spacing);
    const max = per * per;
    const off = new Float32Array(max * 3);
    const par = new Float32Array(max * 4);
    const tnt = new Float32Array(max * 3);
    const ctx = { ny: 1, n3: 0 };
    let n = 0;
    const occ = ch.occupied;
    for (let a = 0; a < per; a++) {
      for (let c = 0; c < per; c++) {
        const x = ch.x0 + (a + rnd()) * spacing;
        const z = ch.z0 + (c + rnd()) * spacing;
        const accept = rnd();
        const hRnd = rnd();
        const wRnd = rnd();
        const yaw = rnd() * TAU;
        const r = rnd();
        if (x >= ch.x0 + CHUNK || z >= ch.z0 + CHUNK) continue;
        ctx.ny = this._sampleGrid(ch, ch.ny, x, z);
        ctx.n3 = this._sampleGrid(ch, ch.n3, x, z);
        if (accept > g.mask(ctx)) continue;
        let blocked = false;
        for (let k = 0; k < occ.length; k++) {
          const o = occ[k];
          if ((x - o.x) * (x - o.x) + (z - o.z) * (z - o.z) < o.r * o.r) {
            blocked = true;
            break;
          }
        }
        if (blocked) continue;
        const y = this._sampleGrid(ch, ch.hs, x, z);
        off[n * 3] = x;
        off[n * 3 + 1] = y - 0.02;
        off[n * 3 + 2] = z;
        par[n * 4] = yaw;
        par[n * 4 + 1] = lerp(g.height[0], g.height[1], hRnd);
        par[n * 4 + 2] = lerp(g.width[0], g.width[1], wRnd);
        par[n * 4 + 3] = r;
        tnt[n * 3] = this._sampleGrid(ch, ch.col, x, z, 3);
        tnt[n * 3 + 1] = this._sampleGrid({ x0: ch.x0, z0: ch.z0 }, ch.col.subarray(1), x, z, 3);
        tnt[n * 3 + 2] = this._sampleGrid({ x0: ch.x0, z0: ch.z0 }, ch.col.subarray(2), x, z, 3);
        n++;
      }
    }
    if (n === 0) return;
    const geo = new THREE.InstancedBufferGeometry();
    const base = getBladeGeometry();
    geo.index = base.index;
    geo.setAttribute('position', base.attributes.position);
    geo.setAttribute('aOff', new THREE.InstancedBufferAttribute(off.slice(0, n * 3), 3));
    geo.setAttribute('aParam', new THREE.InstancedBufferAttribute(par.slice(0, n * 4), 4));
    geo.setAttribute('aTint', new THREE.InstancedBufferAttribute(tnt.slice(0, n * 3), 3));
    geo.instanceCount = n;
    const cy = (ch.minH + ch.maxH) / 2;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(ch.x0 + CHUNK / 2, cy, ch.z0 + CHUNK / 2), CHUNK * 0.72 + (ch.maxH - ch.minH) / 2 + 2);
    const mesh = new THREE.Mesh(geo, this.grassMat);
    mesh.matrixAutoUpdate = false;
    ch.group.add(mesh);
    ch.grass = mesh;
    ch.geos.push(geo);
  }

  disposeChunk(ch) {
    this.group.remove(ch.group);
    for (const g of ch.geos) g.dispose();
    for (const d of ch.doors) d.dispose();
    this.chunks.delete(this._key(ch.cx, ch.cz));
    this._doorsDirty = true;
  }

  disposeGrass(ch) {
    if (!ch.grass) return;
    ch.group.remove(ch.grass);
    const geo = ch.grass.geometry;
    geo.dispose();
    ch.geos = ch.geos.filter((g) => g !== geo);
    ch.grass = null;
  }

  // ------------------------------------------------------------------ streaming
  _plan(pcx, pcz) {
    this.pcx = pcx;
    this.pcz = pcz;
    const tasks = [];
    for (let dz = -VIEW; dz <= VIEW; dz++) {
      for (let dx = -VIEW; dx <= VIEW; dx++) {
        const cx = pcx + dx;
        const cz = pcz + dz;
        const ring = Math.max(Math.abs(dx), Math.abs(dz));
        const dist = Math.hypot(dx, dz);
        const ch = this.chunks.get(this._key(cx, cz));
        if (!ch) tasks.push({ type: 'chunk', cx, cz, key: dist });
        if (ring <= GRASS_RING && this.cfg.grass && (!ch || !ch.grass)) tasks.push({ type: 'grass', cx, cz, key: dist + 0.6 });
      }
    }
    tasks.sort((a, b) => a.key - b.key);
    this.queue = tasks;
    // unload anything that has drifted out of range
    for (const ch of [...this.chunks.values()]) {
      const ring = Math.max(Math.abs(ch.cx - pcx), Math.abs(ch.cz - pcz));
      if (ring > VIEW + 1) this.disposeChunk(ch);
      else if (ring > GRASS_RING + 1) this.disposeGrass(ch);
    }
  }

  _runTask(t) {
    if (t.type === 'chunk') {
      if (!this.chunks.has(this._key(t.cx, t.cz))) this.buildChunk(t.cx, t.cz);
    } else {
      const ch = this.chunks.get(this._key(t.cx, t.cz));
      if (ch) this.buildGrass(ch);
    }
  }

  stream(px, pz, budgetMs) {
    const pcx = Math.floor(px / CHUNK);
    const pcz = Math.floor(pz / CHUNK);
    if (pcx !== this.pcx || pcz !== this.pcz) this._plan(pcx, pcz);
    const t0 = performance.now();
    while (this.queue.length && performance.now() - t0 < budgetMs) this._runTask(this.queue.shift());
  }

  async preload(onProgress) {
    const sp = this.spawn();
    this._plan(Math.floor(sp.x / CHUNK), Math.floor(sp.z / CHUNK));
    const total = this.queue.length;
    let done = 0;
    while (this.queue.length) {
      this._runTask(this.queue.shift());
      done++;
      if (done % 2 === 0) {
        onProgress?.(done / total);
        await tick();
      }
    }
    onProgress?.(1);
  }

  spawn() {
    if (this.spawnOverride) {
      const s = this.spawnOverride;
      return { x: s.x, y: this.heightAt(s.x, s.z), z: s.z, yaw: s.yaw };
    }
    const nx = Math.sin(this.spawnYaw);
    const nz = Math.cos(this.spawnYaw);
    const x = nx * 3.2;
    const z = nz * 3.2;
    return { x, y: this.heightAt(x, z), z, yaw: this.spawnYaw + Math.PI };
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

  _chunkAt(x, z) {
    return this.chunks.get(this._key(Math.floor(x / CHUNK), Math.floor(z / CHUNK)));
  }

  ground(x, z, y) {
    let g = this.heightAt(x, z);
    const cx = Math.floor(x / CHUNK);
    const cz = Math.floor(z / CHUNK);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const ch = this.chunks.get(this._key(cx + dx, cz + dz));
        if (!ch) continue;
        const t = topAt(ch.colliders, x, z, y);
        if (t > g) g = t;
      }
    }
    return g;
  }

  collide(player) {
    const cx = Math.floor(player.feet.x / CHUNK);
    const cz = Math.floor(player.feet.z / CHUNK);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const ch = this.chunks.get(this._key(cx + dx, cz + dz));
        if (ch) resolveColliders(ch.colliders, player);
      }
    }
  }

  isSafe() {
    return true;
  }
}
