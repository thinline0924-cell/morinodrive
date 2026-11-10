// 取り込んだ地図データ(raw/)から、ゲームが読む軽いデータ(assets/map/)を作る
// 出典:国土地理院(標高タイル・最適化ベクトルタイル)、国土交通省 PLATEAU 金沢市 2024
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import earcut from 'earcut';
import { AREA, ORIGIN, toLocal } from './area.mjs';
import { parseOSM } from './osm.mjs';

const RAW = path.join(import.meta.dirname, 'raw');
const OUT = path.join(import.meta.dirname, '../../assets/map');
fs.mkdirSync(OUT, { recursive: true });
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;

// ---------- 標高:4m → 8m(平均してならす) ----------
const { grids } = JSON.parse(fs.readFileSync(path.join(RAW, 'gsi/grids.json')));
const readF32 = (n) => new Float32Array(fs.readFileSync(path.join(RAW, `gsi/${n}.f32`)).buffer.slice(0));
function fillNaN(a, nx, nz) {
  for (let pass = 0; pass < 50; pass++) {
    let left = 0;
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (a[k] === a[k]) continue;
      let s = 0, c = 0;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) continue;
        const v = a[jj * nx + ii];
        if (v === v) { s += v; c++; }
      }
      if (c) a[k] = s / c; else left++;
    }
    if (!left) break;
  }
}
function downsample(src, g, f) {
  const nx = Math.floor((g.nx - 1) / f) + 1, nz = Math.floor((g.nz - 1) / f) + 1;
  const out = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    let s = 0, c = 0;
    for (let dj = -f; dj <= f; dj++) for (let di = -f; di <= f; di++) {
      const ii = i * f + di, jj = j * f + dj;
      if (ii < 0 || jj < 0 || ii >= g.nx || jj >= g.nz) continue;
      const w = (f + 1 - Math.abs(di)) * (f + 1 - Math.abs(dj));
      const v = src[jj * g.nx + ii];
      if (v === v) { s += v * w; c += w; }
    }
    out[j * nx + i] = c ? s / c : NaN;
  }
  return { h: out, meta: { x0: g.x0, z0: g.z0, nx, nz, spacing: g.spacing * f } };
}
async function writeHeightPng(name, h, meta) {
  const buf = Buffer.alloc(meta.nx * meta.nz * 3);
  for (let k = 0; k < h.length; k++) {
    const v = Math.max(0, Math.round(h[k] * 100));
    buf[k * 3] = (v >> 16) & 255; buf[k * 3 + 1] = (v >> 8) & 255; buf[k * 3 + 2] = v & 255;
  }
  await sharp(buf, { raw: { width: meta.nx, height: meta.nz, channels: 3 } }).png({ compressionLevel: 9 }).toFile(path.join(OUT, `${name}.png`));
}
const coreSrc = readF32('dem_core'); fillNaN(coreSrc, grids[0].nx, grids[0].nz);
const core = downsample(coreSrc, grids[0], 2);
fillNaN(core.h, core.meta.nx, core.meta.nz);
const farSrc = readF32('dem_far'); fillNaN(farSrc, grids[1].nx, grids[1].nz);
const far = downsample(farSrc, grids[1], 2);
fillNaN(far.h, far.meta.nx, far.meta.nz);
// ---------- 道路沿いに高さをならす(路面のガタつきを消す) ----------
const osm = parseOSM(JSON.parse(fs.readFileSync(path.join(RAW, 'osm.json'))));
console.log('osm drivable ways', osm.ways.length, 'signals', osm.signals.length, 'crossings', osm.crossings.length);
{
  const m = core.meta, src = Float32Array.from(core.h);
  const bil = (x, z) => {
    const fx = (x - m.x0) / m.spacing, fz = (z - m.z0) / m.spacing;
    const i = Math.max(0, Math.min(m.nx - 2, Math.floor(fx))), j = Math.max(0, Math.min(m.nz - 2, Math.floor(fz)));
    const u = Math.min(1, Math.max(0, fx - i)), v = Math.min(1, Math.max(0, fz - j)), k = j * m.nx + i;
    return (src[k] * (1 - u) + src[k + 1] * u) * (1 - v) + (src[k + m.nx] * (1 - u) + src[k + m.nx + 1] * u) * v;
  };
  const bestD = new Float32Array(m.nx * m.nz).fill(Infinity), target = new Float32Array(m.nx * m.nz), reach = new Float32Array(m.nx * m.nz);
  for (const w of osm.ways) {
    if (w.tunnel || w.bridge) continue;
    const sm = [];
    for (let i = 0; i < w.pts.length - 1; i++) {
      const [a, b] = [w.pts[i], w.pts[i + 1]];
      const n = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / 2));
      for (let k = 0; k < n; k++) sm.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
    }
    sm.push(w.pts.at(-1));
    const raw = sm.map(([x, z]) => bil(x, z));
    // 道路に沿ってなめらかに(σ ≒ 12m)
    const sig = 6, Kw = 18;
    const hs = raw.map((_, i) => { let s2 = 0, c = 0; for (let k = -Kw; k <= Kw; k++) { const j = Math.min(raw.length - 1, Math.max(0, i + k)); const g = Math.exp(-(k * k) / (2 * sig * sig)); s2 += raw[j] * g; c += g; } return s2 / c; });
    const R = w.w / 2 + 18;
    sm.forEach(([x, z], si) => {
      for (let j = Math.floor((z - R - m.z0) / m.spacing); j <= Math.ceil((z + R - m.z0) / m.spacing); j++) for (let i = Math.floor((x - R - m.x0) / m.spacing); i <= Math.ceil((x + R - m.x0) / m.spacing); i++) {
        if (i < 0 || j < 0 || i >= m.nx || j >= m.nz) continue;
        const d = Math.hypot(m.x0 + i * m.spacing - x, m.z0 + j * m.spacing - z), k = j * m.nx + i;
        if (d < bestD[k]) { bestD[k] = d; target[k] = hs[si]; reach[k] = w.w / 2; }
      }
    });
  }
  let changed = 0, maxd = 0;
  for (let k = 0; k < core.h.length; k++) {
    if (!Number.isFinite(bestD[k])) continue;
    const t = 1 - Math.min(1, Math.max(0, (bestD[k] - (reach[k] + 6)) / 10));
    if (t <= 0) continue;
    const nh = core.h[k] + (target[k] - core.h[k]) * t * t * (3 - 2 * t);
    maxd = Math.max(maxd, Math.abs(nh - core.h[k])); core.h[k] = nh; changed++;
  }
  console.log('road flattening: grid nodes changed', changed, 'max change', maxd.toFixed(2), 'm');
}
await writeHeightPng('height_core', core.h, core.meta);
await writeHeightPng('height_far', far.h, far.meta);
console.log('height core', core.meta.nx, 'x', core.meta.nz, '@', core.meta.spacing, 'm / far', far.meta.nx, 'x', far.meta.nz, '@', far.meta.spacing, 'm');

// 地形の高さ(実行時と同じ三角形の分け方で補間)
function heightAt(x, z) {
  const m = core.meta;
  const fx = (x - m.x0) / m.spacing, fz = (z - m.z0) / m.spacing;
  const i = Math.max(0, Math.min(m.nx - 2, Math.floor(fx))), j = Math.max(0, Math.min(m.nz - 2, Math.floor(fz)));
  const u = Math.min(1, Math.max(0, fx - i)), v = Math.min(1, Math.max(0, fz - j));
  const H = (a, b) => core.h[(j + b) * m.nx + i + a];
  return u + v <= 1 ? H(0, 0) + (H(1, 0) - H(0, 0)) * u + (H(0, 1) - H(0, 0)) * v
    : H(1, 1) + (H(0, 1) - H(1, 1)) * (1 - u) + (H(1, 0) - H(1, 1)) * (1 - v);
}

