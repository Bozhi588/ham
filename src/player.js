import * as THREE from 'three';
import { clamp } from './util/rng.js';

const STEP_UP = 0.55;
const _look = { x: 0, y: 0 };

/**
 * First-person controller: walk, sprint, jump, double jump and glide.
 * `feet` is the position of the player's feet; the camera sits at eye height.
 */
export class Player {
  constructor() {
    this.feet = new THREE.Vector3();
    this.prevFeet = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.radius = 0.35;
    this.height = 1.8;
    this.eyeHeight = 1.66;
    this.grounded = false;
    this.airTime = 0;
    this.coyote = 0;
    this.canDouble = true;
    this.gliding = false;
    this.glideLock = 0;
    this.sprinting = false;
    this.bob = 0;
    this.bobAmp = 0;
    this.landDip = 0;
    this.stepDist = 0;
    this.events = []; // 'jump' | 'double' | 'land' | 'step'
    this.fovKick = 0;
    this.lastSafe = new THREE.Vector3();
    this.mouseSens = 0.0022;
    this.landSpeed = 0;
  }

  teleport(x, y, z, yaw = this.yaw) {
    this.feet.set(x, y, z);
    this.prevFeet.copy(this.feet);
    this.vel.set(0, 0, 0);
    this.yaw = yaw;
    this.pitch = 0;
    this.grounded = false;
    this.canDouble = true;
    this.gliding = false;
    this.lastSafe.copy(this.feet);
  }

  get eye() {
    return new THREE.Vector3(this.feet.x, this.feet.y + this.eyeHeight, this.feet.z);
  }

  forward(out = new THREE.Vector3()) {
    const cp = Math.cos(this.pitch);
    return out.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
  }

