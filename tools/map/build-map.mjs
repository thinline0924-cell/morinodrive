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
  let base = Infinity;
  for (const q of p) base = Math.min(base, heightAt(q[0], q[1]));
  const o = { p: p.flat().map(r1), h: r1(h), g: r2(base), u: b.u || 461 };
  if (b.st) o.s = b.st;
  if (b.n) o.n = b.n;
  if (HOUSE.has(o.u) && Math.abs(A) < 320 && h < 13) {
    const r = minRect(p);
    if (Math.abs(A) / r.ar > 0.8 && r.W > 3) { o.r = [r1(r.cx), r1(r.cz), Math.round(r.ang * 1000) / 1000, r1(r.L), r1(r.W)]; gable++; }
  }
  buildings.push(o);
}
console.log('buildings', buildings.length, 'with gable roof', gable);

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
}

// ---------- 木(林):建物と道路から離れた斜面や山 ----------
const mask = globalThis.__mask;
const maskAt = (x, z) => { const i = Math.floor(x - MASK.x0), j = Math.floor(z - MASK.z0); if (i < 0 || j < 0 || i >= MASK.w || j >= MASK.h) return -1; return mask[j * MASK.w + i]; };
const bgrid = new Map();
for (const b of buildings) { const k = `${Math.floor(b.p[0] / 40)},${Math.floor(b.p[1] / 40)}`; bgrid.set(k, (bgrid.get(k) || 0) + 1); }
let seed = 12345; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const trees = [];
const m = core.meta;
for (let z = m.z0 + 20; z < m.z0 + (m.nz - 3) * m.spacing; z += 16) for (let x = m.x0 + 20; x < m.x0 + (m.nx - 3) * m.spacing; x += 16) {
  const px = x + (rnd() - 0.5) * 14, pz = z + (rnd() - 0.5) * 14;
  const h0 = heightAt(px, pz);
  const slope = Math.hypot(heightAt(px + 6, pz) - heightAt(px - 6, pz), heightAt(px, pz + 6) - heightAt(px, pz - 6)) / 12;
  let busy = false, nearB = 0;
  for (const [dx, dz] of [[0, 0], [6, 0], [-6, 0], [0, 6], [0, -6], [4, 4], [-4, -4], [4, -4], [-4, 4]]) { const v = maskAt(px + dx, pz + dz); if (v > 0) { busy = true; break; } }
  if (busy) continue;
  for (let a = -1; a <= 1; a++) for (let c = -1; c <= 1; c++) nearB += bgrid.get(`${Math.floor(px / 40) + a},${Math.floor(pz / 40) + c}`) || 0;
  const wild = slope > 0.22 || (h0 > 75 && nearB < 3) || nearB === 0;
  if (!wild || rnd() < 0.2) continue;
  trees.push(Math.round(px), Math.round(pz), Math.floor(rnd() * 255));
}
console.log('trees', trees.length / 3);

// ---------- 区画線・電柱:中心線から左右に道路の面の端を探して幅を測る ----------
const isRoad = (x, z) => { const v = maskAt(x, z); return v === 1 || v === 2; };
const markings = [], poles = [];
let poleAcc = 0, poleSide = 1;
for (const ln of lines) {
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
    poles.push(r1(px), r1(pz), Math.round(((a + Math.PI) / (2 * Math.PI)) * 255));
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
const offsetLine = (sm, off) => sm.map(([x, z, a]) => [x - Math.sin(a) * off, z + Math.cos(a) * off]);
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
  source: '出典:国土地理院(地理院タイル 標高・最適化ベクトルタイル)、国土交通省 PLATEAU 金沢市 2024、© OpenStreetMap contributors(ODbL)。加工して作成',
  origin: ORIGIN, area: AREA,
  height: { core: core.meta, far: far.meta, scale: 0.01 },
  land: { x0: MASK.x0, z0: MASK.z0, w: MASK.w, h: MASK.h },
};
fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify(meta, null, 1));
fs.writeFileSync(path.join(OUT, 'buildings.json'), JSON.stringify(buildings));
fs.writeFileSync(path.join(OUT, 'roads.json'), JSON.stringify({ bridges, markings, crosswalks, stops, water }));
const RANK = { trunk: 3, primary: 3, motorway: 3, secondary: 2, tertiary: 2, unclassified: 1, residential: 1, living_street: 1, service: 0 };
fs.writeFileSync(path.join(OUT, 'lines.json'), JSON.stringify({
  lines: osm.ways.filter((w) => !w.tunnel).map((w) => ({ w: RANK[w.hw.replace('_link', '')] ?? 1, cw: r1(w.w), o: w.oneway ? 1 : 0, n: w.name || w.ref || undefined, v: w.maxspeed || undefined, p: w.pts.flat().map(r1) })),
  poles, signals,
}));
fs.writeFileSync(path.join(OUT, 'places.json'), JSON.stringify({ places, trees }));
for (const f of fs.readdirSync(OUT)) console.log(f, (fs.statSync(path.join(OUT, f)).size / 1e6).toFixed(2), 'MB');
