const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Thin wrapper over the DOM overlay: prompt, title card, fade, menus. */
export class Hud {
  constructor() {
    this.prompt = $('prompt');
    this.title = $('title');
    this.titleMain = $('title-main');
    this.titleSub = $('title-sub');
    this.fade = $('fade');
    this.fadeLabel = $('fade-label');
    this.start = $('start');
    this.pause = $('pause');
    this.hint = $('hint');
    this.where = $('where');
    this._promptText = null;
    this._titleTimer = 0;
  }

  setPrompt(text) {
    if (text === this._promptText) return;
    this._promptText = text;
    if (text) {
      this.prompt.textContent = text;
      this.prompt.classList.add('on');
    } else {
      this.prompt.classList.remove('on');
    }
  }

  setWhere(text) {
    this.where.textContent = text;
  }

  showTitle(main, sub, ms = 4200) {
    this.titleMain.textContent = main;
    this.titleSub.textContent = sub;
    this.title.classList.add('on');
    clearTimeout(this._titleTimer);
    this._titleTimer = setTimeout(() => this.title.classList.remove('on'), ms);
  }

  hideTitle() {
    clearTimeout(this._titleTimer);
    this.title.classList.remove('on');
  }

  /** Fade the full-screen overlay. `to` is 0 (clear) or 1 (covered). */
  async fadeTo(to, ms = 600, color = '#000') {
    if (to > 0) this.fade.style.background = color;
    this.fade.style.transition = `opacity ${ms}ms ease`;
    // force the transition to start from the current state
    void this.fade.offsetWidth;
    this.fade.style.opacity = String(to);
    await sleep(ms);
  }

  setFadeInstant(v, color) {
    this.fade.style.transition = 'none';
    if (color) this.fade.style.background = color;
    this.fade.style.opacity = String(v);
  }

  setLoading(label) {
    this.fadeLabel.textContent = label || '';
    this.fadeLabel.classList.toggle('on', !!label);
  }

  showStart(v) {
    this.start.classList.toggle('on', v);
  }

  showPause(v) {
    this.pause.classList.toggle('on', v);
  }
}
