import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { World } from './world.js';
import { Vehicle, SPEC } from './vehicle.js';
import { Instruments } from './instruments.js';
import { Input } from './input.js';
import { CarAudio } from './audio.js';

const $ = (id) => document.getElementById(id);
const ui = {
  loader: $('loader'), bar: $('load-bar'), status: $('load-status'), start: $('start'),
  plate: $('plate'), plateName: $('plate-name'), plateRoman: $('plate-roman'),
  help: $('help'), speed: $('speed'), speedNum: $('speed-num'), pause: $('pause'),
  minimap: $('minimap'), minimapCanvas: $('minimap-canvas'), minimapPlace: $('minimap-place'),
};

// ---------- 描画の土台 ----------
// 奥行きはふつうの深度(対数深度は重く、reverse Z はこの版では表示が崩れるため)
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
// 画素の細かさは、描画の速さを見ながら自動で上げ下げする(下の adaptResolution)
const maxRatio = Math.min(devicePixelRatio, 1.5);
let pixelRatio = Math.min(devicePixelRatio, 1.25);
renderer.setPixelRatio(pixelRatio);
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.72;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
$('view').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 14000);

// 空と太陽(晴れた日の午後、南西寄りから)
const sky = new Sky();
sky.scale.setScalar(5000);
const su = sky.material.uniforms;
su.turbidity.value = 3.2; su.rayleigh.value = 2.4; su.mieCoefficient.value = 0.004; su.mieDirectionalG.value = 0.8;
const sunDir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - 40), THREE.MathUtils.degToRad(215));
su.sunPosition.value.copy(sunDir);
scene.add(sky);
{
  const pm = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  const s2 = new Sky(); s2.scale.setScalar(1000);
  Object.assign(s2.material.uniforms.sunPosition.value, sunDir);
  for (const k of ['turbidity', 'rayleigh', 'mieCoefficient', 'mieDirectionalG']) s2.material.uniforms[k].value = su[k].value;
  envScene.add(s2);
  scene.environment = pm.fromScene(envScene, 0, 0.1, 2000).texture;
  scene.environmentIntensity = 0.55;
}
scene.fog = new THREE.FogExp2(0xb4c8dc, 0.00021);

const hemi = new THREE.HemisphereLight(0xd6e8f8, 0x6b7552, 1.1);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff1dc, 3.2);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const sc = sun.shadow.camera;
sc.left = -45; sc.right = 45; sc.top = 45; sc.bottom = -45; sc.near = 1; sc.far = 400;
sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.08;
scene.add(sun, sun.target);

// ---------- 土地(実際の地図) ----------
let world = null;

// ---------- 車 ----------
const manager = new THREE.LoadingManager();
manager.onProgress = () => {};
const loader = new GLTFLoader(manager);
loader.setMeshoptDecoder(MeshoptDecoder);

let vehicle, carRoot, instruments, steering, wheelNodes = {};
const input = new Input();
const audio = new CarAudio();
try { audio.on = localStorage.getItem('morinodrive.sound') !== 'off'; } catch {}
let camMode = 'chase';
let paused = false;
let started = false;

const prog = { map: 0, car: 0 };
function setProgress(p, text) {
  ui.bar.style.transform = `scaleX(${p})`;
  ui.status.textContent = text;
}
function showLoad() {
  const p = prog.map * 0.6 + prog.car * 0.4;
  setProgress(p * 0.97, `地図と車を読み込んでいます ${Math.round(p * 100)}%`);
}