// ---------- 建物 ----------
const plateau = JSON.parse(fs.readFileSync(path.join(RAW, 'plateau.json')));
const area2 = (p) => { let s = 0; for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; };
function hull(pts) {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo.at(-2), lo.at(-1), q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.reverse()) { while (up.length >= 2 && cr(up.at(-2), up.at(-1), q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
// 最小外接長方形(切妻屋根の向きを決める)
function minRect(pts) {
  const h = hull(pts);
  let best = null;
  for (let i = 0; i < h.length; i++) {
    const a = h[i], b = h[(i + 1) % h.length];
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const c = Math.cos(ang), s = Math.sin(ang);
    let mnx = Infinity, mxx = -Infinity, mnz = Infinity, mxz = -Infinity;
    for (const p of h) { const u = p[0] * c + p[1] * s, v = -p[0] * s + p[1] * c; mnx = Math.min(mnx, u); mxx = Math.max(mxx, u); mnz = Math.min(mnz, v); mxz = Math.max(mxz, v); }
    const ar = (mxx - mnx) * (mxz - mnz);
    if (!best || ar < best.ar) {
      const cu = (mnx + mxx) / 2, cv = (mnz + mxz) / 2;
      let L = mxx - mnx, W = mxz - mnz, an = ang;
      if (W > L) { [L, W] = [W, L]; an += Math.PI / 2; }
      best = { ar, cx: cu * c - cv * s, cz: cu * s + cv * c, ang: an, L, W };
    }
  }
  return best;
}
const HOUSE = new Set([411, 413, 415]);
// 建物の種類(ゲーム内の外観)
const CAT = { house: 0, oldhouse: 1, apartment: 2, office: 3, school: 4, shop: 5, conv: 6, mall: 7, clinic: 8, public: 9, warehouse: 10, temple: 11, gym: 12, shed: 13, shophouse: 14, shopapt: 15 };
function poiCategory(p) {
  const a = p.amenity, sh = p.shop;
  if (sh === 'convenience') return 'conv';
  if (['supermarket', 'department_store', 'mall', 'doityourself', 'hardware', 'electronics', 'furniture'].includes(sh)) return 'mall';
  if (sh) return 'shop';
  if (['school', 'university', 'college', 'kindergarten', 'childcare'].includes(a)) return 'school';
  if (['hospital', 'clinic', 'doctors', 'dentist', 'pharmacy', 'veterinary', 'nursing_home', 'social_facility'].includes(a)) return 'clinic';
  if (['post_office', 'police', 'fire_station', 'townhall', 'library', 'community_centre', 'courthouse', 'prison'].includes(a)) return 'public';
  if (a === 'place_of_worship') return 'temple';
  if (['restaurant', 'cafe', 'fast_food', 'bank', 'fuel', 'bar', 'pub', 'car_wash', 'car_rental'].includes(a)) return 'shop';
  return null;
}
const SIGNED = new Set(['shop', 'conv', 'mall', 'clinic', 'shophouse', 'shopapt']);
// 店・施設の点を建物に割り当てる(中に入る建物、なければ 12m 以内で一番近い建物)
const poiGrid = new Map();
for (const poi of osm.pois) { const k = `${Math.floor(poi.x / 50)},${Math.floor(poi.z / 50)}`; if (!poiGrid.has(k)) poiGrid.set(k, []); poiGrid.get(k).push(poi); }
const pip = (p, x, z) => { let inside = false; for (let i = 0, j = p.length - 1; i < p.length; j = i++) if ((p[i][1] > z) !== (p[j][1] > z) && x < (p[j][0] - p[i][0]) * (z - p[i][1]) / (p[j][1] - p[i][1]) + p[i][0]) inside = !inside; return inside; };
const segDist = (p, x, z) => { let best = Infinity; for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; const dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz || 1; const t = Math.min(1, Math.max(0, ((x - a[0]) * dx + (z - a[1]) * dz) / L2)); best = Math.min(best, Math.hypot(x - a[0] - dx * t, z - a[1] - dz * t)); } return best; };
const poiOf = new Map();
{
  const bgridP = new Map();
  plateau.buildings.forEach((b, bi) => { const k = `${Math.floor(b.p[0][0] / 50)},${Math.floor(b.p[0][1] / 50)}`; if (!bgridP.has(k)) bgridP.set(k, []); bgridP.get(k).push(bi); });
  let matched = 0;
  for (const poi of osm.pois) {
    let best = null;
    for (let a = -1; a <= 1; a++) for (let c = -1; c <= 1; c++) for (const bi of bgridP.get(`${Math.floor(poi.x / 50) + a},${Math.floor(poi.z / 50) + c}`) || []) {
      const p = plateau.buildings[bi].p;
      const d = pip(p, poi.x, poi.z) ? 0 : segDist(p, poi.x, poi.z);
      if (d < 12 && (!best || d < best.d)) best = { d, bi };
    }
    if (best && !poiOf.has(best.bi)) { poiOf.set(best.bi, poi); matched++; }
  }
  console.log('pois', osm.pois.length, 'matched to buildings', matched);
}
// 一番近い道路(看板を向ける面を決める)
const roadSeg = [];
for (const w of osm.ways) for (let i = 0; i < w.pts.length - 1; i++) roadSeg.push([...w.pts[i], ...w.pts[i + 1]]);
const roadGrid = new Map();
roadSeg.forEach((sg, i) => { const k = `${Math.floor((sg[0] + sg[2]) / 2 / 60)},${Math.floor((sg[1] + sg[3]) / 2 / 60)}`; if (!roadGrid.has(k)) roadGrid.set(k, []); roadGrid.get(k).push(i); });
const roadDist = (x, z) => { let best = Infinity; for (let a = -1; a <= 1; a++) for (let c = -1; c <= 1; c++) for (const i of roadGrid.get(`${Math.floor(x / 60) + a},${Math.floor(z / 60) + c}`) || []) { const [ax, az, bx, bz] = roadSeg[i]; const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1; const t = Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / L2)); best = Math.min(best, Math.hypot(x - ax - dx * t, z - az - dz * t)); } return best; };
const buildings = [];
let gable = 0;
for (const b of plateau.buildings) {
  let p = b.p.filter((q, i, a) => i === 0 || q[0] !== a[i - 1][0] || q[1] !== a[i - 1][1]);
  if (p.length < 3) continue;
  const A = area2(p);
  if (Math.abs(A) < 4) continue;
  if (A < 0) p = p.reverse(); // 反時計回り(上から見て x 右・z 下の向きで正)にそろえる
  let h = b.h || b.mh || (b.st ? b.st * 3 : 6);
  h = Math.max(2.5, Math.min(h, 80));
  // 敷地の地面:角と内側(2m おき)を調べ、いちばん高い所を建物の床にする。低い側は基礎の壁で地面まで下ろす
  let gmax = -Infinity, gmin = Infinity;
  const probe = (x, z) => { const v = heightAt(x, z); gmax = Math.max(gmax, v); gmin = Math.min(gmin, v); };
  for (const q of p) probe(q[0], q[1]);
  for (let i = 0; i < p.length; i++) { const a = p[i], c = p[(i + 1) % p.length]; probe((a[0] + c[0]) / 2, (a[1] + c[1]) / 2); }
  {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const q of p) { x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); z0 = Math.min(z0, q[1]); z1 = Math.max(z1, q[1]); }
    for (let x = x0 + 1; x < x1; x += 2) for (let z = z0 + 1; z < z1; z += 2) {
      let inside = false;
      for (let i = 0, j = p.length - 1; i < p.length; j = i++) if ((p[i][1] > z) !== (p[j][1] > z) && x < (p[j][0] - p[i][0]) * (z - p[i][1]) / (p[j][1] - p[i][1]) + p[i][0]) inside = !inside;
      if (inside) probe(x, z);
    }
  }
  const o = { p: p.flat().map(r1), h: r1(h), g: r2(gmax), gb: r2(gmin), u: b.u || 461 };
  if (b.st) o.s = b.st;
  if (b.n) o.n = b.n;
  // ---- 種類 ----
  const Aabs = Math.abs(A);
  const poi = poiOf.get(plateau.buildings.indexOf(b));
  let cat;
  const u = b.u;
  const hr = ((Math.sin(p[0][0] * 12.9898 + p[0][1] * 78.233) * 43758.5453) % 1 + 1) % 1; // 位置から決まる乱数
  if (u === 411) cat = (b.y && b.y < 1975 && hr < 0.55) || hr > 0.92 ? 'oldhouse' : 'house';
  else if (u === 412) cat = 'apartment';
  else if (u === 413 || u === 415) cat = 'shophouse';
  else if (u === 414) cat = 'shopapt';
  else if (u === 401) cat = 'office';
  else if (u === 402 || u === 404) cat = Aabs > 2500 ? 'mall' : 'shop';
  else if (u === 403) cat = 'office';
  else if (u === 421) cat = 'public';
  else if (u === 422) cat = 'school';
  else if (u === 431 || u === 441 || u === 452) cat = 'warehouse';
  else if (u === 451) cat = 'shed';
  else cat = Aabs < 160 ? (h < 10 ? 'house' : 'apartment') : (h < 7 && (b.st || 1) <= 1 ? 'warehouse' : h > 9 ? 'apartment' : 'office');
  if (poi) cat = poiCategory(poi) || cat;
  if (cat === 'school' && Aabs > 500 && h < 15 && (b.st || 1) <= 2) cat = 'gym';
  if (cat === 'house' && Aabs > 260) cat = 'apartment';
  o.c = CAT[cat];
  // ---- 屋根:倉庫・体育館・小屋・寺社にも切妻(勾配はゲーム側で種類ごとに) ----
  if (!o.r && ['warehouse', 'gym', 'shed', 'temple', 'oldhouse', 'shophouse'].includes(cat) && Aabs < 3500 && h < 20) {
    const r = minRect(p);
    if (Aabs / r.ar > 0.78 && r.W > 3) o.r = [r1(r.cx), r1(r.cz), Math.round(r.ang * 1000) / 1000, r1(r.L), r1(r.W)];
  }
  // ---- 看板:店名を道路に面した壁に ----
  if (poi && SIGNED.has(cat)) {
    let bi = -1, bd = Infinity;
    for (let i = 0; i < p.length; i++) {
      const a = p[i], c = p[(i + 1) % p.length];
      const L = Math.hypot(c[0] - a[0], c[1] - a[1]); if (L < 3) continue;
      const nx = (c[1] - a[1]) / L, nz = -(c[0] - a[0]) / L;
      const d = roadDist((a[0] + c[0]) / 2 + nx * 3, (a[1] + c[1]) / 2 + nz * 3);
      if (d < bd) { bd = d; bi = i; }
    }
    if (bi >= 0 && bd < 40) o.sg = [bi, poi.name.slice(0, 18)];
  }
  if (HOUSE.has(o.u) && Math.abs(A) < 320 && h < 13) {
    const r = minRect(p);
    if (Math.abs(A) / r.ar > 0.8 && r.W > 3) { o.r = [r1(r.cx), r1(r.cz), Math.round(r.ang * 1000) / 1000, r1(r.L), r1(r.W)]; gable++; }
  }
  buildings.push(o);
}
console.log('buildings', buildings.length, 'with gable roof', gable, 'categories', JSON.stringify(Object.fromEntries(Object.entries(CAT).map(([k, v]) => [k, buildings.filter((b) => b.c === v).length]))), 'signs', buildings.filter((b) => b.sg).length);

