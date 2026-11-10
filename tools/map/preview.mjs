// 取り込んだデータを上から見た確認用の画像にする
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
const RAW = path.join(import.meta.dirname, 'raw');
const { grids } = JSON.parse(fs.readFileSync(path.join(RAW, 'gsi/grids.json')));
const g = grids[0];
const h = new Float32Array(fs.readFileSync(path.join(RAW, 'gsi/dem_core.f32')).buffer.slice(0));
const [cx, cz, half, W] = process.argv.slice(2).map(Number);
const X0 = (cx ?? 0) - (half ?? 2100), Z0 = (cz ?? 0) - (half ?? 2100), S = (half ?? 2100) * 2, PX = W || 2400;
const k = PX / S;
// 陰影図
const img = Buffer.alloc(PX * PX * 3);
const hAt = (x, z) => { const i = Math.round((x - g.x0) / g.spacing), j = Math.round((z - g.z0) / g.spacing); if (i < 1 || j < 1 || i >= g.nx - 1 || j >= g.nz - 1) return NaN; return h[j * g.nx + i]; };
let hmin = Infinity, hmax = -Infinity; for (const v of h) if (v === v) { hmin = Math.min(hmin, v); hmax = Math.max(hmax, v); }
for (let py = 0; py < PX; py++) for (let px = 0; px < PX; px++) {
  const x = X0 + px / k, z = Z0 + py / k;
  const c = hAt(x, z), dx = hAt(x + 4, z) - hAt(x - 4, z), dz = hAt(x, z + 4) - hAt(x, z - 4);
  const shade = Math.max(0, Math.min(1, 0.75 - (dx - dz) * 0.06));
  const t = (c - hmin) / (hmax - hmin);
  const o = (py * PX + px) * 3;
  img[o] = (200 + 40 * t) * shade; img[o + 1] = (215 + 20 * t) * shade; img[o + 2] = (190 - 10 * t) * shade;
}
const bg = await sharp(img, { raw: { width: PX, height: PX, channels: 3 } }).png().toBuffer();
const P = (p) => `${((p[0] - X0) * k).toFixed(1)},${((p[1] - Z0) * k).toFixed(1)}`;
const { buildings, roads } = JSON.parse(fs.readFileSync(path.join(RAW, 'plateau.json')));
const vec = JSON.parse(fs.readFileSync(path.join(RAW, 'gsi/vector.json')));
const col = { 411: '#d9c7a3', 412: '#c9a97a', 413: '#e0a77a', 414: '#e0a77a', 401: '#9fb6d6', 402: '#e58c6a', 422: '#9fd0a8', 421: '#8fa3c0' };
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${PX}" height="${PX}"><image href="data:image/png;base64,${bg.toString('base64')}" width="${PX}" height="${PX}"/>`;
for (const r of roads) svg += `<polygon points="${r.p.map(P).join(' ')}" fill="${r.s === 7 ? '#8a7f9a' : r.s === 6 ? '#555' : '#f7f7f2'}" stroke="#b0aca0" stroke-width="0.6"/>`;
for (const w of vec.waterarea) for (const ring of w.c) svg += `<polygon points="${ring.map(P).join(' ')}" fill="#9cc3e6"/>`;
for (const b of buildings) svg += `<polygon points="${b.p.map(P).join(' ')}" fill="${col[b.u] || '#cfc8bc'}" stroke="#6f6a60" stroke-width="0.5"/>`;
for (const r of vec.road) if (r.p.ftCode === 2701 || r.p.ftCode === 2711) for (const ls of r.c) svg += `<polyline points="${ls.map(P).join(' ')}" fill="none" stroke="${['#c0392b', '#2471a3', '#7d3c98'][r.p.rdCtg] || '#e67e22'}" stroke-width="${0.6 + r.p.rnkWidth * 0.5}"/>`;
for (const l of vec.label) if ([800, 885].includes(l.p.annoCtg) || l.p.annoCtg === 413) { const [x, y] = P(l.c[0]).split(','); svg += `<text x="${x}" y="${y}" font-family="IPAGothic" font-size="${Math.max(10, PX / 150)}" fill="#111" stroke="#fff" stroke-width="3" paint-order="stroke">${l.p.knj}</text>`; }
svg += '</svg>';
await sharp(Buffer.from(svg), { limitInputPixels: false }).png().toFile(process.argv[6] || path.join(RAW, 'preview.png'));
console.log('ok', hmin.toFixed(1), hmax.toFixed(1));
