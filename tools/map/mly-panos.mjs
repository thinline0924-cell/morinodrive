// Mapillary の 360°写真(正距円筒、1024×512)を、同じ連続撮影の中で 12m おきに間引いて取得する
// 出典:© Mapillary contributors(CC BY-SA 4.0)
import fs from 'node:fs';
import path from 'node:path';
import { toLocal } from './area.mjs';
const DIR = path.join(import.meta.dirname, 'raw/mly');
const IMG = path.join(DIR, 'pano'); fs.mkdirSync(IMG, { recursive: true });
const all = JSON.parse(fs.readFileSync(path.join(DIR, 'images.json'))).filter((d) => d.is_pano);
// 新しい写真を優先、12m 以内に既に選んだ写真があれば省く
all.sort((a, b) => b.captured_at - a.captured_at);
const pick = [], grid = new Map();
for (const d of all) {
  const [x, z] = toLocal(d.geometry.coordinates[1], d.geometry.coordinates[0]);
  const k = (a, b) => `${Math.floor(a / 12)},${Math.floor(b / 12)}`;
  let near = false;
  for (let a = -1; a <= 1 && !near; a++) for (let b = -1; b <= 1 && !near; b++) for (const q of grid.get(k(x + a * 12, z + b * 12)) || []) if (Math.hypot(q[0] - x, q[1] - z) < 12) { near = true; break; }
  if (near) continue;
  if (!grid.has(k(x, z))) grid.set(k(x, z), []);
  grid.get(k(x, z)).push([x, z]);
  pick.push(d.id);
}
console.log('panos', all.length, 'picked', pick.length);
// カメラの向き・高さ・URL をまとめて問い合わせ(50 件ずつ)
const meta = {};
for (let i = 0; i < pick.length; i += 50) {
  const ids = pick.slice(i, i + 50).join(',');
  const r = await fetch(`https://graph.mapillary.com/?ids=${ids}&fields=id,computed_geometry,geometry,computed_compass_angle,compass_angle,computed_rotation,computed_altitude,altitude,captured_at,thumb_1024_url`);
  if (!r.ok) { console.log('meta HTTP', r.status); continue; }
  Object.assign(meta, await r.json());
}
fs.writeFileSync(path.join(DIR, 'pano_meta.json'), JSON.stringify(Object.values(meta).map(({ thumb_1024_url, ...m }) => m)));
let got = 0, fail = 0;
const ids = Object.keys(meta);
async function worker() {
  while (ids.length) {
    const id = ids.pop();
    const f = path.join(IMG, `${id}.jpg`);
    if (fs.existsSync(f)) { got++; continue; }
    try {
      const r = await fetch(meta[id].thumb_1024_url);
      if (!r.ok) throw new Error(r.status);
      fs.writeFileSync(f, Buffer.from(await r.arrayBuffer())); got++;
    } catch { fail++; }
    if ((got + fail) % 100 === 0) process.stdout.write(`\r${got}`);
  }
}
await Promise.all(Array.from({ length: 6 }, worker));
console.log(`\ndownloaded ${got} failed ${fail}`);