// ---------- 橋(道路の面は地形に描くので、宙に浮く橋だけ形を持たせる) ----------
const bridges = [];
for (const r of plateau.roads) {
  if (r.s !== 7) continue;
  // 長い方向の両端の地面の高さを結んだ直線を路面にする
  const pts = r.p;
  const mx = pts.reduce((s, q) => s + q[0], 0) / pts.length, mz = pts.reduce((s, q) => s + q[1], 0) / pts.length;
  let sxx = 0, sxz = 0, szz = 0;
  for (const q of pts) { const dx = q[0] - mx, dz = q[1] - mz; sxx += dx * dx; sxz += dx * dz; szz += dz * dz; }
  const ang = 0.5 * Math.atan2(2 * sxz, sxx - szz);
  const ax = Math.cos(ang), az = Math.sin(ang);
  let tmin = Infinity, tmax = -Infinity;
  for (const q of pts) { const t = (q[0] - mx) * ax + (q[1] - mz) * az; tmin = Math.min(tmin, t); tmax = Math.max(tmax, t); }
  if (tmax - tmin < 6) continue;
  const ends = [tmin - 4, tmax + 4].map((t) => [mx + ax * t, mz + az * t]);
  const hs = ends.map(([x, z]) => heightAt(x, z));
  const flat = pts.flat();
  bridges.push({ p: flat.map(r1), t: earcut(flat), a: [r1(ends[0][0]), r1(ends[0][1]), r2(hs[0])], b: [r1(ends[1][0]), r1(ends[1][1]), r2(hs[1])] });
}
console.log('bridges', bridges.length);

// ---------- 地図の線(国土地理院) ----------
const vec = JSON.parse(fs.readFileSync(path.join(RAW, 'gsi/vector.json')));
const lines = [];
for (const r of vec.road) {
  if (r.p.ftCode !== 2701 && r.p.ftCode !== 2703) continue;
  for (const ls of r.c) if (ls.length >= 2) lines.push({ w: r.p.rnkWidth, c: r.p.rdCtg, m: r.p.medSect ? 1 : 0, p: ls.flat() });
}
const water = [];
for (const w of vec.waterarea) {
  const flat = [], holes = [];
  for (const ring of w.c) { if (flat.length) holes.push(flat.length / 2); for (const q of ring) flat.push(q[0], q[1]); }
  const tri = earcut(flat, holes.length ? holes : null);
  if (tri.length) water.push({ v: flat, i: tri });
}
const rivers = vec.river.filter((r) => r.t.includes('Line')).flatMap((r) => r.c.map((ls) => ls.flat()));
console.log('center lines', lines.length, 'water polygons', water.length, 'river lines', rivers.length);

// ---------- 町名(住居表示板) ----------
const KANA = { きゃ: 'kya', きゅ: 'kyu', きょ: 'kyo', しゃ: 'sha', しゅ: 'shu', しょ: 'sho', ちゃ: 'cha', ちゅ: 'chu', ちょ: 'cho', にゃ: 'nya', にゅ: 'nyu', にょ: 'nyo', ひゃ: 'hya', ひゅ: 'hyu', ひょ: 'hyo', みゃ: 'mya', みゅ: 'myu', みょ: 'myo', りゃ: 'rya', りゅ: 'ryu', りょ: 'ryo', ぎゃ: 'gya', ぎゅ: 'gyu', ぎょ: 'gyo', じゃ: 'ja', じゅ: 'ju', じょ: 'jo', びゃ: 'bya', びゅ: 'byu', びょ: 'byo', ぴゃ: 'pya', ぴゅ: 'pyu', ぴょ: 'pyo' };
const K1 = 'あa い i う u え e お o か ka き ki く ku け ke こ ko さ sa し shi す su せ se そ so た ta ち chi つ tsu て te と to な na に ni ぬ nu ね ne の no は ha ひ hi ふ fu へ he ほ ho ま ma み mi む mu め me も mo や ya ゆ yu よ yo ら ra り ri る ru れ re ろ ro わ wa を o ん n が ga ぎ gi ぐ gu げ ge ご go ざ za じ ji ず zu ぜ ze ぞ zo だ da ぢ ji づ zu で de ど do ば ba び bi ぶ bu べ be ぼ bo ぱ pa ぴ pi ぷ pu ぺ pe ぽ po'.replace('あa', 'あ a').split(' ');
const K = {}; for (let i = 0; i < K1.length; i += 2) K[K1[i]] = K1[i + 1];
function romaji(kana) {
  let s = '';
  for (let i = 0; i < kana.length; i++) {
    const two = kana.slice(i, i + 2);
    if (KANA[two]) { s += KANA[two]; i++; continue; }
    const c = kana[i];
    if (c === 'っ') { const nx = KANA[kana.slice(i + 1, i + 3)] || K[kana[i + 1]] || ''; s += nx[0] || ''; continue; }
    if (c === 'ー') continue;
    s += K[c] ?? c;
  }
  return s.charAt(0).toUpperCase() + s.slice(1);
}
const NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const readings = {};
for (const l of vec.label) {
  if (l.p.annoCtg !== 210 || !l.p.kana) continue;
  const base = l.p.knj.replace(/（.*）$/, '');
  readings[base] = l.p.kana.replace(/[0-9０-９]+ちょうめ$/, '').replace(/ちょうめ$/, '');
}
const places = [];
const seenPlace = new Set();
for (const l of vec.label) {
  if (l.p.annoCtg !== 800 || seenPlace.has(l.p.knj)) continue;
  seenPlace.add(l.p.knj);
  const m = l.p.knj.match(/^(.+?)([一二三四五六七八九])丁目$/);
  const base = m ? m[1] : l.p.knj;
  const kana = readings[base];
  let roman = kana ? romaji(kana) : '';
  if (roman && m) roman += ` ${NUM[m[2]]}-chome`;
  places.push({ n: l.p.knj, r: roman, x: l.c[0][0], z: l.c[0][1] });
}
console.log('places', places.length, places.filter((p) => p.r).length, 'with romaji;', places.slice(0, 6).map((p) => `${p.n}=${p.r}`).join(', '));

