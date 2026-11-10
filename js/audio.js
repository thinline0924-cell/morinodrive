// 車の音。音のファイルは使わず、その場で作る(Web Audio)。
// e:HEV は低い速度ではモーターだけで走り、強く加速したときや速い速度ではエンジンが回る。
export class CarAudio {
  constructor() {
    this.ctx = null;
    this.on = true;
    this.engine = 0;      // エンジンの回り具合(0〜1)
    this.engineRpm = 1300;
    this.beepT = 0;
  }

  // 「出発する」を押したときに呼ぶ(ブラウザは操作のあとでないと音を出せない)
  start() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC();
    const out = this.out = ctx.createGain();
    out.gain.value = this.on ? 0.9 : 0;
    // 車内ではこもった音に
    this.cabin = ctx.createBiquadFilter(); this.cabin.type = 'lowpass'; this.cabin.frequency.value = 9000;
    this.cabin.connect(out); out.connect(ctx.destination);

    // 雑音(ブラウン系)を 2 秒ぶん作ってくり返す
    const len = ctx.sampleRate * 2, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; last = (last + 0.04 * w) / 1.04; d[i] = last * 3.2 + w * 0.08; }
    const noise = () => { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.loopStart = Math.random(); s.start(0, Math.random() * 2); return s; };
    const chain = (src, ...nodes) => { let n = src; for (const x of nodes) { n.connect(x); n = x; } n.connect(this.cabin); return nodes.at(-1); };
    const filt = (type, f, q = 0.7) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; };
    const gain = (v = 0) => { const g = ctx.createGain(); g.gain.value = v; return g; };

    // モーターのうなり(速さで高さが変わる)
    this.motorA = ctx.createOscillator(); this.motorA.type = 'sine';
    this.motorB = ctx.createOscillator(); this.motorB.type = 'triangle';
    this.motorG = gain();
    const mf = filt('bandpass', 1200, 1.2);
    this.motorA.connect(this.motorG); this.motorB.connect(this.motorG); chain(this.motorG, mf);
    this.motorA.start(); this.motorB.start();

    // エンジン(4 気筒:回転の 2 倍の周波数を基音に)
    this.engA = ctx.createOscillator(); this.engA.type = 'sawtooth';
    this.engB = ctx.createOscillator(); this.engB.type = 'square';
    this.engG = gain();
    this.engF = filt('lowpass', 500, 1.5);
    const engMix = gain(1);
    const eb = gain(0.35); this.engB.connect(eb); eb.connect(engMix); this.engA.connect(engMix);
    engMix.connect(this.engF); this.engF.connect(this.engG); this.engG.connect(this.cabin);
    this.engA.start(); this.engB.start();

    // ロードノイズ
    this.roadF = filt('bandpass', 300, 0.6); this.roadG = gain();
    chain(noise(), this.roadF, this.roadG);
    // 砂利・草の上のざらつき
    this.gravelF = filt('highpass', 1800, 0.5); this.gravelG = gain();
    chain(noise(), this.gravelF, this.gravelG);
    // 風切り音
    this.windF = filt('bandpass', 900, 0.4); this.windG = gain();
    chain(noise(), this.windF, this.windG);
    // タイヤのきしみ
    this.squealF = filt('bandpass', 1050, 9); this.squealG = gain();
    chain(noise(), this.squealF, this.squealG);
    // 後退のブザー(車内のピッ、ピッ)
    this.beep = ctx.createOscillator(); this.beep.type = 'sine'; this.beep.frequency.value = 1150;
    this.beepG = gain(); this.beep.connect(this.beepG); this.beepG.connect(out); this.beep.start();
    this.buf = buf;
  }

  setOn(on) {
    this.on = on;
    if (this.out) this.out.gain.setTargetAtTime(on ? 0.9 : 0, this.ctx.currentTime, 0.05);
  }
  pause(p) {
    if (!this.ctx) return;
    if (p) this.ctx.suspend(); else this.ctx.resume();
  }

  // ぶつかったときの「ドン」
  thump(strength) {
    if (!this.ctx || strength < 0.05) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const s = ctx.createBufferSource(); s.buffer = this.buf;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 260;
    const g = ctx.createGain(); g.gain.setValueAtTime(Math.min(1.2, 0.3 + strength), t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    s.connect(f); f.connect(g); g.connect(this.cabin);
    s.start(t, Math.random()); s.stop(t + 0.4);
    const o = ctx.createOscillator(); o.frequency.setValueAtTime(70, t); o.frequency.exponentialRampToValueAtTime(35, t + 0.25);
    const og = ctx.createGain(); og.gain.setValueAtTime(Math.min(0.8, strength), t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    o.connect(og); og.connect(this.cabin); o.start(t); o.stop(t + 0.32);
  }

  update(dt, v, { cockpit }) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, k = 0.08;
    const set = (param, val) => param.setTargetAtTime(val, t, k);
    const kmh = v.speed * 3.6;
    const kw = (v.drivePower || 0) / 1000;
    const load = Math.max(0, kw) / 90;

    // 車内:高い音が減り、風と道の音が小さい
    set(this.cabin.frequency, cockpit ? 2600 : 9000);

    // モーター
    const mf = 140 + kmh * 15;
    set(this.motorA.frequency, mf); set(this.motorB.frequency, mf * 2.02);
    set(this.motorG.gain, v.gear === 'P' ? 0 : (0.006 + 0.03 * Math.min(1, Math.abs(kw) / 50)) * Math.min(1, kmh / 8 + 0.2));

    // エンジン:強い加速(30kW 以上)か 75km/h 以上で回る。少し遅れてかかり、ゆっくり止まる
    const want = v.gear !== 'P' && (kw > 30 || kmh > 75) ? 1 : 0;
    this.engine += (want - this.engine) * Math.min(1, dt * (want ? 1.2 : 0.5));
    const rpm = 1250 + load * 3200 + Math.max(0, kmh - 60) * 12;
    this.engineRpm += (rpm - this.engineRpm) * Math.min(1, dt * 2.5);
    const ef = this.engineRpm / 60 * 2;
    set(this.engA.frequency, ef); set(this.engB.frequency, ef * 0.5);
    set(this.engF.frequency, 300 + load * 900);
    set(this.engG.gain, this.engine * (0.05 + load * 0.09));

    // ロードノイズと風
    const surf = v.wheels.filter((w) => w.contact).map((w) => w.surface);
    const rough = surf.length ? surf.filter((s) => s !== 'road').length / surf.length : 0;
    set(this.roadF.frequency, 180 + kmh * 4);
    set(this.roadG.gain, Math.min(0.5, Math.pow(kmh / 60, 1.2) * 0.22 * (1 + rough * 0.8)) * (cockpit ? 0.8 : 1));
    set(this.gravelG.gain, rough * Math.min(1, kmh / 30) * 0.08);
    set(this.windF.frequency, 500 + kmh * 9);
    set(this.windG.gain, Math.pow(kmh / 100, 2) * (cockpit ? 0.08 : 0.2));

    // きしみ:舗装の上でタイヤが限界を超えたとき
    const slip = Math.max(0, ...v.wheels.filter((w) => w.contact && w.surface === 'road').map((w) => w.slip || 0));
    set(this.squealG.gain, kmh > 8 ? Math.min(0.25, Math.max(0, slip - 0.92) * 1.6) : 0);
    set(this.squealF.frequency, 950 + slip * 300);

    // 後退のブザー
    this.beepT += dt;
    const beepOn = v.gear === 'R' && (this.beepT % 0.9) < 0.45;
    set(this.beepG.gain, beepOn ? 0.05 : 0);

    // ぶつかった
    // 続けて押しつけているときに何度も鳴らさない
    this.thumpCool = Math.max(0, (this.thumpCool || 0) - dt);
    if (v.bump > 0.05 && this.thumpCool === 0) { this.thump(v.bump); this.thumpCool = 0.45; }
    v.bump = 0;
  }
}
