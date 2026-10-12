import * as THREE from 'three';
import { World } from './world.js';
import { Door, DOOR_H, DOOR_W } from '../door.js';
import { MeshBuilder } from '../gfx/builder.js';
import { makeParticles } from '../gfx/materials.js';
import { orientedBox, resolveColliders } from '../colliders.js';
import { mulberry32 } from '../util/rng.js';

const HALF = 5; // interior is 10 x 10 m
const HEIGHT = 3.5;
const WALL_T = 0.6;

// ---------------------------------------------------------------------------
// Procedural textures so the room needs no image assets.
// ---------------------------------------------------------------------------
function canvasTexture(size, draw, repeatX = 1, repeatY = 1) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeatX, repeatY);
  t.anisotropy = 4;
  return t;
}

function floorTexture() {
  const rnd = mulberry32(11);
  return canvasTexture(512, (g, S) => {
    g.fillStyle = '#2c1d14';
    g.fillRect(0, 0, S, S);
    const planks = 8;
    const pw = S / planks;
    for (let i = 0; i < planks; i++) {
      let y = -rnd() * 200;
      while (y < S) {
        const len = 160 + rnd() * 240;
        const shade = 0.75 + rnd() * 0.5;
        g.fillStyle = `rgb(${Math.round(58 * shade)},${Math.round(38 * shade)},${Math.round(25 * shade)})`;
        g.fillRect(i * pw + 1, y + 1, pw - 2, len - 2);
        for (let k = 0; k < 26; k++) {
          g.strokeStyle = `rgba(20,10,5,${0.05 + rnd() * 0.12})`;
          g.lineWidth = 1;
          const gx = i * pw + 3 + rnd() * (pw - 6);
          g.beginPath();
          g.moveTo(gx, y + 2);
          g.bezierCurveTo(gx + rnd() * 6 - 3, y + len * 0.3, gx + rnd() * 6 - 3, y + len * 0.7, gx + rnd() * 4 - 2, y + len - 2);
          g.stroke();
        }
        y += len;
      }
    }
    g.fillStyle = 'rgba(0,0,0,0.5)';
    for (let i = 0; i <= planks; i++) g.fillRect(i * pw - 1, 0, 2, S);
  }, 5, 5);
}

function wallTexture() {
  const rnd = mulberry32(5);
  return canvasTexture(512, (g, S) => {
    g.fillStyle = '#2d2c35';
    g.fillRect(0, 0, S, S);
    for (let x = 0; x < S; x += 64) {
      g.fillStyle = 'rgba(255,255,255,0.025)';
      g.fillRect(x, 0, 32, S);
      g.fillStyle = 'rgba(0,0,0,0.06)';
      g.fillRect(x + 32, 0, 3, S);
    }
    // damask-ish diamonds
    g.strokeStyle = 'rgba(255,255,255,0.035)';
    g.lineWidth = 2;
    for (let y = 0; y < S; y += 64) {
      for (let x = 16; x < S; x += 64) {
        g.beginPath();
        g.moveTo(x, y + 10);
        g.lineTo(x + 12, y + 32);
        g.lineTo(x, y + 54);
        g.lineTo(x - 12, y + 32);
        g.closePath();
        g.stroke();
      }
    }
    for (let i = 0; i < 2500; i++) {
      g.fillStyle = `rgba(${rnd() < 0.5 ? 0 : 255},${rnd() < 0.5 ? 0 : 255},255,${rnd() * 0.04})`;
      g.fillRect(rnd() * S, rnd() * S, 1 + rnd() * 2, 1 + rnd() * 2);
    }
    const grad = g.createLinearGradient(0, 0, 0, S);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(10,6,0,0.35)');
    g.fillStyle = grad;
    g.fillRect(0, 0, S, S);
  }, 4, 2);
}

function ceilingTexture() {
  const rnd = mulberry32(9);
  return canvasTexture(256, (g, S) => {
    g.fillStyle = '#1a1a1f';
    g.fillRect(0, 0, S, S);
    for (let i = 0; i < 1500; i++) {
      g.fillStyle = `rgba(255,255,255,${rnd() * 0.03})`;
      g.fillRect(rnd() * S, rnd() * S, 2, 2);
    }
  }, 3, 3);
}

