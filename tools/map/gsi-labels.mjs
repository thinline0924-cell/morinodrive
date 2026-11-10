// 国土地理院ベクトルタイルから地名(注記)を拾って、範囲を決めるための確認用
import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';
const [lat0, lon0, lat1, lon1] = [36.535, 136.670, 36.575, 136.730];
const z = 15;
const tx = (lon) => Math.floor((lon + 180) / 360 * 2 ** z);
const ty = (lat) => { const r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z); };
const seen = new Map();
for (let x = tx(lon0); x <= tx(lon1); x++) for (let y = ty(lat1); y <= ty(lat0); y++) {
  const res = await fetch(`https://cyberjapandata.gsi.go.jp/xyz/experimental_bvmap/${z}/${x}/${y}.pbf`);
  if (!res.ok) { console.error('tile', x, y, res.status); continue; }
  const vt = new VectorTile(new Pbf(new Uint8Array(await res.arrayBuffer())));
  if (x === tx(lon0) && y === ty(lat1)) console.log('layers', Object.keys(vt.layers).join(','));
  const L = vt.layers.label;
  if (!L) continue;
  for (let i = 0; i < L.length; i++) {
    const f = L.feature(i);
    const g = f.toGeoJSON(x, y, z);
    const name = f.properties.knj;
    if (!name || seen.has(name)) continue;
    const c = g.geometry.type === 'Point' ? g.geometry.coordinates : g.geometry.coordinates[0];
    seen.set(name, [c[1].toFixed(5), c[0].toFixed(5), f.properties.annoCtg]);
  }
}
for (const [k, v] of seen) console.log(v.join(' '), k);
