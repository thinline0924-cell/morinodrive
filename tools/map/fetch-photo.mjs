// 国土地理院のシームレス空中写真をつないで、地面の下地にする
// 出典:国土地理院(地理院タイル シームレス空中写真)
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { toLocal } from './area.mjs';

const RAW = path.join(import.meta.dirname, 'raw/photo');
const OUT = path.join(import.meta.dirname, '../../assets/map');
fs.mkdirSync(RAW, { recursive: true });
const { core } = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'raw/gsi/grids.json')));
const { AREA } = await import('./area.mjs');

const tx = (lon, z) => Math.floor((lon + 180) / 360 * 2 ** z);
const ty = (lat, z) => { const r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z); };
const lonOf = (x, z) => x / 2 ** z * 360 - 180;
const latOf = (y, z) => { const n = Math.PI - 2 * Math.PI * y / 2 ** z; return 180 / Math.PI * Math.atan(Math.sinh(n)); };

async function tile(z, x, y) {
  const f = path.join(RAW, `${z}_${x}_${y}.jpg`);
  if (fs.existsSync(f)) return fs.readFileSync(f);
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(`https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/${z}/${x}/${y}.jpg`);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const b = Buffer.from(await r.arrayBuffer()); fs.writeFileSync(f, b); return b;
    } catch (e) { if (a === 3) throw e; await new Promise((r) => setTimeout(r, 1500 * 2 ** a)); }
  }
}
async function stitch(name, box, z, quality) {
  const x0 = tx(box.lon0, z), x1 = tx(box.lon1, z), y0 = ty(box.lat1, z), y1 = ty(box.lat0, z);
  const W = (x1 - x0 + 1) * 256, H = (y1 - y0 + 1) * 256;
  const comps = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) comps.push({ input: await tile(z, x, y), left: (x - x0) * 256, top: (y - y0) * 256 });
  await sharp({ create: { width: W, height: H, channels: 3, background: '#556644' } }).composite(comps).jpeg({ quality, mozjpeg: true }).toFile(path.join(OUT, `${name}.jpg`));
  // 画像の四隅をゲームの座標に
  const [ax, az] = toLocal(latOf(y0, z), lonOf(x0, z));
  const [bx, bz] = toLocal(latOf(y1 + 1, z), lonOf(x1 + 1, z));
  console.log(name, W, 'x', H, 'tiles', comps.length, (fs.statSync(path.join(OUT, `${name}.jpg`)).size / 1e6).toFixed(2), 'MB');
  return { x0: ax, z0: az, x1: bx, z1: bz };
}
const out = {
  core: await stitch('photo_core', core, 16, 80),
  far: await stitch('photo_far', AREA.far, 13, 80),
};
fs.writeFileSync(path.join(RAW, 'bounds.json'), JSON.stringify(out, null, 1));
