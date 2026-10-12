import * as THREE from 'three';
import { Input } from './input.js';
import { Player } from './player.js';
import { Hud } from './hud.js';
import { AudioEngine } from './audio.js';
import { BaseRoom } from './worlds/baseRoom.js';
import { TerrainWorld } from './worlds/terrainWorld.js';
import { IslandWorld } from './worlds/islandWorld.js';
import { TERRAIN_CONFIGS } from './worlds/terrainConfigs.js';
import { BIOME_DATA, BIOME_IDS, placeName } from './worlds/biomeData.js';
import { QUALITY } from './quality.js';

const BASE_FOV = 72;
const ROOM_LOOK = { glow: 0xffc27a, horizon: 0x3a2c20, zenith: 0x0c0907 };
const params = new URLSearchParams(location.search);
const DEBUG = params.has('debug');

const lookOf = (entry) => (!entry || entry.type === 'room' ? ROOM_LOOK : BIOME_DATA[entry.biome]);
const css = (hex, lift = 0) => '#' + new THREE.Color(hex).lerp(new THREE.Color(0xffffff), lift).getHexString();
const randomSeed = () => Math.floor(Math.random() * 0xfffffe) + 1;

function loadQuality() {
  const q = params.get('quality');
  const byName = QUALITY.findIndex((x) => x.name === q);
  if (byName >= 0) return byName;
  try {
    const saved = Number(localStorage.getItem('thresholds.quality'));
    if (Number.isInteger(saved) && saved >= 0 && saved < QUALITY.length) return saved;
  } catch {
    /* storage can be unavailable (private mode); ignore */
  }
  return QUALITY.length - 1;
}

class Game {
  constructor() {
    this.canvas = document.getElementById('view');
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.maxRatio = Math.min(window.devicePixelRatio || 1, 2);
    this.ratio = this.maxRatio;
    this.renderer.setPixelRatio(this.ratio);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.08, 2200);
    this.scene.add(this.camera);

    this.input = new Input(this.canvas);
    this.player = new Player();
    this.hud = new Hud();
    this.audio = new AudioEngine();
    this.clock = new THREE.Clock();

    this.time = 0;
    this.world = null;
    this.room = null;
    this.history = [];
    this.busy = true;
    this.started = false;
    this.lastBiome = null;
    this.pointScale = 600;
    this.qualityIndex = loadQuality();
    this.perf = { ema: 1 / 60, slow: 0, fast: 0, cooldown: 0, settle: 0 };
    this._v = new THREE.Vector3();

    window.addEventListener('resize', () => this.resize());
    this.resize();

