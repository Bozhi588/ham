// Small deterministic random helpers. Everything in the game is derived from
// integer seeds so a world can be rebuilt exactly (that is how the "back"
// doors and the R key work without storing any geometry).

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mix(h) {
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Hash up to four integers into an unsigned 32-bit integer. */
export function hashInts(a, b = 0, c = 0, d = 0) {
  let h = 0x9e3779b9;
  h = mix(h ^ (a | 0));
  h = mix(h ^ (b | 0));
  h = mix(h ^ (c | 0));
  h = mix(h ^ (d | 0));
  return h;
}

/** Hash integers into a float in [0, 1). */
export function hashFloat(a, b = 0, c = 0, d = 0) {
  return hashInts(a, b, c, d) / 4294967296;
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
export const TAU = Math.PI * 2;

/** Pick from [[item, weight], ...] with a [0,1) random number. */
export function weightedPick(entries, r) {
  let total = 0;
  for (const e of entries) total += e[1];
  let acc = r * total;
  for (const e of entries) {
    acc -= e[1];
    if (acc <= 0) return e[0];
  }
  return entries[entries.length - 1][0];
}
