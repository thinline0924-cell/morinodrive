// 試走コース:実際の地図データが入るまでの仮の土地。
// 地形の高さ・路面の種類を物理側に返す窓口(height / normal / surface)は、
// 本番の地図に差し替えても同じ形のまま使う。
import * as THREE from 'three';

const ROAD_W = 7.0; // 片側1車線ずつの2車線道路(車線3.0m+路肩0.5m)
const SHOULDER = ROAD_W / 2;
const BLEND = 9; // 道路の脇で地形をなじませる幅

// 道路の中心線(閉じた周回路)。x=東, z=南(北が -z)
const CONTROL = [
  [-210, 150], [-40, 175], [120, 150], [228, 60], [236, -70], [150, -175],
  [20, -168], [-50, -80], [-150, -110], [-262, -30], [-282, 80],
];

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// 道路の影響を受ける前の地形
function rawHeight(x, z) {
  const hill = 17 * Math.exp(-((x - 150) ** 2 + (z + 60) ** 2) / (2 * 85 ** 2));
  const roll = 1.3 * Math.sin(x * 0.013) * Math.cos(z * 0.011) + 0.5 * Math.sin(x * 0.031 + z * 0.027);
  const r = Math.hypot(x, z);
  const th = Math.atan2(z, x);
  const n = 0.55 + 0.22 * Math.sin(3 * th + 1.3) + 0.14 * Math.sin(7 * th + 0.4) + 0.08 * Math.sin(17 * th + 2.1)
    + 0.05 * Math.sin(31 * th + r * 0.004);
  // 東側(+x)を高く:医王山・戸室山の方角を意識した遠景
  const east = 0.75 + 0.35 * Math.max(0, Math.cos(th));
  const ridge = Math.pow(smoothstep(720, 1500, r), 1.4) * 300 * n * east;
  return hill + roll + ridge;
}

export class Course {
  constructor() {
    const pts = CONTROL.map(([x, z]) => new THREE.Vector3(x, 0, z));
    this.curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal');
    this.length = this.curve.getLength();
    const n = Math.round(this.length / 2);
    this.samples = this.curve.getSpacedPoints(n).slice(0, n); // 2m おき
    // 道路の中心の高さ:地形を少しならしてから使う
    const raw = this.samples.map((p) => rawHeight(p.x, p.z));
    const sm = raw.map((_, i) => {
      let s = 0, w = 0;
      for (let k = -6; k <= 6; k++) { const ww = 7 - Math.abs(k); s += raw[(i + k + n) % n] * ww; w += ww; }
      return s / w;
    });
    this.samples.forEach((p, i) => (p.y = sm[i]));
    this._buildGrid();
  }

  // 線分ごとの空間ハッシュ(16m 格子)
  _buildGrid() {
    this.cell = 16;
    this.grid = new Map();
    const reach = SHOULDER + BLEND + 2;
    const s = this.samples;
    for (let i = 0; i < s.length; i++) {
      const a = s[i], b = s[(i + 1) % s.length];
      const x0 = Math.floor((Math.min(a.x, b.x) - reach) / this.cell), x1 = Math.floor((Math.max(a.x, b.x) + reach) / this.cell);
      const z0 = Math.floor((Math.min(a.z, b.z) - reach) / this.cell), z1 = Math.floor((Math.max(a.z, b.z) + reach) / this.cell);
      for (let gx = x0; gx <= x1; gx++) for (let gz = z0; gz <= z1; gz++) {
        const k = gx * 100003 + gz;
        if (!this.grid.has(k)) this.grid.set(k, []);
        this.grid.get(k).push(i);
      }
    }
  }

  // 最寄りの道路:距離・中心の高さ・進行方向
  nearestRoad(x, z) {
    const list = this.grid.get(Math.floor(x / this.cell) * 100003 + Math.floor(z / this.cell));
    if (!list) return null;
    const s = this.samples;
    let best = null;
    for (const i of list) {
      const a = s[i], b = s[(i + 1) % s.length];
      const dx = b.x - a.x, dz = b.z - a.z;
      const L2 = dx * dx + dz * dz;
      const t = Math.min(1, Math.max(0, ((x - a.x) * dx + (z - a.z) * dz) / L2));
      const px = a.x + dx * t, pz = a.z + dz * t;
      const d = Math.hypot(x - px, z - pz);
      if (!best || d < best.d) best = { d, h: a.y + (b.y - a.y) * t, i, t, dir: Math.atan2(dz, dx), side: (x - px) * -dz + (z - pz) * dx };
    }
    return best;
  }

  height(x, z) {
    const raw = rawHeight(x, z);
    const q = this.nearestRoad(x, z);
    if (!q) return raw;
    const t = smoothstep(SHOULDER + 0.4, SHOULDER + BLEND, q.d);
    return q.h + (raw - q.h) * t;
  }