// ---------- 土地の区分(1m):0 地面 1 道路 2 橋 3 水 4 建物 ----------
const MASK = { x0: Math.floor(toLocal(AREA.lat0, AREA.lon0 - 0.0025)[0]), z0: Math.floor(toLocal(AREA.lat1 + 0.002, AREA.lon0)[1]) };
MASK.x1 = Math.ceil(toLocal(AREA.lat0, AREA.lon1 + 0.0025)[0]); MASK.z1 = Math.ceil(toLocal(AREA.lat0 - 0.002, AREA.lon0)[1]);
MASK.w = MASK.x1 - MASK.x0; MASK.h = MASK.z1 - MASK.z0;
{
  const P = (flat) => { let s = ''; for (let i = 0; i < flat.length; i += 2) s += `${(flat[i] - MASK.x0).toFixed(1)},${(flat[i + 1] - MASK.z0).toFixed(1)} `; return s; };
  const g = (v) => `rgb(${v},${v},${v})`;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${MASK.w}" height="${MASK.h}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="${g(0)}"/>`;
  for (const w of water) { /* 水面は三角形で */ for (let t = 0; t < w.i.length; t += 3) svg += `<polygon points="${P([w.v[w.i[t] * 2], w.v[w.i[t] * 2 + 1], w.v[w.i[t + 1] * 2], w.v[w.i[t + 1] * 2 + 1], w.v[w.i[t + 2] * 2], w.v[w.i[t + 2] * 2 + 1]])}" fill="${g(3)}"/>`; }
  for (const r of plateau.roads) svg += `<path d="${[r.p, ...(r.hl || [])].map((ring) => 'M' + ring.map((q) => `${(q[0] - MASK.x0).toFixed(1)},${(q[1] - MASK.z0).toFixed(1)}`).join('L') + 'Z').join('')}" fill-rule="evenodd" fill="${g(1)}"/>`;
  for (const b of bridges) svg += `<polygon points="${P(b.p)}" fill="${g(2)}"/>`;
  for (const b of buildings) svg += `<polygon points="${P(b.p)}" fill="${g(4)}"/>`;
  svg += '</svg>';
  const raw = await sharp(Buffer.from(svg), { limitInputPixels: false }).extractChannel(0).raw().toBuffer();
  // 車道:OpenStreetMap の道路の中心線を車道の幅で太らせる(PLATEAU の道路の面の外にははみ出さない)
  const LP = (pts) => pts.map((q) => `${(q[0] - MASK.x0).toFixed(1)},${(q[1] - MASK.z0).toFixed(1)}`).join(' ');
  const strokeSvg = (items) => `<svg xmlns="http://www.w3.org/2000/svg" width="${MASK.w}" height="${MASK.h}"><rect width="100%" height="100%" fill="#000"/>${items.map(([pts, w]) => `<polyline points="${LP(pts)}" fill="none" stroke="#fff" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round"/>`).join('')}</svg>`;
  const render = async (svgText) => sharp(Buffer.from(svgText), { limitInputPixels: false }).extractChannel(0).raw().toBuffer();
  const carr = await render(strokeSvg(osm.ways.filter((w) => !w.tunnel).map((w) => [w.pts, w.w])));
  // OSM に無い細い道は、国土地理院の中心線から幅 4.5m で補う
  const near = await render(strokeSvg(osm.ways.map((w) => [w.pts, 16])));
  const nearAt = (x, z) => { const i = Math.floor(x - MASK.x0), j = Math.floor(z - MASK.z0); return i >= 0 && j >= 0 && i < MASK.w && j < MASK.h && near[j * MASK.w + i] > 127; };
  const extra = [];
  for (const ln of lines) for (let i = 0; i + 3 < ln.p.length; i += 2) {
    const mx = (ln.p[i] + ln.p[i + 2]) / 2, mz = (ln.p[i + 1] + ln.p[i + 3]) / 2;
    if (!nearAt(mx, mz)) extra.push([[[ln.p[i], ln.p[i + 1]], [ln.p[i + 2], ln.p[i + 3]]], 4.5]);
  }
  const carr2 = await render(strokeSvg(extra));
  // 道路の面(なめらかな縁):境目のギザギザを減らすため、ここだけはアンチエイリアスありで描く
  const roadAA = await render(`<svg xmlns="http://www.w3.org/2000/svg" width="${MASK.w}" height="${MASK.h}"><rect width="100%" height="100%" fill="#000"/>${plateau.roads.map((r) => `<path d="${[r.p, ...(r.hl || [])].map((ring) => 'M' + ring.map((q) => `${(q[0] - MASK.x0).toFixed(2)},${(q[1] - MASK.z0).toFixed(2)}`).join('L') + 'Z').join('')}" fill-rule="evenodd" fill="#fff"/>`).join('')}${bridges.map((b) => `<polygon points="${P(b.p)}" fill="#000"/>`).join('')}</svg>`);
  let cPix = 0, sPix = 0;
  // ゲーム用:R 車道 G 水面(255)/歩道など道路の残り(128) B 建物(255)とその周りの敷地(距離で薄くなる)
  const N = MASK.w * MASK.h;
  const dist = new Float32Array(N).fill(1e9);
  for (let k = 0; k < N; k++) if (raw[k] === 4) dist[k] = 0;
  const W2 = MASK.w;
  for (let j = 0; j < MASK.h; j++) for (let i = 0; i < W2; i++) { const k = j * W2 + i; if (i) dist[k] = Math.min(dist[k], dist[k - 1] + 1); if (j) dist[k] = Math.min(dist[k], dist[k - W2] + 1); if (i && j) dist[k] = Math.min(dist[k], dist[k - W2 - 1] + 1.414); if (j && i < W2 - 1) dist[k] = Math.min(dist[k], dist[k - W2 + 1] + 1.414); }
  for (let j = MASK.h - 1; j >= 0; j--) for (let i = W2 - 1; i >= 0; i--) { const k = j * W2 + i; if (i < W2 - 1) dist[k] = Math.min(dist[k], dist[k + 1] + 1); if (j < MASK.h - 1) dist[k] = Math.min(dist[k], dist[k + W2] + 1); if (i < W2 - 1 && j < MASK.h - 1) dist[k] = Math.min(dist[k], dist[k + W2 + 1] + 1.414); if (j < MASK.h - 1 && i) dist[k] = Math.min(dist[k], dist[k + W2 - 1] + 1.414); }
  const rgb = Buffer.alloc(N * 3);
  for (let k = 0; k < N; k++) {
    const v = raw[k];
    // 車道 = 中心線を太らせた形と道路の面の重なり(どちらも縁はなめらか)。橋は別の形で描くので地形には塗らない
    const ra = v === 4 ? 0 : roadAA[k];
    const cr = Math.min(ra, Math.max(carr[k], carr2[k]));
    rgb[k * 3] = cr;
    rgb[k * 3 + 1] = v === 3 && ra < 128 ? 255 : Math.round(Math.max(0, ra - cr) / 2);
    if (cr > 127) cPix++; else if (ra > 127) sPix++;
    rgb[k * 3 + 2] = v === 4 ? 255 : dist[k] < 7 ? Math.round(190 * (1 - dist[k] / 7)) : 0;
  }
  await sharp(rgb, { raw: { width: MASK.w, height: MASK.h, channels: 3 }, limitInputPixels: false }).png({ compressionLevel: 9 }).toFile(path.join(OUT, 'land.png'));
  const hist = [0, 0, 0, 0, 0]; for (const v of raw) hist[Math.min(4, v)]++;
  console.log('land mask', MASK.w, 'x', MASK.h, 'histogram', hist.join(' '), '/ carriageway', cPix, 'sidewalk etc', sPix, '/ gsi fallback segments', extra.length);
  globalThis.__mask = raw;
  globalThis.__rgb = rgb;
}

// ---------- 土地利用(2m):0 その他 1 田 2 畑 3 山林 4 その他の自然地 5 公園・緑地 6 住宅地 7 商業・公益・工業 8 空地・農業施設 ----------
const mask = globalThis.__mask;
const maskAt = (x, z) => { const i = Math.floor(x - MASK.x0), j = Math.floor(z - MASK.z0); if (i < 0 || j < 0 || i >= MASK.w || j >= MASK.h) return -1; return mask[j * MASK.w + i]; };
const LU = { 201: 1, 202: 2, 203: 3, 205: 4, 217: 5, 211: 6, 212: 7, 213: 7, 214: 7, 216: 7, 218: 7, 219: 8, 263: 8 };
const LUW = Math.ceil(MASK.w / 2), LUH = Math.ceil(MASK.h / 2);
let luse;
{
  const polys = JSON.parse(fs.readFileSync(path.join(RAW, 'luse.json')));
  const byCat = new Map();
  for (const pl of polys) { const c = LU[pl.c]; if (!c) continue; if (!byCat.has(c)) byCat.set(c, []); byCat.get(c).push(pl.r); }
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${LUW}" height="${LUH}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#000"/>`;
  for (const [c, list] of byCat) {
    const v = c * 28;
    svg += `<path fill-rule="evenodd" fill="rgb(${v},${v},${v})" d="${list.map((rings) => rings.map((ring) => 'M' + ring.map((q) => `${((q[0] - MASK.x0) / 2).toFixed(1)},${((q[1] - MASK.z0) / 2).toFixed(1)}`).join('L') + 'Z').join('')).join('')}"/>`;
  }
  svg += '</svg>';
  luse = await sharp(Buffer.from(svg), { limitInputPixels: false }).extractChannel(0).raw().toBuffer();
  await sharp(luse, { raw: { width: LUW, height: LUH, channels: 1 } }).png({ compressionLevel: 9 }).toFile(path.join(OUT, 'landuse.png'));
  const hist = new Array(9).fill(0); for (const v of luse) hist[Math.round(v / 28)]++;
  console.log('landuse', LUW, 'x', LUH, hist.map((v, i) => `${i}:${(v * 4 / 1e6).toFixed(2)}km2`).join(' '));
}
const luAt = (x, z) => { const i = Math.floor((x - MASK.x0) / 2), j = Math.floor((z - MASK.z0) / 2); if (i < 0 || j < 0 || i >= LUW || j >= LUH) return -1; return Math.round(luse[j * LUW + i] / 28); };

