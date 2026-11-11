// 撮影の連続(sequence)ごとに、走った跡が道路の中心線に重なるよう平行移動を求める(ICP)
// 結果:raw/mly/align.json { 写真ID: [x, z, 道路からの距離] }
import fs from 'node:fs';
import path from 'node:path';
import { toLocal } from './area.mjs';
const ROOT = path.join(import.meta.dirname, '../..');
const DIR = path.join(import.meta.dirname, 'raw/mly');
const LINES = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/map/lines.json'))).lines;
const segGrid = new Map();
for (const l of LINES) for (let i = 0; i + 3 < l.p.length; i += 2) { const k = `${Math.floor(l.p[i] / 50)},${Math.floor(l.p[i + 1] / 50)}`; if (!segGrid.has(k)) segGrid.set(k, []); segGrid.get(k).push([l.p[i], l.p[i + 1], l.p[i + 2], l.p[i + 3], l.b ? 1 : 0]); }
function nearest(x, z, ang) {
  let best = null;
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const [ax, az, bx, bz, br] of segGrid.get(`${Math.floor(x / 50) + a},${Math.floor(z / 50) + b}`) || []) {
    const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1; const t = Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / L2));
    // 進む向きと道路の向きが合わない線分は対象外(交差点で別の道に吸い寄せられないように)
    if (ang != null && Math.abs(Math.sin(Math.atan2(dz, dx) - ang)) > 0.5) continue;
    const px = ax + dx * t, pz = az + dz * t, d = Math.hypot(x - px, z - pz);
    if (!best || d < best.d) best = { d, px, pz, br };
  }
  return best;
}
const imgs = JSON.parse(fs.readFileSync(path.join(DIR, 'images.json')));
const bySeq = new Map();
for (const d of imgs) { if (!bySeq.has(d.sequence)) bySeq.set(d.sequence, []); bySeq.get(d.sequence).push(d); }
const out = {};
let good = 0, total = 0;
for (const [seq, list] of bySeq) {
  list.sort((a, b) => a.captured_at - b.captured_at);
  const P = list.map((d) => toLocal(d.geometry.coordinates[1], d.geometry.coordinates[0]));
  const ang = P.map((p, i) => { const a = P[Math.max(0, i - 2)], b = P[Math.min(P.length - 1, i + 2)]; return Math.hypot(b[0] - a[0], b[1] - a[1]) > 2 ? Math.atan2(b[1] - a[1], b[0] - a[0]) : null; });
  let tx = 0, tz = 0;
  for (let it = 0; it < 15; it++) {
    const res = [];
    P.forEach(([x, z], i) => { const r = nearest(x + tx, z + tz, ang[i]); if (r && r.d < 25) res.push([r.px - (x + tx), r.pz - (z + tz), r.d]); });
    if (res.length < 5) break;
    // 外れ値に強いよう、距離の中央値以下のものだけで平均
    const md = res.map((q) => q[2]).sort((a, b) => a - b)[res.length >> 1];
    const use = res.filter((q) => q[2] <= md * 1.5 + 0.5);
    tx += use.reduce((s, q) => s + q[0], 0) / use.length * 0.8;
    tz += use.reduce((s, q) => s + q[1], 0) / use.length * 0.8;
  }
  const ds = [];
  P.forEach(([x, z], i) => { const r = nearest(x + tx, z + tz, ang[i]); const d = r ? r.d : 99; ds.push(d); out[list[i].id] = [Math.round((x + tx) * 10) / 10, Math.round((z + tz) * 10) / 10, Math.round(d * 10) / 10, r && r.br ? 1 : 0]; total++; if (d < 6) good++; });
  const s = [...ds].sort((a, b) => a - b);
  console.log(`seq ${seq.slice(0, 8)} n=${list.length} shift=(${tx.toFixed(1)},${tz.toFixed(1)}) dist p50=${s[s.length >> 1].toFixed(1)} p90=${s[Math.floor(s.length * 0.9)].toFixed(1)}`);
}
fs.writeFileSync(path.join(DIR, 'align.json'), JSON.stringify(out));
console.log('images within 6m of a road after alignment', good, '/', total);
