// PLATEAU 金沢市 2024 の土地利用(MVT)を範囲の分だけ集める
// 出典:国土交通省 PLATEAU
import fs from 'node:fs';
import path from 'node:path';
import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import { AREA, toLocal } from './area.mjs';

const URL = 'https://assets.cms.plateau.reearth.io/assets/be/9c5b45-6000-4973-b135-5084dc1bacda/17201_kanazawa-shi_city_2024_citygml_1_op_luse_mvt';
const RAW = path.join(import.meta.dirname, 'raw');
const CACHE = path.join(RAW, 'luse'); fs.mkdirSync(CACHE, { recursive: true });
const Z = 16, m = 0.006;
const tx = (lon) => Math.floor((lon + 180) / 360 * 2 ** Z);
const ty = (lat) => { const r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** Z); };
const out = [];
const seen = new Set();
let tiles = 0;
for (let x = tx(AREA.lon0 - m * 1.25); x <= tx(AREA.lon1 + m * 1.25); x++) for (let y = ty(AREA.lat1 + m); y <= ty(AREA.lat0 - m); y++) {
  const f = path.join(CACHE, `${x}_${y}.mvt`);
  let buf;
  if (fs.existsSync(f)) buf = fs.readFileSync(f);
  else {
    const res = await fetch(`${URL}/${Z}/${x}/${y}.mvt`);
    buf = res.ok ? Buffer.from(await res.arrayBuffer()) : Buffer.alloc(0);
    fs.writeFileSync(f, buf);
  }
  tiles++;
  if (!buf.length) continue;
  const L = new VectorTile(new Pbf(new Uint8Array(buf))).layers.luse;
  if (!L) continue;
  for (let i = 0; i < L.length; i++) {
    const ft = L.feature(i);
    let code = 0;
    try { code = Number(JSON.parse(ft.properties.attributes)['luse:class_code']); } catch { continue; }
    const g = ft.toGeoJSON(x, y, Z).geometry;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    for (const poly of polys) {
      const rings = poly.map((ring) => ring.map(([lon, lat]) => toLocal(lat, lon).map((v) => Math.round(v * 10) / 10)));
      const key = code + ':' + rings[0].slice(0, 3).join(';');
      if (seen.has(key)) continue; // タイルの境目で重なった分
      seen.add(key);
      out.push({ c: code, r: rings });
    }
  }
}
const count = {}; for (const o of out) count[o.c] = (count[o.c] || 0) + 1;
console.log('tiles', tiles, 'polygons', out.length, JSON.stringify(count));
fs.writeFileSync(path.join(RAW, 'luse.json'), JSON.stringify(out));
