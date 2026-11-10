// OpenStreetMap(Overpass で取得した JSON)から、車が走る道路と信号・横断歩道を取り出す
// 出典:© OpenStreetMap contributors(ODbL)
import { toLocal } from './area.mjs';

const DRIVE = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'service', 'living_street',
  'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link']);

// 車道の幅(m)。車線数があればそれを使い、なければ道路の種類から決める
function carriageWidth(t) {
  const hw = t.highway.replace('_link', '');
  const link = t.highway.endsWith('_link');
  const laneW = ['motorway', 'trunk', 'primary'].includes(hw) ? 3.25 : 3.0;
  let lanes = Number(t.lanes);
  if (!lanes) {
    if (link) lanes = 1;
    else if (['motorway', 'trunk', 'primary', 'secondary', 'tertiary'].includes(hw)) lanes = t.oneway === 'yes' ? 1 : 2;
  }
  if (lanes) return { w: lanes * laneW + (lanes >= 2 ? 1.0 : 1.5), lanes, laneW };
  if (hw === 'service') return { w: 4.0, lanes: 0, laneW };
  return { w: 5.0, lanes: 0, laneW }; // 生活道路:中央線なし
}

export function parseOSM(json) {
  const nodes = new Map();
  for (const e of json.elements) if (e.type === 'node' && (!nodes.has(e.id) || e.tags)) nodes.set(e.id, e);
  const ways = [];
  const use = new Map(); // ノードを何本の道路が使っているか(交差点の判定)
  for (const e of json.elements) {
    if (e.type !== 'way' || !e.tags || !DRIVE.has(e.tags.highway)) continue;
    if (e.tags.access === 'private' || e.tags.area === 'yes') continue;
    const pts = e.nodes.map((id) => nodes.get(id)).filter(Boolean).map((n) => toLocal(n.lat, n.lon));
    if (pts.length < 2) continue;
    const cw = carriageWidth(e.tags);
    ways.push({
      id: e.id, nodes: e.nodes, pts, tags: e.tags, hw: e.tags.highway, ...cw,
      oneway: e.tags.oneway === 'yes' || e.tags.highway.endsWith('_link') && e.tags.oneway !== 'no',
      bridge: e.tags.bridge === 'yes', tunnel: e.tags.tunnel === 'yes',
      name: e.tags.name || null, ref: e.tags.ref || null, maxspeed: Number(e.tags.maxspeed) || null,
    });
    for (const id of new Set(e.nodes)) use.set(id, (use.get(id) || 0) + 1);
  }
  // 交差点:2本以上の道路が共有するノード、または1本の道路の途中で別の道路と接するノード
  const junction = new Set([...use].filter(([, c]) => c >= 2).map(([id]) => id));
  const signals = [], crossings = [];
  for (const [id, n] of nodes) {
    const hwTag = n.tags?.highway;
    if (hwTag === 'traffic_signals') signals.push({ id, xz: toLocal(n.lat, n.lon) });
    else if (hwTag === 'crossing' || n.tags?.crossing) crossings.push({ id, xz: toLocal(n.lat, n.lon), kind: n.tags.crossing || '' });
  }
  // 店や施設(名前のあるもの)。建物の種類と看板に使う
  const pois = [];
  for (const e of json.elements) {
    const t = e.tags;
    if (!t || !t.name || !(t.amenity || t.shop)) continue;
    let lat, lon;
    if (e.type === 'node') { lat = e.lat; lon = e.lon; }
    else if (e.type === 'way') {
      const ns = (e.nodes || []).map((id) => nodes.get(id)).filter(Boolean);
      if (!ns.length) continue;
      lat = ns.reduce((s, n) => s + n.lat, 0) / ns.length; lon = ns.reduce((s, n) => s + n.lon, 0) / ns.length;
    } else continue;
    const [x, z] = toLocal(lat, lon);
    pois.push({ x, z, name: t.name, amenity: t.amenity || '', shop: t.shop || '', religion: t.religion || '' });
  }
  return { ways, junction, signals, crossings, nodes, pois };
}

// ノード位置での道路の向き(そのノードを通る最初の車道)
export function wayDirAt(ways, nodeId) {
  const out = [];
  for (const w of ways) {
    const i = w.nodes.indexOf(nodeId);
    if (i < 0) continue;
    const a = w.pts[Math.max(0, i - 1)], b = w.pts[Math.min(w.pts.length - 1, i + 1)];
    out.push({ w, i, ang: Math.atan2(b[1] - a[1], b[0] - a[0]) });
  }
  return out;
}
