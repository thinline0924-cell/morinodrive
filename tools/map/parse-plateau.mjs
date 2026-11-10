// PLATEAU CityGML(建物 LOD1・道路 LOD1)をゲームの座標に直して軽い JSON にする
// 出典:国土交通省 PLATEAU 金沢市 2024
import fs from 'node:fs';
import path from 'node:path';
import { AREA, toLocal } from './area.mjs';

const RAW = path.join(import.meta.dirname, 'raw');
const dir = path.join(RAW, 'plateau');
const r1 = (v) => Math.round(v * 10) / 10;
const margin = 0.004;
const inArea = (lat, lon) => lat > AREA.lat0 - margin && lat < AREA.lat1 + margin && lon > AREA.lon0 - margin * 1.25 && lon < AREA.lon1 + margin * 1.25;

function ring(posList) {
  const v = posList.trim().split(/\s+/).map(Number);
  const pts = [];
  let zmin = Infinity, zmax = -Infinity;
  for (let i = 0; i + 2 < v.length; i += 3) {
    const [x, z] = toLocal(v[i], v[i + 1]);
    pts.push([r1(x), r1(z)]);
    zmin = Math.min(zmin, v[i + 2]); zmax = Math.max(zmax, v[i + 2]);
  }
  if (pts.length > 1 && pts[0][0] === pts.at(-1)[0] && pts[0][1] === pts.at(-1)[1]) pts.pop();
  return { pts, zmin, zmax, lat: v[0], lon: v[1] };
}
const tag = (s, t) => { const m = s.match(new RegExp(`<${t}[^>]*>([^<]*)</${t}>`)); return m ? m[1] : null; };

// ---------- 建物 ----------
const buildings = [];
const usageCount = {};
for (const f of fs.readdirSync(dir).filter((f) => f.includes('_bldg_'))) {
  const s = fs.readFileSync(path.join(dir, f), 'utf8');
  let i = 0;
  for (;;) {
    const a = s.indexOf('<bldg:Building ', i);
    if (a < 0) break;
    const b = s.indexOf('</bldg:Building>', a);
    const blk = s.slice(a, b);
    i = b;
    const fp = blk.match(/<bldg:lod0FootPrint>[\s\S]*?<gml:posList>([^<]*)<\/gml:posList>/) || blk.match(/<bldg:lod0RoofEdge>[\s\S]*?<gml:posList>([^<]*)<\/gml:posList>/);
    if (!fp) continue;
    const foot = ring(fp[1]);
    if (!inArea(foot.lat, foot.lon)) continue;
    // LOD1 の立体から、地面の高さと屋上の高さ
    let zmin = Infinity, zmax = -Infinity;
    for (const m of blk.matchAll(/<bldg:lod1Solid>[\s\S]*?<\/bldg:lod1Solid>/g)) {
      for (const p of m[0].matchAll(/<gml:posList>([^<]*)<\/gml:posList>/g)) {
        const v = p[1].trim().split(/\s+/).map(Number);
        for (let k = 2; k < v.length; k += 3) { zmin = Math.min(zmin, v[k]); zmax = Math.max(zmax, v[k]); }
      }
    }
    const usage = tag(blk, 'bldg:usage');
    usageCount[usage] = (usageCount[usage] || 0) + 1;
    const o = {
      p: foot.pts,
      b: Number.isFinite(zmin) ? r1(zmin) : null,      // 地面の標高
      h: Number.isFinite(zmax) ? r1(zmax - zmin) : null, // LOD1 の高さ
      mh: Number(tag(blk, 'bldg:measuredHeight')) || null,
      u: usage ? Number(usage) : null,
      st: Number(tag(blk, 'bldg:storeysAboveGround')) || null,
    };
    const name = tag(blk, 'gml:name');
    if (name) o.n = name;
    const year = Number(tag(blk, 'bldg:yearOfConstruction'));
    if (year > 1800) o.y = year;
    buildings.push(o);
  }
}
console.log('buildings', buildings.length, 'usage', JSON.stringify(usageCount));
console.log('named', buildings.filter((b) => b.n).length, buildings.filter((b) => b.n).slice(0, 25).map((b) => b.n).join(' / '));

// ---------- 道路(面) ----------
const roads = [];
const fnCount = {}, secCount = {};
for (const f of fs.readdirSync(dir).filter((f) => f.includes('_tran_'))) {
  const s = fs.readFileSync(path.join(dir, f), 'utf8');
  for (const m of s.matchAll(/<tran:Road [\s\S]*?<\/tran:Road>/g)) {
    const blk = m[0];
    const fn = Number(tag(blk, 'tran:function'));
    const sec = Number(tag(blk, 'uro:sectionType'));
    fnCount[fn] = (fnCount[fn] || 0) + 1; secCount[sec] = (secCount[sec] || 0) + 1;
    for (const poly of blk.matchAll(/<gml:Polygon>([\s\S]*?)<\/gml:Polygon>/g)) {
      const ext = poly[1].match(/<gml:exterior>[\s\S]*?<gml:posList>([^<]*)</);
      if (!ext) continue;
      const e = ring(ext[1]);
      if (!inArea(e.lat, e.lon)) continue;
      const holes = [...poly[1].matchAll(/<gml:interior>[\s\S]*?<gml:posList>([^<]*)</g)].map((h) => ring(h[1]).pts);
      roads.push({ p: e.pts, hl: holes.length ? holes : undefined, f: fn, s: sec });
    }
  }
}
console.log('road polygons', roads.length, 'function', JSON.stringify(fnCount), 'section', JSON.stringify(secCount));
fs.writeFileSync(path.join(RAW, 'plateau.json'), JSON.stringify({ buildings, roads }));
