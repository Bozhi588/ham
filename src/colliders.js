// Simple 2D (xz) colliders with a vertical extent.
//   circle: { kind: 0, x, z, r, y0, y1, top, enabled }
//   box:    { kind: 1, x, z, hx, hz, c, s, y0, y1, top, enabled }  (c/s = cos/sin of yaw)
// `top: true` means the upper face can be stood on.

export function circle(x, z, r, y0, y1, top = false) {
  return { kind: 0, x, z, r, y0, y1, top, enabled: true };
}

export function orientedBox(x, z, hx, hz, yaw, y0, y1, top = false) {
  return { kind: 1, x, z, hx, hz, c: Math.cos(yaw), s: Math.sin(yaw), y0, y1, top, enabled: true };
}

/** Push the player out of every collider in `list`. */
export function resolveColliders(list, player, stepUp = 0.55) {
  const p = player.feet;
  const r = player.radius;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (!c.enabled) continue;
    if (p.y + player.height <= c.y0) continue;
    // standing on / stepping onto the top of a walkable collider: no push
    if (c.top ? p.y + stepUp >= c.y1 : p.y >= c.y1 - 0.01) continue;
    if (c.kind === 0) {
      const dx = p.x - c.x;
      const dz = p.z - c.z;
      const rr = c.r + r;
      const d2 = dx * dx + dz * dz;
      if (d2 < rr * rr) {
        const d = Math.sqrt(d2) || 1e-4;
        const push = rr - d;
        p.x += (dx / d) * push;
        p.z += (dz / d) * push;
        const into = player.vel.x * (dx / d) + player.vel.z * (dz / d);
        if (into < 0) {
          player.vel.x -= (dx / d) * into;
          player.vel.z -= (dz / d) * into;
        }
      }
    } else {
      const dx = p.x - c.x;
      const dz = p.z - c.z;
      const lx = dx * c.c - dz * c.s;
      const lz = dx * c.s + dz * c.c;
      const qx = Math.max(-c.hx, Math.min(c.hx, lx));
      const qz = Math.max(-c.hz, Math.min(c.hz, lz));
      let nx;
      let nz;
      let push;
      if (Math.abs(lx) < c.hx && Math.abs(lz) < c.hz) {
        // centre is inside the box: leave through the nearest face
        const px = c.hx - Math.abs(lx);
        const pz = c.hz - Math.abs(lz);
        if (px < pz) {
          nx = Math.sign(lx) || 1;
          nz = 0;
          push = px + r;
        } else {
          nx = 0;
          nz = Math.sign(lz) || 1;
          push = pz + r;
        }
      } else {
        const ex = lx - qx;
        const ez = lz - qz;
        const d = Math.hypot(ex, ez);
        if (d >= r) continue;
        nx = ex / (d || 1);
        nz = ez / (d || 1);
        push = r - d;
      }
      // local normal -> world: local x -> (c, -s), local z -> (s, c)
      const wx = nx * c.c + nz * c.s;
      const wz = -nx * c.s + nz * c.c;
      p.x += wx * push;
      p.z += wz * push;
      const into = player.vel.x * wx + player.vel.z * wz;
      if (into < 0) {
        player.vel.x -= wx * into;
        player.vel.z -= wz * into;
      }
    }
  }
}

/** Highest walkable collider top at (x,z) that is at or below `yMax`. */
export function topAt(list, x, z, yMax, margin = 0) {
  let best = -Infinity;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (!c.enabled || !c.top || c.y1 > yMax || c.y1 <= best) continue;
    if (c.kind === 0) {
      const dx = x - c.x;
      const dz = z - c.z;
      const rr = c.r + margin;
      if (dx * dx + dz * dz < rr * rr) best = c.y1;
    } else {
      const dx = x - c.x;
      const dz = z - c.z;
      const lx = dx * c.c - dz * c.s;
      const lz = dx * c.s + dz * c.c;
      if (Math.abs(lx) <= c.hx + margin && Math.abs(lz) <= c.hz + margin) best = c.y1;
    }
  }
  return best;
}
