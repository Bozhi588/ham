import { clamp, lerp, TAU } from '../util/rng.js';

// Procedural scenery. Every function adds low-poly geometry to a MeshBuilder
// and returns the footprint so the caller can register a collider.

/** Multiply a {r,g,b} colour by a random brightness factor. */
export function tint(c, rng, amt = 0.1) {
  const k = 1 + (rng() - 0.5) * 2 * amt;
  return { r: c.r * k, g: c.g * k, b: c.b * k };
}

const pick = (arr, rng) => arr[Math.floor(rng() * arr.length) % arr.length];

/**
 * A gnarled tree bent by the prevailing wind: the trunk leans downwind and the
 * canopy streams out in that direction like a flag.
 * o: { height:[min,max], lean, wind:{x,z}, trunk, bark, leaves:[colors] }
 */
export function windTree(b, rng, x, y, z, o) {
  const H = lerp(o.height[0], o.height[1], rng());
  const lean = H * lerp(0.16, 0.34, rng()) * (o.lean ?? 1);
  const wx = o.wind.x;
  const wz = o.wind.z;
  const px = -wz;
  const pz = wx;
  const wob = (rng() - 0.5) * H * 0.14;
  const N = 5;
  const pts = [];
  const rad = [];
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const bend = t * t * lean;
    const s = Math.sin(t * 3.1) * wob;
    pts.push([x + wx * bend + px * s, y - 0.3 + (H + 0.3) * t, z + wz * bend + pz * s]);
    rad.push((o.trunk ?? 0.3) * (1 - t * 0.74));
  }
  const sw = (yy) => Math.pow(clamp((yy - y) / H, 0, 1.4), 1.5) * 0.45;
  b.tube(pts, rad, 6, o.bark, { swayFn: sw, seed: Math.floor(rng() * 1e6) });
  const top = pts[N - 1];
  const blobs = 4 + Math.floor(rng() * 3);
  for (let k = 0; k < blobs; k++) {
    const ang = rng() * TAU;
    const rr = rng() * H * 0.26;
    const down = rng() * H * 0.22;
    const cx = top[0] + wx * down + Math.cos(ang) * rr;
    const cy = top[1] + (rng() - 0.35) * H * 0.14;
    const cz = top[2] + wz * down + Math.sin(ang) * rr;
    const size = H * (0.2 + rng() * 0.13);
    b.blob(cx, cy, cz, size * 1.2, size * 0.7, size * 1.2, tint(pick(o.leaves, rng), rng, 0.08), {
      detail: 1,
      jitter: 0.22,
      seed: Math.floor(rng() * 1e6),
      swayFn: (yy) => sw(yy) * 1.7 + 0.2,
    });
    if (k < 2) {
      const mid = pts[2];
      b.tube([mid, [cx, cy - size * 0.2, cz]], [rad[2] * 0.5, rad[3] * 0.4], 4, o.bark, { capTop: false, swayFn: sw });
    }
  }
  return { radius: (o.trunk ?? 0.3) * 1.1, height: H };
}

/** Tiered conifer with a slight lean. o: { height, wind, bark, leaves, lean } */
export function pineTree(b, rng, x, y, z, o) {
  const H = lerp(o.height[0], o.height[1], rng());
  const tiers = 5 + Math.floor(rng() * 2);
  const lean = H * 0.05 * (o.lean ?? 1);
  const wx = o.wind.x;
  const wz = o.wind.z;
  const sw = (yy) => Math.pow(clamp((yy - y) / H, 0, 1.3), 1.6) * 0.3;
  b.tube(
    [
      [x, y - 0.3, z],
      [x + wx * lean * 0.5, y + H * 0.55, z + wz * lean * 0.5],
    ],
    [0.2, 0.09],
    5,
    o.bark,
    { swayFn: sw, capTop: false },
  );
  for (let i = 0; i < tiers; i++) {
    const t = i / tiers;
    const yy = y + H * (0.14 + 0.78 * t);
    const r = (1 - t * 0.85) * H * 0.26 + 0.3;
    const h = H * 0.3;
    const off = lean * t * t;
    const c = tint(pick(o.leaves, rng), rng, 0.06);
    b.tube(
      [
        [x + wx * off, yy, z + wz * off],
        [x + wx * (off + lean * 0.04), yy + h, z + wz * (off + lean * 0.04)],
      ],
      [r, 0.03],
      7,
      c,
      { capBottom: true, capTop: false, swayFn: sw, seed: Math.floor(rng() * 1e5), twist: 0.3 },
    );
  }
  return { radius: 0.3, height: H };
}

