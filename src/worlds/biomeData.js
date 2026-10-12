import { hashFloat, weightedPick } from '../util/rng.js';

// Pure data about each kind of world. `glow`, `horizon` and `zenith` tint the
// doors that lead there, so the colour of a door hints at what is behind it.
export const BIOME_DATA = {
  verdant: {
    id: 'verdant',
    title: 'Windswept Hills',
    tagline: 'verdant downs',
    glow: 0xa6e86a,
    horizon: 0xcfe6ee,
    zenith: 0x3f86d4,
    door: [['wood', 3], ['stone', 1]],
  },
  golden: {
    id: 'golden',
    title: 'Amberwind Moor',
    tagline: 'golden hour',
    glow: 0xffa83c,
    horizon: 0xf7b878,
    zenith: 0x3b3f86,
    door: [['stone', 2], ['wood', 2], ['dark', 1]],
  },
  moonlit: {
    id: 'moonlit',
    title: 'Moonlit Downs',
    tagline: 'night wind',
    glow: 0x86a8ff,
    horizon: 0x27396a,
    zenith: 0x060a1c,
    door: [['dark', 3], ['stone', 2]],
  },
  islands: {
    id: 'islands',
    title: 'Floating Isles',
    tagline: 'above the clouds',
    glow: 0x62e6ff,
    horizon: 0xe3f1ff,
    zenith: 0x3b88e6,
    door: [['stone', 3], ['wood', 2]],
  },
  dunes: {
    id: 'dunes',
    title: 'Dune Sea',
    tagline: 'sand and sun',
    glow: 0xff7757,
    horizon: 0xf3d6a8,
    zenith: 0x6aa2c8,
    door: [['wood', 2], ['dark', 2], ['stone', 1]],
  },
};

export const BIOME_IDS = Object.keys(BIOME_DATA);

/** Pick a destination for a door. Prefers a different world than the current one. */
export function pickDestination(currentId, seed, a, b, c) {
  const entries = BIOME_IDS.map((id) => [id, id === currentId ? 0.45 : 1.6]);
  const biome = weightedPick(entries, hashFloat(seed, a, b, c * 7 + 1));
  const newSeed = Math.floor(hashFloat(seed, a, b, c * 7 + 2) * 0xffffff) + 1;
  return { biome, seed: newSeed };
}

const SYL_A = ['Ael', 'Bri', 'Cor', 'Dun', 'Eld', 'Fen', 'Gal', 'Hol', 'Ith', 'Kel', 'Lor', 'Mir', 'Nor', 'Orm', 'Pel', 'Quil', 'Ros', 'Sel', 'Tar', 'Ul', 'Vel', 'Wyn', 'Yar', 'Zeph'];
const SYL_B = ['a', 'o', 'e', 'i', 'an', 'en', 'or', 'ar', 'ia', 'ou'];
const SYL_C = ['dale', 'mere', 'moor', 'wick', 'fell', 'haven', 'reach', 'wyn', 'thorn', 'vale', 'drift', 'rest'];

/** A pronounceable place name derived from the seed. */
export function placeName(seed) {
  const a = SYL_A[Math.floor(hashFloat(seed, 1) * SYL_A.length)];
  const b = SYL_B[Math.floor(hashFloat(seed, 2) * SYL_B.length)];
  const c = SYL_C[Math.floor(hashFloat(seed, 3) * SYL_C.length)];
  return a + b + c;
}
