// Mapillary が写真から検出した物(標識・電柱・信号・消火栓・カーブミラーなど)の位置
// 出典:© Mapillary contributors(CC BY-SA 4.0)
import fs from 'node:fs';
import path from 'node:path';
import { AREA } from './area.mjs';
const OUT = path.join(import.meta.dirname, 'raw/mly');
const step = 0.005, all = [];
for (const layer of ['map_features']) {
  for (let la = AREA.lat0; la < AREA.lat1; la += step) for (let lo = AREA.lon0; lo < AREA.lon1; lo += step) {
    const bbox = [lo, la, Math.min(lo + step, AREA.lon1), Math.min(la + step, AREA.lat1)].map((v) => v.toFixed(5)).join(',');
    const r = await fetch(`https://graph.mapillary.com/${layer}?bbox=${bbox}&fields=id,object_value,object_type,geometry,aligned_direction&limit=5000`);
    if (!r.ok) { console.log('HTTP', r.status, (await r.text()).slice(0, 200)); continue; }
    all.push(...((await r.json()).data || []));
  }
}
fs.writeFileSync(path.join(OUT, 'features.json'), JSON.stringify(all));
const c = {}; for (const f of all) c[f.object_value] = (c[f.object_value] || 0) + 1;
console.log('features', all.length);
console.log(Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, v]) => `${v} ${k}`).join('\n'));