  normal(x, z, out = new THREE.Vector3()) {
    const e = 0.4;
    const hx = this.height(x + e, z) - this.height(x - e, z);
    const hz = this.height(x, z + e) - this.height(x, z - e);
    return out.set(-hx, 2 * e, -hz).normalize();
  }

  // 路面:'road' | 'grass'
  surface(x, z) {
    const q = this.nearestRoad(x, z);
    return q && q.d < SHOULDER + 0.15 ? 'road' : 'grass';
  }

  // スタート位置(または指定位置の最寄りの道路上)
  spawnNear(x, z) {
    let bi = 0, bd = Infinity;
    this.samples.forEach((p, i) => { const d = (p.x - x) ** 2 + (p.z - z) ** 2; if (d < bd) { bd = d; bi = i; } });
    const a = this.samples[bi], b = this.samples[(bi + 2) % this.samples.length];
    const heading = Math.atan2(b.z - a.z, b.x - a.x);
    // 左側通行:進行方向の左車線の中央(中心線から 1.6m)
    const lx = Math.sin(heading) * 1.6, lz = -Math.cos(heading) * 1.6;
    return { x: a.x + lx, z: a.z + lz, heading };
  }

  // ---------- 見た目 ----------
  build(scene, renderer) {
    const aniso = renderer.capabilities.getMaxAnisotropy();
    this._buildTerrain(scene, aniso);
    this._buildRoad(scene, aniso);
    this._buildProps(scene);
  }

  _buildTerrain(scene, aniso) {
    const N = 320, R = 1800, a = 0.356;
    const f = (u) => Math.sign(u) * R * (a * Math.abs(u) + (1 - a) * Math.abs(u) ** 3);
    const pos = new Float32Array((N + 1) * (N + 1) * 3);
    const uv = new Float32Array((N + 1) * (N + 1) * 2);
    const col = new Float32Array((N + 1) * (N + 1) * 3);
    const c1 = new THREE.Color(0x8fae5e), c2 = new THREE.Color(0x7a9a4e), c3 = new THREE.Color(0x58774a), tmp = new THREE.Color();
    let k = 0;
    for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
      const x = f(i / N * 2 - 1), z = f(j / N * 2 - 1);
      const y = this.height(x, z);
      pos.set([x, y, z], k * 3);
      uv.set([x / 9, z / 9], k * 2);
      const r = Math.hypot(x, z);
      // 山は杉林の濃い緑、平地は草地
      tmp.copy(c1).lerp(c2, 0.5 + 0.5 * Math.sin(x * 0.02 + Math.cos(z * 0.017) * 2)).lerp(c3, smoothstep(650, 1100, r));
      col.set([tmp.r, tmp.g, tmp.b], k * 3);
      k++;
    }
    const idx = [];
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const p = j * (N + 1) + i;
      idx.push(p, p + N + 1, p + 1, p + 1, p + N + 1, p + N + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const tex = new THREE.CanvasTexture(grassCanvas());
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = aniso;
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: tex, vertexColors: true, roughness: 0.95 }));
    m.receiveShadow = true;
    scene.add(m);
  }

  _buildRoad(scene, aniso) {
    const s = this.samples, n = s.length;
    const across = [-SHOULDER, -SHOULDER / 2, 0, SHOULDER / 2, SHOULDER];
    const pos = [], uv = [], idx = [];
    let v = 0;
    for (let i = 0; i <= n; i++) {
      const p = s[i % n], q = s[(i + 1) % n], o = s[(i - 1 + n) % n];
      const dx = q.x - o.x, dz = q.z - o.z, l = Math.hypot(dx, dz);
      const nx = -dz / l, nz = dx / l; // 進行方向の右
      for (let k = 0; k < across.length; k++) {
        pos.push(p.x + nx * across[k], p.y + 0.02, p.z + nz * across[k]);
        uv.push(k / (across.length - 1), (i * 2) / 20); // 20m で1周期
      }
      if (i < n) for (let k = 0; k < across.length - 1; k++) {
        const a = v + k, b = v + k + across.length;
        idx.push(a, a + 1, b, a + 1, b + 1, b);
      }
      v += across.length;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    const tex = new THREE.CanvasTexture(roadCanvas());
    tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = aniso;
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.88, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
    const m = new THREE.Mesh(g, mat);
    m.receiveShadow = true;
    scene.add(m);
  }

  _buildProps(scene) {
    // 電柱(コンクリート柱)を道路の左側に 35m おき
    const s = this.samples, n = s.length;
    const pole = new THREE.CylinderGeometry(0.13, 0.19, 11, 10).translate(0, 5.5, 0);
    const arm = new THREE.BoxGeometry(1.6, 0.1, 0.1).translate(0, 10.2, 0);
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x9c9a92, roughness: 0.8 });
    const armMat = new THREE.MeshStandardMaterial({ color: 0x55534d, roughness: 0.6, metalness: 0.3 });
    const step = 18; // 2m × 18 = 36m
    const count = Math.floor(n / step);
    const poles = new THREE.InstancedMesh(pole, poleMat, count);
    const arms = new THREE.InstancedMesh(arm, armMat, count);
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), P = new THREE.Vector3(), S = new THREE.Vector3(1, 1, 1);
    for (let c = 0; c < count; c++) {
      const i = c * step, p = s[i], q = s[(i + 1) % n];
      const h = Math.atan2(q.z - p.z, q.x - p.x);
      const lx = Math.sin(h), lz = -Math.cos(h); // 進行方向の左
      const x = p.x + lx * (SHOULDER + 1.1), z = p.z + lz * (SHOULDER + 1.1);
      P.set(x, this.height(x, z) - 0.2, z);
      Q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -h);
      M.compose(P, Q, S);
      poles.setMatrixAt(c, M); arms.setMatrixAt(c, M);
    }
    poles.castShadow = arms.castShadow = true;
    scene.add(poles, arms);

    // 木:道路から離れた草地に散らす
    const rnd = mulberry32(7);
    const trunk = new THREE.CylinderGeometry(0.12, 0.18, 2.2, 6).translate(0, 1.1, 0);
    const crown = new THREE.ConeGeometry(1.6, 5.5, 8).translate(0, 4.6, 0);
    const T = 900;
    const trunks = new THREE.InstancedMesh(trunk, new THREE.MeshStandardMaterial({ color: 0x4a3b2c, roughness: 1 }), T);
    const crowns = new THREE.InstancedMesh(crown, new THREE.MeshStandardMaterial({ color: 0x3f6232, roughness: 1 }), T);
    let placed = 0, guard = 0;
    while (placed < T && guard++ < 20000) {
      const r = 60 + rnd() * 620, th = rnd() * Math.PI * 2;
      const x = Math.cos(th) * r, z = Math.sin(th) * r;
      const q = this.nearestRoad(x, z);
      if (q && q.d < 14) continue;
      // 林のかたまりにする
      if (Math.sin(x * 0.021) * Math.cos(z * 0.018) + rnd() * 0.6 < 0.35) continue;
      const sc = 0.7 + rnd() * 0.8;
      P.set(x, this.height(x, z) - 0.1, z);
      Q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * 6.28);
      M.compose(P, Q, S.set(sc, sc * (0.9 + rnd() * 0.4), sc));
      trunks.setMatrixAt(placed, M); crowns.setMatrixAt(placed, M);
      placed++;
    }
    trunks.count = crowns.count = placed;
    crowns.castShadow = true;
    scene.add(trunks, crowns);
  }

  // 案内画面の地図用:道路の中心線
  polyline() { return this.samples; }
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function grassCanvas() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#dfe4d6';
  g.fillRect(0, 0, 256, 256);
  const rnd = mulberry32(3);
  for (let i = 0; i < 9000; i++) {
    const l = 170 + rnd() * 85;
    g.fillStyle = `rgba(${l * 0.86 | 0},${l | 0},${l * 0.72 | 0},${0.25 + rnd() * 0.35})`;
    g.fillRect(rnd() * 256, rnd() * 256, 1 + rnd() * 2, 1 + rnd() * 3);
  }
  return c;
}