// ---------- 木と植え込み:[x, z, 乱数, 種類] 種類 0 杉 1 広葉樹 2 庭木 3 低木 ----------
const bgrid = new Map();
for (const b of buildings) { const k = `${Math.floor(b.p[0] / 40)},${Math.floor(b.p[1] / 40)}`; bgrid.set(k, (bgrid.get(k) || 0) + 1); }
let seed = 12345; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const trees = [];
const m = core.meta;
const clearOf = (x, z, r) => { for (const [dx, dz] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r], [r * 0.7, r * 0.7], [-r * 0.7, -r * 0.7], [r * 0.7, -r * 0.7], [-r * 0.7, r * 0.7]]) { const v = maskAt(x + dx, z + dz); if (v > 0) return false; } return true; };
const chanB = (x, z) => { const i = Math.floor(x - MASK.x0), j = Math.floor(z - MASK.z0); if (i < 0 || j < 0 || i >= MASK.w || j >= MASK.h) return 0; return globalThis.__rgb[(j * MASK.w + i) * 3 + 2]; };
const xEnd = m.x0 + (m.nx - 3) * m.spacing, zEnd = m.z0 + (m.nz - 3) * m.spacing;
// 林・公園・自然地
for (let z = m.z0 + 20; z < zEnd; z += 9) for (let x = m.x0 + 20; x < xEnd; x += 9) {
  const px = x + (rnd() - 0.5) * 8, pz = z + (rnd() - 0.5) * 8;
  const lu = luAt(px, pz);
  let prob;
  if (lu === -1 || lu === 0) {
    // 土地利用の範囲の外:斜面と建物の少ない所を林に
    const h0 = heightAt(px, pz);
    const slope = Math.hypot(heightAt(px + 6, pz) - heightAt(px - 6, pz), heightAt(px, pz + 6) - heightAt(px, pz - 6)) / 12;
    let nearB = 0; for (let a = -1; a <= 1; a++) for (let c = -1; c <= 1; c++) nearB += bgrid.get(`${Math.floor(px / 40) + a},${Math.floor(pz / 40) + c}`) || 0;
    prob = (slope > 0.22 || (h0 > 75 && nearB < 3) || nearB === 0) ? (lu === -1 ? 0.55 : 0.35) : 0;
  } else prob = { 3: 0.9, 4: 0.18, 5: 0.14, 1: 0, 2: 0.01, 6: 0, 7: 0.02, 8: 0.05 }[lu] ?? 0;
  if (rnd() >= prob || !clearOf(px, pz, 3)) continue;
  const type = lu === 3 || lu === -1 || lu === 0 ? (rnd() < 0.55 ? 0 : 1) : 1;
  trees.push(Math.round(px), Math.round(pz), Math.floor(rnd() * 255), type);
}
const nForest = trees.length / 4;
// 住宅地の庭:建物のまわりの敷地(道路と建物の外)に庭木と低木
for (let z = m.z0 + 20; z < zEnd; z += 5) for (let x = m.x0 + 20; x < xEnd; x += 5) {
  const px = x + (rnd() - 0.5) * 4, pz = z + (rnd() - 0.5) * 4;
  const lu = luAt(px, pz);
  if (lu !== 6 && lu !== 7 && lu !== 5) continue;
  const bv = chanB(px, pz);
  if (bv < 30 || bv > 200) continue;
  if (rnd() > (lu === 6 ? 0.5 : 0.15) || !clearOf(px, pz, 1.2)) continue;
  trees.push(Math.round(px), Math.round(pz), Math.floor(rnd() * 255), rnd() < 0.35 ? 2 : 3);
}
console.log('trees', nForest, 'garden plants', trees.length / 4 - nForest);

