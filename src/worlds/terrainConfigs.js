import * as THREE from 'three';
import { clamp, smoothstep } from '../util/rng.js';

const C = (hex) => new THREE.Color(hex);
const dir = (azDeg, elDeg) => {
  const az = (azDeg * Math.PI) / 180;
  const el = (elDeg * Math.PI) / 180;
  return [Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)];
};

// ---------------------------------------------------------------------------
// Height functions. Each factory receives a seeded Noise and returns h(x, z).
// "Windswept" hills are stretched along the wind: long, streamlined ridges.
// ---------------------------------------------------------------------------
function hills(angle, o) {
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  return (noise) => (x, z) => {
    const u = x * ca + z * sa; // along the wind
    const v = -x * sa + z * ca; // across it
    const macro = noise.fbm2(u / o.along, v / o.across, 3, 2.1, 0.5);
    const ridge = noise.ridged2(u / (o.along * 0.55) + 31, v / (o.across * 0.5) - 17, 2);
    const detail = noise.fbm2(x / 26, z / 26, 2) * o.detail + noise.noise2(x / 7, z / 7) * o.detail * 0.18;
    return macro * o.amp + ridge * o.ridge + detail;
  };
}

function dunes(angle) {
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  return (noise) => (x, z) => {
    const u = x * ca + z * sa;
    const v = -x * sa + z * ca;
    // gentle domain warp so crest lines meander without ever pinching the profile
    const warp = noise.fbm2(u / 260, v / 160, 3) * 38 + noise.noise2(u / 70, v / 52) * 3;
    const phase = (u + warp) / 70;
    const f = phase - Math.floor(phase);
    // long gentle windward face, shorter (but walkable) slip face, rounded crest
    const rise = smoothstep(0, 0.7, f);
    const fall = 1 - smoothstep(0.7, 1.0, f);
    const prof = f < 0.7 ? rise : fall;
    const amp = 3.5 + 6.5 * (0.5 + 0.5 * noise.noise2(u / 360 + 5, v / 260));
    const swell = noise.fbm2(x / 240, z / 240, 3) * 8;
    const grain = noise.noise2(x / 9, z / 9) * 0.25;
    return prof * amp + swell + grain;
  };
}

// ---------------------------------------------------------------------------
// Palettes: ctx = { x, z, h, ny, n1, n2, n3 } -> out (THREE.Color)
// ---------------------------------------------------------------------------
function meadowPalette({ lo, hi, dry, rock, dirt, dryFrom = 14, dryTo = 32, rockFrom = 0.8, rockTo = 0.64 }) {
  return (c, out) => {
    const t = clamp(0.5 + c.n1 * 0.95, 0, 1);
    out.copy(lo).lerp(hi, t);
    out.lerp(dry, smoothstep(dryFrom, dryTo, c.h) * 0.5 * (0.6 + 0.4 * c.n2));
    out.lerp(dirt, smoothstep(0.72, 0.95, c.n3) * 0.75);
    out.lerp(rock, smoothstep(rockFrom, rockTo, c.ny));
  };
}

function sandPalette() {
  const pale = C(0xeacb94);
  const warm = C(0xd9a56a);
  const deep = C(0xb9764a);
  const rock = C(0x9b6a4a);
  return (c, out) => {
    const t = clamp(0.5 + c.n1 * 0.9, 0, 1);
    out.copy(pale).lerp(warm, t * 0.6);
    out.lerp(deep, smoothstep(0.1, 0.9, c.n3) * 0.35);
    // fine ripple streaks
    out.multiplyScalar(0.95 + 0.07 * c.n2);
    out.lerp(rock, smoothstep(0.8, 0.6, c.ny));
  };
}

// ---------------------------------------------------------------------------
// Biome configs
// ---------------------------------------------------------------------------
const verdantSun = dir(235, 46);
const goldenSun = dir(255, 11);
const moonDir = dir(120, 40);
const duneSun = dir(200, 58);

