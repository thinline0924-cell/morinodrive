// 国土地理院のシームレス空中写真(z18、約 0.4m/画素)を取得し、ゲーム座標で色を読む
// 出典:国土地理院(地理院タイル シームレス空中写真)
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { AREA, toLatLon } from './area.mjs';

const Z = 18;
const DIR = path.join(import.meta.dirname, 'raw/photo18');
const tx = (lon) => (lon + 180) / 360 * 2 ** Z * 256;
const ty = (lat) => { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** Z * 256; };

export async function download(conc = 6) {
  fs.mkdirSync(DIR, { recursive: true });
  const m = 0.002;
  const x0 = Math.floor(tx(AREA.lon0 - m * 1.25) / 256), x1 = Math.floor(tx(AREA.lon1 + m * 1.25) / 256);
  const y0 = Math.floor(ty(AREA.lat1 + m) / 256), y1 = Math.floor(ty(AREA.lat0 - m) / 256);
  const jobs = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) jobs.push([x, y]);
  let done = 0, failed = 0;
  async function worker() {
    while (jobs.length) {
      const [x, y] = jobs.pop();
      const f = path.join(DIR, `${x}_${y}.jpg`);
      if (fs.existsSync(f)) { done++; continue; }
      for (let a = 0; a < 4; a++) {
        try {
          const r = await fetch(`https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/${Z}/${x}/${y}.jpg`);
          if (r.status === 404) { fs.writeFileSync(f, ''); break; }
          if (!r.ok) throw new Error('HTTP ' + r.status);
          fs.writeFileSync(f, Buffer.from(await r.arrayBuffer()));
          break;
        } catch (e) { if (a === 3) failed++; else await new Promise((res) => setTimeout(res, 1500 * 2 ** a)); }
      }
      if (++done % 100 === 0) process.stdout.write(`\r${done}`);
    }
  }
  await Promise.all(Array.from({ length: conc }, worker));
  console.log(`\rtiles ${done} failed ${failed}`);
}

// 読み込み:タイルを生の画素にしてためる
const cache = new Map();
export async function loadAll() {
  for (const f of fs.readdirSync(DIR)) {
    const buf = fs.readFileSync(path.join(DIR, f));
    if (!buf.length) continue;
    const { data } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    cache.set(f.replace('.jpg', ''), data);
  }
  return cache.size;
}
// ゲーム座標 (x, z) の色 [r, g, b](0〜255)。範囲外は null
export function colorAt(x, z) {
  const [lat, lon] = toLatLon(x, z);
  const px = tx(lon), py = ty(lat);
  const t = cache.get(`${Math.floor(px / 256)}_${Math.floor(py / 256)}`);
  if (!t) return null;
  const k = ((Math.floor(py) & 255) * 256 + (Math.floor(px) & 255)) * 3;
  return [t[k], t[k + 1], t[k + 2]];
}

if (process.argv[1] && process.argv[1].endsWith('photo18.mjs')) await download();