/** A lumpy boulder, optionally with smaller companions. Returns the main footprint. */
export function rock(b, rng, x, y, z, r, color, o = {}) {
  const sink = o.sink ?? 0.3;
  const ry = r * lerp(0.55, 0.85, rng());
  b.blob(x, y + ry * (1 - sink * 1.2), z, r * lerp(0.9, 1.2, rng()), ry, r * lerp(0.9, 1.2, rng()), tint(color, rng, 0.06), {
    detail: o.detail ?? 1,
    jitter: o.jitter ?? 0.26,
    seed: Math.floor(rng() * 1e6),
    colorVar: 0.14,
    underDark: 0.55,
  });
  const extra = o.cluster ?? 0;
  for (let i = 0; i < extra; i++) {
    const a = rng() * TAU;
    const d = r * lerp(0.8, 1.4, rng());
    const rr = r * lerp(0.25, 0.55, rng());
    b.blob(x + Math.cos(a) * d, y + rr * 0.3, z + Math.sin(a) * d, rr * 1.1, rr * 0.7, rr, tint(color, rng, 0.08), {
      detail: 1,
      jitter: 0.25,
      seed: Math.floor(rng() * 1e6),
      underDark: 0.55,
    });
  }
  return { radius: r * 0.78, height: ry * 1.55 * (1 - sink * 0.5) };
}

/** Tall leaning standing stone, optionally with a glowing band. */
export function monolith(b, rng, x, y, z, o) {
  const H = lerp(o.height[0], o.height[1], rng());
  const w = lerp(0.7, 1.3, rng());
  const tx = (rng() - 0.5) * 0.18 * H;
  const tz = (rng() - 0.5) * 0.18 * H;
  const c = tint(o.color, rng, 0.05);
  b.tube(
    [
      [x, y - 0.8, z],
      [x + tx * 0.5, y + H * 0.5, z + tz * 0.5],
      [x + tx, y + H, z + tz],
    ],
    [w, w * 0.85, w * 0.6],
    4,
    c,
    { capTop: true, twist: rng() * 0.2, seed: Math.floor(rng() * 1e5) },
  );
  if (o.glow) {
    b.unlit = true;
    const gy = y + H * 0.62;
    b.tube(
      [
        [x + tx * 0.62 - 0.0, gy, z + tz * 0.62],
        [x + tx * 0.66, gy + 0.18, z + tz * 0.66],
      ],
      [w * 0.74, w * 0.74],
      4,
      o.glow,
      { capTop: false, capBottom: false },
    );
    b.unlit = false;
  }
  return { radius: w * 0.95, height: H };
}

export function cactus(b, rng, x, y, z, o) {
  const H = lerp(1.8, 4.2, rng());
  const r = lerp(0.2, 0.3, rng());
  const col = tint(o.color, rng, 0.08);
  const lean = (rng() - 0.5) * 0.3;
  b.tube(
    [
      [x, y - 0.2, z],
      [x + lean * 0.3, y + H * 0.5, z],
      [x + lean, y + H, z],
    ],
    [r, r * 0.95, r * 0.75],
    7,
    col,
    { capTop: true },
  );
  const arms = Math.floor(rng() * 3);
  for (let i = 0; i < arms; i++) {
    const side = rng() < 0.5 ? -1 : 1;
    const ay = y + H * lerp(0.35, 0.65, rng());
    const out = lerp(0.6, 1.0, rng());
    const rise = lerp(0.6, 1.3, rng());
    b.tube(
      [
        [x + lean * 0.5, ay, z],
        [x + lean * 0.5 + side * out * 0.7, ay + 0.08, z],
        [x + lean * 0.5 + side * out, ay + 0.35, z],
        [x + lean * 0.5 + side * out, ay + rise, z],
      ],
      [r * 0.6, r * 0.55, r * 0.5, r * 0.4],
      6,
      col,
      { capTop: true },
    );
  }
  return { radius: r * 1.3, height: H };
}