// ---------- 区画線・電柱:中心線から左右に道路の面の端を探して幅を測る ----------
const isRoad = (x, z) => { const v = maskAt(x, z); return v === 1 || v === 2; };
const markings = [], poles = [], wires = [];
let lineIdx = -1, lastPole = null;
let poleAcc = 0, poleSide = 1;
for (const ln of lines) {
  lineIdx++;
  if (ln.w < 1) continue;
  const pts = []; for (let i = 0; i < ln.p.length; i += 2) pts.push([ln.p[i], ln.p[i + 1]]);
  // 2m おきに並べ直す
  const sm = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [a, b] = [pts[i], pts[i + 1]];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.round(L / 2));
    for (let k = 0; k < n; k++) sm.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n, Math.atan2(b[1] - a[1], b[0] - a[0])]);
  }
  sm.push([...pts.at(-1), sm.length ? sm.at(-1)[2] : 0]);
  if (sm.length < 3) continue;
  const probe = (x, z, nx, nz) => { let d = 0; while (d < 14 && isRoad(x + nx * d, z + nz * d)) d += 0.25; return d; };
  const W = sm.map(([x, z, a]) => { const nx = -Math.sin(a), nz = Math.cos(a); return isRoad(x, z) ? [probe(x, z, -nx, -nz), probe(x, z, nx, nz)] : [0, 0]; });
  const med = (arr, i, k) => { const s2 = []; for (let j = Math.max(0, i - 5); j <= Math.min(arr.length - 1, i + 5); j++) s2.push(arr[j][k]); s2.sort((a, b) => a - b); return s2[s2.length >> 1]; };
  const ok = W.map((w, i) => w[0] > 0.8 && w[1] > 0.8 && w[0] < med(W, i, 0) * 1.35 + 0.3 && w[1] < med(W, i, 1) * 1.35 + 0.3);
  const runs = (fn) => { const out = []; let cur = []; sm.forEach((s3, i) => { const p = ok[i] ? fn(s3, i) : null; if (p) cur.push(p[0], p[1]); else { if (cur.length >= 6) out.push(cur); cur = []; } }); if (cur.length >= 6) out.push(cur); return out; };
  const total = (w) => w[0] + w[1];
  // 電柱:だいたい 35m おき、道路の外の地面に
  for (let i = 0; i < sm.length; i++) {
    poleAcc += 2;
    if (poleAcc < 35 || !ok[i]) continue;
    const [x, z, a] = sm[i];
    const d = W[i][poleSide < 0 ? 0 : 1] + 0.5;
    const px = x - Math.sin(a) * d * poleSide, pz = z + Math.cos(a) * d * poleSide;
    let clear = true;
    for (const [dx, dz] of [[0, 0], [0.6, 0], [-0.6, 0], [0, 0.6], [0, -0.6]]) if (maskAt(px + dx, pz + dz) !== 0) clear = false;
    if (!clear) continue;
    const pi = poles.length / 3;
    poles.push(r1(px), r1(pz), Math.round(((a + Math.PI) / (2 * Math.PI)) * 255));
    if (lastPole && lastPole.line === lineIdx && Math.hypot(lastPole.x - px, lastPole.z - pz) < 55) wires.push(lastPole.i, pi);
    lastPole = { i: pi, x: px, z: pz, line: lineIdx };
    poleAcc = 0; poleSide = -poleSide;
  }
}
// ---------- 区画線(OpenStreetMap の車線数・一方通行・道路の種類から) ----------
const MAJOR = new Set(['trunk', 'primary', 'secondary', 'trunk_link', 'primary_link', 'secondary_link', 'motorway']);
// 交差点の手前で線を切る距離
const trimAt = new Map();
for (const id of osm.junction) {
  let mw = 0;
  for (const w of osm.ways) if (w.nodes.includes(id)) mw = Math.max(mw, w.w);
  trimAt.set(id, mw / 2 + 2.5);
}
const offsetLine = (sm, off) => {
  const pts = sm.map(([x, z, a]) => [x - Math.sin(a) * off, z + Math.cos(a) * off]);
  // まっすぐな所は点を間引く(向きの変化 0.6° 未満、最大 4m)。地形に沿わせるため 4m より長くはしない
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out.at(-1), b = pts[i], c = pts[i + 1];
    const a1 = Math.atan2(b[1] - a[1], b[0] - a[0]), a2 = Math.atan2(c[1] - b[1], c[0] - b[0]);
    let d = Math.abs(a1 - a2); if (d > Math.PI) d = 2 * Math.PI - d;
    if (d > 0.01 || Math.hypot(c[0] - a[0], c[1] - a[1]) > 4) out.push(b);
  }
  out.push(pts.at(-1));
  return out;
};
for (const w of osm.ways) {
  if (w.tunnel) continue;
  // 1m おきに並べ、交差点の近くは使わない
  const sm = [];
  const jPts = w.nodes.map((id, i) => (trimAt.has(id) ? [w.pts[i], trimAt.get(id)] : null)).filter(Boolean);
  for (let i = 0; i < w.pts.length - 1; i++) {
    const [a, b] = [w.pts[i], w.pts[i + 1]];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.round(L));
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    for (let k = 0; k < n; k++) {
      const x = a[0] + (b[0] - a[0]) * k / n, z = a[1] + (b[1] - a[1]) * k / n;
      const cut = jPts.some(([q, t]) => Math.hypot(q[0] - x, q[1] - z) < t);
      sm.push(cut ? null : [x, z, ang]);
    }
  }
  const runs = [];
  let cur = [];
  for (const q of sm) { if (q) cur.push(q); else { if (cur.length > 4) runs.push(cur); cur = []; } }
  if (cur.length > 4) runs.push(cur);
  const major = MAJOR.has(w.hw);
  for (const run of runs) {
    const push = (style, off) => markings.push({ s: style, p: offsetLine(run, off).flat().map(r1) });
    if (!w.oneway && w.w >= 5.5 && (w.lanes >= 2 || major)) {
      push(w.lanes >= 4 || major ? 'yellow' : 'dash', 0);
      const per = Math.floor(w.lanes / 2);
      for (let k = 1; k < per; k++) { push('lane', k * w.laneW); push('lane', -k * w.laneW); }
    }
    if (w.oneway && w.lanes >= 2) for (let k = 1; k < w.lanes; k++) push('lane', -w.lanes * w.laneW / 2 + k * w.laneW);
    if (w.w >= 5.5 && (major || w.lanes >= 2 || w.hw === 'tertiary')) { push('edge', w.w / 2 - 0.35); push('edge', -(w.w / 2 - 0.35)); }
  }
}
// 横断歩道(しま模様)
const crosswalks = [];
for (const c of osm.crossings) {
  const w = osm.ways.find((ww) => ww.nodes.includes(c.id));
  if (!w || w.w < 4.5 || w.tunnel) continue;
  const i = w.nodes.indexOf(c.id);
  const a = w.pts[Math.max(0, i - 1)], b = w.pts[Math.min(w.pts.length - 1, i + 1)];
  crosswalks.push([r1(c.xz[0]), r1(c.xz[1]), Math.round(Math.atan2(b[1] - a[1], b[0] - a[0]) * 1000) / 1000, r1(w.w)]);
}
// 信号機と停止線:信号のノードごとに、そこへ入ってくる方向それぞれに1基
const signals = [], stops = [];
const groups = [];
for (const sgn of osm.signals) {
  const inc = [];
  for (const w of osm.ways) {
    const i = w.nodes.indexOf(sgn.id);
    if (i < 0 || w.tunnel) continue;
    const P = w.pts[i];
    // 手前側の向き(ノードから離れる向き)。そこから来る車が信号を見る
    if (i > 0) inc.push({ w, back: w.pts[i - 1], fwdAllowed: true });
    if (i < w.pts.length - 1) inc.push({ w, back: w.pts[i + 1], fwdAllowed: !w.oneway });
  }
  if (!inc.length) continue;
  let g = groups.find((q) => Math.hypot(q[0] - sgn.xz[0], q[1] - sgn.xz[1]) < 40);
  if (!g) { g = [sgn.xz[0], sgn.xz[1], groups.length]; groups.push(g); }
  const span = Math.max(...inc.map((q) => q.w.w));
  const a0 = Math.atan2(sgn.xz[1] - inc[0].back[1], sgn.xz[0] - inc[0].back[0]);
  for (const q of inc) {
    if (!q.fwdAllowed) continue;
    const L = Math.hypot(sgn.xz[0] - q.back[0], sgn.xz[1] - q.back[1]) || 1;
    const tx = (sgn.xz[0] - q.back[0]) / L, tz = (sgn.xz[1] - q.back[1]) / L; // 進む向き
    const lx = tz, lz = -tx; // 進む向きの左
    const ang = Math.atan2(tz, tx);
    const phase = Math.abs(Math.cos(ang - a0)) > 0.7 ? 0 : 1;
    const far = span / 2 + 3;
    const hw = q.w.oneway ? q.w.w / 2 : q.w.w / 2;
    // 交差点の向こう側、左の路肩に柱。腕を道路の上へ出して、灯器は左側の車線の上
    const px = sgn.xz[0] + tx * far + lx * (hw + 1.0), pz = sgn.xz[1] + tz * far + lz * (hw + 1.0);
    const hx = sgn.xz[0] + tx * far + lx * (q.w.oneway ? 0 : hw / 2), hz = sgn.xz[1] + tz * far + lz * (q.w.oneway ? 0 : hw / 2);
    signals.push([r1(px), r1(pz), r1(hx), r1(hz), Math.round(ang * 1000) / 1000, phase, g[2]]);
    // 停止線:交差点の手前、左側の車線を横切る
    const d = span / 2 + 4.5;
    const cx = sgn.xz[0] - tx * d + lx * (q.w.oneway ? 0 : hw / 2), cz = sgn.xz[1] - tz * d + lz * (q.w.oneway ? 0 : hw / 2);
    stops.push([r1(cx), r1(cz), Math.round(ang * 1000) / 1000, r1(q.w.oneway ? q.w.w - 0.6 : hw - 0.3)]);
  }
}
console.log('markings', markings.length, 'crosswalks', crosswalks.length, 'signal heads', signals.length, 'intersections', groups.length, 'stop lines', stops.length, 'poles', poles.length / 3);