// 車のデータは配信の都合で base64 のテキストにしてある。読み込みながら進み具合を出す
async function fetchCar(url, approxBytes) {
  // 手元のサーバーでは .glb をそのまま、配信先では base64 のテキストを読む
  const raw = await fetch('assets/car.glb').catch(() => null);
  if (raw && raw.ok && !/text|html/.test(raw.headers.get('content-type') || '')) {
    prog.car = 0.9; showLoad();
    return raw.arrayBuffer();
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || approxBytes;
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    prog.car = Math.min(1, got / total);
    showLoad();
  }
  const text = new TextDecoder().decode(await new Blob(chunks).arrayBuffer());
  const bin = atob(text.trim());
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

const mapReady = World.load('assets/map/', (p) => { prog.map = p; showLoad(); }).then((w) => {
  world = w;
  setProgress(0.97, '街を組み立てています');
  // 看板の文字を描く前に字体の読み込みを待つ(待ちすぎない)
  const fonts = Promise.race([document.fonts.load('700 36px "BIZ UDPGothic"'), new Promise((r) => setTimeout(r, 3000))]).catch(() => {});
  return fonts.then(() => new Promise((ok) => setTimeout(() => { world.build(scene, renderer); ok(); }, 30)));
});
const carReady = fetchCar('assets/car.b64.txt', 4363048).then((buf) => new Promise((ok, ng) => loader.parse(buf, '', ok, ng)));
Promise.all([carReady, mapReady]).then(([gltf]) => {
  carRoot = gltf.scene;
  carRoot.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
      const m = o.material;
      if (m && m.transparent) { o.castShadow = false; m.depthWrite = false; }
    }
  });
  scene.add(carRoot);
  const defs = [];
  for (const n of ['FL', 'FR', 'RL', 'RR']) {
    const hub = carRoot.getObjectByName('wheel_' + n);
    wheelNodes[n] = { hub, spin: carRoot.getObjectByName('spin_' + n), rest: hub.position.clone() };
    defs.push({ name: n, pos: hub.position.clone(), radius: hub.userData.radius || 0.312 });
  }
  steering = carRoot.getObjectByName('steering');
  steering.userData.axisV = new THREE.Vector3(...steering.userData.axis);
  steering.userData.q0 = steering.quaternion.clone();
  vehicle = new Vehicle(world, defs);
  // 出発はもりの里一丁目、大きな商業施設の前の広い道
  const sp = world.spawnNear(-560, -100, 3);
  vehicle.reset(sp.x, sp.z, sp.heading);
  instruments = new Instruments(carRoot, world, renderer);
  applyQuality();
  setProgress(1, '準備ができました');
  ui.start.hidden = false;
  ui.start.focus();
}).catch((err) => {
  ui.status.textContent = '地図か車のデータを読み込めませんでした。ページを再読み込みしてください。';
  console.error(err);
});

ui.start.addEventListener('click', () => {
  started = true;
  audio.start();
  ui.loader.classList.add('gone');
  setTimeout(() => (ui.loader.hidden = true), 700);
  currentPlace = null;
  ui.help.hidden = false;
  helpTimer = 14;
  setMinimap(true);
  renderer.domElement.focus();
});

// ---------- 画面上の表示 ----------
let plateTimer = 0, helpTimer = 0, currentPlace = null, placeTimer = 0;
function showPlate(name, roman) {
  ui.plateName.textContent = name;
  ui.plateRoman.textContent = roman;
  ui.plate.classList.add('on');
  plateTimer = 5;
}
input.on('camera', () => { if (started && !paused) camMode = camMode === 'chase' ? 'cockpit' : 'chase'; lookYaw = lookPitch = 0; input.mouseLook.x = input.mouseLook.y = 0; });
input.on('reset', () => {
  if (!vehicle || !started) return;
  const sp = world.spawnNear(vehicle.pos.x, vehicle.pos.z);
  vehicle.reset(sp.x, sp.z, sp.heading);
  chase.init = false;
});
function updateSoundLabel() { const b = ui.pause.querySelector('[data-act="sound"] span'); if (b) b.textContent = audio.on ? '入' : '切'; }
updateSoundLabel();

