// キーボードとゲームパッド(標準配置)をまとめて読む
const GAME_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);

export class Input {
  constructor() {
    this.keys = new Set();
    this.handlers = {};
    this.prevButtons = [];
    this.usingPad = false;
    this.look = { x: 0, y: 0 };
    this.mouseLook = { x: 0, y: 0, active: false };
    addEventListener('keydown', (e) => {
      if (GAME_KEYS.has(e.code)) e.preventDefault();
      if (e.repeat) return;
      this.keys.add(e.code);
      this.usingPad = false;
      const map = { KeyC: 'camera', KeyV: 'camera', KeyR: 'reset', Backspace: 'reset', KeyH: 'help', Escape: 'pause', KeyM: 'map' };
      if (map[e.code]) this._emit(map[e.code]);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    // マウスのドラッグで見回す
    addEventListener('pointerdown', (e) => { if (e.target.tagName === 'CANVAS') { this.mouseLook.active = true; this._lx = e.clientX; this._ly = e.clientY; } });
    addEventListener('pointerup', () => { this.mouseLook.active = false; });
    addEventListener('pointermove', (e) => {
      if (!this.mouseLook.active) return;
      this.mouseLook.x += (e.clientX - this._lx) * 0.005;
      this.mouseLook.y += (e.clientY - this._ly) * 0.004;
      this._lx = e.clientX; this._ly = e.clientY;
    });
  }

  on(name, fn) { (this.handlers[name] ||= []).push(fn); }
  _emit(name) { (this.handlers[name] || []).forEach((f) => f()); }

  poll() {
    const k = (c) => this.keys.has(c);
    let accel = k('KeyW') || k('ArrowUp') ? 1 : 0;
    let brake = k('KeyS') || k('ArrowDown') ? 1 : 0;
    let steer = (k('KeyD') || k('ArrowRight') ? 1 : 0) - (k('KeyA') || k('ArrowLeft') ? 1 : 0);
    let handbrake = k('Space');
    let analog = false;
    this.look.x = 0; this.look.y = 0;

    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) {
      if (!p || !p.connected) continue;
      const b = (i) => (p.buttons[i] ? p.buttons[i].value : 0);
      const dz = (x, d = 0.12) => (Math.abs(x) < d ? 0 : (x - Math.sign(x) * d) / (1 - d));
      const sx = dz(p.axes[0] || 0);
      const rt = b(7), lt = b(6);
      if (rt > 0.02 || lt > 0.02 || Math.abs(sx) > 0 || b(0) > 0.5) this.usingPad = true;
      if (this.usingPad) {
        accel = Math.max(accel, rt);
        brake = Math.max(brake, lt);
        if (Math.abs(sx) > 0) { steer = Math.sign(sx) * Math.pow(Math.abs(sx), 1.6); analog = true; }
        handbrake = handbrake || b(0) > 0.5 || b(1) > 0.5;
      }
      this.look.x = dz(p.axes[2] || 0, 0.2);
      this.look.y = dz(p.axes[3] || 0, 0.2);
      // ボタンの押し始めだけ拾う
      const edge = (i, name) => {
        const now = b(i) > 0.5;
        if (now && !this.prevButtons[i]) this._emit(name);
        this.prevButtons[i] = now;
      };
      edge(3, 'camera'); edge(8, 'reset'); edge(9, 'pause'); edge(2, 'help'); edge(12, 'map');
      break;
    }
    return { accel, brake, steer, handbrake, analog };
  }
}