const meta = {
  source: '出典:国土地理院(地理院タイル 標高・最適化ベクトルタイル・シームレス空中写真)、国土交通省 PLATEAU 金沢市 2024、© OpenStreetMap contributors(ODbL)。加工して作成',
  origin: ORIGIN, area: AREA,
  height: { core: core.meta, far: far.meta, scale: 0.01 },
  land: { x0: MASK.x0, z0: MASK.z0, w: MASK.w, h: MASK.h },
  landuse: { x0: MASK.x0, z0: MASK.z0, w: LUW, h: LUH, cell: 2 },
  photo: fs.existsSync(path.join(RAW, 'photo/bounds.json')) ? JSON.parse(fs.readFileSync(path.join(RAW, 'photo/bounds.json'))) : null,
};
fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify(meta, null, 1));
fs.writeFileSync(path.join(OUT, 'buildings.json'), JSON.stringify(buildings));
// ---------- 縁石:車道の縁のうち、歩道や中央分離帯に接する所 ----------
const RGB = globalThis.__rgb;
const chan = (x, z, c) => { const i = Math.floor(x - MASK.x0), j = Math.floor(z - MASK.z0); if (i < 0 || j < 0 || i >= MASK.w || j >= MASK.h) return 0; return RGB[(j * MASK.w + i) * 3 + c]; };
const curbs = [];
{
  const W = MASK.w, Hh = MASK.h;
  const R = (i, j) => RGB[(j * W + i) * 3];
  const segs = new Map(); // 端点 → 線分
  const key = (x, z) => `${Math.round(x * 4)},${Math.round(z * 4)}`;
  const list = [];
  for (let j = 0; j < Hh - 1; j++) for (let i = 0; i < W - 1; i++) {
    const a = R(i, j), b = R(i + 1, j), c = R(i + 1, j + 1), d = R(i, j + 1);
    const T = 128;
    const idx = (a > T ? 1 : 0) | (b > T ? 2 : 0) | (c > T ? 4 : 0) | (d > T ? 8 : 0);
    if (idx === 0 || idx === 15) continue;
    const pts = [];
    const e = (p, q, x0, z0, x1, z1) => { if ((p > T) !== (q > T)) { const t = (T - p) / (q - p); pts.push([MASK.x0 + 0.5 + x0 + (x1 - x0) * t, MASK.z0 + 0.5 + z0 + (z1 - z0) * t]); } };
    e(a, b, i, j, i + 1, j); e(b, c, i + 1, j, i + 1, j + 1); e(c, d, i + 1, j + 1, i, j + 1); e(d, a, i, j + 1, i, j);
    for (let k = 0; k + 1 < pts.length; k += 2) list.push([pts[k], pts[k + 1]]);
  }
  // 歩道側(R が小さい側)に歩道・分離帯があるかを見て、縁石にする線分だけ残す
  const keep = list.filter(([p, q]) => {
    const mx = (p[0] + q[0]) / 2, mz = (p[1] + q[1]) / 2;
    const dx = q[0] - p[0], dz = q[1] - p[1], L = Math.hypot(dx, dz) || 1;
    const nx = -dz / L, nz = dx / L;
    const r1v = chan(mx + nx * 1.2, mz + nz * 1.2, 0), r2v = chan(mx - nx * 1.2, mz - nz * 1.2, 0);
    const sx = r1v < r2v ? nx : -nx, sz = r1v < r2v ? nz : -nz; // 車道でない側
    const g = chan(mx + sx * 1.0, mz + sz * 1.0, 1), b = chan(mx + sx * 1.0, mz + sz * 1.0, 2);
    return g > 40 && g < 200 && b < 250;
  });
  // つないで折れ線に
  const adj = new Map();
  keep.forEach((s3, i) => { for (const q of s3) { const k = key(...q); if (!adj.has(k)) adj.set(k, []); adj.get(k).push(i); } });
  const used = new Uint8Array(keep.length);
  for (let i = 0; i < keep.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const line = [keep[i][0], keep[i][1]];
    for (const dir of [1, 0]) {
      for (;;) {
        const end = dir ? line.at(-1) : line[0];
        const nb = (adj.get(key(...end)) || []).find((k) => !used[k]);
        if (nb === undefined) break;
        used[nb] = 1;
        const [p, q] = keep[nb];
        const nxt = key(...p) === key(...end) ? q : p;
        if (dir) line.push(nxt); else line.unshift(nxt);
      }
    }
    // 間引き(Douglas-Peucker 0.25m)
    const dp = (pts) => {
      if (pts.length < 3) return pts;
      const [a, b] = [pts[0], pts.at(-1)];
      let mi = 0, md = 0;
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1e-9;
      for (let k = 1; k < pts.length - 1; k++) { const d = Math.abs((b[0] - a[0]) * (a[1] - pts[k][1]) - (a[0] - pts[k][0]) * (b[1] - a[1])) / L; if (d > md) { md = d; mi = k; } }
      return md > 0.25 ? dp(pts.slice(0, mi + 1)).slice(0, -1).concat(dp(pts.slice(mi))) : [a, b];
    };
    const simp = dp(line);
    let len = 0; for (let k = 1; k < simp.length; k++) len += Math.hypot(simp[k][0] - simp[k - 1][0], simp[k][1] - simp[k - 1][1]);
    if (len >= 3) curbs.push(simp.flat().map(r1));
  }
  let total = 0, nseg = 0; for (const c of curbs) { nseg += c.length / 2 - 1; for (let k = 2; k < c.length; k += 2) total += Math.hypot(c[k] - c[k - 2], c[k + 1] - c[k - 1]); }
  console.log('curbs', curbs.length, 'lines', nseg, 'segments', (total / 1000).toFixed(1), 'km');
}