// ---------- 画質:標準 / 軽量 ----------
let quality = 'normal';
try { quality = localStorage.getItem('morinodrive.quality') || 'normal'; } catch {}
function applyQuality() {
  if (world) world.setQuality(quality);
  sun.shadow.mapSize.set(quality === 'low' ? 1024 : 2048, quality === 'low' ? 1024 : 2048);
  if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
  scene.fog.density = quality === 'low' ? 0.00045 : 0.00021;
  camera.far = quality === 'low' ? 5000 : 14000;
  const b = ui.pause.querySelector('[data-act="quality"] span');
  if (b) b.textContent = quality === 'low' ? '軽量' : '標準';
}
// 速さに合わせて画素の細かさを変える(1 秒ごとに見直す)
let frameAcc = 0, frameN = 0;
function adaptResolution(dt) {
  frameAcc += dt; frameN++;
  if (frameAcc < 1) return;
  const avg = frameAcc / frameN;
  frameAcc = 0; frameN = 0;
  let next = pixelRatio;
  if (avg > 1 / 45) next = Math.max(0.8, pixelRatio - 0.1); // これより下げると白線がにじむ
  else if (avg < 1 / 58 && pixelRatio < maxRatio) next = Math.min(maxRatio, pixelRatio + 0.05);
  if (Math.abs(next - pixelRatio) > 0.01) { pixelRatio = next; renderer.setPixelRatio(pixelRatio); }
}

// ---------- ミニマップ ----------
let mapOn = false, mapTimer = 0;
function setMinimap(on) {
  mapOn = on;
  ui.minimap.hidden = !on;
  ui.help.classList.toggle('with-map', on);
}
input.on('map', () => { if (started) setMinimap(!mapOn); });
function drawMinimap(dt) {
  mapTimer -= dt;
  if (!mapOn || mapTimer > 0) return;
  mapTimer = 1 / 15;
  const c = ui.minimapCanvas, g = c.getContext('2d');
  const W = c.width, H = c.height;
  const f = new THREE.Vector3(1, 0, 0).applyQuaternion(vehicle.quat);
  const heading = Math.atan2(f.z, f.x);
  g.fillStyle = '#eceee4'; g.fillRect(0, 0, W, H);
  const px = 1.6; // 1m = 1.6px(画面上で約 280m 四方)
  const cx = W / 2, cy = H * 0.6;
  world.drawNav(g, vehicle.pos.x, vehicle.pos.z, heading, px, W, H, cx, cy);
  // 自車
  g.save(); g.translate(cx, cy);
  g.fillStyle = '#c8352b'; g.strokeStyle = '#fff'; g.lineWidth = 3;
  g.beginPath(); g.moveTo(0, -15); g.lineTo(10, 11); g.lineTo(0, 5); g.lineTo(-10, 11); g.closePath(); g.fill(); g.stroke();
  g.restore();
  // 北
  g.save(); g.translate(W - 30, 34); g.rotate(-heading - Math.PI / 2);
  g.fillStyle = '#c8352b'; g.beginPath(); g.moveTo(0, -18); g.lineTo(7, 0); g.lineTo(-7, 0); g.closePath(); g.fill();
  g.fillStyle = '#5f676d'; g.beginPath(); g.moveTo(0, 18); g.lineTo(7, 0); g.lineTo(-7, 0); g.closePath(); g.fill();
  g.restore();
  g.fillStyle = '#1e252b'; g.font = '700 18px "BIZ UDPGothic", sans-serif'; g.textAlign = 'center'; g.fillText('N', W - 30, 72);
  // 縮尺
  g.fillStyle = '#1e252b'; g.fillRect(16, H - 18, 100 * px, 3); g.fillRect(16, H - 24, 2, 9); g.fillRect(16 + 100 * px - 2, H - 24, 2, 9);
  g.font = '500 16px "Barlow Semi Condensed", sans-serif'; g.textAlign = 'left'; g.fillText('100 m', 16, H - 30);
}