// 7m 幅 × 20m 長さ分の路面。外側線(白実線)と中央線(白破線 5m/5m)
function roadCanvas() {
  const W = 256, H = 732; // 1m ≒ 36.6px
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#5b5c5e';
  g.fillRect(0, 0, W, H);
  const rnd = mulberry32(11);
  for (let i = 0; i < 26000; i++) {
    const l = 60 + rnd() * 90;
    g.fillStyle = `rgba(${l},${l},${l + 2},${0.18 + rnd() * 0.25})`;
    g.fillRect(rnd() * W, rnd() * H, 1 + rnd() * 1.5, 1 + rnd() * 1.5);
  }
  // わだち(車線中央のタイヤ跡)をうっすら
  g.fillStyle = 'rgba(40,40,44,0.10)';
  for (const m of [1.0, 2.6, 4.4, 6.0]) g.fillRect((m / 7) * W - 10, 0, 20, H);
  const px = W / 7;
  g.fillStyle = 'rgba(236,236,230,0.92)';
  g.fillRect(0.30 * px, 0, 0.15 * px, H);
  g.fillRect(W - 0.45 * px, 0, 0.15 * px, H);
  g.fillRect(W / 2 - 0.075 * px, 0, 0.15 * px, H / 4); // 5m 描いて 5m あける
  g.fillRect(W / 2 - 0.075 * px, H / 2, 0.15 * px, H / 4);
  // 白線のかすれ
  g.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 2500; i++) { g.fillStyle = `rgba(0,0,0,${rnd() * 0.5})`; g.fillRect(rnd() * W, rnd() * H, 2, 2); }
  g.globalCompositeOperation = 'destination-over';
  g.fillStyle = '#5b5c5e'; g.fillRect(0, 0, W, H);
  return c;
}