// ---------- 中央分離帯:向きが逆の一方通行が平行に並ぶ所 ----------
const medians = [];
{
  const ones = osm.ways.filter((w) => w.oneway && !w.tunnel && !w.hw.endsWith('_link'));
  const samples = [];
  ones.forEach((w, wi) => { for (let i = 0; i < w.pts.length - 1; i++) { const [a, b] = [w.pts[i], w.pts[i + 1]]; const L = Math.hypot(b[0] - a[0], b[1] - a[1]); const n = Math.max(1, Math.round(L / 4)); const ang = Math.atan2(b[1] - a[1], b[0] - a[0]); for (let k = 0; k < n; k++) samples.push({ wi, x: a[0] + (b[0] - a[0]) * k / n, z: a[1] + (b[1] - a[1]) * k / n, ang }); } });
  const grid = new Map(); const gk = (x, z) => `${Math.floor(x / 30)},${Math.floor(z / 30)}`;
  samples.forEach((sm, i) => { const k = gk(sm.x, sm.z); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); });
  const mids = [];
  for (const sm of samples) {
    let best = null;
    for (let a = -1; a <= 1; a++) for (let c = -1; c <= 1; c++) for (const i of grid.get(`${Math.floor(sm.x / 30) + a},${Math.floor(sm.z / 30) + c}`) || []) {
      const o = samples[i]; if (o.wi === sm.wi) continue;
      if (Math.cos(o.ang - sm.ang) > -0.85) continue;
      const d = Math.hypot(o.x - sm.x, o.z - sm.z);
      if (d < 4 || d > 26) continue;
      // 横に並んでいる(前後ではない)
      const along = Math.abs((o.x - sm.x) * Math.cos(sm.ang) + (o.z - sm.z) * Math.sin(sm.ang));
      if (along > 3) continue;
      if (!best || d < best.d) best = { d, o };
    }
    if (!best) continue;
    const w1 = ones[sm.wi].w, w2 = ones[best.o.wi].w;
    const mw = best.d - w1 / 2 - w2 / 2;
    if (mw < 1.0) continue;
    const mx = (sm.x + best.o.x) / 2, mz = (sm.z + best.o.z) / 2;
    // 分離帯の中が本当に車道でないか
    if (chan(mx, mz, 0) > 100) continue;
    mids.push({ x: mx, z: mz, ang: sm.ang, w: mw });
  }
  // 近い点をつないで帯にする(向きのそろった 4m おきの点列)
  mids.sort((a, b) => a.x - b.x);
  const usedM = new Uint8Array(mids.length);
  for (let i = 0; i < mids.length; i++) {
    if (usedM[i]) continue;
    const run = [mids[i]]; usedM[i] = 1;
    for (const dir of [1, -1]) {
      for (;;) {
        const end = dir > 0 ? run.at(-1) : run[0];
        let bj = -1, bd = 7;
        for (let j = 0; j < mids.length; j++) { if (usedM[j]) continue; const d = Math.hypot(mids[j].x - end.x, mids[j].z - end.z); if (d < bd && d > 0.5) { const fx = mids[j].x - end.x, fz = mids[j].z - end.z; if (Math.abs(fx * Math.sin(end.ang) - fz * Math.cos(end.ang)) < 2.5) { bd = d; bj = j; } } }
        if (bj < 0) break;
        usedM[bj] = 1;
        if (dir > 0) run.push(mids[bj]); else run.unshift(mids[bj]);
      }
    }
    if (run.length < 3) continue;
    // 進む向きにそろえる
    const ordered = run[0].x * Math.cos(run[0].ang) + run[0].z * Math.sin(run[0].ang) <= run.at(-1).x * Math.cos(run[0].ang) + run.at(-1).z * Math.sin(run[0].ang) ? run : run.reverse();
    medians.push({ p: ordered.flatMap((q) => [r1(q.x), r1(q.z)]), w: ordered.map((q) => r1(Math.min(q.w, 8))) });
  }
  console.log('medians', medians.length, 'points', medians.reduce((s3, m) => s3 + m.w.length, 0));
}

// ---------- 街路樹:主な道路で、歩道の幅が 2.5m 以上ある所に 12m おき ----------
const streetTrees = [];
{
  const MAIN = new Set(['trunk', 'primary', 'secondary', 'tertiary']);
  for (const w of osm.ways) {
    if (!MAIN.has(w.hw) || w.tunnel || w.bridge) continue;
    let acc = 0;
    for (let i = 0; i < w.pts.length - 1; i++) {
      const [a, b] = [w.pts[i], w.pts[i + 1]];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]); const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
      const lx = Math.sin(ang), lz = -Math.cos(ang);
      for (let t = 0; t < L; t += 2) {
        acc += 2; if (acc < 12) continue;
        const x = a[0] + (b[0] - a[0]) * t / L, z = a[1] + (b[1] - a[1]) * t / L;
        for (const side of [1, -1]) {
          // 車道の端を越えて、歩道がどこまで続くか
          let d = w.w / 2; while (d < w.w / 2 + 6 && chan(x + lx * side * d, z + lz * side * d, 0) > 100) d += 0.25;
          let e = d; while (e < d + 8 && (() => { const g = chan(x + lx * side * e, z + lz * side * e, 1); return g > 60 && g < 200; })()) e += 0.25;
          if (e - d < 2.5) continue;
          const td = d + 0.9;
          streetTrees.push(r1(x + lx * side * td), r1(z + lz * side * td));
        }
        acc = 0;
      }
    }
  }
  console.log('street trees', streetTrees.length / 2);
}

fs.writeFileSync(path.join(OUT, 'roads.json'), JSON.stringify({ bridges, markings, crosswalks, stops, water, curbs, medians, streetTrees }));
// ---------- ガードレール:住宅地の外で、道路の脇が 1.2m 以上落ち込んでいる所 ----------
const guards = [];
for (const w of osm.ways) {
  if (w.tunnel || w.bridge || w.hw === 'service') continue;
  for (const side of [-1, 1]) {
    let run = [];
    const flush = () => { if (run.length >= 5) guards.push(run.flat().map(r1)); run = []; };
    for (let i = 0; i < w.pts.length - 1; i++) {
      const [a, b] = [w.pts[i], w.pts[i + 1]];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 0.5) continue;
      const ux = (b[0] - a[0]) / L, uz = (b[1] - a[1]) / L, lx = uz * side, lz = -ux * side;
      for (let t = 0; t < L; t += 2) {
        const x = a[0] + ux * t, z = a[1] + uz * t;
        const lu = luAt(x, z);
        const e = w.w / 2 + 0.5;
        const ex = x + lx * e, ez = z + lz * e;
        const drop = heightAt(x, z) - Math.min(heightAt(ex + lx * 3, ez + lz * 3), heightAt(ex + lx * 5, ez + lz * 5));
        const ok = drop > 1.2 && lu !== 6 && lu !== 7 && maskAt(ex, ez) !== 4 && chan(ex, ez, 0) < 100;
        if (ok) run.push([ex, ez]); else flush();
      }
    }
    flush();
  }
}
console.log('guardrails', guards.length, (guards.reduce((s3, g) => s3 + g.length / 2, 0) * 2 / 1000).toFixed(1), 'km');

// ---------- 速度の標識:制限速度のある道路の入口に。同じ速度・同じ向きの標識が 200m 以内にあれば省く ----------
const speedSigns = [];
for (const w of osm.ways) {
  if (!w.maxspeed || w.tunnel) continue;
  const place = (pts, dirSign) => {
    let acc = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const [a, b] = [pts[i], pts[i + 1]];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (acc + L < 15) { acc += L; continue; }
      const t = (15 - acc) / L;
      const ux = (b[0] - a[0]) / L, uz = (b[1] - a[1]) / L;
      const x = a[0] + (b[0] - a[0]) * t + uz * (w.w / 2 + 0.9), z = a[1] + (b[1] - a[1]) * t - ux * (w.w / 2 + 0.9);
      const ang = Math.atan2(uz, ux);
      if (speedSigns.some((q) => q[3] === w.maxspeed && Math.hypot(q[0] - x, q[1] - z) < 200 && Math.cos(q[2] - ang) > 0.7)) return;
      if (maskAt(x, z) === 4) return;
      speedSigns.push([r1(x), r1(z), Math.round(ang * 1000) / 1000, w.maxspeed]);
      return;
    }
  };
  place(w.pts, 1);
  if (!w.oneway) place([...w.pts].reverse(), -1);
}
console.log('speed signs', speedSigns.length);

const RANK = { trunk: 3, primary: 3, motorway: 3, secondary: 2, tertiary: 2, unclassified: 1, residential: 1, living_street: 1, service: 0 };
fs.writeFileSync(path.join(OUT, 'lines.json'), JSON.stringify({
  lines: osm.ways.filter((w) => !w.tunnel).map((w) => ({ w: RANK[w.hw.replace('_link', '')] ?? 1, cw: r1(w.w), o: w.oneway ? 1 : 0, n: w.name || w.ref || undefined, v: w.maxspeed || undefined, p: w.pts.flat().map(r1) })),
  poles, signals, wires, guards, speedSigns,
}));
fs.writeFileSync(path.join(OUT, 'places.json'), JSON.stringify({ places, trees }));
for (const f of fs.readdirSync(OUT)) console.log(f, (fs.statSync(path.join(OUT, f)).size / 1e6).toFixed(2), 'MB');
