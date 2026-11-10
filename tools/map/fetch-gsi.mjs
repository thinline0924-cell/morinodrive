// 国土地理院タイルから標高と地図の線(道路中心線・川・建物・注記)を集める
// 出典:国土地理院(標高タイル、最適化ベクトルタイル)
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import { AREA, toLocal, toLatLon } from './area.mjs';

const RAW = path.join(import.meta.dirname, 'raw/gsi');
const CACHE = path.join(RAW, 'tiles');
fs.mkdirSync(CACHE, { recursive: true });

const lon2px = (lon, z) => (lon + 180) / 360 * 256 * 2 ** z;
const lat2px = (lat, z) => { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 256 * 2 ** z; };

async function getTile(kind, z, x, y, ext) {
  const f = path.join(CACHE, `${kind}_${z}_${x}_${y}.${ext}`);
  if (fs.existsSync(f)) { const b = fs.readFileSync(f); return b.length ? b : null; }
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(`https://cyberjapandata.gsi.go.jp/xyz/${kind}/${z}/${x}/${y}.${ext}`);
      if (res.status === 404) { fs.writeFileSync(f, ''); return null; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const b = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(f, b);
      return b;
    } catch (e) {
      if (attempt === 3) throw e;
      await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
    }
  }
}

// ---------- 標高 ----------
const demCache = new Map();
async function demTile(kind, z, x, y) {
  const key = `${kind}/${z}/${x}/${y}`;
  if (demCache.has(key)) return demCache.get(key);
  const png = await getTile(kind, z, x, y, 'png');
  let arr = null;
  if (png) {
    const { data } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    arr = new Float32Array(256 * 256);
    for (let i = 0; i < arr.length; i++) {
      const v = data[i * 3] * 65536 + data[i * 3 + 1] * 256 + data[i * 3 + 2];
      arr[i] = v === 8388608 ? NaN : (v < 8388608 ? v : v - 16777216) * 0.01;
    }
  }
  demCache.set(key, arr);
  return arr;
}
async function sampleDem(sources, lat, lon) {
  for (const [kind, z] of sources) {
    const px = lon2px(lon, z) - 0.5, py = lat2px(lat, z) - 0.5;
    const x0 = Math.floor(px), y0 = Math.floor(py), fx = px - x0, fy = py - y0;
    const vals = [];
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const gx = x0 + dx, gy = y0 + dy;
      const t = await demTile(kind, z, Math.floor(gx / 256), Math.floor(gy / 256));
      vals.push(t ? t[(gy & 255) * 256 + (gx & 255)] : NaN);
    }
    if (vals.some(Number.isNaN)) continue;
    return vals[0] * (1 - fx) * (1 - fy) + vals[1] * fx * (1 - fy) + vals[2] * (1 - fx) * fy + vals[3] * fx * fy;
  }
  return NaN;
}

async function buildGrid(name, box, spacing, sources) {
  const [x0, z1] = toLocal(box.lat0, box.lon0);
  const [x1, z0] = toLocal(box.lat1, box.lon1);
  const nx = Math.floor((x1 - x0) / spacing) + 1, nz = Math.floor((z1 - z0) / spacing) + 1;
  const h = new Float32Array(nx * nz);
  let missing = 0;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const [lat, lon] = toLatLon(x0 + i * spacing, z0 + j * spacing);
      const v = await sampleDem(sources, lat, lon);
      if (Number.isNaN(v)) missing++;
      h[j * nx + i] = v;
    }
    if (j % 100 === 0) process.stdout.write(`\r${name} ${j}/${nz}`);
  }
  console.log(`\r${name} ${nx}x${nz} spacing ${spacing}m missing ${missing}`);
  fs.writeFileSync(path.join(RAW, `${name}.f32`), Buffer.from(h.buffer));
  return { name, x0, z0, nx, nz, spacing };
}

const margin = 0.005; // 約 500m の余白
const core = { lat0: AREA.lat0 - margin, lat1: AREA.lat1 + margin, lon0: AREA.lon0 - margin * 1.25, lon1: AREA.lon1 + margin * 1.25 };
const grids = [];
grids.push(await buildGrid('dem_core', core, 4, [['dem5a_png', 15], ['dem5b_png', 15], ['dem_png', 14]]));
grids.push(await buildGrid('dem_far', AREA.far, 30, [['dem_png', 14]]));

// ---------- ベクトル(z16) ----------
const Z = 16;
const tx0 = Math.floor(lon2px(core.lon0, Z) / 256), tx1 = Math.floor(lon2px(core.lon1, Z) / 256);
const ty0 = Math.floor(lat2px(core.lat1, Z) / 256), ty1 = Math.floor(lat2px(core.lat0, Z) / 256);
const LAYERS = ['road', 'railway', 'river', 'waterarea', 'building', 'label', 'structurel', 'symbol'];
const out = Object.fromEntries(LAYERS.map((l) => [l, []]));
const r1 = (v) => Math.round(v * 10) / 10;
const conv = (c) => { const [x, z] = toLocal(c[1], c[0]); return [r1(x), r1(z)]; };
for (let x = tx0; x <= tx1; x++) for (let y = ty0; y <= ty1; y++) {
  const pbf = await getTile('experimental_bvmap', Z, x, y, 'pbf');
  if (!pbf) continue;
  const vt = new VectorTile(new Pbf(new Uint8Array(pbf)));
  for (const l of LAYERS) {
    const L = vt.layers[l];
    if (!L) continue;
    for (let i = 0; i < L.length; i++) {
      const f = L.feature(i);
      const g = f.toGeoJSON(x, y, Z).geometry;
      let coords;
      if (g.type === 'Point') coords = [conv(g.coordinates)];
      else if (g.type === 'LineString') coords = [g.coordinates.map(conv)];
      else if (g.type === 'MultiLineString') coords = g.coordinates.map((ls) => ls.map(conv));
      else if (g.type === 'Polygon') coords = g.coordinates.map((r) => r.map(conv));
      else if (g.type === 'MultiPolygon') coords = g.coordinates.flatMap((p) => p.map((r) => r.map(conv)));
      else continue;
      out[l].push({ t: g.type, p: f.properties, c: coords, tile: `${x}/${y}` });
    }
  }
}
for (const l of LAYERS) console.log(l, out[l].length);
fs.writeFileSync(path.join(RAW, 'vector.json'), JSON.stringify(out));
fs.writeFileSync(path.join(RAW, 'grids.json'), JSON.stringify({ grids, core }, null, 1));
