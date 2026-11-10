// 実際の地図(もりの里・若松・田上・角間)
// 出典:国土地理院(標高・ベクトルタイル)、国土交通省 PLATEAU 金沢市 2024 を加工
// 物理側に返す窓口(height / normal / surface / obstacle)は試走コースと同じ形
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

async function fetchJSON(url) { const r = await fetch(url); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.json(); }
async function fetchBitmap(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return createImageBitmap(await r.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
}
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
      ['luse', () => fetchPixels(base + 'landuse.png')],
      ['photoCore', () => fetchBitmap(base + 'photo_core.jpg').catch(() => null)],
      ['photoFar', () => fetchBitmap(base + 'photo_far.jpg').catch(() => null)],
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
    this.luse = { ...d.meta.landuse, bmp: d.luse.bmp, data: d.luse.data };
    this.photo = d.meta.photo && d.photoCore ? { box: d.meta.photo, core: d.photoCore, far: d.photoFar } : null;
    this.buildings = d.buildings;
    this.bridges = d.roads.bridges;
    this.markings = d.roads.markings;
    this.crosswalks = d.roads.crosswalks || [];
    this.stops = d.roads.stops || [];
    this.water = d.roads.water;
    this.lines = d.lines.lines;
    this.poles = d.lines.poles;
    this.signals = d.lines.signals || [];
    this.wires = d.lines.wires || [];
    this.guards = d.lines.guards || [];
    this.speedSigns = d.lines.speedSigns || [];
    this.curbs = d.roads.curbs || [];
    this.medians = d.roads.medians || [];
    this.streetTrees = d.roads.streetTrees || [];
    this.walls = d.roads.walls || [];
    // ぶつかる物(電柱・信号の柱・街路樹・分離帯の植え込み)
    this.solids = new Map();
    for (let i = 0; i < this.poles.length; i += 3) this._addSolid({ x: this.poles[i], z: this.poles[i + 1], r: 0.22 });
    for (const sg of this.signals) this._addSolid({ x: sg[0], z: sg[1], r: 0.18 });
    for (const g of this.guards) for (let i = 0; i + 3 < g.length; i += 2) this._addSolid({ x: g[i], z: g[i + 1], bx: g[i + 2], bz: g[i + 3], r: 0.15 });
    for (const ss of this.speedSigns) this._addSolid({ x: ss[0], z: ss[1], r: 0.1 });
    for (const w of this.walls) for (let i = 0; i + 3 < w.p.length; i += 2) this._addSolid({ x: w.p[i], z: w.p[i + 1], bx: w.p[i + 2], bz: w.p[i + 3], r: w.t === 1 ? 0.35 : 0.12 });
    for (let i = 0; i < this.streetTrees.length; i += 2) this._addSolid({ x: this.streetTrees[i], z: this.streetTrees[i + 1], r: 0.3 });
    for (const m of this.medians) for (let i = 0; i + 3 < m.p.length; i += 2) {
      const w = Math.min(m.w[i / 2], m.w[i / 2 + 1]);
      this._addSolid({ x: m.p[i], z: m.p[i + 1], bx: m.p[i + 2], bz: m.p[i + 3], r: Math.max(0.3, w / 2 - 0.25) });
    }
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
  _addSolid(o) {
    const x0 = Math.min(o.x, o.bx ?? o.x) - o.r, x1 = Math.max(o.x, o.bx ?? o.x) + o.r;
    const z0 = Math.min(o.z, o.bz ?? o.z) - o.r, z1 = Math.max(o.z, o.bz ?? o.z) + o.r;
    for (let gx = Math.floor(x0 / 16); gx <= Math.floor(x1 / 16); gx++) for (let gz = Math.floor(z0 / 16); gz <= Math.floor(z1 / 16); gz++) {
      const k = gx * 65536 + gz;
      if (!this.solids.has(k)) this.solids.set(k, []);
      this.solids.get(k).push(o);
    }
  }
  _solidAt(x, z) {
    let best = null;
    for (const o of this.solids.get(Math.floor(x / 16) * 65536 + Math.floor(z / 16)) || []) {
      let px = o.x, pz = o.z;
      if (o.bx !== undefined) {
        const dx = o.bx - o.x, dz = o.bz - o.z, L2 = dx * dx + dz * dz || 1;
        const t = Math.min(1, Math.max(0, ((x - o.x) * dx + (z - o.z) * dz) / L2));
        px = o.x + dx * t; pz = o.z + dz * t;
      }
      const d = Math.hypot(x - px, z - pz);
      if (d < o.r && (!best || o.r - d > best.depth)) best = { x: d > 1e-4 ? (x - px) / d : 1, z: d > 1e-4 ? (z - pz) / d : 0, depth: o.r - d };
    }
    return best;
  }
  obstacle(x, z) {
    if (!this.isBuilding(x, z)) return this._solidAt(x, z);
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
    this._buildCurbs(scene);
    this._buildWalls(scene);
    this._buildWires(scene);
    this._buildGuards(scene);
    this._buildSpeedSigns(scene);
    this._buildMedians(scene);
    this._buildSignals(scene);
  }

  _terrainMaterial(aniso, landTex) {
    const grass = new THREE.CanvasTexture(noiseCanvas(256, [208, 216, 196], 70, 3));
    const asphalt = new THREE.CanvasTexture(valueNoiseCanvas(512, 11));
    for (const t of [grass, asphalt]) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = aniso; t.colorSpace = THREE.SRGBColorSpace; }
    const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
    const L = this.land;
    m.onBeforeCompile = (sh) => {
      sh.uniforms.landTex = { value: landTex };
      sh.uniforms.luseTex = { value: this._luseTex };
      const ph = this.photo;
      const mkTex = (bmp) => { const t = new THREE.Texture(bmp); t.flipY = false; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; t.needsUpdate = true; return t; };
      sh.uniforms.photoCore = { value: ph ? mkTex(ph.core) : null };
      sh.uniforms.photoFar = { value: ph && ph.far ? mkTex(ph.far) : null };
      const bx = (b) => new THREE.Vector4(b.x0, b.z0, b.x1 - b.x0, b.z1 - b.z0);
      sh.uniforms.photoCoreBox = { value: ph ? bx(ph.box.core) : new THREE.Vector4(0, 0, 1, 1) };
      sh.uniforms.photoFarBox = { value: ph && ph.far ? bx(ph.box.far) : new THREE.Vector4(0, 0, 1, 1) };
      sh.uniforms.usePhoto = { value: ph ? 1 : 0 };
      sh.uniforms.luseBox = { value: new THREE.Vector4(this.luse.x0, this.luse.z0, this.luse.w * this.luse.cell, this.luse.h * this.luse.cell) };
      sh.uniforms.landBox = { value: new THREE.Vector4(L.x0, L.z0, L.w, L.h) };
      sh.uniforms.grassTex = { value: grass };
      sh.uniforms.asphaltTex = { value: asphalt };
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
varying vec3 vWPos;
uniform sampler2D landTex, grassTex, asphaltTex, luseTex, photoCore, photoFar;
uniform vec4 landBox, luseBox, photoCoreBox, photoFarBox;
uniform int usePhoto;`)
        .replace('#include <color_fragment>', `#include <color_fragment>
{
  vec2 luv = (vWPos.xz - landBox.xy) / landBox.zw;
  vec3 land = (luv.x > 0.0 && luv.y > 0.0 && luv.x < 1.0 && luv.y < 1.0) ? texture2D(landTex, luv).rgb : vec3(0.0);
  vec3 g = diffuseColor.rgb * texture2D(grassTex, vWPos.xz * 0.21).rgb;
  // 土地利用(2m マス)。境目が四角く見えないよう、少しずらして読む
  {
    vec4 jn = texture2D(asphaltTex, vWPos.xz * 0.07);
    vec2 uu = (vWPos.xz + (jn.rg - 0.5) * 3.0 - luseBox.xy) / luseBox.zw;
    float lu = (uu.x > 0.0 && uu.y > 0.0 && uu.x < 1.0 && uu.y < 1.0) ? floor(texture2D(luseTex, uu).r * 255.0 / 28.0 + 0.5) : 0.0;
    float n1 = texture2D(asphaltTex, vWPos.xz * 0.23).b, n2 = texture2D(grassTex, vWPos.xz * 0.6).g;
    if (lu == 1.0) { // 田:刈り取ったあとの株の列
      float row = smoothstep(0.35, 0.5, abs(fract(vWPos.x * 3.3) - 0.5));
      g = mix(vec3(0.20, 0.17, 0.09), vec3(0.27, 0.24, 0.12), row) * mix(0.85, 1.1, n1);
    } else if (lu == 2.0) { // 畑:土と作物の畝
      float row = smoothstep(0.2, 0.45, abs(fract(vWPos.z * 1.25) - 0.5));
      g = mix(vec3(0.16, 0.11, 0.07), vec3(0.11, 0.19, 0.07), row * step(0.35, n1)) * mix(0.85, 1.1, n2);
    } else if (lu == 3.0) { // 山林:落ち葉と下草
      g = mix(vec3(0.07, 0.09, 0.05), vec3(0.13, 0.11, 0.07), n1) * mix(0.8, 1.15, n2);
    } else if (lu == 4.0) { // その他の自然地:伸びた草
      g = mix(vec3(0.20, 0.22, 0.10), vec3(0.15, 0.20, 0.08), n1) * mix(0.85, 1.12, n2);
    } else if (lu == 5.0) { // 公園・緑地:芝
      g = vec3(0.12, 0.22, 0.07) * mix(0.85, 1.12, n2);
    } else if (lu == 6.0) { // 住宅地:砂利・土間コンクリートと庭の緑が混じる
      float garden = smoothstep(0.55, 0.7, n1);
      g = mix(mix(vec3(0.26, 0.25, 0.22), vec3(0.30, 0.29, 0.27), n2), vec3(0.12, 0.18, 0.07), garden);
    } else if (lu == 7.0) { // 商業・公共:舗装
      g = mix(vec3(0.22, 0.22, 0.22), vec3(0.28, 0.28, 0.27), n2);
    } else if (lu == 8.0) { // 空き地・農業施設:土と砂利
      g = mix(vec3(0.22, 0.19, 0.14), vec3(0.18, 0.18, 0.12), n1) * mix(0.9, 1.1, n2);
    }
    // 航空写真を下地に:林・畑・田・草地・公園と、土地利用の範囲の外(遠景の山)。住宅地などは屋根が写るので使わない
    if (usePhoto == 1 && (lu < 6.0 || lu == 8.0)) {
      vec2 pc = (vWPos.xz - photoCoreBox.xy) / photoCoreBox.zw;
      vec3 ph;
      if (pc.x > 0.0 && pc.y > 0.0 && pc.x < 1.0 && pc.y < 1.0) ph = texture2D(photoCore, pc).rgb;
      else ph = texture2D(photoFar, (vWPos.xz - photoFarBox.xy) / photoFarBox.zw).rgb;
      // 写真は霞んで青っぽいので少し締め、細かい粒を足す
      // 写真の林はとても暗く、そのままだと空の光で青く沈むので、明るさを上げて青みを抜く
      float lum = dot(ph, vec3(0.3, 0.55, 0.15));
      ph = mix(vec3(lum), ph, 1.35) * vec3(1.0, 1.02, 0.72) * 1.25 * mix(0.88, 1.1, n2);
      float wPh = lu == 0.0 ? 0.92 : 0.7;
      g = mix(g, ph, wPh);
    }
  }
  // アスファルト:細かい骨材の粒(約 0.5m 周期)+ 数 m の色むら + 数十 m の補修跡のような濃淡
  vec4 nA = texture2D(asphaltTex, vWPos.xz * 0.9);
  vec4 nB = texture2D(asphaltTex, vWPos.xz * 0.11 + 0.37);
  vec4 nC = texture2D(asphaltTex, vWPos.xz * 0.013 + 0.71);
  float aGrain = mix(0.82, 1.18, nA.r) * mix(0.9, 1.1, nB.g) * mix(0.86, 1.08, smoothstep(0.35, 0.75, nC.b));
  vec3 asp = vec3(0.118, 0.12, 0.125) * aGrain;
  vec3 lot = vec3(0.30, 0.29, 0.26) * mix(0.85, 1.1, texture2D(asphaltTex, vWPos.xz * 0.11).r);
  vec3 wat = vec3(0.05, 0.08, 0.08);
  vec3 c = g;
  c = mix(c, lot, smoothstep(0.08, 0.45, land.b));
  c *= 1.0 - 0.38 * smoothstep(0.55, 0.78, land.b); // 建物の足元の陰
  float wat_t = smoothstep(0.75, 0.95, land.g);
  // 道路の範囲(車道+歩道)をひとまとめにしてから、車道を上に塗る(境目に草が出ないように)
  float area = clamp(land.r + min(land.g, 0.5) * 2.0 * (1.0 - wat_t), 0.0, 1.0);
  // 境目は画面の 1 画素ぶんだけで切り替える(近くでもぼやけない)
  float fwA = max(fwidth(area), 0.002), fwR = max(fwidth(land.r), 0.002);
  // 歩道:30cm × 15cm のブロック舗装(遠くでは模様を消して平均色に)
  vec2 bp = vec2(vWPos.x / 0.3 + mod(floor(vWPos.z / 0.15), 2.0) * 0.5, vWPos.z / 0.15);
  vec2 bf = fract(bp);
  float joint = 1.0 - (smoothstep(0.0, 0.06, bf.x) * smoothstep(1.0, 0.94, bf.x) * smoothstep(0.0, 0.1, bf.y) * smoothstep(1.0, 0.9, bf.y));
  float far = smoothstep(0.02, 0.08, fwidth(vWPos.x) + fwidth(vWPos.z));
  float tint = fract(sin(dot(floor(bp), vec2(12.9898, 78.233))) * 43758.5453);
  vec3 walkBase = mix(vec3(0.42, 0.41, 0.39), vec3(0.36, 0.33, 0.31), step(0.8, tint));
  vec3 walk = mix(walkBase * mix(1.0, 0.72, joint) * mix(0.94, 1.04, tint), vec3(0.385, 0.375, 0.36), far);
  c = mix(c, walk, clamp((area - 0.45) / fwA + 0.5, 0.0, 1.0));
  c = mix(c, wat, wat_t);
  float road = clamp((land.r - 0.5) / fwR + 0.5, 0.0, 1.0);
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
    // 256m 四方ほどの塊に分けて、見えない所を描かないようにする。
    // 遠い塊は 2 マスおき(三角形 1/4)に切り替え、継ぎ目は縁から下へ垂らした「スカート」で隠す
    const C = Math.max(8, Math.round(256 / (G.spacing * step)));
    const group = new THREE.Group();
    // スカート用の頂点(各頂点を 4m 下げたもの)を後ろにつなげる
    const nv = nx * nz;
    const pos2 = new Float32Array(nv * 6), nor2 = new Float32Array(nv * 6), col2 = new Float32Array(nv * 6);
    pos2.set(pos); nor2.set(nor); col2.set(col);
    for (let k = 0; k < nv; k++) { pos2[(nv + k) * 3] = pos[k * 3]; pos2[(nv + k) * 3 + 1] = pos[k * 3 + 1] - 4; pos2[(nv + k) * 3 + 2] = pos[k * 3 + 2]; nor2.set(nor.subarray(k * 3, k * 3 + 3), (nv + k) * 3); col2.set(col.subarray(k * 3, k * 3 + 3), (nv + k) * 3); }
    const posA = new THREE.BufferAttribute(pos2, 3), norA = new THREE.BufferAttribute(nor2, 3), colA = new THREE.BufferAttribute(col2, 3);
    this.terrainChunks = this.terrainChunks || [];
    for (let cj = 0; cj < nz - 1; cj += C) for (let ci = 0; ci < nx - 1; ci += C) {
      const w = Math.min(C, nx - 1 - ci), h = Math.min(C, nz - 1 - cj);
      const make = (st) => {
        const idx = [];
        for (let j = cj; j < cj + h; j += st) for (let i = ci; i < ci + w; i += st) {
          const j2 = Math.min(j + st, cj + h), i2 = Math.min(i + st, ci + w);
          const a = j * nx + i, b = j * nx + i2, c = j2 * nx + i, d = j2 * nx + i2;
          idx.push(a, c, b, b, c, d);
        }
        if (st > 1) {
          // 縁のスカート(上の頂点から 4m 下へ)
          const edge = [];
          for (let i = ci; i < ci + w; i += st) edge.push([cj * nx + i, cj * nx + Math.min(i + st, ci + w)]);
          for (let i = ci; i < ci + w; i += st) edge.push([(cj + h) * nx + Math.min(i + st, ci + w), (cj + h) * nx + i]);
          for (let j = cj; j < cj + h; j += st) edge.push([Math.min(j + st, cj + h) * nx + ci, j * nx + ci]);
          for (let j = cj; j < cj + h; j += st) edge.push([j * nx + ci + w, Math.min(j + st, cj + h) * nx + ci + w]);
          for (const [a, b] of edge) idx.push(a, b, nv + a, b, nv + b, nv + a);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', posA); g.setAttribute('normal', norA); g.setAttribute('color', colA);
        g.setIndex(idx);
        g.boundingBox = new THREE.Box3();
        for (let j = cj; j <= cj + h; j++) for (let i = ci; i <= ci + w; i++) { const k = (j * nx + i) * 3; g.boundingBox.expandByPoint(new THREE.Vector3(pos[k], pos[k + 1], pos[k + 2])); }
        g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
        const m = new THREE.Mesh(g, mat);
        m.receiveShadow = true;
        return m;
      };
      const hi = make(1);
      group.add(hi);
      if (!sink) { const lo = make(2); lo.visible = false; group.add(lo); this.terrainChunks.push({ hi, lo }); }
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
    this._luseTex = new THREE.Texture(this.luse.bmp);
    this._luseTex.flipY = false; this._luseTex.colorSpace = THREE.NoColorSpace;
    this._luseTex.magFilter = this._luseTex.minFilter = THREE.NearestFilter; this._luseTex.generateMipmaps = false;
    this._luseTex.needsUpdate = true;
    const mat = this._terrainMaterial(aniso, landTex);
    scene.add(this._terrainMesh(this.core, 1, mat, false));
    scene.add(this._terrainMesh(this.far, 2, mat, true));
  }

  _buildBuildings(scene, aniso) {
    const rnd = mulberry32(42);
    // 外壁の模様は 1 枚の絵(4×4 マス)にまとめ、マスの番号を頂点に持たせる
    const atlas = new THREE.CanvasTexture(facadeAtlas());
    atlas.anisotropy = aniso; atlas.colorSpace = THREE.SRGBColorSpace;
    const wallMat = new THREE.MeshStandardMaterial({ map: atlas, vertexColors: true, roughness: 0.8, metalness: 0.03 });
    wallMat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec2 facade;\nvarying vec2 vFacade;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFacade = facade;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec2 vFacade;')
        .replace('#include <map_fragment>', `
#ifdef USE_MAP
  vec2 tuv = vMapUv;
  // 補間で 7.9999 のようにずれると隣のマスを読むので、整数に丸める
  float tile = floor((tuv.y < 1.0 ? vFacade.x : vFacade.y) + 0.5);
  vec2 cell = vec2(mod(tile, 4.0), floor(tile / 4.0));
  vec2 f = clamp(fract(tuv), 0.004, 0.996);
  vec2 auv = vec2((cell.x + f.x) / 4.0, 1.0 - (cell.y + 1.0 - f.y) / 4.0);
  diffuseColor *= textureGrad(map, auv, dFdx(tuv) / 4.0, dFdy(tuv) / 4.0);
#endif`);
    };
    const roofMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.15, side: THREE.DoubleSide });
    // 種類ごとの外観:[1階のマス, 2階以上のマス, 1マスの幅(m), 1階分の高さ(m), 壁の色, 屋根の勾配(度), 屋根の色]
    const HOUSE_WALL = [0xf0ebe1, 0xe2dccf, 0xd2ccc0, 0xece4d2, 0xc4bdb0, 0x9a8a76, 0x6e6156, 0xe0ded8, 0xb5b0a6];
    const ROOF_TILE = [0x2a2c30, 0x2a2c30, 0x34373c, 0x45484d, 0x7d8287, 0x5b4c40, 0x3c4a58, 0x2f3a33];
    const METAL = [0x8b9196, 0x6d7c86, 0x5f7d73, 0x8a6a55, 0xa3a7aa, 0x4f6274];
    const STYLE = {
      0: [-1, -1, 3.0, 2.9, HOUSE_WALL, [22, 30], ROOF_TILE],              // 住宅
      1: [2, 2, 2.7, 2.9, [0xffffff, 0xf2efe8, 0xe8e2d8], [28, 34], [0x232528, 0x2b2d31]], // 町家風(格子)
      2: [9, 3, 3.4, 2.9, [0xe0dbd0, 0xd1ccc1, 0xece8e0, 0xc3c1bb, 0xd9d0c0], 0, [0x8f8e8a]], // 集合住宅
      3: [4, 4, 3.6, 3.4, [0xdcdcd8, 0xc8c8c4, 0xe6e4de, 0xb4b6b8], 0, [0x8f8e8a]],    // 事務所
      4: [5, 5, 3.6, 3.8, [0xe9e2d0, 0xe0d8c6, 0xf0ece2], 0, [0x8f8e8a]],             // 学校
      5: [6, 8, 3.6, 3.4, [0xf0f0ee, 0xe0ded8, 0xd6d2ca, 0xc9cdd1], 0, [0x8f8e8a]],    // 店
      6: [10, 11, 3.6, 4.6, [0xffffff, 0xf4f4f2], 0, [0x9a9a96]],                    // コンビニ
      7: [6, 13, 4.0, 4.6, [0xf2f2f0, 0xe4e4e2, 0xd8dade], 0, [0x9a9a96]],           // 大きな店
      8: [6, 8, 3.6, 3.4, [0xffffff, 0xf2f2f0, 0xeef0ee], 0, [0x8f8e8a]],             // 医院
      9: [8, 8, 3.6, 3.6, [0xe4e0d6, 0xd6d2c8, 0xe9e7e1], 0, [0x8f8e8a]],             // 役所・郵便局など
      10: [7, 7, 3.0, 4.2, [0xc9cdd0, 0xb0b8be, 0xd8d8d2, 0x9fb0b8, 0xcab9a2], [7, 10], METAL], // 倉庫・工場
      11: [12, 12, 2.4, 3.6, [0xffffff, 0xeee6da], [32, 36], [0x232528, 0x3a3428]],  // 寺社
      12: [11, 15, 3.6, 4.5, [0xe6e1d4, 0xd8d4ca], [10, 14], [0x6d7c86, 0x5f7d73, 0x8b9196]], // 体育館
      13: [7, 7, 3.0, 3.6, [0xb7ad9c, 0x9c9488, 0xc9cdd0], [10, 14], METAL],         // 小屋
      14: [14, -1, 3.0, 2.9, HOUSE_WALL, [22, 30], ROOF_TILE],                       // 店舗併用住宅
      15: [6, 3, 3.4, 3.1, [0xe0dbd0, 0xd1ccc1, 0xece8e0], 0, [0x8f8e8a]],           // 店舗併用の集合住宅
    };
    const chunks = new Map();
    const geo = () => ({ p: [], n: [], c: [], uv: [], f: [] });
    const getChunk = (x, z) => {
      const k = `${Math.floor(x / 256)},${Math.floor(z / 256)}`;
      if (!chunks.has(k)) chunks.set(k, { wall: geo(), roof: geo() });
      return chunks.get(k);
    };
    const tmp = new THREE.Color();
    let fac = [0, 0];
    const quad = (G, a, b, c, d, n, col, uv, colLow) => { // a b c d:反時計回り(a と d が下)。colLow があれば下の頂点の色
      const lo = colLow || col;
      for (const [v, t, cc] of [[a, uv[0], lo], [b, uv[1], col], [c, uv[2], col], [a, uv[0], lo], [c, uv[2], col], [d, uv[3], lo]]) { G.p.push(...v); G.n.push(...n); G.c.push(cc.r, cc.g, cc.b); G.uv.push(...t); G.f.push(...fac); }
    };
    const triangle = (G, a, b, c, n, col, uv) => { for (const [v, t] of [[a, uv[0]], [b, uv[1]], [c, uv[2]]]) { G.p.push(...v); G.n.push(...n); G.c.push(col.r, col.g, col.b); G.uv.push(...t); G.f.push(...fac); } };
    const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
    const signs = [];

    for (const b of this.buildings) {
      const p = b.p, n = p.length / 2;
      const ch = getChunk(p[0], p[1]);
      const st = STYLE[b.c ?? 0] || STYLE[0];
      const houseTile = rnd() < 0.5 ? 0 : 1;
      fac = [st[0] < 0 ? houseTile : st[0], st[1] < 0 ? houseTile : st[1]];
      const G = ch.wall;
      const wallCol = tmp.set(pick(st[4])).clone().multiplyScalar(0.93 + rnd() * 0.1);
      const wallLow = wallCol.clone().multiplyScalar(Math.max(0.62, 1 - 1.6 / Math.max(3, b.h)));
      const g0 = (b.gb ?? b.g) - 0.4; // 低い側は基礎の壁で地面まで
      let top = b.g + b.h, eave = top;
      let rise = 0;
      const pitch = st[5] ? THREE.MathUtils.degToRad(st[5][0] + rnd() * (st[5][1] - st[5][0])) : 0;
      const useGable = b.r && pitch > 0;
      if (useGable) { rise = (b.r[4] / 2) * Math.tan(pitch); eave = Math.max(b.g + 2.6, top - rise * 0.5); top = eave + rise; }
      const texW = st[2], floorH = st[3];
      let run = rnd() * 3;
      const baseCol = tmp.set(0x8d8a83).clone().multiplyScalar(0.85 + rnd() * 0.2);
      const fl = b.g - 0.05; // 床の高さ。ここより下は窓のない基礎
      for (let i = 0; i < n; i++) {
        const ax = p[i * 2], az = p[i * 2 + 1], bx = p[((i + 1) % n) * 2], bz = p[((i + 1) % n) * 2 + 1];
        const L = Math.hypot(bx - ax, bz - az);
        if (L < 0.05) continue;
        const nn = [(bz - az) / L, 0, -(bx - ax) / L];
        const u0 = run / texW, u1 = (run + L) / texW; run += L;
        const v0 = 0, v1 = (eave - b.g) / floorH;
        // 外向きの面になる順(下a 上a 上b 下b を外から見て反時計回り)
        // 足元は地面からの照り返しが少なく暗い(壁の高さで薄める)
        quad(G, [ax, fl, az], [ax, eave, az], [bx, eave, bz], [bx, fl, bz], nn, wallCol, [[u0, v0], [u0, v1], [u1, v1], [u1, v0]], wallLow);
        if (fl - g0 > 0.05) quad(ch.roof, [ax, g0, az], [ax, fl, az], [bx, fl, bz], [bx, g0, bz], nn, baseCol, [[0, 0], [0, 0], [0, 0], [0, 0]]);
      }
      // 屋根の色:空中写真から取った色があれば使う(霞の分だけ暗く・色を濃く)
      const roofCol = b.rc != null ? photoRoof(b.rc, tmp) : tmp.set(pick(st[6])).clone().multiplyScalar(0.9 + rnd() * 0.2);
      if (useGable) {
        const [cx, cz, ang, L, W] = b.r;
        const ux = Math.cos(ang), uz = Math.sin(ang), vx = -uz, vz = ux;
        const o = b.c === 11 ? 0.9 : 0.45, hl = L / 2, hw = W / 2;
        const P = (s2, t, y) => [cx + ux * s2 + vx * t, y, cz + uz * s2 + vz * t];
        const drop = o * (rise / hw);
        for (const side of [-1, 1]) {
          const nrm = new THREE.Vector3(vx * side * rise, hw, vz * side * rise).normalize();
          quad(ch.roof, P(-hl - o, 0, top), P(-hl - o, side * (hw + o), eave - drop), P(hl + o, side * (hw + o), eave - drop), P(hl + o, 0, top), [nrm.x, nrm.y, nrm.z], roofCol, [[0, 0], [0, 1], [1, 1], [1, 0]]);
        }
        // 妻壁(三角の壁)
        for (const end of [-1, 1]) {
          const nrm = [ux * end, 0, uz * end];
          const a = P(end * hl, -hw * end, eave), c = P(end * hl, hw * end, eave), m = P(end * hl, 0, top);
          const fac0 = fac; fac = [fac[1], fac[1]];
          triangle(G, a, m, c, nrm, wallCol, [[0, (eave - b.g) / floorH], [W / 2 / texW, (top - b.g) / floorH], [W / texW, (eave - b.g) / floorH]]);
          fac = fac0;
        }
      } else {
        const flat = b.rc != null ? photoRoof(b.rc, tmp) : tmp.set(0x8f8e8a).clone().multiplyScalar(0.85 + rnd() * 0.25);
        const contour = []; for (let i = 0; i < n; i++) contour.push(new THREE.Vector2(p[i * 2], p[i * 2 + 1]));
        for (const t of THREE.ShapeUtils.triangulateShape(contour, [])) triangle(ch.roof, [p[t[0] * 2], top, p[t[0] * 2 + 1]], [p[t[2] * 2], top, p[t[2] * 2 + 1]], [p[t[1] * 2], top, p[t[1] * 2 + 1]], [0, 1, 0], flat, [[0, 0], [0, 0], [0, 0]]);
        // 屋上の立ち上がり(パラペット)
        if (b.h > 5) {
          for (let i = 0; i < n; i++) {
            const ax = p[i * 2], az = p[i * 2 + 1], bx = p[((i + 1) % n) * 2], bz = p[((i + 1) % n) * 2 + 1];
            const L = Math.hypot(bx - ax, bz - az); if (L < 0.05) continue;
            quad(ch.roof, [ax, top, az], [ax, top + 0.6, az], [bx, top + 0.6, bz], [bx, top, bz], [(bz - az) / L, 0, -(bx - ax) / L], wallCol, [[0, 0], [0, 0], [0, 0], [0, 0]]);
          }
        }
        // 屋上の設備(室外機・塔屋)を大きな建物に
        if (b.h > 8 && n >= 4) {
          let cx = 0, cz = 0; for (let i = 0; i < n; i++) { cx += p[i * 2]; cz += p[i * 2 + 1]; } cx /= n; cz /= n;
          const box = (x, z, w, d, h, col) => {
            const y0 = top, y1 = top + h, X0 = x - w / 2, X1 = x + w / 2, Z0 = z - d / 2, Z1 = z + d / 2;
            quad(ch.roof, [X0, y1, Z0], [X0, y1, Z1], [X1, y1, Z1], [X1, y1, Z0], [0, 1, 0], col, [[0, 0], [0, 0], [0, 0], [0, 0]]);
            quad(ch.roof, [X0, y0, Z1], [X0, y1, Z1], [X1, y1, Z1], [X1, y0, Z1], [0, 0, 1], col, [[0, 0], [0, 0], [0, 0], [0, 0]]);
            quad(ch.roof, [X1, y0, Z0], [X1, y1, Z0], [X0, y1, Z0], [X0, y0, Z0], [0, 0, -1], col, [[0, 0], [0, 0], [0, 0], [0, 0]]);
            quad(ch.roof, [X1, y0, Z1], [X1, y1, Z1], [X1, y1, Z0], [X1, y0, Z0], [1, 0, 0], col, [[0, 0], [0, 0], [0, 0], [0, 0]]);
            quad(ch.roof, [X0, y0, Z0], [X0, y1, Z0], [X0, y1, Z1], [X0, y0, Z1], [-1, 0, 0], col, [[0, 0], [0, 0], [0, 0], [0, 0]]);
          };
          box(cx, cz, 3.2, 3.2, 2.6, wallCol);
          box(cx + 3.5, cz + 1.2, 1.4, 0.8, 1.1, tmp.set(0xb9bcbe).clone());
          box(cx - 3.2, cz - 1.5, 1.4, 0.8, 1.1, tmp.set(0xb9bcbe).clone());
        }
      }
      // 看板
      if (b.sg) {
        const [ei, text] = b.sg;
        const ax = p[ei * 2], az = p[ei * 2 + 1], bx = p[((ei + 1) % n) * 2], bz = p[((ei + 1) % n) * 2 + 1];
        const L = Math.hypot(bx - ax, bz - az);
        const nx = (bz - az) / L, nz = -(bx - ax) / L;
        const w = Math.min(L * 0.8, 7.5, 1.2 + text.length * 0.55), h = w / 4;
        const y = b.g + Math.min(3.3, Math.max(2.4, eave - b.g - h / 2 - 0.3));
        const mx = (ax + bx) / 2 + nx * 0.14, mz = (az + bz) / 2 + nz * 0.14;
        signs.push({ text, cat: b.c, x: mx, z: mz, y, w, h, ux: (bx - ax) / L, uz: (bz - az) / L, nx, nz });
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
      g.setAttribute('facade', new THREE.Float32BufferAttribute(G.f, 2));
      g.computeBoundingSphere();
      const m = new THREE.Mesh(g, k === 'wall' ? wallMat : roofMat);
      m.castShadow = true; m.receiveShadow = true;
      scene.add(m);
      tris += G.p.length / 9;
    }
    this._buildSigns(scene, signs, aniso);
    this.stats = { ...(this.stats || {}), buildingTris: Math.round(tris), signs: signs.length };
  }

  // 店の看板:名前を絵にして、1 枚の絵(8×16 枠)にまとめる
  _buildSigns(scene, signs, aniso) {
    if (!signs.length) return;
    const C = document.createElement('canvas'); C.width = 2048; C.height = 1024;
    const g = C.getContext('2d');
    const SW = 256, SH = 64;
    const STY = { 6: ['#f6f6f2', '#1e252b', '#2f7d55'], 7: ['#ffffff', '#b8322a', '#b8322a'], 8: ['#ffffff', '#2c6e49', '#2c6e49'], 5: ['#1f3c5a', '#ffffff', '#e0a92a'], 14: ['#3a2f26', '#f4ead8', '#c9a46a'], 15: ['#1f3c5a', '#ffffff', '#e0a92a'] };
    const P = [], N = [], UV = [];
    signs.slice(0, 128).forEach((s, i) => {
      const cx = (i % 8) * SW, cy = Math.floor(i / 8) * SH;
      const [bg, fg, ac] = STY[s.cat] || STY[5];
      g.fillStyle = bg; g.fillRect(cx, cy, SW, SH);
      g.fillStyle = ac; g.fillRect(cx, cy + SH - 7, SW, 7);
      g.fillStyle = fg;
      let size = 36;
      g.font = `700 ${size}px "BIZ UDPGothic", "Hiragino Sans", sans-serif`;
      while (g.measureText(s.text).width > SW - 20 && size > 14) { size -= 2; g.font = `700 ${size}px "BIZ UDPGothic", "Hiragino Sans", sans-serif`; }
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(s.text, cx + SW / 2, cy + SH / 2 - 3);
      // 板(外に向いた面)
      const u0 = cx / 2048, u1 = (cx + SW) / 2048, v1 = 1 - cy / 1024, v0 = 1 - (cy + SH) / 1024;
      const hw = s.w / 2;
      const A = [s.x - s.ux * hw, s.y - s.h / 2, s.z - s.uz * hw], B = [s.x + s.ux * hw, s.y - s.h / 2, s.z + s.uz * hw];
      const Ct = [B[0], s.y + s.h / 2, B[2]], D = [A[0], s.y + s.h / 2, A[2]];
      // 外から見て左が文字の頭になるよう、壁の向きの逆から並べる
      for (const [v, t] of [[B, [u0, v0]], [Ct, [u0, v1]], [D, [u1, v1]], [B, [u0, v0]], [D, [u1, v1]], [A, [u1, v0]]]) { P.push(...v); N.push(s.nx, 0, s.nz); UV.push(...t); }
    });
    const tex = new THREE.CanvasTexture(C);
    tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = aniso;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.5, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.25, side: THREE.DoubleSide }));
    scene.add(m);
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
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, color: 0x2a3a30, roughness: 0.22, metalness: 0.0, envMapIntensity: 0.6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    m.receiveShadow = true;
    scene.add(m);
  }

  _buildMarkings(scene) {
    const P = [], C = [];
    const white = new THREE.Color(0xf4f4f0), yellow = new THREE.Color(0xeaae2a);
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
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, vertexColors: true, roughness: 0.55, emissive: 0x202020, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8 }));
    m.receiveShadow = true;
    scene.add(m);
  }

  _buildPoles(scene) {
    const n = this.poles.length / 3;
    const pole = new THREE.CylinderGeometry(0.13, 0.19, 11, 6, 1, true).translate(0, 5.5, 0);
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
    const t = this.trees, n = t.length / 4;
    const withColor = (geo, rgb) => { const c = new Float32Array(geo.attributes.position.count * 3); for (let i = 0; i < c.length; i += 3) c.set(rgb, i); geo.setAttribute('color', new THREE.BufferAttribute(c, 3)); return geo.toNonIndexed ? geo.index ? geo.toNonIndexed() : geo : geo; };
    const prep = (g) => { const h = g.index ? g.toNonIndexed() : g; h.deleteAttribute('uv'); return h; };
    const trunk = (h, r) => withColor(prep(new THREE.CylinderGeometry(r * 0.7, r, h, 5, 1, true).translate(0, h / 2, 0)), [0.42, 0.34, 0.27]);
    const crownC = [1, 1, 1];
    const GEO = [
      // 0 杉:二段の円すい
      mergeGeometries([trunk(4, 0.25), withColor(prep(new THREE.ConeGeometry(2.3, 6, 7, 1, true).translate(0, 6.5, 0)), crownC), withColor(prep(new THREE.ConeGeometry(1.6, 4.5, 7, 1, true).translate(0, 10, 0)), crownC)]),
      // 1 広葉樹:塊を二つ
      mergeGeometries([trunk(3.6, 0.22), withColor(prep(new THREE.IcosahedronGeometry(2.8, 0).scale(1, 0.85, 1).translate(0, 5.2, 0)), crownC), withColor(prep(new THREE.IcosahedronGeometry(2.0, 0).translate(1.2, 6.4, 0.5)), crownC)]),
      // 2 庭木
      mergeGeometries([trunk(1.6, 0.1), withColor(prep(new THREE.DodecahedronGeometry(1.25, 0).scale(1, 0.8, 1).translate(0, 2.5, 0)), crownC)]),
      // 3 低木
      withColor(prep(new THREE.IcosahedronGeometry(0.75, 0).scale(1.2, 0.7, 1.0).translate(0, 0.45, 0)), crownC),
    ];
    // 遠くで使う簡単な形(三角形を 5〜8 枚)
    const LOW = [
      withColor(prep(new THREE.ConeGeometry(2.1, 10, 5, 1, true).translate(0, 7, 0)), crownC),
      withColor(prep(new THREE.OctahedronGeometry(3.0, 0).scale(1, 0.95, 1).translate(0, 5.4, 0)), crownC),
      withColor(prep(new THREE.OctahedronGeometry(1.3, 0).translate(0, 2.4, 0)), crownC),
      null, // 低木は遠くでは描かない
    ];
    const HUE = [[0.31, 0.38, 0.085, 0.03], [0.24, 0.42, 0.12, 0.05], [0.28, 0.40, 0.11, 0.04], [0.29, 0.45, 0.10, 0.04]]; // [色相, 彩度, 明るさ, ばらつき]
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true });
    const chunks = new Map();
    for (let i = 0; i < n; i++) {
      const k = `${Math.floor(t[i * 4] / 256)},${Math.floor(t[i * 4 + 1] / 256)},${t[i * 4 + 3]}`;
      if (!chunks.has(k)) chunks.set(k, []);
      chunks.get(k).push(i);
    }
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3(), V = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0), col = new THREE.Color();
    this.treeChunks = [];
    for (const [k, list] of chunks) {
      const type = Number(k.split(',')[2]);
      const im = new THREE.InstancedMesh(GEO[type], mat, list.length);
      list.forEach((i, j) => {
        const x = t[i * 4], z = t[i * 4 + 1], s = t[i * 4 + 2];
        const sc = (type === 3 ? 0.7 : 0.75) + (s % 97) / 97 * 0.65;
        Q.setFromAxisAngle(Y, s * 0.37);
        M.compose(V.set(x, this.terrainHeight(x, z) - 0.15, z), Q, S.set(sc, sc * (0.88 + (s % 13) / 28), sc));
        im.setMatrixAt(j, M);
        const [hh, ss, ll, vv] = HUE[type];
        im.setColorAt(j, col.setHSL(hh + ((s % 7) / 7 - 0.5) * vv, ss, ll + ((s % 11) / 11 - 0.5) * vv));
      });
      im.computeBoundingSphere();
      im.castShadow = false; // 林の木の影は重いので落とさない(街路樹は落とす)
      im.receiveShadow = true;
      scene.add(im);
      let lo = null;
      if (LOW[type]) {
        lo = new THREE.InstancedMesh(LOW[type], mat, list.length);
        for (let j = 0; j < list.length; j++) { im.getMatrixAt(j, M); lo.setMatrixAt(j, M); im.getColorAt(j, col); lo.setColorAt(j, col); }
        lo.computeBoundingSphere();
        lo.visible = false;
        scene.add(lo);
      }
      this.treeChunks.push({ hi: im, lo, type });
    }
  }
  // 遠くの木の塊は描かない(霧で見えない距離)
  // 塊の中心からの距離で、近い形・遠い形・描かないを切り替える(画質の設定で距離が変わる)
  updateVisibility(cam) {
    for (const l of this.wireChunks || []) { const sp = l.geometry.boundingSphere; l.visible = sp.center.distanceTo(cam) - sp.radius < 180; }
    for (const c of this.terrainChunks || []) {
      const sp = c.hi.geometry.boundingSphere;
      const far = sp.center.distanceTo(cam) - sp.radius > 450;
      c.hi.visible = !far; c.lo.visible = far;
    }
    if (!this.treeChunks) return;
    const q = this.quality || { near: 260, far: 1100 };
    for (const c of this.treeChunks) {
      const s = c.hi.boundingSphere;
      const d = s ? Math.max(0, s.center.distanceTo(cam) - s.radius) : 0;
      // 塊は 256m 四方。近い形は塊の端までの距離で決める
      c.hi.visible = d < q.near;
      if (c.lo) c.lo.visible = d >= q.near && d < q.far;
    }
  }
  setQuality(level) {
    this.quality = level === 'low' ? { near: 120, far: 650 } : { near: 260, far: 1100 };
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
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.55, emissive: 0x202020, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8 }));
    m.receiveShadow = true;
    scene.add(m);
  }

  // ---------- 電線:腕木の両端と下の通信線の 3 本。たるみをつけて結ぶ ----------
  _buildWires(scene) {
    const P = [];
    const end = (i) => {
      const x = this.poles[i * 3], z = this.poles[i * 3 + 1], a = this.poles[i * 3 + 2] / 255 * Math.PI * 2 - Math.PI;
      const g = this.terrainHeight(x, z) - 0.3;
      // 腕木は道路と直角(電柱の向きに対して z 方向)
      const ax = -Math.sin(a), az = Math.cos(a);
      return [[x + ax * 0.7, g + 10.15, z + az * 0.7], [x - ax * 0.7, g + 10.15, z - az * 0.7], [x, g + 8.3, z]];
    };
    for (let k = 0; k < this.wires.length; k += 2) {
      const A = end(this.wires[k]), B = end(this.wires[k + 1]);
      const L = Math.hypot(A[2][0] - B[2][0], A[2][2] - B[2][2]);
      const sag = 0.25 + 0.5 * (L / 40) ** 2;
      for (let w = 0; w < 3; w++) {
        const a = A[w], b = B[w];
        // 向かい合う腕木の端を入れ違えないよう、近い方どうしを結ぶ
        const bb = w < 2 && Math.hypot(a[0] - B[1 - w][0], a[2] - B[1 - w][2]) < Math.hypot(a[0] - b[0], a[2] - b[2]) ? B[1 - w] : b;
        let prev = a;
        for (let s2 = 1; s2 <= 8; s2++) {
          const t = s2 / 8;
          const q = [a[0] + (bb[0] - a[0]) * t, a[1] + (bb[1] - a[1]) * t - sag * 4 * t * (1 - t), a[2] + (bb[2] - a[2]) * t];
          P.push(...prev, ...q); prev = q;
        }
      }
    }
    // 線は遠くでも 1 画素の太さで描かれて黒く目立つので、256m の塊に分けて近い塊だけ描く
    const mat = new THREE.LineBasicMaterial({ color: 0x3a3e42, transparent: true, opacity: 0.85 });
    const groups = new Map();
    for (let i = 0; i < P.length; i += 6) {
      const k = `${Math.floor(P[i] / 256)},${Math.floor(P[i + 2] / 256)}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(...P.slice(i, i + 6));
    }
    this.wireChunks = [];
    for (const arr of groups.values()) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      g.computeBoundingSphere();
      const l = new THREE.LineSegments(g, mat);
      scene.add(l); this.wireChunks.push(l);
    }
  }

  // ---------- ガードレール(白い波形の板と支柱) ----------
  _buildGuards(scene) {
    const P = [], N = [];
    const push = (v, n) => { P.push(...v); N.push(...n); };
    const posts = [];
    for (const gd of this.guards) {
      let acc = 0;
      for (let i = 0; i + 3 < gd.length; i += 2) {
        const ax = gd[i], az = gd[i + 1], bx = gd[i + 2], bz = gd[i + 3];
        const L = Math.hypot(bx - ax, bz - az); if (L < 0.05) continue;
        const ha = this.terrainHeight(ax, az), hb = this.terrainHeight(bx, bz);
        const n = [-(bz - az) / L, 0, (bx - ax) / L];
        for (const [y0, y1] of [[0.55, 0.7], [0.72, 0.87]]) {
          const A0 = [ax, ha + y0, az], A1 = [ax, ha + y1, az], B0 = [bx, hb + y0, bz], B1 = [bx, hb + y1, bz];
          for (const v of [A0, B0, B1, A0, B1, A1]) push(v, n);
        }
        acc += L;
        if (acc >= 4) { posts.push(ax, ha, az); acc = 0; }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0xe9eae6, roughness: 0.45, metalness: 0.3, side: THREE.DoubleSide }));
    m.castShadow = true;
    scene.add(m);
    const pg = new THREE.CylinderGeometry(0.07, 0.07, 1.0, 6, 1, true).translate(0, 0.45, 0);
    const im = new THREE.InstancedMesh(pg, m.material, posts.length / 3);
    const M = new THREE.Matrix4();
    for (let i = 0; i < posts.length / 3; i++) { M.makeTranslation(posts[i * 3], posts[i * 3 + 1], posts[i * 3 + 2]); im.setMatrixAt(i, M); }
    scene.add(im);
  }

  // ---------- 速度の標識(赤い輪・白地・青い数字) ----------
  _buildSpeedSigns(scene) {
    if (!this.speedSigns.length) return;
    const speeds = [...new Set(this.speedSigns.map((q) => q[3]))];
    const C = document.createElement('canvas'); C.width = 128 * speeds.length; C.height = 128;
    const g = C.getContext('2d');
    speeds.forEach((v, i) => {
      const cx = i * 128 + 64;
      g.fillStyle = '#d42b26'; g.beginPath(); g.arc(cx, 64, 62, 0, 7); g.fill();
      g.fillStyle = '#ffffff'; g.beginPath(); g.arc(cx, 64, 48, 0, 7); g.fill();
      g.fillStyle = '#1d4e98'; g.font = '700 46px "Barlow Semi Condensed", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(String(v), cx, 67);
    });
    const tex = new THREE.CanvasTexture(C); tex.colorSpace = THREE.SRGBColorSpace;
    const P = [], UV = [], N = [];
    const metal = new THREE.MeshStandardMaterial({ color: 0x9a9da0, roughness: 0.5, metalness: 0.4 });
    const poleG = new THREE.CylinderGeometry(0.04, 0.04, 2.6, 6, 1, true).translate(0, 1.3, 0);
    const poles = new THREE.InstancedMesh(poleG, metal, this.speedSigns.length);
    const M = new THREE.Matrix4();
    this.speedSigns.forEach(([x, z, ang, v], i) => {
      const gy = this.terrainHeight(x, z);
      M.makeTranslation(x, gy, z); poles.setMatrixAt(i, M);
      // 板は進んでくる車の方(-進行方向)を向く。円を 16 角形で
      const fx = Math.cos(ang), fz = Math.sin(ang), rx = -fz, rz = fx; // 板の横方向
      const k = speeds.indexOf(v), cy = gy + 2.35, R = 0.3;
      const cxp = x - fx * 0.05, czp = z - fz * 0.05;
      for (let s2 = 0; s2 < 16; s2++) {
        const t0 = s2 / 16 * Math.PI * 2, t1 = (s2 + 1) / 16 * Math.PI * 2;
        const pt = (t) => [cxp + rx * Math.cos(t) * R, cy + Math.sin(t) * R, czp + rz * Math.cos(t) * R];
        const uv = (t) => [(k * 128 + 64 - Math.cos(t) * 62) / C.width, 0.5 + Math.sin(t) * 62 / 128];
        for (const [v3, u2] of [[[cxp, cy, czp], [(k * 128 + 64) / C.width, 0.5]], [pt(t0), uv(t0)], [pt(t1), uv(t1)]]) { P.push(...v3); UV.push(...u2); N.push(-fx, 0, -fz); }
      }
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
    scene.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.5, side: THREE.DoubleSide, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.15 })), poles);
  }

  // ---------- 敷地の境:ブロック塀(笠木つき)・生垣・アルミフェンス ----------
  _buildWalls(scene) {
    const P = [], N = [], C = [];
    const FP = [], FU = [];
    const rnd = mulberry32(5);
    const col = new THREE.Color();
    const push = (v, n, c) => { P.push(...v); N.push(...n); C.push(c.r, c.g, c.b); };
    const box = (ax, az, bx, bz, y0a, y0b, h, th, c, capC) => {
      const L = Math.hypot(bx - ax, bz - az); if (L < 0.05) return;
      const nx = -(bz - az) / L * th / 2, nz = (bx - ax) / L * th / 2;
      const A1 = [ax + nx, y0a, az + nz], A2 = [ax - nx, y0a, az - nz], B1 = [bx + nx, y0b, bz + nz], B2 = [bx - nx, y0b, bz - nz];
      const T = (q) => [q[0], q[1] + h, q[2]];
      const n1 = [nx / (th / 2), 0, nz / (th / 2)], n2 = n1.map((v) => -v);
      for (const v of [A1, B1, T(B1), A1, T(B1), T(A1)]) push(v, n1, c);
      for (const v of [A2, T(B2), B2, A2, T(A2), T(B2)]) push(v, n2, c);
      for (const v of [T(A1), T(B1), T(B2), T(A1), T(B2), T(A2)]) push(v, [0, 1, 0], capC || c);
    };
    for (const w of this.walls) {
      const pts = w.p;
      if (w.t === 0) col.setHSL(0.1, 0.04, 0.5 + rnd() * 0.12);
      else if (w.t === 1) col.setHSL(0.27 + rnd() * 0.04, 0.42, 0.1 + rnd() * 0.03);
      const cap = col.clone().multiplyScalar(0.85);
      for (let i = 0; i + 3 < pts.length; i += 2) {
        const ax = pts[i], az = pts[i + 1], bx = pts[i + 2], bz = pts[i + 3];
        const ha = this.terrainHeight(ax, az) - 0.05, hb = this.terrainHeight(bx, bz) - 0.05;
        if (w.t === 0) {
          box(ax, az, bx, bz, ha, hb, w.h, 0.15, col);
          // 笠木(上の縁の少し広い板)
          box(ax, az, bx, bz, ha + w.h, hb + w.h, 0.06, 0.19, cap);
        } else if (w.t === 1) {
          box(ax, az, bx, bz, ha, hb, w.h, 0.6, col);
        } else {
          // フェンス:低い土台+縦格子の板(透かし)
          box(ax, az, bx, bz, ha, hb, 0.25, 0.15, col.setHSL(0.1, 0.04, 0.55));
          const L = Math.hypot(bx - ax, bz - az);
          for (const v of [[ax, ha + 0.25, az], [bx, hb + 0.25, bz], [bx, hb + 0.25 + w.h - 0.25, bz], [ax, ha + 0.25, az], [bx, hb + w.h, bz], [ax, ha + w.h, az]]) FP.push(...v);
          FU.push(0, 0, L, 0, L, 1, 0, 0, L, 1, 0, 1);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide }));
    m.castShadow = m.receiveShadow = true;
    scene.add(m);
    if (FP.length) {
      const c = document.createElement('canvas'); c.width = 64; c.height = 64;
      const gg = c.getContext('2d');
      gg.fillStyle = '#3d342c'; for (let x = 2; x < 64; x += 11) gg.fillRect(x, 0, 4, 64); gg.fillRect(0, 0, 64, 5); gg.fillRect(0, 59, 64, 5);
      const tex = new THREE.CanvasTexture(c); tex.wrapS = THREE.RepeatWrapping; tex.colorSpace = THREE.SRGBColorSpace;
      const fg = new THREE.BufferGeometry();
      fg.setAttribute('position', new THREE.Float32BufferAttribute(FP, 3));
      fg.setAttribute('uv', new THREE.Float32BufferAttribute(FU, 2));
      fg.computeVertexNormals();
      const fm = new THREE.Mesh(fg, new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.5, transparent: false, side: THREE.DoubleSide, roughness: 0.5, metalness: 0.3 }));
      fm.castShadow = true;
      scene.add(fm);
    }
  }

  // ---------- 縁石(高さ 15cm、幅 18cm) ----------
  _buildCurbs(scene) {
    const P = [], N = [];
    const H = 0.15, W = 0.09;
    const push = (v, n) => { P.push(...v); N.push(...n); };
    for (const c of this.curbs) {
      for (let i = 0; i + 3 < c.length; i += 2) {
        const ax = c[i], az = c[i + 1], bx = c[i + 2], bz = c[i + 3];
        const L = Math.hypot(bx - ax, bz - az); if (L < 0.05) continue;
        const nx = -(bz - az) / L * W, nz = (bx - ax) / L * W;
        const ha = this.height(ax, az) - 0.02, hb = this.height(bx, bz) - 0.02;
        const A1 = [ax + nx, ha, az + nz], A2 = [ax - nx, ha, az - nz], B1 = [bx + nx, hb, bz + nz], B2 = [bx - nx, hb, bz - nz];
        const T = (p, h) => [p[0], p[1] + h, p[2]];
        // 上の面
        for (const v of [T(A1, H), T(B2, H), T(B1, H), T(A1, H), T(A2, H), T(B2, H)]) push(v, [0, 1, 0]);
        // 両側の面
        const sn = [nx / W, 0, nz / W];
        for (const v of [A1, B1, T(B1, H), A1, T(B1, H), T(A1, H)]) push(v, sn);
        for (const v of [A2, T(B2, H), B2, A2, T(A2, H), T(B2, H)]) push(v, sn.map((x) => -x));
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0xb4b1a9, roughness: 0.85, side: THREE.DoubleSide }));
    m.receiveShadow = true; m.castShadow = false;
    scene.add(m);
  }

  // ---------- 中央分離帯の植え込みと街路樹 ----------
  _buildMedians(scene) {
    const P = [], N = [], C = [];
    const rnd = mulberry32(77);
    const leaf = new THREE.Color(), tmpN = new THREE.Vector3();
    const push = (v, n, c) => { P.push(...v); N.push(...n); C.push(c.r, c.g, c.b); };
    const treeSpots = [];
    for (const m of this.medians) {
      let acc = 6;
      for (let i = 0; i + 3 < m.p.length; i += 2) {
        const ax = m.p[i], az = m.p[i + 1], bx = m.p[i + 2], bz = m.p[i + 3];
        const L = Math.hypot(bx - ax, bz - az); if (L < 0.05) continue;
        const wa = Math.max(0.5, m.w[i / 2] - 0.9) / 2, wb = Math.max(0.5, m.w[i / 2 + 1] - 0.9) / 2;
        const ux = (bx - ax) / L, uz = (bz - az) / L, nx = -uz, nz = ux;
        const ha = this.height(ax, az) + 0.12, hb = this.height(bx, bz) + 0.12;
        // 低木の植え込み:高さ 0.7m、少し波打たせる
        const hh = 0.65 + rnd() * 0.15;
        leaf.setHSL(0.28 + rnd() * 0.04, 0.45, 0.09 + rnd() * 0.03);
        const A1 = [ax + nx * wa, ha, az + nz * wa], A2 = [ax - nx * wa, ha, az - nz * wa], B1 = [bx + nx * wb, hb, bz + nz * wb], B2 = [bx - nx * wb, hb, bz - nz * wb];
        const T = (p) => [p[0], p[1] + hh, p[2]];
        for (const v of [T(A1), T(B2), T(B1), T(A1), T(A2), T(B2)]) push(v, [0, 1, 0], leaf);
        for (const v of [A1, B1, T(B1), A1, T(B1), T(A1)]) push(v, [nx, 0, nz], leaf);
        for (const v of [A2, T(B2), B2, A2, T(A2), T(B2)]) push(v, [-nx, 0, -nz], leaf);
        // 幅が 2m 以上あれば 12m おきに木
        acc += L;
        if (acc >= 12 && m.w[i / 2] >= 2) { treeSpots.push(ax, az); acc = 0; }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
    const hedge = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide }));
    hedge.castShadow = hedge.receiveShadow = true;
    scene.add(hedge);
    for (let i = 0; i < treeSpots.length; i += 2) this._addSolid({ x: treeSpots[i], z: treeSpots[i + 1], r: 0.3 });
    // 街路樹(ケヤキのような丸い樹冠)
    this._streetTreeMesh(scene, [...this.streetTrees, ...treeSpots]);
  }
  _streetTreeMesh(scene, pts) {
    const n = pts.length / 2;
    if (!n) return;
    const trunk = new THREE.CylinderGeometry(0.14, 0.22, 4.2, 6, 1, true).translate(0, 2.1, 0);
    // 樹冠:大きさの違う塊を 3 つ寄せる
    const parts = [[0, 5.6, 0, 2.3], [1.1, 5.0, 0.6, 1.6], [-0.9, 5.2, -0.7, 1.7]].map(([x, y, z, r]) => new THREE.IcosahedronGeometry(r, 0).translate(x, y, z));
    const crown = mergeGeometries(parts);
    const tm = new THREE.InstancedMesh(trunk, new THREE.MeshStandardMaterial({ color: 0x5a4a3c, roughness: 1 }), n);
    const cm = new THREE.InstancedMesh(crown, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, flatShading: true }), n);
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3(), V = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0), col = new THREE.Color();
    const rnd = mulberry32(31);
    for (let i = 0; i < n; i++) {
      const x = pts[i * 2], z = pts[i * 2 + 1], sc = 0.8 + rnd() * 0.45;
      Q.setFromAxisAngle(Y, rnd() * 6.28);
      M.compose(V.set(x, this.height(x, z) - 0.1, z), Q, S.set(sc, sc * (0.9 + rnd() * 0.25), sc));
      tm.setMatrixAt(i, M); cm.setMatrixAt(i, M);
      cm.setColorAt(i, col.setHSL(0.22 + rnd() * 0.06, 0.42 + rnd() * 0.1, 0.11 + rnd() * 0.04));
    }
    tm.castShadow = cm.castShadow = true;
    scene.add(tm, cm);
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

  // ---------- カーナビ・ミニマップの地図(256m 四方のタイル) ----------
  // 1 枚 1〜2ms で作れるよう 1m = 1 画素で色を決め、描くときになめらかに拡大する。
  // 1 フレームに作るのは 1 枚まで(まとめて作ると一瞬止まるため)。まだ無いタイルは後回し。
  navTile(tx, tz) {
    const key = `${tx},${tz}`;
    const t = this.navTiles.get(key);
    if (t) return t;
    if (!this.navQueue) this.navQueue = new Set();
    this.navQueue.add(key);
    return null;
  }
  _makeNavTile(tx, tz) {
    const N = 256;
    const c = document.createElement('canvas'); c.width = c.height = N;
    const g = c.getContext('2d');
    const img = g.createImageData(N, N);
    const L = this.land, D = L.data, out = img.data;
    for (let py = 0; py < N; py++) {
      const j = tz * 256 + py - L.z0;
      for (let px = 0; px < N; px++) {
        const i = tx * 256 + px - L.x0, k = (py * N + px) * 4;
        let r = 236, gg = 238, b = 228;
        if (i >= 0 && j >= 0 && i < L.w && j < L.h) {
          const q = (j * L.w + i) * 4, ro = D[q], wa = D[q + 1], bl = D[q + 2];
          if (ro > 127) { r = 252; gg = 251; b = 246; }
          else if (wa > 200) { r = 164; gg = 196; b = 222; }
          else if (wa > 90) { r = 244; gg = 243; b = 236; }
          else if (bl > 240) { r = 214; gg = 206; b = 190; }
        }
        out[k] = r; out[k + 1] = gg; out[k + 2] = b; out[k + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    if (this.navTiles.size > 80) this.navTiles.delete(this.navTiles.keys().next().value);
    this.navTiles.set(`${tx},${tz}`, c);
  }
  // 毎フレーム呼ぶ:頼まれたタイルか、車のまわりのタイルを 1 枚だけ作る
  pumpNavTiles(cx, cz) {
    let key = null;
    if (this.navQueue && this.navQueue.size) { key = this.navQueue.values().next().value; this.navQueue.delete(key); }
    else {
      const tx0 = Math.floor(cx / 256), tz0 = Math.floor(cz / 256);
      for (let r = 0; r <= 2 && !key; r++) for (let a = -r; a <= r && !key; a++) for (let b = -r; b <= r && !key; b++) {
        const k = `${tx0 + a},${tz0 + b}`; if (!this.navTiles.has(k)) key = k;
      }
    }
    if (key && !this.navTiles.has(key)) { const [tx, tz] = key.split(',').map(Number); this._makeNavTile(tx, tz); }
  }
  drawNav(g, cx, cz, heading, pxPerM, W, H, ox, oy) {
    g.save();
    g.translate(ox, oy);
    g.rotate(-heading - Math.PI / 2);
    const R = Math.hypot(W, H) / pxPerM;
    g.imageSmoothingEnabled = true;
    for (let tz = Math.floor((cz - R) / 256); tz <= Math.floor((cz + R) / 256); tz++) for (let tx = Math.floor((cx - R) / 256); tx <= Math.floor((cx + R) / 256); tx++) {
      const tile = this.navTile(tx, tz);
      if (tile) g.drawImage(tile, (tx * 256 - cx) * pxPerM, (tz * 256 - cz) * pxPerM, 256 * pxPerM + 0.5, 256 * pxPerM + 0.5);
    }
    g.restore();
  }
}

// 空中写真の屋根の色を、地上から見た色に近づける
function photoRoof(rc, tmp) {
  // 空中写真の霞(だいたい R+14 G+16 B+30 の明るい青み)を差し引き、彩度を少し戻す
  let r = ((rc >> 16) & 255) - 14, g = ((rc >> 8) & 255) - 16, b = (rc & 255) - 30;
  const l = (r + g + b) / 3;
  const f = (v) => Math.max(10, Math.min(240, (l + (v - l) * 1.35) * 1.02));
  return tmp.setRGB(f(r) / 255, f(g) / 255, f(b) / 255, THREE.SRGBColorSpace).clone();
}

// ---------- 素材の絵 ----------
// つなぎ目の出ない値ノイズ(RGBA それぞれ別の周期)
function valueNoiseCanvas(N, seed) {
  const rnd = mulberry32(seed);
  const c = document.createElement('canvas'); c.width = c.height = N;
  const g = c.getContext('2d');
  const img = g.createImageData(N, N);
  const octaves = [[4, 0.15], [8, 0.2], [16, 0.22], [32, 0.2], [64, 0.13], [128, 0.1]];
  const grids = octaves.map(([n]) => [0, 1, 2, 3].map(() => Float32Array.from({ length: n * n }, rnd)));
  const sm = (t) => t * t * (3 - 2 * t);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    for (let ch = 0; ch < 4; ch++) {
      let v = 0;
      octaves.forEach(([n, w], oi) => {
        const fx = x / N * n, fy = y / N * n, i = Math.floor(fx), j = Math.floor(fy), u = sm(fx - i), t = sm(fy - j);
        const G = grids[oi][ch], at = (a, b) => G[((b % n) * n) + (a % n)];
        v += w * ((at(i, j) * (1 - u) + at(i + 1, j) * u) * (1 - t) + (at(i, j + 1) * (1 - u) + at(i + 1, j + 1) * u) * t);
      });
      // 細かい粒
      v += (rnd() - 0.5) * 0.18;
      img.data[(y * N + x) * 4 + ch] = Math.max(0, Math.min(255, v * 255));
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}
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
// 外壁の絵:4×4 マス(1 マス = 横 1 区画 × 1 階分)。0:住宅A 1:住宅B 2:町家の格子 3:集合住宅のベランダ 4:事務所の連窓
// 5:学校の大窓 6:店のガラス面 7:倉庫の波板 8:窓の並ぶ壁 9:集合住宅の1階 10:コンビニの全面ガラス 11:無地の壁 12:寺社の板壁
// 13:大きな店の上階 14:店舗併用住宅の1階(シャッター) 15:体育館の高窓
function facadeAtlas() {
  const T = 256, c = document.createElement('canvas'); c.width = c.height = T * 4;
  const g = c.getContext('2d');
  const rnd = mulberry32(9);
  const tile = (i, draw) => { g.save(); g.translate((i % 4) * T, Math.floor(i / 4) * T); g.beginPath(); g.rect(0, 0, T, T); g.clip(); draw(); g.restore(); };
  const grain = (a) => { for (let k = 0; k < 2500; k++) { g.fillStyle = `rgba(0,0,0,${rnd() * a})`; g.fillRect(rnd() * T, rnd() * T, 2, 2); } };
  const glass = (x, y, w, h, frame = '#7a8288') => {
    g.fillStyle = frame; g.fillRect(x - 5, y - 5, w + 10, h + 10);
    const gr = g.createLinearGradient(x, y, x + w, y + h); gr.addColorStop(0, '#3f5664'); gr.addColorStop(0.45, '#26343d'); gr.addColorStop(1, '#4a5f6b');
    g.fillStyle = gr; g.fillRect(x, y, w, h);
    g.fillStyle = 'rgba(220,235,245,0.16)'; g.beginPath(); g.moveTo(x, y + h * 0.7); g.lineTo(x + w * 0.35, y); g.lineTo(x + w * 0.5, y); g.lineTo(x, y + h); g.fill();
  };
  // 0 住宅A:サイディング+引き違い窓
  tile(0, () => { g.fillStyle = '#f2f2f0'; g.fillRect(0, 0, T, T); g.fillStyle = 'rgba(0,0,0,0.06)'; for (let y = 0; y < T; y += 16) g.fillRect(0, y, T, 2); grain(0.03);
    glass(64, 74, 54, 96); glass(124, 74, 54, 96); g.fillStyle = '#d6d6d2'; g.fillRect(54, 176, 134, 8); });
  // 1 住宅B:縦張り+小窓 2 つと換気口
  tile(1, () => { g.fillStyle = '#f0f0ee'; g.fillRect(0, 0, T, T); g.fillStyle = 'rgba(0,0,0,0.05)'; for (let x = 0; x < T; x += 14) g.fillRect(x, 0, 2, T); grain(0.03);
    glass(36, 90, 60, 60); glass(160, 70, 44, 96); g.fillStyle = '#b8b8b4'; g.fillRect(110, 40, 22, 22); });
  // 2 町家の格子(木の縦格子と土壁)
  tile(2, () => { g.fillStyle = '#e9e1d2'; g.fillRect(0, 0, T, T); grain(0.05);
    g.fillStyle = '#4a3527'; g.fillRect(0, 30, T, 14); g.fillRect(0, 200, T, 16);
    g.fillStyle = '#5a4030'; g.fillRect(20, 44, 216, 156); g.fillStyle = '#2b1f17';
    for (let x = 24; x < 234; x += 12) g.fillRect(x, 44, 6, 156);
    g.fillStyle = '#3b2a1f'; g.fillRect(0, 0, 10, T); g.fillRect(T - 10, 0, 10, T); });
  // 3 集合住宅のベランダ(手すりと掃き出し窓、室外機)
  tile(3, () => { g.fillStyle = '#efede7'; g.fillRect(0, 0, T, T); grain(0.03);
    glass(30, 40, 196, 150, '#8a9094'); g.fillStyle = '#e5e3dd'; g.fillRect(0, 150, T, 106);
    g.fillStyle = 'rgba(0,0,0,0.12)'; g.fillRect(0, 150, T, 4); g.fillStyle = '#c9c7c1'; g.fillRect(0, 238, T, 18);
    g.fillStyle = '#9aa0a4'; g.fillRect(190, 190, 46, 38); g.fillStyle = '#7c8286'; g.beginPath(); g.arc(213, 209, 13, 0, 7); g.fill(); });
  // 4 事務所の連窓
  tile(4, () => { g.fillStyle = '#ecebe7'; g.fillRect(0, 0, T, T); grain(0.03); glass(0, 60, T, 130, '#6d7a83');
    g.fillStyle = '#6d7a83'; for (let x = 0; x < T; x += 64) g.fillRect(x, 55, 6, 140); g.fillStyle = '#d0cfcb'; g.fillRect(0, 210, T, 14); });
  // 5 学校の大窓(緑がかったサッシ)
  tile(5, () => { g.fillStyle = '#efe9da'; g.fillRect(0, 0, T, T); grain(0.03); glass(18, 40, 220, 160, '#9aa59b');
    g.fillStyle = '#9aa59b'; g.fillRect(126, 40, 6, 160); g.fillRect(18, 118, 220, 5); g.fillStyle = '#d8d2c2'; g.fillRect(0, 214, T, 18); });
  // 6 店のガラス面(1階)
  tile(6, () => { g.fillStyle = '#d9d9d6'; g.fillRect(0, 0, T, T); glass(10, 70, 236, 186, '#a6abae');
    g.fillStyle = '#a6abae'; g.fillRect(124, 70, 8, 186); g.fillStyle = '#e8e8e6'; g.fillRect(0, 0, T, 60); g.fillStyle = 'rgba(255,240,200,0.25)'; g.fillRect(14, 160, 228, 92); });
  // 7 倉庫の波板
  tile(7, () => { g.fillStyle = '#e4e6e8'; g.fillRect(0, 0, T, T); for (let x = 0; x < T; x += 8) { g.fillStyle = x % 16 ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,255,0.25)'; g.fillRect(x, 0, 4, T); } grain(0.04); });
  // 8 窓の並ぶ壁
  tile(8, () => { g.fillStyle = '#efefec'; g.fillRect(0, 0, T, T); grain(0.03); glass(48, 60, 160, 120, '#8b9296'); g.fillStyle = '#8b9296'; g.fillRect(124, 60, 8, 120); g.fillStyle = '#d6d5d0'; g.fillRect(0, 214, T, 12); });
  // 9 集合住宅の1階(玄関と外壁タイル)
  tile(9, () => { g.fillStyle = '#e2ddd2'; g.fillRect(0, 0, T, T); g.fillStyle = 'rgba(0,0,0,0.06)'; for (let y = 0; y < T; y += 12) g.fillRect(0, y, T, 1); for (let x = 0; x < T; x += 24) g.fillRect(x, 0, 1, T);
    g.fillStyle = '#7a6a58'; g.fillRect(90, 40, 76, 216); g.fillStyle = '#c0b6a6'; g.fillRect(150, 140, 6, 22); glass(20, 70, 50, 80); });
  // 10 コンビニの全面ガラス
  tile(10, () => { g.fillStyle = '#f4f4f2'; g.fillRect(0, 0, T, T); glass(0, 60, T, 196, '#c9cdd0'); g.fillStyle = '#c9cdd0'; for (let x = 0; x < T; x += 85) g.fillRect(x, 60, 6, 196);
    g.fillStyle = 'rgba(255,250,230,0.35)'; g.fillRect(0, 150, T, 100); g.fillStyle = '#ffffff'; g.fillRect(0, 0, T, 52); });
  // 11 無地の壁
  tile(11, () => { g.fillStyle = '#ececea'; g.fillRect(0, 0, T, T); grain(0.04); g.fillStyle = 'rgba(0,0,0,0.05)'; g.fillRect(0, 0, T, 3); });
  // 12 寺社の板壁
  tile(12, () => { g.fillStyle = '#6a4d36'; g.fillRect(0, 0, T, T); for (let x = 0; x < T; x += 20) { g.fillStyle = `rgba(0,0,0,${0.12 + rnd() * 0.1})`; g.fillRect(x, 0, 3, T); }
    g.fillStyle = '#e8e2d6'; g.fillRect(0, 0, T, 50); g.fillStyle = '#4a3324'; g.fillRect(0, 50, T, 10); g.fillRect(0, 230, T, 14); });
  // 13 大きな店の上階(パネルと細い窓)
  tile(13, () => { g.fillStyle = '#ebebea'; g.fillRect(0, 0, T, T); g.fillStyle = 'rgba(0,0,0,0.07)'; for (let x = 0; x < T; x += 64) g.fillRect(x, 0, 2, T); grain(0.02); glass(20, 100, 216, 26, '#9aa0a4'); });
  // 14 店舗併用住宅の1階(シャッターと小さな店の窓)
  tile(14, () => { g.fillStyle = '#e6e2da'; g.fillRect(0, 0, T, T); g.fillStyle = '#a9adb0'; g.fillRect(20, 60, 140, 196);
    g.fillStyle = 'rgba(0,0,0,0.12)'; for (let y = 64; y < 256; y += 10) g.fillRect(20, y, 140, 2); glass(176, 90, 60, 110); g.fillStyle = '#3a4650'; g.fillRect(0, 34, T, 18); });
  // 15 体育館の高窓
  tile(15, () => { g.fillStyle = '#e8e3d6'; g.fillRect(0, 0, T, T); grain(0.03); glass(20, 30, 216, 60, '#9aa59b'); g.fillStyle = '#9aa59b'; g.fillRect(126, 30, 6, 60); });
  return c;
}
