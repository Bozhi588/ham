/**
 * Keyboard + mouse input. Uses pointer lock when available and falls back to
 * click-and-drag looking when it is not (e.g. inside a sandboxed iframe).
 */
export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.down = new Set();
    this.pressedFrame = new Set();
    this.dx = 0;
    this.dy = 0;
    this.locked = false;
    this.dragMode = false;
    this.dragging = false;
    this.active = false; // true while the game should receive input
    this.onLockChange = null;

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) e.preventDefault();
      this.down.add(e.code);
      this.pressedFrame.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => this.down.clear());

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (!this.locked) this.down.clear();
      this._sync();
    });
    document.addEventListener('pointerlockerror', () => {
      this.dragMode = true;
      this.active = true;
      this._sync();
    });
    document.addEventListener('mousemove', (e) => {
      if (this.locked || (this.dragMode && this.dragging)) {
        this.dx += e.movementX || 0;
        this.dy += e.movementY || 0;
      }
    });
    canvas.addEventListener('mousedown', () => {
      this.dragging = true;
    });
    window.addEventListener('mouseup', () => {
      this.dragging = false;
    });
  }

  _sync() {
    this.active = this.locked || this.dragMode;
    if (this.onLockChange) this.onLockChange(this.active);
  }

  /** Ask the browser for pointer lock; fall back to drag-look on failure. */
  capture() {
    const req = this.canvas.requestPointerLock?.();
    if (req && typeof req.catch === 'function') {
      req.catch(() => {
        this.dragMode = true;
        this._sync();
      });
    } else if (!this.canvas.requestPointerLock) {
      this.dragMode = true;
      this._sync();
    }
  }

  release() {
    if (document.pointerLockElement) document.exitPointerLock();
    this.dragMode = false;
    this._sync();
  }

  isDown(code) {
    return this.down.has(code);
  }

  /** True once per key press. */
  wasPressed(code) {
    return this.pressedFrame.has(code);
  }

  /** Consume accumulated mouse movement. */
  look(out) {
    out.x = this.dx;
    out.y = this.dy;
    this.dx = 0;
    this.dy = 0;
    return out;
  }

  endFrame() {
    this.pressedFrame.clear();
  }
}