input.on('help', () => { if (started) { ui.help.hidden = !ui.help.hidden; helpTimer = ui.help.hidden ? 0 : 999; } });
input.on('pause', () => { if (started) setPaused(!paused); });
function setPaused(p) {
  paused = p;
  audio.pause(p);
  ui.pause.hidden = !p;
  if (p) ui.pause.querySelector('button').focus();
}
ui.pause.addEventListener('click', (e) => {
  const a = e.target.closest('button')?.dataset.act;
  if (!a) return;
  if (a === 'resume') setPaused(false);
  if (a === 'camera') { camMode = camMode === 'chase' ? 'cockpit' : 'chase'; setPaused(false); }
  if (a === 'reset') { input._emit('reset'); setPaused(false); }
  if (a === 'help') { ui.help.hidden = false; helpTimer = 999; setPaused(false); }
  if (a === 'map') { setMinimap(!mapOn); setPaused(false); }
  if (a === 'sound') { audio.setOn(!audio.on); try { localStorage.setItem('morinodrive.sound', audio.on ? 'on' : 'off'); } catch {} updateSoundLabel(); }
  if (a === 'quality') { quality = quality === 'low' ? 'normal' : 'low'; try { localStorage.setItem('morinodrive.quality', quality); } catch {} applyQuality(); }
});

// ---------- カメラ ----------
const chase = { pos: new THREE.Vector3(), look: new THREE.Vector3(), init: false };
let lookYaw = 0, lookPitch = 0;
const tmpV = new THREE.Vector3(), tmpV2 = new THREE.Vector3(), tmpQ = new THREE.Quaternion();
const EYE = new THREE.Vector3(-0.16, 1.43, 0.352); // 運転席の目の位置(右ハンドル、地面から 1.43m)

function updateCamera(dt) {
  const v = vehicle;
  const fwd = tmpV.set(1, 0, 0).applyQuaternion(v.quat);
  // 見回し(右スティック / マウスドラッグ)。離すと前に戻る
  const tYaw = input.look.x * 1.9 + input.mouseLook.x;
  const tPitch = input.look.y * 0.6 + input.mouseLook.y;
  if (!input.mouseLook.active) { input.mouseLook.x *= Math.exp(-dt * 2.5); input.mouseLook.y *= Math.exp(-dt * 2.5); }
  lookYaw += (tYaw - lookYaw) * Math.min(1, dt * 8);
  lookPitch += (THREE.MathUtils.clamp(tPitch, -0.6, 0.5) - lookPitch) * Math.min(1, dt * 8);

  if (camMode === 'cockpit') {
    camera.fov = 64; camera.near = 0.05;
    const eye = EYE.clone();
    eye.x -= THREE.MathUtils.clamp(v.longAcc * 0.006, -0.04, 0.04);
    eye.z -= THREE.MathUtils.clamp(v.latAcc * 0.005, -0.04, 0.04);
    carRoot.localToWorld(camera.position.copy(eye));
    tmpQ.setFromEuler(new THREE.Euler(-0.06 - lookPitch, -Math.PI / 2 - lookYaw, 0, 'YXZ'));
    camera.quaternion.copy(carRoot.quaternion).multiply(tmpQ);
  } else {
    camera.fov = 58; camera.near = 0.1;
    const flat = tmpV2.set(fwd.x, 0, fwd.z).normalize();
    const yawQ = tmpQ.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -lookYaw);
    flat.applyQuaternion(yawQ);
    const target = v.pos.clone().addScaledVector(flat, -6.2).add(new THREE.Vector3(0, 2.0 + lookPitch * 2, 0));
    const look = v.pos.clone().addScaledVector(flat, 2.5).add(new THREE.Vector3(0, 0.75, 0));
    if (!chase.init) { chase.pos.copy(target); chase.look.copy(look); chase.init = true; }
    chase.pos.lerp(target, 1 - Math.exp(-dt * 5));
    chase.look.lerp(look, 1 - Math.exp(-dt * 9));
    // 地面にもぐらない
    const gh = world.height(chase.pos.x, chase.pos.z) + 0.6;
    if (chase.pos.y < gh) chase.pos.y = gh;
    camera.position.copy(chase.pos);
    // 建物にめり込むときは、車に寄せる
    const from = v.pos, to = chase.pos;
    for (let t = 0.15; t <= 1; t += 0.05) {
      const x = from.x + (to.x - from.x) * t, z = from.z + (to.z - from.z) * t;
      if (world.isBuilding(x, z)) { camera.position.lerpVectors(from, to, Math.max(0.12, t - 0.08)); camera.position.y = Math.max(camera.position.y, from.y + 1.6); break; }
    }
    camera.lookAt(chase.look);
  }
  camera.updateProjectionMatrix();
}

