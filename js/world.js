// 実際の地図(もりの里・若松・田上・角間)
// 出典:国土地理院(標高・ベクトルタイル)、国土交通省 PLATEAU 金沢市 2024 を加工
// 物理側に返す窓口(height / normal / surface / obstacle)は試走コースと同じ形
import * as THREE from 'three';

async function fetchJSON(url) { const r = await fetch(url); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.json(); }
async function fetchPixels(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  const bmp = await createImageBitmap(await r.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0);
  return { bmp, w: bmp.width, h: bmp.height, data: g.getImageData(0, 0, bmp.width, bmp.height).data };
}
function decodeHeights(px) {
  const h = new Float32Array(px.w * px.h);
  for (let k = 0; k < h.length; k++) h[k] = (px.data[k * 4] * 65536 + px.data[k * 4 + 1] * 256 + px.data[k * 4 + 2]) * 0.01;
  return h;
}
function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export class World {
  static async load(base, progress = () => {}) {
    const steps = [
      ['meta', () => fetchJSON(base + 'meta.json')],
      ['core', () => fetchPixels(base + 'height_core.png')],
      ['far', () => fetchPixels(base + 'height_far.png')],
      ['land', () => fetchPixels(base + 'land.png')],
      ['buildings', () => fetchJSON(base + 'buildings.json')],
      ['roads', () => fetchJSON(base + 'roads.json')],
      ['lines', () => fetchJSON(base + 'lines.json')],
      ['places', () => fetchJSON(base + 'places.json')],
    ];
    const d = {};
    let n = 0;
    await Promise.all(steps.map(async ([k, f]) => { d[k] = await f(); progress(++n / steps.length); }));
    return new World(d);
  }

  constructor(d) {
    this.meta = d.meta;
    this.core = { ...d.meta.height.core, h: decodeHeights(d.core) };
    this.far = { ...d.meta.height.far, h: decodeHeights(d.far) };
    this.land = { ...d.meta.land, data: d.land.data, bmp: d.land.bmp };
    this.buildings = d.buildings;
    this.bridges = d.roads.bridges;
    this.markings = d.roads.markings;
    this.crosswalks = d.roads.crosswalks || [];
    this.stops = d.roads.stops || [];
    this.water = d.roads.water;
    this.lines = d.lines.lines;
    this.poles = d.lines.poles;
    this.signals = d.lines.signals || [];
    this.places = d.places.places;
    this.trees = d.places.trees;
    this._indexBridges();
    this._indexLines();
    this.navTiles = new Map();
  }

  // ---------- 高さ ----------
  _gridHeight(G, x, z, tri) {
    const fx = (x - G.x0) / G.spacing, fz = (z - G.z0) / G.spacing;
    const i = Math.max(0, Math.min(G.nx - 2, Math.floor(fx))), j = Math.max(0, Math.min(G.nz - 2, Math.floor(fz)));
    const u = Math.min(1, Math.max(0, fx - i)), v = Math.min(1, Math.max(0, fz - j));
    const h = G.h, k = j * G.nx + i;
    const a = h[k], b = h[k + 1], c = h[k + G.nx], e = h[k + G.nx + 1];
    if (!tri) return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + e * u * v;
    // 描画の三角形と同じ分け方
    return u + v <= 1 ? a + (b - a) * u + (c - a) * v : e + (c - e) * (1 - u) + (b - e) * (1 - v);
  }
  inCore(x, z) { const G = this.core; return x >= G.x0 && z >= G.z0 && x <= G.x0 + (G.nx - 1) * G.spacing && z <= G.z0 + (G.nz - 1) * G.spacing; }
  terrainHeight(x, z) { return this.inCore(x, z) ? this._gridHeight(this.core, x, z, true) : this._gridHeight(this.far, x, z, false); }
  height(x, z) {
    const br = this.bridgeAt(x, z);
    return br ? br.h : this.terrainHeight(x, z);
  }
  normal(x, z, out = new THREE.Vector3()) {
    const e = 0.5;
    const hx = this.height(x + e, z) - this.height(x - e, z);
    const hz = this.height(x, z + e) - this.height(x, z - e);
    return out.set(-hx, 2 * e, -hz).normalize();
  }

  // ---------- 土地の区分 ----------
  _land(x, z) {
    const L = this.land;
    const i = Math.floor(x - L.x0), j = Math.floor(z - L.z0);
    if (i < 0 || j < 0 || i >= L.w || j >= L.h) return null;
    const k = (j * L.w + i) * 4;
    return [L.data[k], L.data[k + 1], L.data[k + 2]];
  }
  surface(x, z) {
    if (this.bridgeAt(x, z)) return 'road';
    const l = this._land(x, z);
    if (!l) return 'grass';
    if (l[0] > 127) return 'road';
    if (l[1] > 90 && l[1] < 170) return 'lot'; // 歩道・路肩
    if (l[2] > 60) return 'lot';
    return 'grass';
  }
  isBuilding(x, z) { const l = this._land(x, z); return !!l && l[2] > 250; }
  // 建物の中に入った点を外へ押し出す向きと深さ
  obstacle(x, z) {
    if (!this.isBuilding(x, z)) return null;
    for (let r = 0.4; r <= 4; r += 0.4) {
      for (let a = 0; a < 16; a++) {
        const th = a / 16 * Math.PI * 2;
        const px = x + Math.cos(th) * r, pz = z + Math.sin(th) * r;
        if (!this.isBuilding(px, pz)) {
          // 境目まで詰める
          let lo = r - 0.4, hi = r;
          for (let k = 0; k < 5; k++) { const mid = (lo + hi) / 2; if (this.isBuilding(x + Math.cos(th) * mid, z + Math.sin(th) * mid)) lo = mid; else hi = mid; }
          return { x: Math.cos(th), z: Math.sin(th), depth: hi };
        }
      }
    }
    return null;
  }

  // ---------- 橋 ----------
  _indexBridges() {
    this.bridgeGrid = new Map();
    this.bridges.forEach((b, bi) => {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let i = 0; i < b.p.length; i += 2) { x0 = Math.min(x0, b.p[i]); x1 = Math.max(x1, b.p[i]); z0 = Math.min(z0, b.p[i + 1]); z1 = Math.max(z1, b.p[i + 1]); }
      for (let gx = Math.floor(x0 / 32); gx <= Math.floor(x1 / 32); gx++) for (let gz = Math.floor(z0 / 32); gz <= Math.floor(z1 / 32); gz++) {
        const k = gx * 65536 + gz;
        if (!this.bridgeGrid.has(k)) this.bridgeGrid.set(k, []);
        this.bridgeGrid.get(k).push(bi);
      }
    });
  }
  bridgeAt(x, z) {
    const list = this.bridgeGrid.get(Math.floor(x / 32) * 65536 + Math.floor(z / 32));
    if (!list) return null;
    for (const bi of list) {
      const b = this.bridges[bi], p = b.p;
      let inside = false;
      for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
        if ((p[i + 1] > z) !== (p[j + 1] > z) && x < (p[j] - p[i]) * (z - p[i + 1]) / (p[j + 1] - p[i + 1]) + p[i]) inside = !inside;
      }
      if (!inside) continue;
      return { h: this.deckHeight(b, x, z) + 0.05, b };
    }
    return null;
  }
  deckHeight(b, x, z) {
    const [ax, az, ah] = b.a, [bx, bz, bh] = b.b;
    const dx = bx - ax, dz = bz - az;
    const t = Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
    return ah + (bh - ah) * t;
  }

  // ---------- 道路の中心線(戻る位置・出発位置) ----------
  _indexLines() {
    this.lineGrid = new Map();
    this.lines.forEach((l, li) => {
      if (l.w < 1) return;
      for (let i = 0; i + 3 < l.p.length; i += 2) {
        const k = Math.floor(l.p[i] / 40) * 65536 + Math.floor(l.p[i + 1] / 40);
        if (!this.lineGrid.has(k)) this.lineGrid.set(k, []);
        this.lineGrid.get(k).push(li * 100000 + i);
      }
    });
  }
  nearestRoad(x, z, minWidth = 1) {
    let best = null;
    for (let r = 0; r <= 6 && !best; r++) {
      for (let gx = Math.floor(x / 40) - r; gx <= Math.floor(x / 40) + r; gx++) for (let gz = Math.floor(z / 40) - r; gz <= Math.floor(z / 40) + r; gz++) {
        for (const code of this.lineGrid.get(gx * 65536 + gz) || []) {
          const l = this.lines[Math.floor(code / 100000)], i = code % 100000;
          if (l.w < minWidth) continue;
          const ax = l.p[i], az = l.p[i + 1], bx = l.p[i + 2], bz = l.p[i + 3];
          const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1;
          const t = Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / L2));
          const px = ax + dx * t, pz = az + dz * t, d = Math.hypot(x - px, z - pz);
          if (!best || d < best.d) best = { d, x: px, z: pz, heading: Math.atan2(dz, dx), w: l.w, cw: l.cw || 5, oneway: !!l.o, name: l.n || '', limit: l.v || 0 };
        }
      }
    }
    return best;
  }
  // 道路の左側(左側通行)の車線の中央に置く
  spawnNear(x, z, minWidth = 1) {
    const r = this.nearestRoad(x, z, minWidth) || this.nearestRoad(x, z, 0) || { x, z, heading: 0 };
    const lx = Math.sin(r.heading), lz = -Math.cos(r.heading);
    // 左側通行:対面通行なら左半分の真ん中、一方通行なら中央
    const off = r.oneway ? 0 : (r.cw || 5) / 4;
    return { x: r.x + lx * off, z: r.z + lz * off, heading: r.heading };
  }

  // ---------- 町名 ----------
  placeAt(x, z) {
    let best = null, bd = Infinity;
    for (const p of this.places) { const d = (p.x - x) ** 2 + (p.z - z) ** 2; if (d < bd) { bd = d; best = p; } }
    return best;
  }

  // ---------- 見た目 ----------
  build(scene, renderer) {
    const aniso = renderer.capabilities.getMaxAnisotropy();
    this._buildTerrain(scene, aniso);
    this._buildBuildings(scene, aniso);
    this._buildBridges(scene);
    this._buildWater(scene);
    this._buildMarkings(scene);
    this._buildPoles(scene);
    this._buildTrees(scene);
    this._buildCrossings(scene);
    this._buildSignals(scene);
  }

  _terrainMaterial(aniso, landTex) {
    const grass = new THREE.CanvasTexture(noiseCanvas(256, [208, 216, 196], 70, 3));
    const asphalt = new THREE.CanvasTexture(noiseCanvas(256, [128, 128, 130], 60, 11));
    for (const t of [grass, asphalt]) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = aniso; t.colorSpace = THREE.SRGBColorSpace; }
    const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
    const L = this.land;
    m.onBeforeCompile = (sh) => {
      sh.uniforms.landTex = { value: landTex };
      sh.uniforms.landBox = { value: new THREE.Vector4(L.x0, L.z0, L.w, L.h) };
      sh.uniforms.grassTex = { value: grass };
      sh.uniforms.asphaltTex = { value: asphalt };
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
varying vec3 vWPos;
uniform sampler2D landTex, grassTex, asphaltTex;
uniform vec4 landBox;`)
        .replace('#include <color_fragment>', `#include <color_fragment>
{
  vec2 luv = (vWPos.xz - landBox.xy) / landBox.zw;
  vec3 land = (luv.x > 0.0 && luv.y > 0.0 && luv.x < 1.0 && luv.y < 1.0) ? texture2D(landTex, luv).rgb : vec3(0.0);
  vec3 g = diffuseColor.rgb * texture2D(grassTex, vWPos.xz * 0.21).rgb;
  vec3 asp = vec3(0.105, 0.107, 0.112) * texture2D(asphaltTex, vWPos.xz * 0.35).rgb * 1.9;
  vec3 lot = vec3(0.30, 0.29, 0.26) * mix(0.85, 1.1, texture2D(asphaltTex, vWPos.xz * 0.11).r);
  vec3 wat = vec3(0.05, 0.08, 0.08);
  vec3 c = g;
  c = mix(c, lot, smoothstep(0.08, 0.45, land.b));
  float wat_t = smoothstep(0.75, 0.95, land.g);
  // 道路の範囲(車道+歩道)をひとまとめにしてから、車道を上に塗る(境目に草が出ないように)
  float area = clamp(land.r + min(land.g, 0.5) * 2.0 * (1.0 - wat_t), 0.0, 1.0);
  vec3 walk = vec3(0.36, 0.355, 0.34) * mix(0.9, 1.08, texture2D(asphaltTex, vWPos.xz * 0.6).r);
  c = mix(c, walk, smoothstep(0.25, 0.6, area));
  c = mix(c, wat, wat_t);
  float road = smoothstep(0.38, 0.62, land.r);
  c = mix(c, asp, road);
  diffuseColor.rgb = c;
}`);
    };
    return m;
  }

  _terrainMesh(G, step, mat, sink) {
    const nx = Math.floor((G.nx - 1) / step) + 1, nz = Math.floor((G.nz - 1) / step) + 1;
    const pos = new Float32Array(nx * nz * 3), nor = new Float32Array(nx * nz * 3), col = new Float32Array(nx * nz * 3);
    const H = (i, j) => G.h[Math.min(G.nz - 1, Math.max(0, j)) * G.nx + Math.min(G.nx - 1, Math.max(0, i))];
    const c1 = new THREE.Color(0x8ea35e), c2 = new THREE.Color(0x6f8a48), c3 = new THREE.Color(0x4d6a3a), tmp = new THREE.Color();
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const gi = i * step, gj = j * step;
      const x = G.x0 + gi * G.spacing, z = G.z0 + gj * G.spacing;
      let y = H(gi, gj);
      if (sink && this.inCore(x, z) && this.inCore(x - 40, z - 40) && this.inCore(x + 40, z + 40)) y -= 8;
      const k = (j * nx + i) * 3;
      pos[k] = x; pos[k + 1] = y; pos[k + 2] = z;
      const dx = H(gi + step, gj) - H(gi - step, gj), dz = H(gi, gj + step) - H(gi, gj - step);
      const n = new THREE.Vector3(-dx, 2 * step * G.spacing, -dz).normalize();
      nor[k] = n.x; nor[k + 1] = n.y; nor[k + 2] = n.z;
      const slope = 1 - n.y;
      tmp.copy(c1).lerp(c2, Math.min(1, slope * 6)).lerp(c3, smooth(70, 160, y));
      col[k] = tmp.r; col[k + 1] = tmp.g; col[k + 2] = tmp.b;
    }
    // 512m 四方ほどの塊に分けて、見えない所を描かないようにする
    const C = Math.max(8, Math.round(512 / (G.spacing * step)));
    const group = new THREE.Group();
    for (let cj = 0; cj < nz - 1; cj += C) for (let ci = 0; ci < nx - 1; ci += C) {
      const w = Math.min(C, nx - 1 - ci), h = Math.min(C, nz - 1 - cj);
      const idx = [];
      for (let j = cj; j < cj + h; j++) for (let i = ci; i < ci + w; i++) {
        const p = j * nx + i;
        idx.push(p, p + nx, p + 1, p + 1, p + nx, p + nx + 1);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      g.setIndex(idx);
      g.boundingBox = new THREE.Box3();
      for (let j = cj; j <= cj + h; j++) for (let i = ci; i <= ci + w; i++) { const k = (j * nx + i) * 3; g.boundingBox.expandByPoint(new THREE.Vector3(pos[k], pos[k + 1], pos[k + 2])); }
      g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
      const m = new THREE.Mesh(g, mat);
      m.receiveShadow = true;
      group.add(m);
    }
    return group;
  }

  _buildTerrain(scene, aniso) {
    const landTex = new THREE.Texture(this.land.bmp);
    landTex.flipY = false;
    landTex.colorSpace = THREE.NoColorSpace;
    landTex.anisotropy = aniso;
    landTex.minFilter = THREE.LinearMipmapLinearFilter;
    landTex.needsUpdate = true;
    const mat = this._terrainMaterial(aniso, landTex);
    scene.add(this._terrainMesh(this.core, 1, mat, false));
    scene.add(this._terrainMesh(this.far, 2, mat, true));
  }

  _buildBuildings(scene, aniso) {
    const rnd = mulberry32(42);
    const houseTex = new THREE.CanvasTexture(facadeCanvas('house'));
    const blockTex = new THREE.CanvasTexture(facadeCanvas('block'));
    for (const t of [houseTex, blockTex]) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = aniso; t.colorSpace = THREE.SRGBColorSpace; }
    const mats = {
      house: new THREE.MeshStandardMaterial({ map: houseTex, vertexColors: true, roughness: 0.85 }),
      block: new THREE.MeshStandardMaterial({ map: blockTex, vertexColors: true, roughness: 0.7, metalness: 0.05 }),
      roof: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.15, side: THREE.DoubleSide }),
    };
    const HOUSE_WALL = [0xe9e4da, 0xd9d2c4, 0xc9c3b8, 0xe6dfcf, 0xb9b2a6, 0x8a7a68, 0x5e5247, 0xd8d6d0, 0xa9a49a];
    const BLOCK_WALL = { 412: [0xd8d3c8, 0xc7c2b8, 0xe2ddd2, 0xb6b4ae], 402: [0xe8e8e6, 0xcfcfcd, 0xa8aaad], 422: [0xe2dccd, 0xd5d0c4], 421: [0xd9d5cb], def: [0xcfcac0, 0xbdb9b0, 0xdedad2, 0xa9a7a1] };
    const ROOF = [0x2a2c30, 0x2a2c30, 0x3a3d42, 0x45484d, 0x7d8287, 0x5b4c40, 0x3c4a58, 0x2f3a33];
    const chunks = new Map();
    const getChunk = (x, z) => {
      const k = `${Math.floor(x / 256)},${Math.floor(z / 256)}`;
      if (!chunks.has(k)) chunks.set(k, { house: geo(), block: geo(), roof: geo() });
      return chunks.get(k);
    };
    const geo = () => ({ p: [], n: [], c: [], uv: [] });
    const tmp = new THREE.Color();
    const quad = (G, a, b, c, d, n, col, uv) => { // a b c d:反時計回り
      for (const [v, t] of [[a, uv[0]], [b, uv[1]], [c, uv[2]], [a, uv[0]], [c, uv[2]], [d, uv[3]]]) { G.p.push(...v); G.n.push(...n); G.c.push(col.r, col.g, col.b); G.uv.push(...t); }
    };
    const triangle = (G, a, b, c, n, col, uv) => { for (const [v, t] of [[a, uv[0]], [b, uv[1]], [c, uv[2]]]) { G.p.push(...v); G.n.push(...n); G.c.push(col.r, col.g, col.b); G.uv.push(...t); } };

    for (const b of this.buildings) {
      const p = b.p, n = p.length / 2;
      const ch = getChunk(p[0], p[1]);
      const isHouse = b.u === 411 || b.u === 413 || b.u === 415;
      const G = isHouse ? ch.house : ch.block;
      const wallCol = tmp.set(isHouse ? HOUSE_WALL[Math.floor(rnd() * HOUSE_WALL.length)] : (BLOCK_WALL[b.u] || BLOCK_WALL.def)[Math.floor(rnd() * (BLOCK_WALL[b.u] || BLOCK_WALL.def).length)]).clone();
      wallCol.multiplyScalar(0.92 + rnd() * 0.12);
      const g0 = b.g - 0.3;
      let top = b.g + b.h, eave = top;
      let rise = 0;
      if (b.r) { rise = (b.r[4] / 2) * Math.tan(THREE.MathUtils.degToRad(22 + rnd() * 8)); eave = Math.max(b.g + 2.6, top - rise * 0.5); top = eave + rise; }
      const texW = isHouse ? 3.0 : 3.6, floorH = isHouse ? 2.9 : 3.3;
      let run = rnd() * 3;
      for (let i = 0; i < n; i++) {
        const ax = p[i * 2], az = p[i * 2 + 1], bx = p[((i + 1) % n) * 2], bz = p[((i + 1) % n) * 2 + 1];
        const L = Math.hypot(bx - ax, bz - az);
        if (L < 0.05) continue;
        const nn = [(bz - az) / L, 0, -(bx - ax) / L];
        const u0 = run / texW, u1 = (run + L) / texW; run += L;
        const v0 = (g0 - b.g) / floorH, v1 = (eave - b.g) / floorH;
        // 外向きの面になる順(下a 上a 上b 下b を外から見て反時計回り)
        quad(G, [ax, g0, az], [ax, eave, az], [bx, eave, bz], [bx, g0, bz], nn, wallCol, [[u0, v0], [u0, v1], [u1, v1], [u1, v0]]);
      }
      const roofCol = tmp.set(b.r ? ROOF[Math.floor(rnd() * ROOF.length)] : 0x8f8e8a).clone().multiplyScalar(0.9 + rnd() * 0.2);
      if (b.r) {
        const [cx, cz, ang, L, W] = b.r;
        const ux = Math.cos(ang), uz = Math.sin(ang), vx = -uz, vz = ux;
        const o = 0.45, hl = L / 2, hw = W / 2;
        const P = (s, t, y) => [cx + ux * s + vx * t, y, cz + uz * s + vz * t];
        const drop = o * (rise / hw);
        for (const side of [-1, 1]) {
          const nrm = new THREE.Vector3(vx * side * rise, hw, vz * side * rise).normalize();
          quad(ch.roof, P(-hl - o, 0, top), P(-hl - o, side * (hw + o), eave - drop), P(hl + o, side * (hw + o), eave - drop), P(hl + o, 0, top), [nrm.x, nrm.y, nrm.z], roofCol, [[0, 0], [0, 1], [1, 1], [1, 0]]);
        }
        // 妻壁(三角の壁)
        for (const end of [-1, 1]) {
          const nrm = [ux * end, 0, uz * end];
          const a = P(end * hl, -hw * end, eave), c = P(end * hl, hw * end, eave), m = P(end * hl, 0, top);
          triangle(G, a, m, c, nrm, wallCol, [[0, (eave - b.g) / floorH], [W / 2 / texW, (top - b.g) / floorH], [W / texW, (eave - b.g) / floorH]]);
        }
        // 屋根の下のふた(軒下から壁の上が見えないように)
        const contour = []; for (let i = 0; i < n; i++) contour.push(new THREE.Vector2(p[i * 2], p[i * 2 + 1]));
        const tris = THREE.ShapeUtils.triangulateShape(contour, []);
        for (const t of tris) triangle(ch.roof, [p[t[0] * 2], eave - 0.05, p[t[0] * 2 + 1]], [p[t[2] * 2], eave - 0.05, p[t[2] * 2 + 1]], [p[t[1] * 2], eave - 0.05, p[t[1] * 2 + 1]], [0, 1, 0], roofCol, [[0, 0], [0, 0], [0, 0]]);
      } else {
        const contour = []; for (let i = 0; i < n; i++) contour.push(new THREE.Vector2(p[i * 2], p[i * 2 + 1]));
        const tris = THREE.ShapeUtils.triangulateShape(contour, []);
        for (const t of tris) triangle(ch.roof, [p[t[0] * 2], top, p[t[0] * 2 + 1]], [p[t[2] * 2], top, p[t[2] * 2 + 1]], [p[t[1] * 2], top, p[t[1] * 2 + 1]], [0, 1, 0], roofCol, [[0, 0], [0, 0], [0, 0]]);
        // 屋上の立ち上がり(パラペット)
        if (!isHouse && b.h > 6) {
          for (let i = 0; i < n; i++) {
            const ax = p[i * 2], az = p[i * 2 + 1], bx = p[((i + 1) % n) * 2], bz = p[((i + 1) % n) * 2 + 1];
            const L = Math.hypot(bx - ax, bz - az); if (L < 0.05) continue;
            quad(ch.roof, [ax, top, az], [ax, top + 0.6, az], [bx, top + 0.6, bz], [bx, top, bz], [(bz - az) / L, 0, -(bx - ax) / L], wallCol, [[0, 0], [0, 0], [0, 0], [0, 0]]);
          }
        }
      }
    }
    let tris = 0;
    for (const ch of chunks.values()) for (const [k, G] of Object.entries(ch)) {
      if (!G.p.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(G.p, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(G.n, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(G.c, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(G.uv, 2));
      g.computeBoundingSphere();
      const m = new THREE.Mesh(g, mats[k]);
      m.castShadow = true; m.receiveShadow = true;
      scene.add(m);
      tris += G.p.length / 9;
    }
    this.stats = { ...(this.stats || {}), buildingTris: Math.round(tris) };
  }

  _buildBridges(scene) {
    const P = [], N = [], C = [];
    const deck = new THREE.Color(0x3e3f42), concrete = new THREE.Color(0x9e9b94);
    const push = (v, n, c) => { P.push(...v); N.push(...n); C.push(c.r, c.g, c.b); };
    for (const b of this.bridges) {
      const p = b.p, n = p.length / 2;
      const H = (i) => this.deckHeight(b, p[i * 2], p[i * 2 + 1]);
      for (let t = 0; t < b.t.length; t += 3) {
        const [i, j, k] = [b.t[t], b.t[t + 2], b.t[t + 1]];
        for (const q of [i, j, k]) push([p[q * 2], H(q) + 0.04, p[q * 2 + 1]], [0, 1, 0], deck);
        for (const q of [i, k, j]) push([p[q * 2], H(q) - 1.0, p[q * 2 + 1]], [0, -1, 0], concrete);
      }
      const axx = b.b[0] - b.a[0], axz = b.b[1] - b.a[1], al = Math.hypot(axx, axz);
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ax = p[i * 2], az = p[i * 2 + 1], bx = p[j * 2], bz = p[j * 2 + 1];
        const L = Math.hypot(bx - ax, bz - az); if (L < 0.1) continue;
        const nn = [(bz - az) / L, 0, -(bx - ax) / L];
        const ha = H(i), hb = H(j);
        const along = Math.abs(((bx - ax) * axx + (bz - az) * axz) / (L * al)) > 0.85;
        const t1 = along ? 1.0 : 0.04; // 橋の長い方の縁には高欄
        for (const v of [[ax, ha - 1.0, az], [bx, hb + t1, bz], [bx, hb - 1.0, bz], [ax, ha - 1.0, az], [ax, ha + t1, az], [bx, hb + t1, bz]]) push(v, nn, concrete);
        if (along) for (const v of [[ax, ha + t1, az], [bx, hb + 0.04, bz], [bx, hb + t1, bz], [ax, ha + t1, az], [ax, ha + 0.04, az], [bx, hb + 0.04, bz]]) push(v, nn.map((x) => -x), concrete);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, side: THREE.DoubleSide }));
    m.castShadow = m.receiveShadow = true;
    scene.add(m);
  }

  _buildWater(scene) {
    const P = [];
    for (const w of this.water) {
      for (let t = 0; t < w.i.length; t += 3) for (const q of [w.i[t], w.i[t + 2], w.i[t + 1]]) {
        const x = w.v[q * 2], z = w.v[q * 2 + 1];
        P.push(x, this.terrainHeight(x, z) + 0.12, z);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(P.length).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, color: 0x35505a, roughness: 0.08, metalness: 0.2, envMapIntensity: 1.2, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    m.receiveShadow = true;
    scene.add(m);
  }

  _buildMarkings(scene) {
    const P = [], C = [];
    const white = new THREE.Color(0xe9e9e4), yellow = new THREE.Color(0xe0a92a);
    const W = 0.15;
    for (const mk of this.markings) {
      const col = mk.s === 'yellow' ? yellow : white;
      const p = mk.p;
      let dist = 0;
      for (let i = 0; i + 3 < p.length; i += 2) {
        const ax = p[i], az = p[i + 1], bx = p[i + 2], bz = p[i + 3];
        const L = Math.hypot(bx - ax, bz - az); if (L < 0.01) continue;
        const nx = -(bz - az) / L * W / 2, nz = (bx - ax) / L * W / 2;
        // 破線:5m 引いて 5m あける
        const on = (mk.s !== 'dash' && mk.s !== 'lane') || (Math.floor(dist / 5) % 2 === 0);
        dist += L;
        if (!on) continue;
        const ha = this.height(ax, az) + 0.03, hb = this.height(bx, bz) + 0.03;
        for (const v of [[ax - nx, ha, az - nz], [bx + nx, hb, bz + nz], [bx - nx, hb, bz - nz], [ax - nx, ha, az - nz], [ax + nx, ha, az + nz], [bx + nx, hb, bz + nz]]) { P.push(...v); C.push(col.r, col.g, col.b); }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(P.length).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, vertexColors: true, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8 }));
    m.receiveShadow = true;
    scene.add(m);
  }

  _buildPoles(scene) {
    const n = this.poles.length / 3;
    const pole = new THREE.CylinderGeometry(0.13, 0.19, 11, 8).translate(0, 5.5, 0);
    const arm = new THREE.BoxGeometry(0.1, 0.1, 1.6).translate(0, 10.1, 0);
    const poles = new THREE.InstancedMesh(pole, new THREE.MeshStandardMaterial({ color: 0x9b9890, roughness: 0.85 }), n);
    const arms = new THREE.InstancedMesh(arm, new THREE.MeshStandardMaterial({ color: 0x55534d, roughness: 0.6, metalness: 0.3 }), n);
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3(1, 1, 1), V = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < n; i++) {
      const x = this.poles[i * 3], z = this.poles[i * 3 + 1], a = this.poles[i * 3 + 2] / 255 * Math.PI * 2 - Math.PI;
      Q.setFromAxisAngle(Y, -a);
      M.compose(V.set(x, this.terrainHeight(x, z) - 0.3, z), Q, S);
      poles.setMatrixAt(i, M); arms.setMatrixAt(i, M);
    }
    poles.castShadow = arms.castShadow = true;
    scene.add(poles, arms);
  }

  _buildTrees(scene) {
    const t = this.trees, n = t.length / 3;
    const cedar = new THREE.ConeGeometry(2.4, 9, 6, 1, true).translate(0, 7.5, 0);
    const trunk = new THREE.CylinderGeometry(0.18, 0.28, 3.4, 4, 1, true).translate(0, 1.7, 0);
    const broad = new THREE.IcosahedronGeometry(3.6, 0).scale(1, 0.85, 1).translate(0, 5.2, 0);
    let nc = 0, nb = 0;
    for (let i = 0; i < n; i++) (t[i * 3 + 2] % 5 < 3 ? nc++ : nb++);
    const mk = (g, c, count) => new THREE.InstancedMesh(g, new THREE.MeshStandardMaterial({ color: c, roughness: 1, flatShading: true }), count);
    const ced = mk(cedar, 0x2e4a2c, nc), brd = mk(broad, 0x4f6b37, nb), trk = mk(trunk, 0x4a3b2c, n);
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3(), V = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0);
    const col = new THREE.Color();
    let ic = 0, ib = 0;
    for (let i = 0; i < n; i++) {
      const x = t[i * 3], z = t[i * 3 + 1], s = t[i * 3 + 2];
      const sc = 0.75 + (s % 97) / 97 * 0.7;
      Q.setFromAxisAngle(Y, s * 0.37);
      M.compose(V.set(x, this.terrainHeight(x, z) - 0.2, z), Q, S.set(sc, sc * (0.9 + (s % 13) / 30), sc));
      trk.setMatrixAt(i, M);
      if (s % 5 < 3) { ced.setMatrixAt(ic, M); ced.setColorAt(ic++, col.setHSL(0.30 + (s % 7) / 120, 0.32, 0.17 + (s % 11) / 160)); }
      else { brd.setMatrixAt(ib, M); brd.setColorAt(ib++, col.setHSL(0.23 + (s % 9) / 90, 0.35, 0.25 + (s % 11) / 120)); }
    }
    scene.add(ced, brd, trk);
  }

  // ---------- 横断歩道と停止線 ----------
  _buildCrossings(scene) {
    const P = [];
    const rect = (cx, cz, ang, along, across) => {
      const fx = Math.cos(ang), fz = Math.sin(ang), lx = -fz, lz = fx;
      const c = [[-along, -across], [along, -across], [along, across], [-along, across]].map(([a, b]) => {
        const x = cx + fx * a + lx * b, z = cz + fz * a + lz * b;
        return [x, this.height(x, z) + 0.035, z];
      });
      P.push(...c[0], ...c[2], ...c[1], ...c[0], ...c[3], ...c[2]);
    };
    for (const [x, z, ang, w] of this.crosswalks) {
      // 道路と平行な白い帯(幅 45cm、間 45cm)を、車道の端から端まで
      const n = Math.max(2, Math.floor((w - 0.6) / 0.9));
      const lx = -Math.sin(ang), lz = Math.cos(ang);
      for (let k = 0; k < n; k++) {
        const t = -((n - 1) * 0.9) / 2 + k * 0.9;
        rect(x + lx * t, z + lz * t, ang, 2.0, 0.225);
      }
    }
    for (const [x, z, ang, len] of this.stops) rect(x, z, ang, 0.225, len / 2);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(P.length).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0xe6e6e1, roughness: 0.7, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8 }));
    m.receiveShadow = true;
    scene.add(m);
  }

  // ---------- 信号機:交差点ごとに 2 方向を交互に(青 26 秒・黄 3 秒・全赤 2 秒) ----------
  _buildSignals(scene) {
    const n = this.signals.length;
    if (!n) return;
    const metal = new THREE.MeshStandardMaterial({ color: 0x8e9196, roughness: 0.5, metalness: 0.4 });
    const poleG = new THREE.CylinderGeometry(0.11, 0.13, 5.6, 8).translate(0, 2.8, 0);
    const poles = new THREE.InstancedMesh(poleG, metal, n);
    const arms = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.06, 0.06, 1, 6).rotateZ(Math.PI / 2).translate(0.5, 0, 0), metal, n);
    // 灯器:横長、左から青・黄・赤(日本の配置)
    const heads = new THREE.InstancedMesh(new THREE.BoxGeometry(0.32, 0.42, 1.28), new THREE.MeshStandardMaterial({ color: 0x5d6168, roughness: 0.6, metalness: 0.3 }), n);
    const lamps = new THREE.InstancedMesh(new THREE.CircleGeometry(0.15, 16).rotateY(-Math.PI / 2), new THREE.MeshBasicMaterial({ toneMapped: false }), n * 3);
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3(1, 1, 1), V = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0);
    this.signalState = [];
    for (let i = 0; i < n; i++) {
      const [px, pz, hx, hz, ang, phase, group] = this.signals[i];
      const gy = this.terrainHeight(px, pz);
      // 柱(向きは関係ないので回さない)
      M.compose(V.set(px, gy - 0.1, pz), Q.identity(), S.set(1, 1, 1)); poles.setMatrixAt(i, M);
      // 腕:柱の上から灯器へ
      const dx = hx - px, dz = hz - pz, L = Math.max(0.5, Math.hypot(dx, dz));
      Q.setFromAxisAngle(Y, -Math.atan2(dz, dx));
      M.compose(V.set(px, gy + 5.35, pz), Q, S.set(L, 1, 1)); arms.setMatrixAt(i, M);
      // 灯器:来る車の方を向く(進む向き ang の逆)
      Q.setFromAxisAngle(Y, -ang);
      M.compose(V.set(hx, gy + 5.35, hz), Q, S.set(1, 1, 1)); heads.setMatrixAt(i, M);
      // 灯の位置:灯器の座標で、車の来る側(-x)の面に、運転する人から見て左から 青・黄・赤
      const Mh = M.clone(), T = new THREE.Matrix4();
      for (let k = 0; k < 3; k++) {
        T.makeTranslation(-0.17, 0, (k - 1) * 0.4);
        lamps.setMatrixAt(i * 3 + k, Mh.clone().multiply(T));
      }
      this.signalState.push({ phase, group });
    }
    for (const im of [poles, arms, heads]) im.castShadow = true;
    scene.add(poles, arms, heads, lamps);
    this.lamps = lamps;
    this._signalT = -1;
    this.updateSignals(0);
  }
  updateSignals(t) {
    if (!this.lamps) return;
    const step = Math.floor(t * 2);
    if (step === this._signalT) return;
    this._signalT = step;
    const C = [new THREE.Color(0x14cfa6), new THREE.Color(0xffb21a), new THREE.Color(0xff2a1a)];
    const off = new THREE.Color(0x1d2226);
    const cyc = 62;
    this.signalState.forEach((s, i) => {
      const tt = (t + s.group * 17.3) % cyc;
      // 0-26 方向0 青、26-29 黄、29-31 全赤、31-57 方向1 青、57-60 黄、60-62 全赤
      const local = s.phase === 0 ? tt : (tt + 31) % cyc;
      const lit = local < 26 ? 0 : local < 29 ? 1 : 2;
      for (let k = 0; k < 3; k++) this.lamps.setColorAt(i * 3 + k, k === lit ? C[k] : off);
    });
    this.lamps.instanceColor.needsUpdate = true;
  }

  // ---------- カーナビの地図(256m 四方のタイルを描いてためておく) ----------
  navTile(tx, tz) {
    const key = `${tx},${tz}`;
    if (this.navTiles.has(key)) return this.navTiles.get(key);
    const S = 2, N = 256 * S;
    const c = document.createElement('canvas'); c.width = c.height = N;
    const g = c.getContext('2d');
    const img = g.createImageData(N, N);
    const L = this.land;
    const sample = (x, z, ch) => {
      const fx = x - L.x0 - 0.5, fz = z - L.z0 - 0.5;
      const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j;
      const at = (a, b) => (a < 0 || b < 0 || a >= L.w || b >= L.h) ? 0 : L.data[(b * L.w + a) * 4 + ch];
      return (at(i, j) * (1 - u) + at(i + 1, j) * u) * (1 - v) + (at(i, j + 1) * (1 - u) + at(i + 1, j + 1) * u) * v;
    };
    for (let py = 0; py < N; py++) for (let px = 0; px < N; px++) {
      const x = tx * 256 + (px + 0.5) / S, z = tz * 256 + (py + 0.5) / S;
      let r = 236, gg = 238, b = 228;
      const bl = sample(x, z, 2), wa = sample(x, z, 1), ro = sample(x, z, 0);
      const blt = smooth(225, 250, bl);
      r += (214 - r) * blt; gg += (206 - gg) * blt; b += (190 - b) * blt;
      const sw = smooth(90, 115, wa) * (1 - smooth(180, 230, wa));
      r += (244 - r) * sw; gg += (243 - gg) * sw; b += (236 - b) * sw;
      const wt = smooth(190, 240, wa);
      r += (164 - r) * wt; gg += (196 - gg) * wt; b += (222 - b) * wt;
      const rt = smooth(100, 160, ro);
      r += (252 - r) * rt; gg += (251 - gg) * rt; b += (246 - b) * rt;
      const k = (py * N + px) * 4;
      img.data[k] = r; img.data[k + 1] = gg; img.data[k + 2] = b; img.data[k + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    if (this.navTiles.size > 60) this.navTiles.delete(this.navTiles.keys().next().value);
    this.navTiles.set(key, c);
    return c;
  }
  drawNav(g, cx, cz, heading, pxPerM, W, H, ox, oy) {
    g.save();
    g.translate(ox, oy);
    g.rotate(-heading - Math.PI / 2);
    const R = Math.hypot(W, H) / pxPerM;
    g.imageSmoothingEnabled = true;
    for (let tz = Math.floor((cz - R) / 256); tz <= Math.floor((cz + R) / 256); tz++) for (let tx = Math.floor((cx - R) / 256); tx <= Math.floor((cx + R) / 256); tx++) {
      g.drawImage(this.navTile(tx, tz), (tx * 256 - cx) * pxPerM, (tz * 256 - cz) * pxPerM, 256 * pxPerM + 0.5, 256 * pxPerM + 0.5);
    }
    g.restore();
  }
}

// ---------- 素材の絵 ----------
function noiseCanvas(N, base, spread, seed) {
  const c = document.createElement('canvas'); c.width = c.height = N;
  const g = c.getContext('2d');
  g.fillStyle = `rgb(${base.join(',')})`; g.fillRect(0, 0, N, N);
  const rnd = mulberry32(seed);
  for (let i = 0; i < N * N * 0.35; i++) {
    const l = (rnd() - 0.5) * spread;
    g.fillStyle = `rgba(${base[0] + l | 0},${base[1] + l | 0},${base[2] + l | 0},${0.3 + rnd() * 0.4})`;
    g.fillRect(rnd() * N, rnd() * N, 1 + rnd() * 2, 1 + rnd() * 2);
  }
  return c;
}
// 壁の模様:1枚 = 横 3〜3.6m × 1階分
function facadeCanvas(kind) {
  const W = 256, H = 256;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#f2f2f0'; g.fillRect(0, 0, W, H);
  const rnd = mulberry32(kind === 'house' ? 5 : 9);
  for (let i = 0; i < 4000; i++) { g.fillStyle = `rgba(0,0,0,${rnd() * 0.04})`; g.fillRect(rnd() * W, rnd() * H, 2, 2); }
  if (kind === 'house') {
    // サイディングの目地
    g.fillStyle = 'rgba(0,0,0,0.06)';
    for (let y = 0; y < H; y += 16) g.fillRect(0, y, W, 2);
    // 窓(引き違い)
    g.fillStyle = '#5f6a70'; g.fillRect(60, 70, 120, 110);
    g.fillStyle = '#2f3a42'; g.fillRect(66, 76, 52, 98); g.fillRect(122, 76, 52, 98);
    g.fillStyle = 'rgba(200,215,225,0.25)'; g.fillRect(66, 76, 20, 98);
    g.fillStyle = '#d8d8d4'; g.fillRect(54, 180, 132, 8);
  } else {
    // コンクリートの建物:横長の窓の帯
    g.fillStyle = '#3a454d'; g.fillRect(14, 60, 228, 120);
    g.fillStyle = '#6d7a83';
    for (let x = 14; x < 242; x += 57) g.fillRect(x, 60, 5, 120);
    g.fillStyle = 'rgba(210,225,235,0.18)'; g.fillRect(20, 64, 40, 112);
    g.fillStyle = '#d0cfcb'; g.fillRect(0, 200, W, 14);
  }
  return c;
}
