/**
 * Procedural audio: wind, room drone, footsteps, doors. No sample files; every
 * sound is synthesised with the Web Audio API. All calls are safe to make
 * before audio is unlocked (they simply do nothing).
 */
export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.mode = 'room';
    this.windLevel = 0.5;
  }

  /** Must be called from a user gesture. */
  init() {
    if (this.ctx) {
      this.ctx.resume?.();
      return;
    }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.8;
      this.master.connect(ctx.destination);

      // two seconds of white noise, reused everywhere
      const len = ctx.sampleRate * 2;
      this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      let b0 = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.97 * b0 + 0.03 * w; // soft low-pass, closer to pink
        d[i] = w * 0.6 + b0 * 4;
      }

      this._buildWind();
      this._buildRoom();
      this.setMode(this.mode, this.windLevel);
    } catch {
      this.ctx = null;
    }
  }

  _loopNoise() {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.loopStart = Math.random();
    src.start();
    return src;
  }

  _buildWind() {
    const ctx = this.ctx;
    this.wind = ctx.createGain();
    this.wind.gain.value = 0;
    this.wind.connect(this.master);

    // airy mid layer with a slowly sweeping band
    const mid = ctx.createBiquadFilter();
    mid.type = 'bandpass';
    mid.frequency.value = 420;
    mid.Q.value = 0.55;
    this._loopNoise().connect(mid);
    this.midGain = ctx.createGain();
    this.midGain.gain.value = 0.5;
    mid.connect(this.midGain).connect(this.wind);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.09;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 260;
    lfo.connect(lfoGain).connect(mid.frequency);
    lfo.start();
    this.midFilter = mid;

    // low rumble
    const low = ctx.createBiquadFilter();
    low.type = 'lowpass';
    low.frequency.value = 170;
    this._loopNoise().connect(low);
    const lowGain = ctx.createGain();
    lowGain.gain.value = 0.9;
    low.connect(lowGain).connect(this.wind);

    // high hiss for gusts
    const hi = ctx.createBiquadFilter();
    hi.type = 'highpass';
    hi.frequency.value = 2400;
    this._loopNoise().connect(hi);
    this.hissGain = ctx.createGain();
    this.hissGain.gain.value = 0.05;
    hi.connect(this.hissGain).connect(this.wind);
    const lfo2 = ctx.createOscillator();
    lfo2.frequency.value = 0.17;
    const lfo2g = ctx.createGain();
    lfo2g.gain.value = 0.04;
    lfo2.connect(lfo2g).connect(this.hissGain.gain);
    lfo2.start();
  }

  _buildRoom() {
    const ctx = this.ctx;
    this.room = ctx.createGain();
    this.room.gain.value = 0;
    this.room.connect(this.master);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 220;
    lp.connect(this.room);
    for (const [f, g] of [[55, 0.5], [55.4, 0.4], [82.4, 0.25], [110.7, 0.08]]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const gg = ctx.createGain();
      gg.gain.value = g;
      o.connect(gg).connect(lp);
      o.start();
    }
    const air = ctx.createBiquadFilter();
    air.type = 'bandpass';
    air.frequency.value = 900;
    air.Q.value = 3;
    this._loopNoise().connect(air);
    const ag = ctx.createGain();
    ag.gain.value = 0.012;
    air.connect(ag).connect(this.room);
    // slow throb
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lg = ctx.createGain();
    lg.gain.value = 0.18;
    lfo.connect(lg).connect(this.room.gain);
    lfo.start();
  }

  setMode(mode, windLevel = 0.5) {
    this.mode = mode;
    this.windLevel = windLevel;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.room.gain.cancelScheduledValues(t);
    this.room.gain.setTargetAtTime(mode === 'room' ? 0.35 : 0, t, 0.6);
  }

  /** Per-frame: let the wind follow the player's speed and gliding. */
  update(dt, { speed = 0, gliding = false, falling = false }) {
    if (!this.ctx || this.mode === 'room') {
      if (this.ctx) this.wind.gain.setTargetAtTime(0, this.ctx.currentTime, 0.4);
      return;
    }
    const t = this.ctx.currentTime;
    let level = 0.12 + this.windLevel * 0.3 + Math.min(speed, 14) * 0.012;
    if (gliding) level += 0.22;
    else if (falling) level += 0.1;
    this.wind.gain.setTargetAtTime(level * 0.8, t, 0.35);
    this.midFilter.frequency.setTargetAtTime(380 + this.windLevel * 260 + (gliding ? 500 : 0), t, 0.4);
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.8, this.ctx.currentTime, 0.05);
    return this.muted;
  }

  _burst({ type = 'bandpass', freq = 1500, q = 0.7, dur = 0.1, gain = 0.1, attack = 0.005, when = 0 }) {
    const ctx = this.ctx;
    const t = ctx.currentTime + when;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random() * 1.5, dur + 0.05);
  }

  _tone({ freq = 100, to = null, type = 'sine', dur = 0.2, gain = 0.1, attack = 0.005, when = 0, filter = null }) {
    const ctx = this.ctx;
    const t = ctx.currentTime + when;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let node = o;
    if (filter) {
      const f = ctx.createBiquadFilter();
      f.type = filter.type;
      f.frequency.value = filter.freq;
      f.Q.value = filter.q ?? 1;
      o.connect(f);
      node = f;
    }
    node.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  footstep(surface = 'grass', sprint = false) {
    if (!this.ctx) return;
    const k = sprint ? 1.25 : 1;
    const j = 0.85 + Math.random() * 0.3;
    switch (surface) {
      case 'wood':
        this._burst({ type: 'lowpass', freq: 650 * j, q: 0.8, dur: 0.12, gain: 0.22 * k });
        this._tone({ freq: 120 * j, to: 55, dur: 0.1, gain: 0.16 * k });
        break;
      case 'sand':
        this._burst({ type: 'bandpass', freq: 900 * j, q: 0.5, dur: 0.17, gain: 0.1 * k, attack: 0.02 });
        break;
      case 'rock':
        this._burst({ type: 'highpass', freq: 1200 * j, q: 0.7, dur: 0.07, gain: 0.12 * k });
        this._tone({ freq: 180 * j, to: 90, dur: 0.06, gain: 0.08 * k });
        break;
      default:
        this._burst({ type: 'bandpass', freq: 2000 * j, q: 0.5, dur: 0.12, gain: 0.09 * k, attack: 0.012 });
        this._burst({ type: 'lowpass', freq: 260, q: 0.7, dur: 0.08, gain: 0.07 * k });
    }
  }

  jump(double = false) {
    if (!this.ctx) return;
    this._burst({ type: 'bandpass', freq: double ? 1800 : 1100, q: 0.6, dur: 0.18, gain: 0.07, attack: 0.03 });
    if (double) this._tone({ freq: 380, to: 760, dur: 0.18, gain: 0.04, type: 'triangle' });
  }

  land(speed = 8, surface = 'grass') {
    if (!this.ctx) return;
    const g = Math.min(0.28, 0.05 + speed * 0.012);
    this._tone({ freq: 95, to: 45, dur: 0.16, gain: g });
    this._burst({ type: 'lowpass', freq: surface === 'wood' ? 700 : 1200, q: 0.6, dur: 0.12, gain: g * 0.8 });
  }

  doorOpen() {
    if (!this.ctx) return;
    this._burst({ type: 'bandpass', freq: 3000, q: 4, dur: 0.05, gain: 0.08 });
    this._tone({ freq: 95, to: 150, type: 'sawtooth', dur: 0.55, gain: 0.05, attack: 0.08, filter: { type: 'bandpass', freq: 620, q: 7 } });
    this._tone({ freq: 150, to: 108, type: 'sawtooth', dur: 0.4, gain: 0.04, attack: 0.05, when: 0.5, filter: { type: 'bandpass', freq: 540, q: 7 } });
    this._burst({ type: 'lowpass', freq: 500, q: 0.7, dur: 0.5, gain: 0.07, when: 0.1, attack: 0.2 });
  }

  doorClose() {
    if (!this.ctx) return;
    this._tone({ freq: 110, to: 60, dur: 0.18, gain: 0.14, when: 0.55 });
    this._burst({ type: 'lowpass', freq: 800, q: 0.7, dur: 0.15, gain: 0.12, when: 0.55 });
  }

  portal() {
    if (!this.ctx) return;
    this._tone({ freq: 220, to: 880, dur: 1.1, gain: 0.07, type: 'sine', attack: 0.2 });
    this._tone({ freq: 330, to: 1320, dur: 1.1, gain: 0.05, type: 'sine', attack: 0.3 });
    this._tone({ freq: 110, to: 440, dur: 1.2, gain: 0.05, type: 'triangle', attack: 0.3 });
    this._burst({ type: 'bandpass', freq: 1200, q: 0.6, dur: 1.2, gain: 0.12, attack: 0.5 });
  }

  arrive() {
    if (!this.ctx) return;
    this._tone({ freq: 660, to: 330, dur: 1.4, gain: 0.04, type: 'sine', attack: 0.05 });
    this._tone({ freq: 495, to: 247, dur: 1.6, gain: 0.03, type: 'sine', attack: 0.05 });
    this._burst({ type: 'bandpass', freq: 900, q: 0.5, dur: 1.2, gain: 0.08, attack: 0.1 });
  }
}
