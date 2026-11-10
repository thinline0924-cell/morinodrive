// 運転席の液晶メーターとセンターディスプレイ。
// 配置はモデルの空のメーター面・ナビ画面の位置に合わせてある(モデル座標、前 = +X)。
// 表示内容は実車の写真をいただくまでの仮のレイアウト。
import * as THREE from 'three';

const NUM = '"Barlow Semi Condensed", "Arial Narrow", sans-serif';
const JP = '"BIZ UDPGothic", "Hiragino Sans", "Yu Gothic", sans-serif';

export class Instruments {
  constructor(carRoot, course, renderer) {
    this.course = course;
    // メーター:7インチ相当の横長液晶
    this.mc = document.createElement('canvas');
    this.mc.width = 1040; this.mc.height = 400;
    this.mtex = new THREE.CanvasTexture(this.mc);
    this.mtex.colorSpace = THREE.SRGBColorSpace;
    this.mtex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    const meter = new THREE.Mesh(new THREE.PlaneGeometry(0.255, 0.098), new THREE.MeshBasicMaterial({ map: this.mtex, toneMapped: false }));
    meter.position.set(0.826, 1.07, 0.354);
    meter.rotation.y = -Math.PI / 2;
    carRoot.add(meter);
    // センターディスプレイ:9インチ相当
    this.nc = document.createElement('canvas');
    this.nc.width = 1024; this.nc.height = 660;
    this.ntex = new THREE.CanvasTexture(this.nc);
    this.ntex.colorSpace = THREE.SRGBColorSpace;
    this.ntex.anisotropy = this.mtex.anisotropy;
    const nav = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.129), new THREE.MeshBasicMaterial({ map: this.ntex, toneMapped: false }));
    nav.position.set(0.752, 1.129, -0.013);
    nav.rotation.set(0, -Math.PI / 2, 0);
    nav.rotateX(-0.066);
    carRoot.add(nav);
    this.t = 0; this.tn = 0;
    this.power = 0;
    this.fuel = 0.72; this.battery = 0.58;
    this.ready = 0;
  }

  update(dt, v, place, visible = true) {
    this.t += dt; this.tn += dt;
    this.ready += dt;
    this.power += ((v.drivePower / 1000) - this.power) * Math.min(1, dt * 5);
    // 電池:回生で増え、強い加速で減る(見た目の目安)
    this.battery = THREE.MathUtils.clamp(this.battery - this.power * dt * 0.00008, 0.2, 0.9);
    this.fuel = Math.max(0.05, this.fuel - Math.max(0, this.power - 20) * dt * 0.0000012);
    // 運転席から見ていないときは書き換えを減らす(絵を GPU に送る量を抑える)
    if (this.t > (visible ? 1 / 24 : 0.5)) { this.t = 0; this._drawMeter(v); this.mtex.needsUpdate = true; }
    if (this.tn > (visible ? 1 / 8 : 1)) { this.tn = 0; this._drawNav(v, place); this.ntex.needsUpdate = true; }
  }

  _drawMeter(v) {
    const g = this.mc.getContext('2d');
    const W = 1040, H = 400;
    g.fillStyle = '#030405'; g.fillRect(0, 0, W, H);
    const bg = g.createRadialGradient(520, 210, 40, 520, 210, 520);
    bg.addColorStop(0, 'rgba(40,52,64,0.55)'); bg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = bg; g.fillRect(0, 0, W, H);

    const kmh = Math.round(v.speed * 3.6);
    const cx = 520, cy = 212, R = 158;
    // パワーメーター:左下 CHARGE / 上 POWER
    const a0 = Math.PI * 0.80, a1 = Math.PI * 2.20, aZero = Math.PI * 1.02;
    const span = a1 - aZero, cspan = aZero - a0;
    g.lineCap = 'butt';
    g.lineWidth = 16; g.strokeStyle = 'rgba(255,255,255,0.08)';
    g.beginPath(); g.arc(cx, cy, R, a0, a1); g.stroke();
    // 目盛り
    for (let i = 0; i <= 20; i++) {
      const a = aZero + span * i / 20;
      const r1 = R + 13, r2 = R + (i % 5 === 0 ? 24 : 18);
      g.strokeStyle = i % 5 === 0 ? 'rgba(235,240,245,0.85)' : 'rgba(235,240,245,0.35)'; g.lineWidth = i % 5 === 0 ? 3 : 2;
      g.beginPath(); g.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); g.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2); g.stroke();
    }
    // ECO 範囲
    g.lineWidth = 4; g.strokeStyle = 'rgba(92,201,128,0.9)';
    g.beginPath(); g.arc(cx, cy, R - 14, aZero, aZero + span * 0.28); g.stroke();
    const p = this.power; // kW
    g.lineWidth = 16;
    if (p >= 0) {
      g.strokeStyle = '#eef3f7';
      g.beginPath(); g.arc(cx, cy, R, aZero, aZero + span * Math.min(1, p / 90)); g.stroke();
    } else {
      g.strokeStyle = '#38a6ec';
      g.beginPath(); g.arc(cx, cy, R, aZero - cspan * Math.min(1, -p / 40), aZero); g.stroke();
    }
    g.fillStyle = 'rgba(200,210,220,0.7)'; g.font = `500 19px ${NUM}`; g.textAlign = 'center';
    const lbl = (txt, a, r) => { g.fillText(txt, cx + Math.cos(a) * r, cy + Math.sin(a) * r + 6); };
    lbl('CHARGE', a0 + 0.12, R + 40);
    lbl('ECO', aZero + span * 0.14, R - 38);
    lbl('POWER', a1 - 0.18, R + 40);

    // 速度
    g.fillStyle = '#f4f7fa';
    g.font = `600 150px ${NUM}`;
    g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    g.fillText(String(kmh), cx, cy + 46);
    g.font = `500 28px ${NUM}`; g.fillStyle = 'rgba(220,228,235,0.75)';
    g.fillText('km/h', cx, cy + 86);

    // 左:シフト位置・READY・EV
    g.textAlign = 'left';
    const gears = ['P', 'R', 'N', 'D'];
    gears.forEach((s, i) => {
      const x = 58 + i * 46, y = 92;
      const on = v.gear === s;
      if (on) { g.fillStyle = '#e8edf2'; g.fillRect(x - 8, y - 34, 38, 44); }
      g.fillStyle = on ? '#05080b' : 'rgba(220,228,235,0.42)';
      g.font = `600 34px ${NUM}`; g.fillText(s, x, y);
    });
    if (this.ready < 4 || v.speed < 0.2) {
      g.fillStyle = '#5cc980'; g.font = `600 30px ${NUM}`; g.fillText('READY', 58, 162);
    }
    const ev = v.gear !== 'P' && this.power < 18 && v.speed < 19;
    if (ev) {
      g.strokeStyle = '#5cc980'; g.lineWidth = 3; g.strokeRect(58, 196, 62, 38);
      g.fillStyle = '#5cc980'; g.font = `600 28px ${NUM}`; g.fillText('EV', 72, 226);
    }
    // 横すべり防止が働いているときの表示灯(点滅)
    if ((v.vsa || 0) > 0.05 && Math.floor(performance.now() / 250) % 2 === 0) {
      g.fillStyle = '#f2a516'; g.font = `600 22px ${NUM}`;
      g.beginPath(); g.moveTo(150, 200); g.lineTo(178, 200); g.lineTo(174, 232); g.lineTo(154, 232); g.closePath(); g.fill();
      g.fillStyle = '#05080b'; g.fillText('S', 158, 225);
      g.fillStyle = '#f2a516'; g.fillText('VSA', 186, 226);
    }
    // 電池残量
    g.fillStyle = 'rgba(220,228,235,0.6)'; g.font = `500 20px ${NUM}`; g.fillText('BATT', 58, 290);
    for (let i = 0; i < 8; i++) {
      g.fillStyle = i < Math.round(this.battery * 8) ? '#38a6ec' : 'rgba(255,255,255,0.1)';
      g.fillRect(118 + i * 22, 274, 17, 18);
    }

    // 右:燃料・距離・時刻・外気温
    const rx = 772;
    g.fillStyle = 'rgba(220,228,235,0.6)'; g.font = `500 22px ${NUM}`;
    g.fillText('E', rx, 104); g.fillText('F', rx + 210, 104);
    for (let i = 0; i < 10; i++) {
      g.fillStyle = i < Math.round(this.fuel * 10) ? '#e8edf2' : 'rgba(255,255,255,0.1)';
      g.fillRect(rx + 24 + i * 18, 86, 13, 20);
    }
    g.fillStyle = '#e8edf2';
    g.font = `500 24px ${JP}`; g.fillText('航続可能', rx, 152);
    g.font = `600 30px ${NUM}`;
    g.fillText(`${Math.round(this.fuel * 640)} km`, rx + 112, 154);
    g.font = `500 22px ${NUM}`; g.fillStyle = 'rgba(220,228,235,0.62)';
    g.fillText('ODO', rx, 214); g.fillText('TRIP A', rx, 252);
    g.fillStyle = '#e8edf2'; g.font = `600 27px ${NUM}`;
    g.fillText(`${Math.floor(v.odometer / 1000).toLocaleString('en-US')} km`, rx + 82, 215);
    g.fillText(`${(v.trip / 1000).toFixed(1)} km`, rx + 82, 253);

    const now = new Date();
    g.textAlign = 'center'; g.fillStyle = '#e8edf2'; g.font = `600 30px ${NUM}`;
    g.fillText(`${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`, cx, 40);
    g.textAlign = 'right'; g.font = `500 26px ${NUM}`; g.fillStyle = 'rgba(220,228,235,0.8)';
    g.fillText('14°C', W - 40, 40);
    g.textAlign = 'left';
  }

  _drawNav(v, place) {
    const g = this.nc.getContext('2d');
    const W = 1024, H = 660;
    // 地形図に寄せた配色
    g.fillStyle = '#eceee4'; g.fillRect(0, 0, W, H);
    const px = 2.4; // 1m = 2.4px(横幅で約430m)
    const heading = Math.atan2(new THREE.Vector3(1, 0, 0).applyQuaternion(v.quat).z, new THREE.Vector3(1, 0, 0).applyQuaternion(v.quat).x);
    const cx = W / 2, cy = H * 0.62;
    this.course.drawNav(g, v.pos.x, v.pos.z, heading, px, W, H, cx, cy);
    // 自車
    g.save(); g.translate(cx, cy);
    g.fillStyle = '#c8352b'; g.strokeStyle = '#fff'; g.lineWidth = 4;
    g.beginPath(); g.moveTo(0, -26); g.lineTo(17, 18); g.lineTo(0, 9); g.lineTo(-17, 18); g.closePath(); g.fill(); g.stroke();
    g.restore();
    // 上の帯
    g.fillStyle = '#20262c'; g.fillRect(0, 0, W, 64);
    g.fillStyle = '#eef2f5'; g.font = `700 30px ${JP}`; g.textAlign = 'left';
    g.fillText(place || '', 28, 43);
    const now = new Date();
    g.textAlign = 'right'; g.font = `600 32px ${NUM}`;
    g.fillText(`${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`, W - 28, 44);
    // 方位
    // 北(-z)を指す針。地図と同じく -heading - 90° 回す
    g.save(); g.translate(W - 70, 130);
    g.rotate(-heading - Math.PI / 2);
    g.beginPath(); g.moveTo(0, -30); g.lineTo(10, 0); g.lineTo(-10, 0); g.closePath(); g.fillStyle = '#c8352b'; g.fill();
    g.beginPath(); g.moveTo(0, 30); g.lineTo(10, 0); g.lineTo(-10, 0); g.closePath(); g.fillStyle = '#7d858c'; g.fill();
    g.restore();
    g.fillStyle = '#20262c'; g.font = `700 22px ${JP}`; g.textAlign = 'center'; g.fillText('N', W - 70, 186);
    // 縮尺
    g.textAlign = 'left'; g.fillStyle = '#20262c'; g.font = `500 22px ${NUM}`;
    g.fillRect(28, H - 34, 100 * px, 4); g.fillText('100 m', 28, H - 44);
  }
}