  update(dt, input, world, enabled, allowPress = true) {
    this.events.length = 0;
    this.prevFeet.copy(this.feet);

    if (enabled) {
      input.look(_look);
      this.yaw -= _look.x * this.mouseSens;
      this.pitch = clamp(this.pitch - _look.y * this.mouseSens, -1.5, 1.5);
    } else {
      input.look(_look);
    }

    // --- desired movement -------------------------------------------------
    let mx = 0;
    let mz = 0;
    if (enabled) {
      if (input.isDown('KeyW') || input.isDown('ArrowUp')) mz -= 1;
      if (input.isDown('KeyS') || input.isDown('ArrowDown')) mz += 1;
      if (input.isDown('KeyA') || input.isDown('ArrowLeft')) mx -= 1;
      if (input.isDown('KeyD') || input.isDown('ArrowRight')) mx += 1;
    }
    const moving = mx !== 0 || mz !== 0;
    if (moving) {
      const l = Math.hypot(mx, mz);
      mx /= l;
      mz /= l;
    }
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    // forward = (-sin, -cos); right = (cos, -sin)
    const wx = mx * cos + mz * sin;
    const wz = -mx * sin + mz * cos;

    this.sprinting = enabled && moving && (input.isDown('ShiftLeft') || input.isDown('ShiftRight'));
    const jumpHeld = enabled && input.isDown('Space');
    const jumpPressed = enabled && allowPress && input.wasPressed('Space');

    // --- jump / double jump / glide ------------------------------------------
    this.coyote = this.grounded ? 0.12 : Math.max(0, this.coyote - dt);
    if (jumpPressed) {
      if (this.coyote > 0) {
        this.vel.y = 8.6;
        this.grounded = false;
        this.coyote = 0;
        this.glideLock = 0.25;
        this.events.push('jump');
      } else if (this.canDouble) {
        this.vel.y = 7.4;
        this.canDouble = false;
        this.glideLock = 0.3;
        this.events.push('double');
      }
    }
    this.glideLock = Math.max(0, this.glideLock - dt);
    // Hold Space while falling to ride the wind.
    this.gliding = !this.grounded && jumpHeld && this.glideLock <= 0 && this.vel.y < -0.5;

    // --- horizontal velocity -------------------------------------------------
    const base = this.sprinting ? 9.2 : 5.4;
    let target = base;
    let accel = this.grounded ? 46 : 9;
    if (this.gliding) {
      target = 14;
      accel = 3.2;
      // gliding always pushes you where you are looking
      if (!moving) {
        const f = this.forward();
        const fl = Math.hypot(f.x, f.z) || 1;
        this.vel.x += (f.x / fl) * 6 * dt;
        this.vel.z += (f.z / fl) * 6 * dt;
      }
    }
    if (moving) {
      const k = 1 - Math.exp(-accel * dt);
      this.vel.x += (wx * target - this.vel.x) * k;
      this.vel.z += (wz * target - this.vel.z) * k;
    } else if (this.grounded) {
      const k = 1 - Math.exp(-14 * dt);
      this.vel.x -= this.vel.x * k;
      this.vel.z -= this.vel.z * k;
    } else {
      const k = 1 - Math.exp(-0.35 * dt);
      this.vel.x -= this.vel.x * k;
      this.vel.z -= this.vel.z * k;
    }
    if (this.gliding) {
      const sp = Math.hypot(this.vel.x, this.vel.z);
      if (sp > 17) {
        this.vel.x *= 17 / sp;
        this.vel.z *= 17 / sp;
      }
    }

    // --- vertical ------------------------------------------------------------
    if (this.gliding) {
      this.vel.y += (-2.4 - this.vel.y) * (1 - Math.exp(-3.5 * dt));
    } else {
      this.vel.y -= 24 * dt;
    }
    if (this.vel.y < -48) this.vel.y = -48;

    // --- integrate with axis-separated collision -------------------------------
    const wasGrounded = this.grounded;
    const fall = this.vel.y;
    this._moveAxis(world, this.vel.x * dt, 0);
    this._moveAxis(world, 0, this.vel.z * dt);
    world.collide(this);

    this.feet.y += this.vel.y * dt;
    const ceiling = world.ceiling ? world.ceiling(this) : Infinity;
    if (this.feet.y + this.height > ceiling && this.vel.y > 0) {
      this.feet.y = ceiling - this.height;
      this.vel.y = 0;
    }

    // --- ground ------------------------------------------------------------------
    this.grounded = false;
    const queryY = Math.max(this.prevFeet.y, this.feet.y) + STEP_UP;
    const g = world.ground(this.feet.x, this.feet.z, queryY);
    if (g > -Infinity) {
      if (this.feet.y <= g + 1e-4 && (this.vel.y <= 0 || g - this.feet.y <= STEP_UP)) {
        this.feet.y = g;
        if (this.vel.y < 0) this.vel.y = 0;
        this.grounded = this.vel.y <= 0;
      } else if (wasGrounded && this.vel.y <= 0.001 && this.feet.y - g < 0.55 && this.glideLock <= 0) {
        // stay glued to the ground when walking down slopes and steps
        this.feet.y = g;
        this.vel.y = 0;
        this.grounded = true;
      }
    }

    if (this.grounded) {
      if (!wasGrounded) {
        if (fall < -7) this.landDip = Math.min(0.28, -fall * 0.012);
        this.landSpeed = -fall;
        this.events.push('land');
        this.airTime = 0;
      }
      this.canDouble = true;
      this.gliding = false;
      if (world.isSafe && world.isSafe(this.feet.x, this.feet.y, this.feet.z)) this.lastSafe.copy(this.feet);
    } else {
      this.airTime += dt;
    }

    // --- camera feel ---------------------------------------------------------------
    const speed = Math.hypot(this.vel.x, this.vel.z);
    const walking = this.grounded && speed > 0.5;
    this.bobAmp += ((walking ? Math.min(1, speed / 6) : 0) - this.bobAmp) * (1 - Math.exp(-8 * dt));
    if (walking) {
      this.bob += dt * speed * 1.55;
      this.stepDist += speed * dt;
      const stride = this.sprinting ? 2.4 : 1.9;
      if (this.stepDist > stride) {
        this.stepDist = 0;
        this.events.push('step');
      }
    }
    this.landDip *= Math.exp(-9 * dt);
    const fovTarget = (this.sprinting ? 5 : 0) + (this.gliding ? 9 : 0);
    this.fovKick += (fovTarget - this.fovKick) * (1 - Math.exp(-5 * dt));
  }

  /** Move along one horizontal axis; refuse if that would walk into a wall of terrain. */
  _moveAxis(world, dx, dz) {
    if (dx === 0 && dz === 0) return;
    const nx = this.feet.x + dx;
    const nz = this.feet.z + dz;
    const g = world.ground(nx, nz, this.feet.y + STEP_UP);
    if (g > this.feet.y + STEP_UP) {
      // blocked by a steep rise: kill the velocity along this axis
      if (dx !== 0) this.vel.x = 0;
      if (dz !== 0) this.vel.z = 0;
      return;
    }
    this.feet.x = nx;
    this.feet.z = nz;
  }

  applyCamera(camera, time, baseFov) {
    const bobY = Math.sin(this.bob * 2) * 0.035 * this.bobAmp;
    const bobX = Math.cos(this.bob) * 0.025 * this.bobAmp;
    camera.position.set(this.feet.x, this.feet.y + this.eyeHeight + bobY - this.landDip, this.feet.z);
    const cs = Math.cos(this.yaw);
    const sn = Math.sin(this.yaw);
    camera.position.x += cs * bobX;
    camera.position.z -= sn * bobX;
    camera.rotation.order = 'YXZ';
    camera.rotation.set(this.pitch, this.yaw, this.gliding ? Math.sin(time * 1.3) * 0.02 : 0);
    const fov = baseFov + this.fovKick;
    if (Math.abs(camera.fov - fov) > 0.01) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
  }
}