    this.input.onLockChange = (active) => {
      if (!this.started) return;
      this.hud.showPause(!active && !this.busy);
    };
    document.getElementById('pause').addEventListener('click', () => this.input.capture());
    this.canvas.addEventListener('click', () => {
      if (this.started && !this.input.active) this.input.capture();
    });
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setPixelRatio(this.ratio);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.pointScale = this.renderer.domElement.height / (2 * Math.tan(THREE.MathUtils.degToRad(BASE_FOV / 2)));
  }

  // ---------------------------------------------------------------- worlds
  get quality() {
    return QUALITY[this.qualityIndex];
  }

  createWorld(spec) {
    const opts = { spawn: spec.spawn, backLook: spec.backLook, quality: this.quality };
    if (spec.biome === 'islands') return new IslandWorld(this, spec.seed, opts);
    return new TerrainWorld(this, TERRAIN_CONFIGS[spec.biome], spec.seed, opts);
  }

  setWorld(world) {
    if (this.world) {
      this.scene.remove(this.world.group);
      if (this.world !== this.room) this.world.dispose();
    }
    this.world = world;
    this.scene.add(world.group);
    const f = world.fog;
    this.scene.fog = new THREE.Fog(f.color, f.near, f.far);
    this.scene.background = new THREE.Color(f.color);
    this.renderer.toneMappingExposure = world.exposure;
    this.audio.setMode(world.ambience, world.windLevel);
  }

  rollNext() {
    const options = BIOME_IDS.filter((id) => id !== this.lastBiome);
    const biome = options[Math.floor(Math.random() * options.length)];
    this.lastBiome = biome;
    return { kind: 'world', biome, seed: randomSeed() };
  }

  async enterRoom({ firstTime = false } = {}) {
    this.history = [];
    if (!this.room) {
      this.room = new BaseRoom(this, ROOM_LOOK);
    }
    const dest = this.rollNext();
    this.room.setDestination(dest, BIOME_DATA[dest.biome]);
    this.setWorld(this.room);
    const sp = this.room.spawn();
    this.player.teleport(sp.x, sp.y, sp.z, sp.yaw);
    this.hud.setWhere('the room');
    if (firstTime) this.hud.showTitle('The Room', 'there is a door', 5200);
    else this.hud.showTitle('The Room', 'where every road begins', 3600);
  }

  /** Build and enter a world described by { biome, seed, spawn?, backLook? }. */
  async enterWorld(spec, { quiet = false } = {}) {
    this.hud.setLoading('shaping the wind');
    const world = this.createWorld(spec);
    world.spec = spec;
    await world.preload();
    this.setWorld(world);
    const sp = world.spawn();
    this.player.teleport(sp.x, sp.y, sp.z, sp.yaw);
    this.player.applyCamera(this.camera, this.time, BASE_FOV);
    // compile shaders while the screen is still covered, so arriving never hitches
    this.renderer.compile(this.scene, this.camera);
    const data = BIOME_DATA[spec.biome];
    const name = placeName(spec.seed);
    this.hud.setWhere(`${data.title} · ${name}`);
    if (!quiet) this.hud.showTitle(data.title, `${name} — ${data.tagline}`);
    this.hud.setLoading('');
  }

  // ---------------------------------------------------------------- travel
  async travel(door) {
    if (this.busy) return;
    this.busy = true;
    this.audio.portal();
    const w = this.world;
    const dest = door.dest;
    const tint = css(door.glow, 0.5);
    this.hud.hideTitle();
    await this.hud.fadeTo(1, 700, tint);

    if (dest.kind === 'back') {
      const entry = this.history.pop() ?? { type: 'room' };
      if (entry.type === 'room') {
        await this.enterRoom();
      } else {
        await this.enterWorld({ ...entry, backLook: lookOf(this.history[this.history.length - 1]) });
      }
    } else {
      if (w === this.room) {
        this.history = [{ type: 'room' }];
      } else {
        this.history.push({
          type: 'world',
          biome: w.spec.biome,
          seed: w.spec.seed,
          spawn: {
            x: door.x + door.normal.x * 3,
            y: door.y,
            z: door.z + door.normal.z * 3,
            yaw: door.yaw + Math.PI,
          },
        });
      }
      await this.enterWorld({ biome: dest.biome, seed: dest.seed, backLook: lookOf(this.history[this.history.length - 1]) });
    }

    this.audio.arrive();
    await this.hud.fadeTo(0, 1000);
    this.busy = false;
  }

  async returnToRoom() {
    if (this.busy || this.world === this.room) return;
    this.busy = true;
    this.audio.portal();
    this.hud.hideTitle();
    await this.hud.fadeTo(1, 500, '#05060a');
    await this.enterRoom();
    this.audio.arrive();
    await this.hud.fadeTo(0, 900);
    this.busy = false;
  }

  /** Change graphics quality; outdoor worlds are rebuilt in place around the player. */
  async setQuality(index, { auto = false } = {}) {
    if (this.busy || index === this.qualityIndex) return;
    this.qualityIndex = index;
    try {
      localStorage.setItem('thresholds.quality', String(index));
    } catch {
      /* ignore */
    }
    this.hud.toast(`graphics: ${this.quality.name}${auto ? ' (adjusted for speed)' : ''}`);
    const w = this.world;
    if (w === this.room || !w.spec) return;
    this.busy = true;
    const p = this.player;
    await this.hud.fadeTo(1, 350, '#000');
    await this.enterWorld({ ...w.spec, spawn: { x: p.feet.x, y: p.feet.y, z: p.feet.z, yaw: p.yaw } }, { quiet: true });
    await this.hud.fadeTo(0, 600);
    this.busy = false;
  }

  async respawn() {
    if (this.busy) return;
    this.busy = true;
    await this.hud.fadeTo(1, 450, '#e6f2ff');
    const p = this.player;
    const s = p.lastSafe;
    p.teleport(s.x, s.y + 0.1, s.z, p.yaw);
    await this.hud.fadeTo(0, 700);
    this.busy = false;
  }

  // ---------------------------------------------------------------- loop
  async boot() {
    await this.enterRoom({ firstTime: true });
    this.hud.setFadeInstant(1, '#000');
    const begin = document.getElementById('begin');
    begin.disabled = false;
    begin.textContent = 'Begin';
    this.hud.setLoading('');

    const start = async () => {
      if (this.started) return;
      this.started = true;
      this.audio.init();
      this.audio.setMode(this.world.ambience, this.world.windLevel);
      this.hud.showStart(false);
      this.input.capture();
      await this.hud.fadeTo(0, 1600);
      this.busy = false;
      setTimeout(() => document.getElementById('hint').classList.add('dim'), 20000);
    };
    document.getElementById('start').addEventListener('click', start);

    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyM') this.hud.toast(this.audio.toggleMute() ? 'sound off' : 'sound on');
      if (e.code === 'KeyG' && this.started) this.setQuality((this.qualityIndex + 1) % QUALITY.length);
    });

    // deep link: ?world=islands&seed=12  (handy for sharing and for testing)
    if (params.has('world') && BIOME_DATA[params.get('world')]) {
      const seed = Number(params.get('seed')) || randomSeed();
      this.history = [{ type: 'room' }];
      await this.enterWorld({ biome: params.get('world'), seed, backLook: ROOM_LOOK });
      if (params.has('autostart')) {
        this.started = true;
        this.input.dragMode = true;
        this.input.active = true;
        this.hud.showStart(false);
        this.hud.setFadeInstant(0);
        this.busy = false;
      }
    } else if (params.has('autostart')) {
      this.started = true;
      this.input.dragMode = true;
      this.input.active = true;
      this.hud.showStart(false);
      this.hud.setFadeInstant(0);
      this.busy = false;
    }

    this.renderer.setAnimationLoop(() => this.frame());
  }

  frame() {
    const raw = this.clock.getDelta();
    const dt = Math.min(raw, 0.1);
    this.time += dt;
    const { player, input, world, camera } = this;
    const enabled = this.started && !this.busy && input.active;

    // --- physics, in small steps so fast movement never tunnels through thin walls
    const start = this._v.copy(player.feet).clone();
    const steps = Math.max(1, Math.ceil(dt / (1 / 60)));
    const events = [];
    for (let k = 0; k < steps; k++) {
      player.update(dt / steps, input, world, enabled, k === 0);
      if (player.events.length) events.push(...player.events);
    }
    player.prevFeet.copy(start);

    // falling out of the world
    if (player.feet.y < world.killY && !this.busy) this.respawn();

    player.applyCamera(camera, this.time, BASE_FOV);
    world.update(dt, this.time, player, camera);

    // --- audio events
    const surface = world.surface(player.feet.x, player.feet.z);
    for (const ev of events) {
      if (ev === 'step') this.audio.footstep(surface, player.sprinting);
      else if (ev === 'jump') this.audio.jump(false);
      else if (ev === 'double') this.audio.jump(true);
      else if (ev === 'land' && player.landSpeed > 3) this.audio.land(player.landSpeed, surface);
    }
    this.audio.update(dt, {
      speed: Math.hypot(player.vel.x, player.vel.z),
      gliding: player.gliding,
      falling: !player.grounded && player.vel.y < -8,
    });

    // --- doors
    let target = null;
    const eye = player.eye;
    const fwd = player.forward();
    for (const door of world.doors) {
      if (!this.busy && door.canInteract(player.feet, eye, fwd)) target = door;
    }
    this.hud.setPrompt(enabled && target ? 'E — open the door' : null);
    if (enabled && target && input.wasPressed('KeyE')) {
      if (target.open(player.feet.x, player.feet.z)) this.audio.doorOpen();
    }
    if (enabled) {
      for (const door of world.doors) {
        if (door.isOpen && door.crossed(player.prevFeet, player.feet)) {
          this.travel(door);
          break;
        }
      }
      if (input.wasPressed('KeyR')) this.returnToRoom();
    }

    input.endFrame();
    this.renderer.render(this.scene, camera);
    this.adaptResolution(raw);
  }

  /** Nudge the render resolution so slower GPUs keep a steady frame rate. */
  adaptResolution(raw) {
    const p = this.perf;
    if (this.busy) {
      p.settle = 150; // ignore the hitches that follow loading a world
      return;
    }
    if (p.settle > 0) {
      p.settle--;
      return;
    }
    if (raw > 0.25) return;
    p.ema += (raw - p.ema) * 0.05;
    p.cooldown = Math.max(0, p.cooldown - 1);
    if (p.cooldown > 0) return;
    if (p.ema > 1 / 32) p.slow++;
    else p.slow = Math.max(0, p.slow - 2);
    if (p.ema < 1 / 70) p.fast++;
    else p.fast = Math.max(0, p.fast - 3);
    if (p.slow > 60 && this.ratio > 0.62) {
      this.ratio = Math.max(0.6, this.ratio * 0.85);
      p.slow = 0;
      p.cooldown = 120;
      this.resize();
    } else if (p.slow > 240 && this.qualityIndex > 0 && !params.has('quality')) {
      // already at the lowest resolution and still slow: reduce grass and view distance
      p.slow = 0;
      p.cooldown = 600;
      this.setQuality(this.qualityIndex - 1, { auto: true });
    } else if (p.fast > 400 && this.ratio < this.maxRatio) {
      this.ratio = Math.min(this.maxRatio, this.ratio * 1.12);
      p.fast = 0;
      p.cooldown = 240;
      this.resize();
    }
  }
}

const game = new Game();
if (DEBUG) window.game = game;
game.boot().catch((err) => {
  console.error(err);
  document.getElementById('begin').textContent = 'Failed to start — see console';
});
