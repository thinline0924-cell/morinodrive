// 高速でスライドさせて、操作を離したあとに戻るまでの時間を測る
import * as THREE from 'three';
import { Course } from '../../js/course.js';
import { Vehicle } from '../../js/vehicle.js';
const course = new Course();
// 平らな広い場所(試走コースの外)
const flat = { height: () => 0, normal: (x, z, o = new THREE.Vector3()) => o.set(0, 1, 0), surface: () => 'road' };
const defs = [['FL', 1.37, 0.324, -0.741], ['FR', 1.37, 0.324, 0.741], ['RL', -1.37, 0.33, -0.741], ['RR', -1.37, 0.33, 0.741]].map(([name, x, y, z]) => ({ name, pos: new THREE.Vector3(x, y, z), radius: 0.312 }));
const dt = 1 / 60;
const inp = (o = {}) => ({ accel: 0, brake: 0, steer: 0, handbrake: false, analog: false, ...o });
function scenario(name, kmh, script) {
  const v = new Vehicle(flat, defs);
  v.reset(0, 0, 0);
  const f = new THREE.Vector3(1, 0, 0);
  v.gear = 'D'; v.vel.copy(f).multiplyScalar(kmh / 3.6);
  for (let i = 0; i < 30; i++) v.update(dt, inp({ accel: 0.3 }));
  const h0 = Math.atan2(new THREE.Vector3(1, 0, 0).applyQuaternion(v.quat).z, 1);
  let t = 0, maxBeta = 0, recovered = null, released = null, spun = false, heading0 = null;
  for (let i = 0; i < 60 * 12; i++) {
    const cmd = script(t);
    if (!cmd && released === null) released = t;
    v.update(dt, cmd || inp());
    t += dt;
    const fw = new THREE.Vector3(1, 0, 0).applyQuaternion(v.quat);
    const hv = new THREE.Vector3(v.vel.x, 0, v.vel.z);
    if (heading0 === null) heading0 = Math.atan2(fw.z, fw.x);
    const beta = hv.length() > 2 ? Math.abs(Math.atan2(fw.x * hv.z - fw.z * hv.x, fw.x * hv.x + fw.z * hv.z)) : 0;
    maxBeta = Math.max(maxBeta, beta);
    if (beta > Math.PI / 2) spun = true;
    if (released !== null && recovered === null && beta < 0.05 && Math.abs(v.angVel.y) < 0.1) recovered = t - released;
  }
  console.log(`${name.padEnd(28)} 最大の横すべり角 ${(maxBeta * 180 / Math.PI).toFixed(0).padStart(3)}° スピン ${spun ? 'あり' : 'なし'}  離してから戻るまで ${recovered === null ? '戻らず' : recovered.toFixed(1) + '秒'}`);
}
scenario('90km/h 急ハンドル+サイドブレーキ', 90, (t) => (t < 1.0 ? inp({ steer: 1, handbrake: t < 0.6 }) : null));
scenario('100km/h 右左に切り返し', 100, (t) => (t < 0.7 ? inp({ steer: 1 }) : t < 1.4 ? inp({ steer: -1 }) : null));
scenario('80km/h 急ハンドルのまま 2 秒', 80, (t) => (t < 2 ? inp({ steer: 1, accel: 1 }) : null));
scenario('120km/h 急ハンドル', 120, (t) => (t < 1.2 ? inp({ steer: -1 }) : null));
