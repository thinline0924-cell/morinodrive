import * as THREE from 'three';
import { Course } from '../../js/course.js';
import { Vehicle, SPEC } from '../../js/vehicle.js';
const course = new Course();
const defs = [['FL',1.37,0.324,-0.741],['FR',1.37,0.324,0.741],['RL',-1.37,0.33,-0.741],['RR',-1.37,0.33,0.741]].map(([name,x,y,z])=>({name,pos:new THREE.Vector3(x,y,z),radius:0.312}));
const v = new Vehicle(course, defs);
const dt = 1/60;
const inp = (o={}) => ({accel:0,brake:0,steer:0,handbrake:false,analog:false,...o});
const up = () => new THREE.Vector3(0,1,0).applyQuaternion(v.quat).y;
const kmh = () => v.speed*3.6;
function run(sec, f) { const n=Math.round(sec/dt); for (let i=0;i<n;i++){ v.update(dt, typeof f==='function'?f(i*dt):f); } }

// 平らな直線で試す:コースの外の平地(遠景の山より内側)
function place(){ v.reset(-450, -450, 0); }
place(); run(3, inp());
console.log('rest: speed', v.speed.toFixed(3), 'comp', v.wheels.map(w=>w.comp.toFixed(3)).join(','), 'up', up().toFixed(4));

place(); let t=0, t100=null, t60=null; const d0=v.pos.clone();
for (let i=0;i<60*40;i++){ v.update(dt, inp({accel:1})); t+=dt; if(!t60&&kmh()>=60)t60=t; if(!t100&&kmh()>=100)t100=t; }
console.log('0-60', t60?.toFixed(1), 's  0-100', t100?.toFixed(1), 's  speed@40s', kmh().toFixed(0), 'km/h');

// 100km/h からの急ブレーキ
place(); while(kmh()<100) v.update(dt, inp({accel:1}));
let p0=v.pos.clone(), tb=0; while(v.speed>0.3 && tb<20){ v.update(dt, inp({brake:1})); tb+=dt; }
console.log('brake 100-0', v.pos.distanceTo(p0).toFixed(1), 'm', tb.toFixed(1), 's');

// 40km/h で一定の舵角
for (const s of [0.3, 0.6, 1.0]) {
  place(); while(kmh()<40) v.update(dt, inp({accel:0.6}));
  let maxLat=0, minUp=1;
  run(6, (tt)=>{ const keep = kmh()<40?0.5:0.15; maxLat=Math.max(maxLat,Math.abs(v.latAcc)); minUp=Math.min(minUp,up()); return inp({accel:keep,steer:s}); });
  const yawRate = v.angVel.y;
  console.log(`steer ${s} @40: speed ${kmh().toFixed(0)} latAcc ${(maxLat/9.81).toFixed(2)}g yawRate ${yawRate.toFixed(2)} minUp ${minUp.toFixed(3)} radius ${(v.speed/Math.abs(yawRate)).toFixed(1)}m`);
}
// 80km/h で急ハンドル
place(); while(kmh()<80) v.update(dt, inp({accel:1}));
let mu=1; run(3,()=>{mu=Math.min(mu,up());return inp({steer:1});}); console.log('80 full lock: minUp', mu.toFixed(3), 'speed', kmh().toFixed(0));

// 後退への切り替え
place(); run(1, inp({brake:1})); console.log('gear after brake hold from P:', v.gear);
run(3, inp({brake:1})); console.log('reverse speed', kmh().toFixed(1), 'gear', v.gear, 'vLong', new THREE.Vector3(1,0,0).applyQuaternion(v.quat).dot(v.vel).toFixed(2));
run(2, inp({accel:1})); console.log('after accel in R:', kmh().toFixed(1), v.gear); run(1, inp({accel:1})); console.log('then', v.gear, kmh().toFixed(1));

// 周回:道路に沿って自動で走らせる(丘の坂を含む)
const s0 = course.spawnNear(-120,160); v.reset(s0.x,s0.z,s0.heading);
let minU=1, maxK=0, off=0, maxSlope=0; const total=course.length; let traveled=0; let last=v.pos.clone();
for (let i=0;i<60*200 && traveled<total;i++){
  const q = course.nearestRoad(v.pos.x, v.pos.z);
  const n = course.samples.length; const ahead = course.samples[(q.i+6)%n];
  const fwd = new THREE.Vector3(1,0,0).applyQuaternion(v.quat);
  const want = Math.atan2(ahead.z - v.pos.z, ahead.x - v.pos.x), have = Math.atan2(fwd.z, fwd.x);
  let e = want-have; while(e>Math.PI)e-=2*Math.PI; while(e<-Math.PI)e+=2*Math.PI;
  // 左車線を保つ
  const steer = THREE.MathUtils.clamp(e*2.5, -1, 1);
  const target = 50;
  v.update(dt, inp({accel: kmh()<target?0.7:0, brake: kmh()>target+8?0.3:0, steer, analog:true}));
  traveled += v.pos.distanceTo(last); last.copy(v.pos);
  minU=Math.min(minU,up()); maxK=Math.max(maxK,kmh()); if(q.d>3.5) off++;
  maxSlope=Math.max(maxSlope, Math.abs(fwd.y));
}
console.log('lap: traveled', traveled.toFixed(0), '/', total.toFixed(0), 'm  minUp', minU.toFixed(3), 'maxKmh', maxK.toFixed(0), 'offroad frames', off, 'max grade', (Math.tan(Math.asin(maxSlope))*100).toFixed(1)+'%');
