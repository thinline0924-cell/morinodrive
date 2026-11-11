// 360°写真から、道路から見える建物の壁の色を集める → raw/mly/wallcolors.json { 建物番号: 0xRRGGBB }
// 出典:© Mapillary contributors(CC BY-SA 4.0)
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { project, camOf, buildings, grid, isB, panos, DIR } from './mly-facades.mjs';

const samples = new Map(); // 建物番号 → [[r,g,b,重み], ...]
let used = 0;
for (const p of panos) {
  const f = path.join(DIR, 'pano', p.id + '.jpg');
  if (!fs.existsSync(f)) continue;
  const { data, info } = await sharp(f).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, Hh = info.height;
  const cam = camOf(p);
  if (!cam) continue;
  const px = (u, v) => { const x = Math.floor(u * W) % W, y = Math.floor(v * Hh); if (y < 0 || y >= Hh) return null; const k = (y * W + x) * 3; return [data[k], data[k + 1], data[k + 2]]; };
  used++;
  // 白とび・青かぶりの補正:前方の路面(アスファルトは灰色のはず)の平均色で、色ごとの倍率を決める
  let sr = 0, sg = 0, sb = 0, sn = 0;
  for (let v = 0.57; v <= 0.64; v += 0.01) for (let u = 0.3; u <= 0.7; u += 0.01) { const c = px(u, v); if (!c) continue; const l = (c[0] + c[1] + c[2]) / 3; if (l < 40 || l > 210 || Math.max(...c) - Math.min(...c) > 45) continue; sr += c[0]; sg += c[1]; sb += c[2]; sn++; }
  if (sn < 20) continue;
  const gm = (sr + sg + sb) / 3 / sn, gain = [gm / (sr / sn), gm / (sg / sn), gm / (sb / sn)];
  if (gain.some((g) => g < 0.75 || g > 1.33)) continue; // 補正が大きすぎる写真は使わない
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const bi of grid.get(`${Math.floor(cam.x / 40) + a},${Math.floor(cam.z / 40) + b}`) || []) {
    const bd = buildings[bi], n = bd.p.length / 2;
    const top = bd.g + Math.min(bd.h, 12) - 0.6;
    if (top < bd.g + 2.2) continue;
    for (let i = 0; i < n; i++) {
      const ax = bd.p[i * 2], az = bd.p[i * 2 + 1], bx = bd.p[((i + 1) % n) * 2], bz = bd.p[((i + 1) % n) * 2 + 1];
      const L = Math.hypot(bx - ax, bz - az); if (L < 2.5) continue;
      const nx = (bz - az) / L, nz = -(bx - ax) / L; // 外向き
      const mx = (ax + bx) / 2, mz = (az + bz) / 2;
      const tx = cam.x - mx, tz = cam.z - mz, d = Math.hypot(tx, tz);
      if (d < 4 || d > 35 || (tx * nx + tz * nz) / d < 0.35) continue;
      // 壁の内側 15〜85%、高さ 1.8m〜軒下
      for (let s = 0.15; s <= 0.851; s += 0.1) {
        const wx = ax + (bx - ax) * s + nx * 0.05, wz = az + (bz - az) * s + nz * 0.05;
        // 途中に別の建物があれば見えない
        let blocked = false;
        const dd = Math.hypot(cam.x - wx, cam.z - wz);
        for (let t = 0.6; t < dd - 0.6; t += 0.7) { if (isB(wx + (cam.x - wx) * t / dd, wz + (cam.z - wz) * t / dd)) { blocked = true; break; } }
        if (blocked) continue;
        for (let y = bd.g + 1.8; y <= top; y += 0.7) {
          const [u, v] = project(cam, wx, y, wz);
          const c = px(u, v); if (!c) continue;
          const sum = c[0] + c[1] + c[2] + 1, exg = (2 * c[1] - c[0] - c[2]) / sum;
          const l = sum / 3;
          if (exg > 0.04) continue;                               // 木
          if (c[2] > c[0] + 25 && c[2] > 140) continue;            // 空
          if (l > 250 || l < 12) continue;                        // 白飛び・真っ暗
          const arr = samples.get(bi) || []; arr.push([Math.min(255, c[0] * gain[0]), Math.min(255, c[1] * gain[1]), Math.min(255, c[2] * gain[2]), 1 / (1 + d / 10)]); samples.set(bi, arr);
        }
      }
    }
  }
}
const out = {};
let nB = 0;
for (const [bi, arr] of samples) {
  if (arr.length < 12) continue;
  // 明るさの中央値付近(上下 25% を捨てる)の平均
  arr.sort((a, b) => (a[0] + a[1] + a[2]) - (b[0] + b[1] + b[2]));
  // 窓ガラス・影より壁の方が明るいので、明るい側(60〜92%)を壁とみなす
  const mid = arr.slice(Math.floor(arr.length * 0.6), Math.ceil(arr.length * 0.92));
  let r = 0, g = 0, b = 0, w = 0; for (const s of mid) { r += s[0] * s[3]; g += s[1] * s[3]; b += s[2] * s[3]; w += s[3]; }
  out[bi] = (Math.round(r / w) << 16) | (Math.round(g / w) << 8) | Math.round(b / w);
  nB++;
}
fs.writeFileSync(path.join(DIR, 'wallcolors.json'), JSON.stringify(out));
console.log('panos used', used, 'buildings with photo wall color', nB);
