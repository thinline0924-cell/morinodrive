// 360°写真に建物の壁を投影して、壁の色を読む
// 出典:© Mapillary contributors(CC BY-SA 4.0)
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { toLocal } from './area.mjs';

const ROOT = path.join(import.meta.dirname, '../..');
const DIR = path.join(import.meta.dirname, 'raw/mly');
const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/map/meta.json')));
const buildings = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/map/buildings.json')));
const panos = JSON.parse(fs.readFileSync(path.join(DIR, 'pano_meta.json')));
// 地形の高さ
const C = meta.height.core;
const { data: hd } = await sharp(path.join(ROOT, 'assets/map/height_core.png')).raw().toBuffer({ resolveWithObject: true });
const hch = hd.length / (C.nx * C.nz);
const H = (x, z) => { const i = Math.max(0, Math.min(C.nx - 1, Math.round((x - C.x0) / C.spacing))), j = Math.max(0, Math.min(C.nz - 1, Math.round((z - C.z0) / C.spacing))); const k = (j * C.nx + i) * hch; return (hd[k] * 65536 + hd[k + 1] * 256 + hd[k + 2]) * 0.01; };
// 建物の当たり(遮るものの判定)
const L = meta.land;
const { data: land, info: linfo } = await sharp(path.join(ROOT, 'assets/map/land.png')).raw().toBuffer({ resolveWithObject: true });
const isB = (x, z) => { const i = Math.floor(x - L.x0), j = Math.floor(z - L.z0); if (i < 0 || j < 0 || i >= L.w || j >= L.h) return false; return land[(j * L.w + i) * linfo.channels + 2] > 250; };
// 建物を 40m の格子に
const grid = new Map();
buildings.forEach((b, bi) => { const k = `${Math.floor(b.p[0] / 40)},${Math.floor(b.p[1] / 40)}`; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(bi); });

export function project(cam, x, y, z) {
  const dx = x - cam.x, dz = z - cam.z, dy = y - cam.y;
  // ゲーム座標:x = 東、z = 南。方位(北から時計回り)
  const bearing = Math.atan2(dx, -dz) * 180 / Math.PI;
  const elev = Math.atan2(dy, Math.hypot(dx, dz));
  let u = ((bearing - cam.heading) / 360 + 0.5) % 1; if (u < 0) u += 1;
  const v = 0.5 - elev / Math.PI;
  return [u, v];
}
// 道路の中心線(位置の補正用)
const LINES = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/map/lines.json'))).lines;
const segGrid = new Map();
for (const l of LINES) for (let i = 0; i + 3 < l.p.length; i += 2) { const k = `${Math.floor(l.p[i] / 50)},${Math.floor(l.p[i + 1] / 50)}`; if (!segGrid.has(k)) segGrid.set(k, []); segGrid.get(k).push([l.p[i], l.p[i + 1], l.p[i + 2], l.p[i + 3], l.cw || 5, l.o]); }
function nearestRoad(x, z) {
  let best = null;
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const [ax, az, bx, bz, cw] of segGrid.get(`${Math.floor(x / 50) + a},${Math.floor(z / 50) + b}`) || []) {
    const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1; const t = Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / L2));
    const px = ax + dx * t, pz = az + dz * t, d = Math.hypot(x - px, z - pz);
    if (!best || d < best.d) best = { d, px, pz, cw };
  }
  return best;
}
// 撮影位置:撮影の連続ごとに道路へ合わせた位置(mly-align.mjs)。道路から 4m より離れた写真は使わない
const ALIGN = JSON.parse(fs.readFileSync(path.join(DIR, 'align.json')));
export function camOf(p) {
  const a = ALIGN[p.id];
  if (!a || a[2] > 4 || a[3]) return null; // 橋・高架の上は壁が見えない(防音壁など)
  const [x, z] = a;
  return { id: p.id, x, z, y: H(x, z) + 2.1, heading: p.computed_compass_angle ?? p.compass_angle, snapped: a[2] };
}
export { buildings, grid, isB, panos, DIR };

// ---- 使い方 1:node mly-facades.mjs check <id> → 壁の輪郭を写真に描いて確かめる ----
if (process.argv[2] === 'check') {
  const p = panos.find((q) => q.id === process.argv[3]) || panos[Number(process.argv[3]) || 0];
  const cam = camOf(p); if (!cam) { console.log('位置が道路から遠い写真'); process.exit(0); }
  let svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="512">';
  for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) for (const bi of grid.get(`${Math.floor(cam.x / 40) + a},${Math.floor(cam.z / 40) + b}`) || []) {
    const bd = buildings[bi], n = bd.p.length / 2;
    for (let i = 0; i < n; i++) {
      const ax = bd.p[i * 2], az = bd.p[i * 2 + 1], bx = bd.p[((i + 1) % n) * 2], bz = bd.p[((i + 1) % n) * 2 + 1];
      if (Math.hypot((ax + bx) / 2 - cam.x, (az + bz) / 2 - cam.z) > 60) continue;
      const pts = [[ax, bd.g, az], [bx, bd.g, bz], [bx, bd.g + bd.h, bz], [ax, bd.g + bd.h, az]].map((q) => project(cam, ...q));
      if (Math.max(...pts.map((q) => q[0])) - Math.min(...pts.map((q) => q[0])) > 0.5) continue;
      svg += `<polygon points="${pts.map((q) => `${q[0] * 1024},${q[1] * 512}`).join(' ')}" fill="none" stroke="#ff2" stroke-width="1.5"/>`;
    }
  }
  svg += '</svg>';
  await sharp(path.join(DIR, 'pano', p.id + '.jpg')).composite([{ input: Buffer.from(svg) }]).toFile(process.argv[4]);
  console.log('cam', cam);
}

// ---- 使い方 2:node mly-facades.mjs poles <id> <出力> → 検出された電柱・街灯を縦線で描く ----
if (process.argv[2] === 'poles') {
  const p = panos.find((q) => q.id === process.argv[3]);
  const cam = camOf(p);
  const feats = JSON.parse(fs.readFileSync(path.join(DIR, 'features.json')));
  let svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="512">';
  for (const f of feats) {
    if (!/utility-pole|street-light|traffic-light/.test(f.object_value)) continue;
    const [x, z] = toLocal(f.geometry.coordinates[1], f.geometry.coordinates[0]);
    const d = Math.hypot(x - cam.x, z - cam.z); if (d > 50 || d < 2) continue;
    const g = cam.y - 2.1;
    const a = project(cam, x, g, z), b = project(cam, x, g + 8, z);
    svg += `<line x1="${a[0] * 1024}" y1="${a[1] * 512}" x2="${b[0] * 1024}" y2="${b[1] * 512}" stroke="#f0f" stroke-width="2"/><text x="${a[0] * 1024}" y="${a[1] * 512 + 12}" fill="#f0f" font-size="10">${d.toFixed(0)}m</text>`;
  }
  svg += '</svg>';
  await sharp(path.join(DIR, 'pano', p.id + '.jpg')).composite([{ input: Buffer.from(svg) }]).toFile(process.argv[4]);
}