export const TERRAIN_CONFIGS = {
  // ------------------------------------------------------------------ 1
  verdant: {
    id: 'verdant',
    surface: 'grass',
    windLevel: 0.55,
    wind: { angle: 0.5, strength: 0.8 },
    fog: { color: 0xcde4ec, near: 60, far: 190 },
    sky: {
      zenith: 0x3f86d4,
      horizon: 0xcde4ec,
      sunDir: verdantSun,
      sunColor: 0xfff3da,
      cloudLight: 0xffffff,
      cloudDark: 0x9fb4cc,
      cover: 0.6,
      sunSize: 0.9994,
    },
    light: { sunDir: verdantSun, sunColor: 0xfff0d2, skyColor: 0xa8cbef, groundColor: 0x5f7442, sunK: 0.78, ambK: 0.58 },
    height: hills(0.5, { along: 340, across: 180, amp: 28, ridge: 5, detail: 1.0 }),
    palette: meadowPalette({
      lo: C(0x3d7a2a),
      hi: C(0x78b53c),
      dry: C(0xa7a84c),
      rock: C(0x84807a),
      dirt: C(0x7a6445),
    }),
    grass: {
      density: 4.4,
      height: [0.45, 0.95],
      width: [0.055, 0.09],
      baseMul: [0.48, 0.58, 0.42],
      tipMul: [1.25, 1.3, 0.78],
      mask: (c) => smoothstep(0.66, 0.76, c.ny) * (1 - smoothstep(0.68, 0.92, c.n3)),
    },
    props: {
      trees: { perChunk: 6, minNy: 0.84, kinds: [['wind', 0.7], ['pine', 0.3]], height: [3.4, 6.2], pineHeight: [5, 9], lean: 1, trunk: 0.3, bark: 0x5a4330, leaves: [0x3d7a35, 0x4a8a3a, 0x336b30, 0x5a9440] },
      rocks: { perChunk: 9, size: [0.5, 1.7], color: 0x8a867e, cluster: 2 },
      boulders: { perChunk: 0.7, size: [2.4, 4.2], color: 0x7d7a74 },
      flowers: { perChunk: 90, colors: [0xffffff, 0xffe066, 0xff8fb0, 0xb99cff, 0xffa15a], minNy: 0.85 },
    },
    particles: [{ count: 220, box: 70, color: 0xfff8d8, size: 0.05, drift: [1, 0.05, 0.3], speed: 5, bob: 1.2, additive: false, opacity: 0.7 }],
    doorGlow: 0xa6e86a,
  },

  // ------------------------------------------------------------------ 2
  golden: {
    id: 'golden',
    surface: 'grass',
    windLevel: 0.85,
    wind: { angle: 2.6, strength: 1.15 },
    fog: { color: 0xeaa070, near: 40, far: 175 },
    sky: {
      zenith: 0x2e3470,
      horizon: 0xeaa070,
      sunDir: goldenSun,
      sunColor: 0xffbb70,
      cloudLight: 0xffc890,
      cloudDark: 0x6a4f80,
      cover: 0.62,
      sunSize: 0.9988,
      sunGlow: 1.7,
      windX: -0.8,
      windZ: 0.5,
    },
    light: { sunDir: goldenSun, sunColor: 0xffa95a, skyColor: 0x8f78b0, groundColor: 0x6e4a3a, sunK: 0.95, ambK: 0.5 },
    height: hills(2.6, { along: 460, across: 220, amp: 34, ridge: 6, detail: 1.2 }),
    palette: meadowPalette({
      lo: C(0xa57a30),
      hi: C(0xd6a640),
      dry: C(0xd0b060),
      rock: C(0x8a7466),
      dirt: C(0x7f5a3c),
      dryFrom: 20,
      dryTo: 45,
    }),
    grass: {
      density: 3.2,
      height: [0.85, 1.55],
      width: [0.08, 0.13],
      baseMul: [0.55, 0.45, 0.35],
      tipMul: [1.4, 1.22, 0.78],
      mask: (c) => smoothstep(0.64, 0.74, c.ny) * (1 - smoothstep(0.68, 0.92, c.n3)),
    },
    props: {
      trees: { perChunk: 2.5, minNy: 0.86, kinds: [['wind', 1]], height: [3.8, 6.6], lean: 1.5, trunk: 0.32, bark: 0x4a3326, leaves: [0xb8561e, 0xd0792a, 0xa8421c, 0xe0932e] },
      rocks: { perChunk: 8, size: [0.5, 1.9], color: 0x8d7868, cluster: 2 },
      boulders: { perChunk: 0.9, size: [2.6, 4.8], color: 0x7d6a5e },
      monoliths: { perChunk: 0.35, height: [5, 9], color: 0x8a8078, glow: 0xffc060 },
      flowers: { perChunk: 50, colors: [0xff6a3d, 0xffb347, 0xffd98a, 0xc9528a], minNy: 0.85 },
    },
    particles: [{ count: 300, box: 80, color: 0xffd6a0, size: 0.06, drift: [-0.8, 0.05, 0.5], speed: 9, bob: 1.5, additive: false, opacity: 0.6 }],
    doorGlow: 0xffa83c,
  },

  // ------------------------------------------------------------------ 3
  moonlit: {
    id: 'moonlit',
    surface: 'grass',
    windLevel: 0.5,
    wind: { angle: 1.1, strength: 0.65 },
    fog: { color: 0x1c2c58, near: 28, far: 150 },
    sky: {
      zenith: 0x050818,
      horizon: 0x1c2c58,
      sunDir: moonDir,
      sunColor: 0xcfdcff,
      cloudLight: 0x4d62a0,
      cloudDark: 0x0f1630,
      cover: 0.4,
      sunSize: 0.9975,
      sunGlow: 0.8,
      stars: 1.1,
    },
    light: { sunDir: moonDir, sunColor: 0xa8bcff, skyColor: 0x4a62a8, groundColor: 0x1a2640, sunK: 0.5, ambK: 0.5 },
    height: hills(1.1, { along: 280, across: 150, amp: 20, ridge: 3.5, detail: 0.9 }),
    palette: meadowPalette({
      lo: C(0x2a6860),
      hi: C(0x4b9a8c),
      dry: C(0x6a90a8),
      rock: C(0x5c6478),
      dirt: C(0x3c4a5c),
      dryFrom: 10,
      dryTo: 26,
    }),
    grass: {
      density: 3.4,
      height: [0.5, 0.95],
      width: [0.07, 0.1],
      baseMul: [0.42, 0.55, 0.62],
      tipMul: [1.0, 1.5, 1.7],
      mask: (c) => smoothstep(0.66, 0.76, c.ny) * (1 - smoothstep(0.68, 0.92, c.n3)),
    },
    props: {
      trees: { perChunk: 5, minNy: 0.84, kinds: [['wind', 0.65], ['pine', 0.35]], height: [3.2, 5.8], pineHeight: [5, 8.5], lean: 1.1, trunk: 0.28, bark: 0x3a3a4c, leaves: [0x2f6b72, 0x3a7e86, 0x285b66, 0x468f94] },
      rocks: { perChunk: 8, size: [0.5, 1.7], color: 0x6c7488, cluster: 2 },
      boulders: { perChunk: 0.6, size: [2.4, 4.0], color: 0x5f677c },
      flowers: { perChunk: 110, colors: [0x9ff0ff, 0x7ad0ff, 0xc9b2ff, 0xffffff], minNy: 0.85, glow: true },
    },
    particles: [{ count: 140, box: 55, color: 0xd9ff7a, size: 0.16, drift: [0.3, 0.02, 0.1], speed: 1.2, bob: 2.4, additive: true, opacity: 1 }],
    doorGlow: 0x86a8ff,
  },

  // ------------------------------------------------------------------ 5
  dunes: {
    id: 'dunes',
    surface: 'sand',
    windLevel: 0.7,
    wind: { angle: 0.35, strength: 0.9 },
    fog: { color: 0xf0d9b2, near: 70, far: 230 },
    sky: {
      zenith: 0x5c9fd0,
      horizon: 0xf0d9b2,
      sunDir: duneSun,
      sunColor: 0xfff1d0,
      cloudLight: 0xffffff,
      cloudDark: 0xd8c8b0,
      cover: 0.22,
      sunSize: 0.9993,
    },
    light: { sunDir: duneSun, sunColor: 0xfff0cc, skyColor: 0xc4d8ea, groundColor: 0xc89c68, sunK: 0.8, ambK: 0.58 },
    detail: { grain: 0.1, ripple: 0.065 },
    height: dunes(0.35),
    palette: sandPalette(),
    grass: {
      density: 0.3,
      height: [0.3, 0.65],
      width: [0.05, 0.08],
      baseMul: [0.55, 0.5, 0.32],
      tipMul: [0.95, 1.0, 0.55],
      mask: (c) => smoothstep(0.85, 0.95, c.ny) * smoothstep(0.5, 0.72, c.n3),
    },
    props: {
      rocks: { perChunk: 3, size: [0.6, 2.2], color: 0xb27a52, cluster: 2 },
      boulders: { perChunk: 0.8, size: [3.0, 6.0], color: 0xa5704c },
      cacti: { perChunk: 1.4, minNy: 0.9, color: 0x5f8a4c },
      deadTrees: { perChunk: 0.7, minNy: 0.88, color: 0x6a5240 },
      monoliths: { perChunk: 0.25, height: [6, 12], color: 0xb48a62 },
    },
    particles: [{ count: 420, box: 70, color: 0xf6dcb0, size: 0.05, drift: [1, 0.02, 0.35], speed: 11, bob: 0.4, additive: false, opacity: 0.55 }],
    doorGlow: 0xff7757,
  },
};
