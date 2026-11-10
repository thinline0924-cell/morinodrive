// 車の動き。素直で重すぎない、日常の乗用車の手応えを狙った簡易物理。
// 座標:車の前 = +X、上 = +Y、右 = +Z(モデルと同じ)
import * as THREE from 'three';

// フリード e:HEV 相当の諸元(公表値に近い丸めた数字)
export const SPEC = {
  mass: 1480,              // kg
  wheelbase: 2.74,
  comLocal: new THREE.Vector3(0.22, 0.62, 0), // 重心(前寄り 58:42)
  frontShare: 0.58,
  maxDriveForce: 5200,     // N(モーター 253N·m 相当をタイヤで)
  maxPower: 90000,         // W(123PS)
  topSpeed: 47,            // m/s(約170km/h で頭打ち)
  reverseTopSpeed: 5.0,
  maxBrakeForce: 13000,    // N(4輪合計)
  steerLock: 0.58,         // rad(最小回転半径 約5.2m)
  steerRatio: 15,          // ハンドル角 / タイヤ角
  restLen: 0.28,
  staticComp: 0.10,
  dragCdA: 0.86,
  rollCoef: 0.012,
};

const UP = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _f = new THREE.Vector3(), _r = new THREE.Vector3();
const _n = new THREE.Vector3(), _p = new THREE.Vector3(), _a = new THREE.Vector3(), _t = new THREE.Vector3();
const _m3 = new THREE.Matrix3();

export class Vehicle {
  constructor(ground, wheelDefs) {
    this.ground = ground;
    this.pos = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.vel = new THREE.Vector3();
    this.angVel = new THREE.Vector3();
    const m = SPEC.mass;
    // 箱で近似した慣性(重さが中心に寄っている分を割り引く)
    this.invI = new THREE.Vector3(1 / (m / 12 * (1.7 ** 2 + 1.7 ** 2) * 0.9), 1 / (m / 12 * (4.3 ** 2 + 1.7 ** 2) * 0.8), 1 / (m / 12 * (4.3 ** 2 + 1.7 ** 2) * 0.8));
    const g = 9.81;
    this.wheels = wheelDefs.map((d) => {
      const front = d.name[0] === 'F';
      const load = m * g * (front ? SPEC.frontShare : 1 - SPEC.frontShare) / 2;
      const k = load / SPEC.staticComp;
      return {
        name: d.name, front, radius: d.radius,
        rest: d.pos.clone(),                                          // 静止時のタイヤ中心(モデル座標)
        anchor: d.pos.clone().add(new THREE.Vector3(0, SPEC.restLen - SPEC.staticComp, 0)),
        k, c: 2 * Math.sqrt(k * load / g) * 0.38,
        comp: 0, prevComp: 0, contact: false, load: 0, spin: 0, spinVel: 0, steer: 0, travel: 0,
        surface: 'road', slip: 0,
      };
    });
    // 車体の当たり判定用の点(横転したときに地面へ潜らないように)
    this.hull = [];
    for (const x of [-2.05, 2.1]) for (const z of [-0.82, 0.82]) { this.hull.push(new THREE.Vector3(x, 0.3, z), new THREE.Vector3(x * 0.85, 1.72, z * 0.9)); }
    // 建物とぶつかる点(バンパーと側面の高さ)
    this.bumpers = [];
    for (const x of [-2.1, -1.1, 0, 1.1, 2.15]) for (const z of [-0.84, 0.84]) this.bumpers.push(new THREE.Vector3(x, 0.55, z));
    this.bumpers.push(new THREE.Vector3(2.18, 0.55, 0), new THREE.Vector3(-2.12, 0.55, 0));
    this.steerInput = 0;
    this.steerAngle = 0;
    this.gear = 'P';
    this.gearTimer = 0;
    this.drivePower = 0; // W(+:駆動, -:回生)
    this.odometer = 1286.4 * 1000; // m(この車がここまで走ってきた距離という設定)
    this.trip = 0;
    this.speed = 0;
    this.accum = 0;
    this.longAcc = 0; this.latAcc = 0;
    this._prevVel = new THREE.Vector3();
  }