function plane(w, h, uRep, vRep) {
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * uRep, uv.getY(i) * vRep);
  return g;
}

/**
 * The dark room you start in (and return to with R). It has exactly one door,
 * whose light is the main thing you can see.
 */
export class BaseRoom extends World {
  constructor(game, look) {
    super(game);
    this.ambience = 'room';
    this.surfaceType = 'wood';
    this.windLevel = 0;
    this.fog = { color: 0x020204, near: 6, far: 24 };
    this.exposure = 1.15;
    this.colliders = [];

    const wallMat = new THREE.MeshStandardMaterial({ map: wallTexture(), roughness: 0.95, metalness: 0 });
    const floorMat = new THREE.MeshStandardMaterial({ map: floorTexture(), roughness: 0.75, metalness: 0.02 });
    const ceilMat = new THREE.MeshStandardMaterial({ map: ceilingTexture(), roughness: 1 });
    const propMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.05 });
    this.propMat = propMat;

    // floor + ceiling
    const floor = new THREE.Mesh(plane(HALF * 2, HALF * 2, 1, 1), floorMat);
    floor.rotation.x = -Math.PI / 2;
    this.group.add(floor);
    const ceil = new THREE.Mesh(plane(HALF * 2, HALF * 2, 1, 1), ceilMat);
    ceil.rotation.x = Math.PI / 2;
    ceil.position.y = HEIGHT;
    this.group.add(ceil);

    // walls (inward facing). The north wall has a doorway cut into it.
    const addWall = (w, h, x, y, z, ry) => {
      const m = new THREE.Mesh(plane(w, h, w / 2.5, h / 2.5), wallMat);
      m.position.set(x, y, z);
      m.rotation.y = ry;
      this.group.add(m);
    };
    addWall(HALF * 2, HEIGHT, 0, HEIGHT / 2, HALF, Math.PI); // south
    addWall(HALF * 2, HEIGHT, -HALF, HEIGHT / 2, 0, Math.PI / 2); // west
    addWall(HALF * 2, HEIGHT, HALF, HEIGHT / 2, 0, -Math.PI / 2); // east
    const frameW = DOOR_W + 0.4;
    const sideW = (HALF * 2 - frameW) / 2;
    addWall(sideW, HEIGHT, -(frameW / 2 + sideW / 2), HEIGHT / 2, -HALF, 0);
    addWall(sideW, HEIGHT, frameW / 2 + sideW / 2, HEIGHT / 2, -HALF, 0);
    const topH = HEIGHT - (DOOR_H + 0.22);
    addWall(frameW, topH, 0, HEIGHT - topH / 2, -HALF, 0);

    // collision walls
    const wall = (x, z, hx, hz) => this.colliders.push(orientedBox(x, z, hx, hz, 0, -1, HEIGHT + 1));
    wall(0, HALF + WALL_T / 2, HALF + WALL_T, WALL_T / 2);
    wall(-HALF - WALL_T / 2, 0, WALL_T / 2, HALF + WALL_T);
    wall(HALF + WALL_T / 2, 0, WALL_T / 2, HALF + WALL_T);
    wall(-(frameW / 2 + sideW / 2), -HALF - WALL_T / 2, sideW / 2, WALL_T / 2);
    wall(frameW / 2 + sideW / 2, -HALF - WALL_T / 2, sideW / 2, WALL_T / 2);

    this._buildProps(propMat);

    // door sitting in the north wall
    this.door = new Door({
      id: 'room-door',
      x: 0,
      y: 0,
      z: -HALF - WALL_T / 2,
      yaw: 0,
      dest: null,
      glow: look.glow,
      horizon: look.horizon,
      zenith: look.zenith,
      style: 'dark',
      lighting: null,
      material: propMat,
      depth: WALL_T,
      plinth: false,
      beam: false,
    });
    this.group.add(this.door.group);
    this.colliders.push(...this.door.colliders);

    // --- lights ----------------------------------------------------------------
    this.group.add(new THREE.HemisphereLight(0x2a3350, 0x0c0a08, 0.55));
    this.doorLight = new THREE.PointLight(look.glow, 18, 16, 1.6);
    this.doorLight.position.set(0, 1.5, -HALF + 0.6);
    this.group.add(this.doorLight);
    this.lantern = new THREE.PointLight(0xffc27a, 5.5, 10, 1.7);
    this.group.add(this.lantern);

    // dust motes drifting in the dark
    this.dust = makeParticles({ count: 260, box: 12, color: 0xfff0d0, size: 0.045, drift: [0.02, 0.012, 0.01], speed: 1, bob: 0.4, opacity: 0.5 });
    this.group.add(this.dust);
  }

  /** Re-tint the door and its light for the next world behind it. */
  setDestination(dest, look) {
    this.door.dest = dest;
    const u = this.door.portalMat.uniforms;
    u.uHorizon.value.set(look.horizon);
    u.uZenith.value.set(look.zenith);
    u.uGlow.value.set(look.glow);
    this.doorLight.color.set(look.glow);
    this.door.reset();
  }

  _buildProps(material) {
    const b = new MeshBuilder(null);
    const c = (hex) => new THREE.Color(hex);
    const wood = c(0x3b2a1e);
    const darkWood = c(0x2a1d15);
    const fabric = c(0x40272c);
    const metal = c(0x6b6252);

    // baseboards + crown moulding
    const trim = c(0x1d1814);
    b.box(0, 0.09, HALF - 0.04, HALF * 2, 0.18, 0.08, trim);
    b.box(-HALF + 0.04, 0.09, 0, 0.08, 0.18, HALF * 2, trim);
    b.box(HALF - 0.04, 0.09, 0, 0.08, 0.18, HALF * 2, trim);
    b.box(-(DOOR_W / 2 + 0.2 + 1.9), 0.09, -HALF + 0.04, 3.8, 0.18, 0.08, trim);
    b.box(DOOR_W / 2 + 0.2 + 1.9, 0.09, -HALF + 0.04, 3.8, 0.18, 0.08, trim);
    b.box(0, HEIGHT - 0.06, HALF - 0.05, HALF * 2, 0.12, 0.1, trim);
    b.box(-HALF + 0.05, HEIGHT - 0.06, 0, 0.1, 0.12, HALF * 2, trim);
    b.box(HALF - 0.05, HEIGHT - 0.06, 0, 0.1, 0.12, HALF * 2, trim);
    b.box(0, HEIGHT - 0.06, -HALF + 0.05, HALF * 2, 0.12, 0.1, trim);
    // ceiling beams
    for (const x of [-3.3, 0, 3.3]) b.box(x, HEIGHT - 0.14, 0, 0.28, 0.28, HALF * 2, darkWood);

    // rug under the middle of the room
    b.box(0.2, 0.012, 0.8, 4.2, 0.024, 3.0, fabric);
    b.box(0.2, 0.026, 0.8, 3.7, 0.01, 2.5, c(0x5a3a30));
    b.box(0.2, 0.034, 0.8, 3.1, 0.01, 1.9, c(0x40272c));

    const add = (x, z, hx, hz, h) => this.colliders.push(orientedBox(x, z, hx, hz, 0, 0, h));

    // a table with a dead candle
    b.box(2.9, 0.74, 1.6, 1.3, 0.07, 0.8, wood);
    for (const [dx, dz] of [[-0.58, -0.33], [0.58, -0.33], [-0.58, 0.33], [0.58, 0.33]]) b.box(2.9 + dx, 0.36, 1.6 + dz, 0.07, 0.72, 0.07, wood);
    b.cylinder(2.7, 0.775, 1.55, 0.035, 0.18, 8, c(0xd9cdb0));
    b.cylinder(2.7, 0.775, 1.55, 0.07, 0.015, 10, metal);
    add(2.9, 1.6, 0.65, 0.4, 0.8);

    // chair
    b.box(1.8, 0.45, 2.2, 0.48, 0.05, 0.48, wood);
    for (const [dx, dz] of [[-0.21, -0.21], [0.21, -0.21], [-0.21, 0.21], [0.21, 0.21]]) b.box(1.8 + dx, 0.22, 2.2 + dz, 0.05, 0.44, 0.05, wood);
    b.box(1.8, 0.82, 2.43, 0.48, 0.7, 0.05, wood);
    add(1.8, 2.2, 0.26, 0.26, 0.5);

    // tall bookshelf on the west wall
    b.box(-HALF + 0.28, 1.1, 0.4, 0.5, 2.2, 3.0, darkWood);
    const rnd = mulberry32(21);
    for (let shelf = 0; shelf < 5; shelf++) {
      const y = 0.25 + shelf * 0.42;
      b.box(-HALF + 0.3, y, 0.4, 0.46, 0.04, 2.9, wood);
      let z = -1.0;
      while (z < 1.75) {
        const w = 0.05 + rnd() * 0.07;
        const h = 0.22 + rnd() * 0.14;
        const hue = new THREE.Color().setHSL(rnd(), 0.25, 0.14 + rnd() * 0.08);
        b.box(-HALF + 0.32, y + 0.02 + h / 2, 0.4 + z, 0.28, h, w, hue);
        z += w + 0.004;
      }
    }
    add(-HALF + 0.28, 0.4, 0.26, 1.5, 2.2);

    // crates stacked in the south-east corner
    b.box(4.0, 0.3, 4.0, 0.9, 0.6, 0.9, wood);
    b.box(4.1, 0.9, 4.1, 0.7, 0.6, 0.7, darkWood);
    b.box(3.0, 0.25, 4.3, 0.6, 0.5, 0.6, wood);
    add(4.0, 4.0, 0.46, 0.46, 1.2);
    add(3.0, 4.3, 0.31, 0.31, 0.5);

    // picture frames on the walls
    const frame = c(0x2a2118);
    const canvas = c(0x1b2428);
    for (const [x, y] of [[-3.0, 1.8], [2.6, 1.9], [4.0, 1.6]]) {
      b.box(x, y, HALF - 0.07, 0.8, 0.6, 0.05, frame);
      b.box(x, y, HALF - 0.1, 0.68, 0.48, 0.03, canvas);
    }
    b.box(HALF - 0.07, 1.85, -1.8, 0.05, 0.9, 0.7, frame);
    b.box(HALF - 0.1, 1.85, -1.8, 0.03, 0.78, 0.58, canvas);

    // a wall lamp that does not work any more
    b.box(-HALF + 0.12, 2.0, -2.4, 0.18, 0.1, 0.1, metal);
    b.cylinder(-HALF + 0.22, 2.0, -2.4, 0.09, 0.24, 8, c(0x3a352c), { rTop: 0.16 });

    const geo = b.build({ normals: true, sway: false });
    const mesh = new THREE.Mesh(geo, material);
    this.group.add(mesh);
  }

  get doors() {
    return [this.door];
  }

  update(dt, time, player) {
    this.door.update(dt, time, player.feet);
    this.dust.material.uniforms.uTime.value = time;
    this.lantern.position.set(player.feet.x, player.feet.y + 1.9, player.feet.z);
    // very slight flicker so the dark feels alive
    this.lantern.intensity = 5.2 + Math.sin(time * 7.3) * 0.25 + Math.sin(time * 3.1) * 0.35;
  }

  ground(x, z) {
    return Math.abs(x) < HALF + 0.2 && Math.abs(z) < HALF + 0.2 ? 0 : -Infinity;
  }

  collide(player) {
    resolveColliders(this.colliders, player);
  }

  ceiling() {
    return HEIGHT - 0.02;
  }

  isSafe() {
    return true;
  }

  /** Where the player stands when entering the room. */
  spawn() {
    return { x: 0, y: 0, z: 3, yaw: 0 };
  }
}
