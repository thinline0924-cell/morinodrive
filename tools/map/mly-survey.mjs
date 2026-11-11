// Mapillary の写真がどこにどれだけあるか調べる(0.005° 四方ずつ)
// 出典:© Mapillary contributors(CC BY-SA 4.0)
import fs from 'node:fs';
import path from 'node:path';
import { AREA } from './area.mjs';
const OUT = path.join(import.meta.dirname, 'raw/mly');
const step = 0.005, all = [];
for (let la = AREA.lat0; la < AREA.lat1; la += step) for (let lo = AREA.lon0; lo < AREA.lon1; lo += step) {
  const bbox = [lo, la, Math.min(lo + step, AREA.lon1), Math.min(la + step, AREA.lat1)].map((v) => v.toFixed(5)).join(',');
  let url = `https://graph.mapillary.com/images?bbox=${bbox}&fields=id,geometry,compass_angle,computed_compass_angle,captured_at,is_pano,camera_type,sequence,creator&limit=2000`;
  const r = await fetch(url);
  if (!r.ok) { console.log('HTTP', r.status, bbox, (await r.text()).slice(0, 200)); continue; }
  const j = await r.json();
  all.push(...(j.data || []));
  process.stdout.write(`\r${all.length}`);
}
fs.writeFileSync(path.join(OUT, 'images.json'), JSON.stringify(all));
const yr = {}, pano = all.filter((d) => d.is_pano).length, seqs = new Set(all.map((d) => d.sequence));
for (const d of all) { const y = new Date(d.captured_at).getFullYear(); yr[y] = (yr[y] || 0) + 1; }
console.log(`\nimages ${all.length} pano ${pano} sequences ${seqs.size} by year ${JSON.stringify(yr)} creators ${new Set(all.map((d) => d.creator?.username)).size}`);