  reset(x, z, heading) {
    this.quat.setFromAxisAngle(UP, -heading);
    const h = this.ground.height(x, z);
    this.pos.set(x, h + 0.01, z).add(_v.copy(SPEC.comLocal).applyQuaternion(this.quat));
    this.vel.set(0, 0, 0);
    this.angVel.set(0, 0, 0);
    for (const w of this.wheels) { w.comp = w.prevComp = SPEC.staticComp; w.spinVel = 0; }
    this.steerInput = this.steerAngle = 0;
    this.gear = 'P';
    this.speed = 0; this.accum = 0; this.drivePower = 0;
    this.longAcc = this.latAcc = 0;
    this._prevVel.set(0, 0, 0);
  }

  // モデル座標の点 → ワールド座標
  toWorld(local, out) { return out.copy(local).sub(SPEC.comLocal).applyQuaternion(this.quat).add(this.pos); }

  // 車のモデルを置く位置
  modelTransform(obj) {
    obj.quaternion.copy(this.quat);
    obj.position.copy(SPEC.comLocal).negate().applyQuaternion(this.quat).add(this.pos);
  }

  update(dt, input) {
    this.accum += Math.min(dt, 0.1);
    const h = 1 / 120;
    while (this.accum >= h) { this._step(h, input); this.accum -= h; }
    // 体感用の加速度(カメラの揺れ・メーターに使う)
    const fwd = _f.set(1, 0, 0).applyQuaternion(this.quat);
    const right = _r.set(0, 0, 1).applyQuaternion(this.quat);
    const acc = _a.copy(this.vel).sub(this._prevVel).divideScalar(Math.max(dt, 1e-3));
    this.longAcc += (acc.dot(fwd) - this.longAcc) * Math.min(1, dt * 6);
    this.latAcc += (acc.dot(right) - this.latAcc) * Math.min(1, dt * 6);
    this._prevVel.copy(this.vel);
  }

