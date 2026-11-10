// PLATEAU 金沢市 2024 の CityGML から、範囲内の 3次メッシュの分だけ取り出す
import fs from 'node:fs';
import path from 'node:path';
import { listZip, readEntry } from './zip-range.mjs';
import { meshCodes } from './area.mjs';

const URL = 'https://assets.cms.plateau.reearth.io/assets/d9/61e6e9-e5c4-4235-a95c-e2220ae66b6b/17201_kanazawa-shi_city_2024_citygml_1_op.zip';
const OUT = path.join(import.meta.dirname, 'raw/plateau');
const KINDS = (process.argv[2] || 'bldg,tran,frn').split(',');
fs.mkdirSync(OUT, { recursive: true });

const meshes = new Set(meshCodes());
const { size, entries } = await listZip(URL);
console.log('zip', (size / 1e6).toFixed(0), 'MB,', entries.length, 'files');
// 2次メッシュ単位のファイル(道路など)も拾う
const second = new Set([...meshes].map((m) => m.slice(0, 6)));
const want = entries.filter((e) => {
  const m = e.name.match(/udx\/(\w+)\/(\d+)_/);
  if (!m || !KINDS.includes(m[1])) return false;
  return meshes.has(m[2]) || second.has(m[2]);
});
console.log('target meshes', [...meshes].join(' '));
console.log('files to fetch', want.length, (want.reduce((s, e) => s + e.csize, 0) / 1e6).toFixed(1), 'MB compressed');
for (const e of want) {
  const dst = path.join(OUT, path.basename(e.name));
  if (fs.existsSync(dst) && fs.statSync(dst).size === e.usize) { console.log('skip', e.name); continue; }
  const buf = await readEntry(URL, e);
  fs.writeFileSync(dst, buf);
  console.log('got', e.name, (buf.length / 1e6).toFixed(1), 'MB');
}
// 他にどんな種類があるか(参考)
const kinds = {};
for (const e of entries) { const m = e.name.match(/udx\/(\w+)\//); if (m) kinds[m[1]] = (kinds[m[1]] || 0) + 1; }
console.log('kinds in zip', JSON.stringify(kinds));