// ---------- 毎フレーム ----------
const clock = new THREE.Clock();
function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  if (vehicle) {
    const inp = input.poll();
    if (!started || paused) { inp.accel = inp.brake = inp.steer = 0; inp.handbrake = false; }
    if (!paused) vehicle.update(dt, inp);
    vehicle.modelTransform(carRoot);
    for (const w of vehicle.wheels) {
      const n = wheelNodes[w.name];
      n.hub.position.y = n.rest.y + (w.travel - SPEC.staticComp);
      n.hub.rotation.y = -w.steer;
      n.spin.rotation.z = -w.spin;
    }
    steering.quaternion.setFromAxisAngle(steering.userData.axisV, vehicle.steerAngle * SPEC.steerRatio).multiply(steering.userData.q0);
    // いまいる町(住居表示板):近い町名が変わったら出す
    placeTimer -= dt;
    if (placeTimer <= 0) {
      placeTimer = 0.5;
      const pl = world.placeAt(vehicle.pos.x, vehicle.pos.z);
      const rd = world.nearestRoad(vehicle.pos.x, vehicle.pos.z, 0);
      ui.minimapPlace.textContent = [pl?.n, rd && rd.d < 10 ? rd.name : ''].filter(Boolean).join('  ');
      if (pl && pl !== currentPlace) {
        currentPlace = pl;
        if (started) showPlate(pl.n, pl.r);
      }
    }
    world.updateSignals(performance.now() / 1000);
    world.updateVisibility(camera.position);
    instruments.update(dt, vehicle, currentPlace ? currentPlace.n : '', camMode === 'cockpit');
    world.pumpNavTiles(vehicle.pos.x, vehicle.pos.z);
    drawMinimap(dt);
    if (started && !paused) audio.update(dt, vehicle, { cockpit: camMode === 'cockpit' });
    updateCamera(dt);
    const fc = window.__drive?.freeCam; // 確認用の上空カメラ
    if (fc) { camera.position.set(...fc.pos); camera.lookAt(...fc.look); camera.updateProjectionMatrix(); }
    // 影は車のまわりだけ細かく
    sun.target.position.copy(vehicle.pos);
    sun.position.copy(vehicle.pos).addScaledVector(sunDir, 200);
    // 表示
    const kmh = Math.round(vehicle.speed * 3.6);
    ui.speed.hidden = !(started && camMode === 'chase');
    ui.speedNum.textContent = kmh;
    if (plateTimer > 0) { plateTimer -= dt; if (plateTimer <= 0) ui.plate.classList.remove('on'); }
    if (helpTimer > 0 && helpTimer < 900 && vehicle.speed > 1) { helpTimer -= dt; if (helpTimer <= 0) ui.help.hidden = true; }
  } else {
    // 読み込み中はコースの上をゆっくり回る
    const t = performance.now() / 1000;
    camera.position.set(Math.cos(t * 0.05) * 900, 420, Math.sin(t * 0.05) * 900);
    camera.lookAt(0, 80, 0);
  }
  renderer.render(scene, camera);
  if (started) adaptResolution(dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

// 動作確認用(自動テストから車を動かす)
window.__drive = { get audio() { return audio; }, get scene() { return scene; }, get caps() { return { reverse: renderer.capabilities.reverseDepthBuffer, ratio: pixelRatio }; }, get info() { return { ...renderer.info.render, geometries: renderer.info.memory.geometries }; }, teleport: (x, z, w = 1) => { const sp = world.spawnNear(x, z, w); vehicle.reset(sp.x, sp.z, sp.heading); chase.init = false; return sp; }, get world() { return world; }, get vehicle() { return vehicle; }, get instruments() { return instruments; }, eye: EYE, input, setCam: (m) => (camMode = m), start: () => ui.start.click() };