  _step(dt, input) {
    const q = this.quat;
    const fwd = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    const right = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    const vLong = this.vel.dot(fwd);
    const speed = Math.abs(vLong);
    this.speed = speed;

    // ---------- 操作の解釈(シフト位置) ----------
    let throttle = 0, brake = 0;
    const accel = input.accel, back = input.brake;
    if (this.gear === 'R') { throttle = back; brake = accel; } else { throttle = accel; brake = back; }
    if (this.gear === 'P') {
      if (accel > 0.1) this.gear = 'D';
      throttle = 0; brake = 1;
    }
    // 止まっている間に反対側のペダルを踏み続けたら D⇔R を切り替える
    if (speed < 0.4 && throttle < 0.05 && brake > 0.3 && this.gear !== 'P') {
      this.gearTimer += dt;
      if (this.gearTimer > 0.35) { this.gear = this.gear === 'D' ? 'R' : 'D'; this.gearTimer = 0; }
    } else if (this.gear === 'P' && back > 0.3 && speed < 0.4) {
      this.gearTimer += dt;
      if (this.gearTimer > 0.35) { this.gear = 'R'; this.gearTimer = 0; }
    } else this.gearTimer = 0;

    // ---------- ハンドル ----------
    const target = input.steer;
    const rate = input.analog ? 6 : (Math.abs(target) > Math.abs(this.steerInput) && Math.sign(target) === Math.sign(this.steerInput || target) ? 2.2 : 4.5);
    this.steerInput += THREE.MathUtils.clamp(target - this.steerInput, -rate * dt, rate * dt);
    const lock = SPEC.steerLock / (1 + speed / 10);
    this.steerAngle = this.steerInput * lock;

    // ---------- 駆動力(前輪駆動) ----------
    const dir = this.gear === 'R' ? -1 : 1;
    let drive = 0;
    if (this.gear !== 'P') {
      const v = Math.max(speed, 1);
      let f = Math.min(SPEC.maxDriveForce, SPEC.maxPower / v) * throttle;
      const top = this.gear === 'R' ? SPEC.reverseTopSpeed : SPEC.topSpeed;
      f *= THREE.MathUtils.clamp((top - speed) / 3, 0, 1);
      // クリープ(ブレーキを離すとゆっくり進む)
      if (throttle < 0.05 && brake < 0.05) f += THREE.MathUtils.clamp((1.8 - speed) * 450, 0, 650);
      // アクセルを離したときの回生(軽いエンジンブレーキの感覚)
      if (throttle < 0.05 && speed > 2 && vLong * dir > 0) f -= 0.045 * SPEC.mass * 9.81 * THREE.MathUtils.clamp((speed - 2) / 6, 0, 1);
      drive = f * dir;
    }
    this.drivePower = drive * vLong - (brake > 0 ? brake * Math.min(SPEC.maxBrakeForce * 0.35, 3500) * speed : 0);

    const force = new THREE.Vector3(0, -9.81 * SPEC.mass, 0);
    const torque = new THREE.Vector3();
    const addForceAt = (F, P) => {
      force.add(F);
      torque.add(_t.copy(P).sub(this.pos).cross(F));
    };

    // ---------- サスペンションとタイヤ ----------
    const frontComp = [], rearComp = [];
    for (const w of this.wheels) {
      const anchor = this.toWorld(w.anchor, new THREE.Vector3());
      const rayDir = up.clone().negate();
      let gh = this.ground.height(anchor.x, anchor.z);
      let d = (anchor.y - gh) / Math.max(0.2, -rayDir.y);
      _p.copy(anchor).addScaledVector(rayDir, d);
      gh = this.ground.height(_p.x, _p.z);
      d = (anchor.y - gh) / Math.max(0.2, -rayDir.y);
      const n = this.ground.normal(_p.x, _p.z, new THREE.Vector3());
      w.prevComp = w.comp;
      const comp = SPEC.restLen + w.radius - d;
      w.comp = THREE.MathUtils.clamp(comp, 0, SPEC.restLen);
      w.travel = THREE.MathUtils.clamp(comp, -0.02, SPEC.staticComp + 0.10); // 見た目のタイヤ位置
      w.contact = comp > 0;
      (w.front ? frontComp : rearComp).push(w.comp);
      if (!w.contact) { w.load = 0; w.spinVel *= 0.995; continue; }
      const contact = anchor.clone().addScaledVector(rayDir, d);
      const compVel = (w.comp - w.prevComp) / dt;
      let Fs = w.k * w.comp + w.c * compVel;
      const bump = w.comp - (SPEC.staticComp + 0.09);
      if (bump > 0) Fs += w.k * 12 * bump;
      Fs = Math.max(0, Fs);
      addForceAt(up.clone().multiplyScalar(Fs), anchor);
      const Fz = Fs * Math.max(0, up.dot(n));
      w.load = Fz;

      // タイヤの向き
      const steer = w.front ? this.steerAngle : 0;
      w.steer = steer;
      const fw = fwd.clone().multiplyScalar(Math.cos(steer)).addScaledVector(right, Math.sin(steer));
      fw.addScaledVector(n, -fw.dot(n)).normalize();
      const rw = new THREE.Vector3().crossVectors(fw, n).normalize();
      // 接地点の速度
      const rel = _a.copy(contact).sub(this.pos);
      const vc = _w.copy(this.angVel).cross(rel).add(this.vel);
      const vl = vc.dot(fw), vlat = vc.dot(rw);

      const surface = this.ground.surface(contact.x, contact.z);
      w.surface = surface;
      const mu = surface === 'road' ? 1.0 : surface === 'lot' ? 0.9 : 0.62;
      const handbrake = input.handbrake && !w.front;

      // 前後方向
      let Fx = 0;
      if (w.front) Fx += drive / 2;
      const bShare = w.front ? 0.62 : 0.38;
      const bw = brake * SPEC.maxBrakeForce * bShare / 2 + (handbrake ? 6000 : 0);
      Fx -= bw * THREE.MathUtils.clamp(vl / 0.3, -1, 1);
      Fx -= SPEC.rollCoef * Fz * (surface === 'road' ? 1 : 3) * THREE.MathUtils.clamp(vl / 0.5, -1, 1);
      // 横方向(簡易マジックフォーミュラ)
      const alpha = Math.atan2(vlat, Math.max(Math.abs(vl), 3));
      let Fy = -mu * Fz * Math.sin(1.5 * Math.atan(12 * alpha)) * (handbrake ? 0.45 : 1);
      // 摩擦円
      const lim = mu * Fz * (handbrake ? 0.6 : 1);
      const mag = Math.hypot(Fx, Fy);
      w.slip = lim > 0 ? Math.min(1.5, mag / lim) : 0;
      if (mag > lim && mag > 0) { Fx *= lim / mag; Fy *= lim / mag; }
      const F = fw.multiplyScalar(Fx).addScaledVector(rw, Fy);
      // 力の作用点を少し上げて、ロールを穏やかにする
      addForceAt(F, contact.addScaledVector(up, 0.18));
      w.spinVel = (handbrake && Math.abs(vl) > 0.5) ? 0 : vl / w.radius;
    }
    // スタビライザー(左右の沈み込みの差を抑える)
    for (const [a, b, k] of [[0, 1, 26000], [2, 3, 16000]]) {
      const ws = this.wheels.filter((w) => (a === 0 ? w.front : !w.front));
      if (ws.length !== 2 || !ws[0].contact || !ws[1].contact) continue;
      const diff = ws[0].comp - ws[1].comp;
      const pa = this.toWorld(ws[0].anchor, new THREE.Vector3()), pb = this.toWorld(ws[1].anchor, new THREE.Vector3());
      addForceAt(up.clone().multiplyScalar(k * diff), pa);
      addForceAt(up.clone().multiplyScalar(-k * diff), pb);
    }

    // ---------- 空気抵抗 ----------
    const sp = this.vel.length();
    if (sp > 0.01) force.addScaledVector(this.vel, -0.5 * 1.2 * SPEC.dragCdA * sp);

    // ---------- 車体の当たり判定 ----------
    for (const hp of this.hull) {
      const P = this.toWorld(hp, new THREE.Vector3());
      const gh = this.ground.height(P.x, P.z);
      const pen = gh - P.y;
      if (pen <= 0) continue;
      const n = this.ground.normal(P.x, P.z, new THREE.Vector3());
      const rel = P.clone().sub(this.pos);
      const vc = this.angVel.clone().cross(rel).add(this.vel);
      const vn = vc.dot(n);
      const Fn = Math.max(0, 250000 * pen - 9000 * vn);
      const vt = vc.clone().addScaledVector(n, -vn);
      const Ft = vt.lengthSq() > 1e-6 ? vt.normalize().multiplyScalar(-Math.min(0.5 * Fn, vt.length() * 4000)) : new THREE.Vector3();
      addForceAt(n.multiplyScalar(Fn).add(Ft), P);
    }

    // ---------- 積分 ----------
    this.vel.addScaledVector(force, dt / SPEC.mass);
    // 角速度:車体座標で慣性の逆数を掛ける
    const qi = this.quat.clone().invert();
    const tb = torque.applyQuaternion(qi);
    tb.set(tb.x * this.invI.x, tb.y * this.invI.y, tb.z * this.invI.z).applyQuaternion(this.quat);
    this.angVel.addScaledVector(tb, dt);
    this.angVel.multiplyScalar(0.9995);
    this.pos.addScaledVector(this.vel, dt);
    const wl = this.angVel.length();
    if (wl > 1e-7) {
      const dq = new THREE.Quaternion().setFromAxisAngle(_n.copy(this.angVel).divideScalar(wl), wl * dt);
      this.quat.premultiply(dq).normalize();
    }
    // 静止時のずり落ちを止める(P レンジや停車中)
    if (this.gear === 'P' || (brake > 0.5 && speed < 0.15)) {
      const onGround = this.wheels.filter((w) => w.contact).length >= 3;
      if (onGround) {
        const vu = this.vel.dot(up);
        this.vel.copy(up).multiplyScalar(vu);
        this.angVel.multiplyScalar(0.8);
      }
    }

    // ---------- 建物との当たり:めり込んだ分を押し戻し、壁へ向かう速さを消す ----------
    if (this.ground.obstacle) {
      for (const bp of this.bumpers) {
        const P = this.toWorld(bp, new THREE.Vector3());
        const ob = this.ground.obstacle(P.x, P.z);
        if (!ob || ob.depth > 1.5) continue;
        const n = new THREE.Vector3(ob.x, 0, ob.z);
        this.pos.addScaledVector(n, ob.depth + 0.01);
        const rel = P.sub(this.pos);
        const vc = this.angVel.clone().cross(rel).add(this.vel);
        const vn = vc.dot(n);
        if (vn < 0) {
          this.bump = Math.max(this.bump || 0, Math.min(1, -vn / 8));
          this.vel.addScaledVector(n, -vn * 1.08);
          // 壁沿いの動きは少し落とし、回転も弱める
          const vt = this.vel.clone().addScaledVector(n, -this.vel.dot(n)); vt.y = 0;
          this.vel.addScaledVector(vt, -Math.min(0.25, 0.04 * -vn));
          this.angVel.multiplyScalar(0.85);
        }
      }
    }

    for (const w of this.wheels) w.spin = (w.spin + w.spinVel * dt) % (Math.PI * 2);
    const ds = Math.abs(vLong) * dt;
    this.odometer += ds; this.trip += ds;
  }
}