export function deadTree(b, rng, x, y, z, o) {
  const H = lerp(2.5, 4.5, rng());
  const wx = o.wind.x;
  const wz = o.wind.z;
  const lean = H * 0.25;
  const pts = [];
  const rad = [];
  for (let i = 0; i < 5; i++) {
    const t = i / 4;
    pts.push([x + wx * lean * t * t + Math.sin(t * 5 + x) * 0.15, y - 0.2 + H * t, z + wz * lean * t * t + Math.cos(t * 4 + z) * 0.15]);
    rad.push(0.22 * (1 - t * 0.85) + 0.02);
  }
  b.tube(pts, rad, 5, o.color, { capTop: true });
  const br = 3 + Math.floor(rng() * 3);
  for (let i = 0; i < br; i++) {
    const t = 0.35 + rng() * 0.55;
    const base = pts[Math.min(4, Math.floor(t * 4))];
    const a = rng() * TAU;
    const L = lerp(0.7, 1.7, rng());
    b.tube(
      [
        base,
        [base[0] + Math.cos(a) * L * 0.6 + wx * 0.2, base[1] + L * 0.5, base[2] + Math.sin(a) * L * 0.6 + wz * 0.2],
        [base[0] + Math.cos(a) * L + wx * 0.5, base[1] + L * 0.85, base[2] + Math.sin(a) * L + wz * 0.5],
      ],
      [0.08, 0.05, 0.015],
      4,
      o.color,
      { capTop: true },
    );
  }
  return { radius: 0.3, height: H };
}

export function flowerHead(b, x, y, z, color, size = 0.075) {
  b.blob(x, y, z, size, size * 0.8, size, color, { detail: 0, jitter: 0.15, seed: Math.floor(x * 31 + z * 17), swayFn: () => 0.55, underDark: 0.8 });
}

/** Round, puffy tree for the sky islands. */
export function puffTree(b, rng, x, y, z, o) {
  const H = lerp(o.height[0], o.height[1], rng());
  const sw = (yy) => Math.pow(clamp((yy - y) / H, 0, 1.4), 1.4) * 0.25;
  b.tube(
    [
      [x, y - 0.25, z],
      [x + (rng() - 0.5) * 0.3, y + H * 0.55, z + (rng() - 0.5) * 0.3],
      [x + (rng() - 0.5) * 0.4, y + H * 0.85, z + (rng() - 0.5) * 0.4],
    ],
    [0.22, 0.15, 0.08],
    5,
    o.bark,
    { swayFn: sw, capTop: false },
  );
  const n = 3 + Math.floor(rng() * 3);
  const base = pick(o.leaves, rng);
  for (let k = 0; k < n; k++) {
    const a = rng() * TAU;
    const rr = k === 0 ? 0 : H * lerp(0.15, 0.3, rng());
    const size = H * lerp(0.22, 0.34, rng());
    b.blob(x + Math.cos(a) * rr, y + H * (0.8 + rng() * 0.2), z + Math.sin(a) * rr, size, size * 0.85, size, tint(base, rng, 0.07), {
      detail: 1,
      jitter: 0.16,
      seed: Math.floor(rng() * 1e6),
      swayFn: (yy) => sw(yy) * 1.6 + 0.1,
    });
  }
  return { radius: 0.3, height: H };
}

/** Glowing crystals (rendered unlit so they look emissive). */
export function crystalCluster(b, rng, x, y, z, o) {
  b.unlit = true;
  const n = 2 + Math.floor(rng() * 3);
  for (let i = 0; i < n; i++) {
    const a = rng() * TAU;
    const d = i === 0 ? 0 : lerp(0.2, 0.6, rng()) * (o.scale ?? 1);
    const h = lerp(0.6, 1.8, rng()) * (o.scale ?? 1) * (i === 0 ? 1.3 : 1);
    const r = lerp(0.1, 0.22, rng()) * (o.scale ?? 1);
    b.crystal(x + Math.cos(a) * d, y, z + Math.sin(a) * d, r, h * (o.dir ?? 1), tint(pick(o.colors, rng), rng, 0.15), [(rng() - 0.5) * 0.5, (rng() - 0.5) * 0.5]);
  }
  b.unlit = false;
}

/** A fluffy bank of overlapping smooth puffs. size ~ overall radius in metres. */
export function cloudBank(b, rng, x, y, z, size, color, detail = 2) {
  const n = 4 + Math.floor(rng() * 4);
  const ang = rng() * TAU;
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * 2 - 1;
    const s = size * lerp(0.45, 1, 1 - Math.abs(t) * 0.7) * lerp(0.8, 1.15, rng());
    const px = x + Math.cos(ang) * t * size * 1.1 + (rng() - 0.5) * size * 0.4;
    const pz = z + Math.sin(ang) * t * size * 1.1 + (rng() - 0.5) * size * 0.4;
    const py = y + (rng() - 0.3) * size * 0.25;
    b.blobSmooth(px, py, pz, s * 1.15, s * 0.55, s * 1.05, color, { detail, jitter: 0.12, seed: Math.floor(rng() * 1e6), underDark: 0.7 });
  }
}
