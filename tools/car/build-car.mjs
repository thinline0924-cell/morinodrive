// 車モデルの加工:座標の焼き込み、タイヤとハンドルの分離、軽量化、テクスチャ圧縮
// 使い方: node build-car.mjs 入力.glb 出力.glb plate.png
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, weld, simplify, textureCompress, meshopt, join } from '@gltf-transform/functions';
import { MeshoptSimplifier, MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';
import fs from 'node:fs';

const [, , SRC, DST, PLATE] = process.argv;
await MeshoptSimplifier.ready;
await MeshoptEncoder.ready;

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'meshopt.encoder': MeshoptEncoder,
});
const doc = await io.read(SRC);
const root = doc.getRoot();
const scene = root.listScenes()[0];
const buffer = root.listBuffers()[0];

// ---------- 行列ユーティリティ(列優先) ----------
const mulPoint = (m, x, y, z) => [
  m[0] * x + m[4] * y + m[8] * z + m[12],
  m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14],
];
const mulDir = (m, x, y, z) => [m[0] * x + m[4] * y + m[8] * z, m[1] * x + m[5] * y + m[9] * z, m[2] * x + m[6] * y + m[10] * z];
function normalMatrix(m) {
  // 3x3 の逆転置
  const a = m[0], b = m[4], c = m[8], d = m[1], e = m[5], f = m[9], g = m[2], h = m[6], i = m[10];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  const inv = [
    A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det,
  ];
  // 逆行列 inv(行優先) の転置 → 列優先で n[col*4+row]
  const n = new Array(16).fill(0);
  n[0] = inv[0]; n[4] = inv[3]; n[8] = inv[6];
  n[1] = inv[1]; n[5] = inv[4]; n[9] = inv[7];
  n[2] = inv[2]; n[6] = inv[5]; n[10] = inv[8];
  return { n, det };
}

// ---------- 全プリミティブをワールド座標に焼き込む ----------
const baked = []; // {prim, material, min, max}
function bake(prim, M) {
  const { n: N, det } = normalMatrix(M);
  const out = doc.createPrimitive().setMode(prim.getMode()).setMaterial(prim.getMaterial());
  for (const sem of prim.listSemantics()) {
    const src = prim.getAttribute(sem);
    const acc = src.clone();
    if (sem === 'POSITION' || sem === 'NORMAL' || sem === 'TANGENT') {
      const arr = new Float32Array(src.getArray());
      const size = src.getElementSize();
      for (let k = 0; k < src.getCount(); k++) {
        const o = k * size;
        let v;
        if (sem === 'POSITION') v = mulPoint(M, arr[o], arr[o + 1], arr[o + 2]);
        else if (sem === 'NORMAL') {
          v = mulDir(N, arr[o], arr[o + 1], arr[o + 2]);
          const l = Math.hypot(...v) || 1; v = v.map((x) => x / l);
        } else {
          v = mulDir(M, arr[o], arr[o + 1], arr[o + 2]);
          const l = Math.hypot(...v) || 1; v = v.map((x) => x / l);
          if (det < 0) arr[o + 3] = -arr[o + 3];
        }
        arr[o] = v[0]; arr[o + 1] = v[1]; arr[o + 2] = v[2];
      }
      acc.setArray(arr).setNormalized(false);
    }
    acc.setBuffer(buffer);
    out.setAttribute(sem, acc);
  }
  let idx = prim.getIndices();
  if (idx) {
    const a = Uint32Array.from(idx.getArray());
    if (det < 0) for (let k = 0; k < a.length; k += 3) { const t = a[k + 1]; a[k + 1] = a[k + 2]; a[k + 2] = t; }
    out.setIndices(doc.createAccessor().setType('SCALAR').setArray(a).setBuffer(buffer));
  }
  return out;
}
function bbox(prim) {
  const p = prim.getAttribute('POSITION').getArray();
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < p.length; k += 3) for (let j = 0; j < 3; j++) { mn[j] = Math.min(mn[j], p[k + j]); mx[j] = Math.max(mx[j], p[k + j]); }
  return { mn, mx };
}

// 面の巻き順が頂点法線と逆になっていれば巻き順だけ直す(元データの右前ドアがこの状態)
function fixWinding(prim) {
  const P = prim.getAttribute('POSITION').getArray();
  const Nacc = prim.getAttribute('NORMAL');
  if (!Nacc || !prim.getIndices()) return false;
  const N = Nacc.getArray();
  const I = prim.getIndices().getArray();
  let agree = 0, total = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const u = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]];
    const v = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const vn = [N[a] + N[b] + N[c], N[a + 1] + N[b + 1] + N[c + 1], N[a + 2] + N[b + 2] + N[c + 2]];
    const ar = Math.hypot(...n);
    agree += (n[0] * vn[0] + n[1] * vn[1] + n[2] * vn[2]) / (Math.hypot(...vn) || 1);
    total += ar;
  }
  if (agree / total > -0.5) return false;
  const idx = Uint32Array.from(I);
  for (let k = 0; k < idx.length; k += 3) { const t = idx[k + 1]; idx[k + 1] = idx[k + 2]; idx[k + 2] = t; }
  prim.getIndices().setArray(idx);
  return true;
}

scene.traverse((node) => {
  const mesh = node.getMesh();
  if (!mesh) return;
  const M = node.getWorldMatrix();
  for (const prim of mesh.listPrimitives()) {
    const b = bake(prim, M);
    if (fixWinding(b)) console.log('fixed winding:', node.getName());
    baked.push({ prim: b, mat: prim.getMaterial()?.getName() ?? '', ...bbox(b), srcNode: node.getName() });
  }
});
console.log('baked primitives', baked.length);

// ---------- タイヤの中心 ----------
const tires = baked.filter((b) => b.mat.startsWith('M_TIRES'));
const wheels = tires.map((t) => ({
  c: [(t.mn[0] + t.mx[0]) / 2, (t.mn[1] + t.mx[1]) / 2, (t.mn[2] + t.mx[2]) / 2],
  r: (t.mx[1] - t.mn[1]) / 2,
}));
const nameOf = (w) => (w.c[0] > 0 ? 'F' : 'R') + (w.c[2] > 0 ? 'R' : 'L'); // +X が前、+Z が右
wheels.forEach((w) => (w.name = nameOf(w)));
console.log('wheels', wheels.map((w) => `${w.name} c=${w.c.map((v) => v.toFixed(3))} r=${w.r.toFixed(3)}`).join(' | '));

function wheelOf(b) {
  for (const w of wheels) {
    const R = w.r + 0.02;
    const inX = b.mn[0] > w.c[0] - R && b.mx[0] < w.c[0] + R;
    const inY = b.mn[1] > w.c[1] - R && b.mx[1] < w.c[1] + R;
    const zIn = Math.abs(w.c[2]) - 0.17, zOut = Math.abs(w.c[2]) + 0.17;
    const az = [Math.abs(b.mn[2]), Math.abs(b.mx[2])];
    const sameSide = Math.sign(b.mn[2]) === Math.sign(w.c[2]) && Math.sign(b.mx[2]) === Math.sign(w.c[2]);
    const inZ = sameSide && Math.min(...az) > zIn && Math.max(...az) < zOut;
    if (inX && inY && inZ) return w;
  }
  return null;
}

// ---------- ハンドルの切り出し ----------
const SW = { c: [0.537, 1.057, 0.352], axis: [0.853, -0.524, 0] };
{
  const l = Math.hypot(...SW.axis); SW.axis = SW.axis.map((v) => v / l);
}
function splitSteering(entry) {
  const prim = entry.prim;
  const pos = prim.getAttribute('POSITION').getArray();
  const idx = prim.getIndices().getArray();
  const inside = new Uint8Array(pos.length / 3);
  for (let v = 0; v < inside.length; v++) {
    const d = [pos[v * 3] - SW.c[0], pos[v * 3 + 1] - SW.c[1], pos[v * 3 + 2] - SW.c[2]];
    const a = d[0] * SW.axis[0] + d[1] * SW.axis[1] + d[2] * SW.axis[2];
    const rad = Math.hypot(d[0] - a * SW.axis[0], d[1] - a * SW.axis[1], d[2] - a * SW.axis[2]);
    inside[v] = rad <= 0.215 && a >= -0.11 && a <= 0.045 ? 1 : 0;
  }
  const keep = [], take = [];
  for (let k = 0; k < idx.length; k += 3) {
    const t = inside[idx[k]] && inside[idx[k + 1]] && inside[idx[k + 2]];
    (t ? take : keep).push(idx[k], idx[k + 1], idx[k + 2]);
  }
  if (!take.length) return null;
  const sw = doc.createPrimitive().setMaterial(prim.getMaterial());
  for (const sem of prim.listSemantics()) sw.setAttribute(sem, prim.getAttribute(sem).clone());
  sw.setIndices(doc.createAccessor().setType('SCALAR').setArray(Uint32Array.from(take)).setBuffer(buffer));
  prim.setIndices(doc.createAccessor().setType('SCALAR').setArray(Uint32Array.from(keep)).setBuffer(buffer));
  return { prim: sw, tris: take.length / 3 };
}

// ---------- 新しいシーン構成 ----------
const newScene = doc.createScene('car');
const carNode = doc.createNode('car');
newScene.addChild(carNode);
const bodyMesh = doc.createMesh('body');
carNode.addChild(doc.createNode('body').setMesh(bodyMesh));

function offsetPrim(prim, o) {
  const p = prim.getAttribute('POSITION');
  const a = new Float32Array(p.getArray());
  for (let k = 0; k < a.length; k += 3) { a[k] -= o[0]; a[k + 1] -= o[1]; a[k + 2] -= o[2]; }
  p.setArray(a);
}

const wheelNodes = {};
for (const w of wheels) {
  const hub = doc.createNode('wheel_' + w.name).setTranslation(w.c);
  const spin = doc.createNode('spin_' + w.name).setMesh(doc.createMesh('spin_' + w.name));
  hub.addChild(spin);
  hub.setExtras({ radius: w.r });
  carNode.addChild(hub);
  wheelNodes[w.name] = { hub, spin, hubMesh: null, w };
}
const steerNode = doc.createNode('steering').setTranslation(SW.c).setExtras({ axis: SW.axis });
steerNode.setMesh(doc.createMesh('steering'));
carNode.addChild(steerNode);

let swTris = 0;
const counts = { body: 0 };
for (const b of baked) {
  const w = wheelOf(b);
  if (w) {
    const wn = wheelNodes[w.name];
    offsetPrim(b.prim, w.c);
    if (b.mat.startsWith('M_ALUMINUM_EXT_BRAKE')) {
      // キャリパーは回転させない(前輪は転舵だけ)
      if (!wn.hubMesh) { wn.hubMesh = doc.createMesh('hub_' + w.name); wn.hub.setMesh(wn.hubMesh); }
      wn.hubMesh.addPrimitive(b.prim);
    } else wn.spin.getMesh().addPrimitive(b.prim);
    counts[w.name] = (counts[w.name] || 0) + 1;
    continue;
  }
  if (b.mat.startsWith('M_INTERIOR')) {
    const s = splitSteering(b);
    if (s) { offsetPrim(s.prim, SW.c); steerNode.getMesh().addPrimitive(s.prim); swTris += s.tris; }
  }
  bodyMesh.addPrimitive(b.prim);
  counts.body++;
}
console.log('assigned', counts, 'steering tris', swTris);

// 旧シーンを外す
for (const s of root.listScenes()) if (s !== newScene) s.dispose();
root.setDefaultScene(newScene);

// ---------- ナンバープレート差し替え ----------
for (const m of root.listMaterials()) {
  if (m.getName().startsWith('M_LICENSE_PLATE') && m.getBaseColorTexture()) {
    m.getBaseColorTexture().setImage(fs.readFileSync(PLATE)).setMimeType('image/png');
    m.setMetallicFactor(0).setRoughnessFactor(0.45);
  }
}

// ---------- 最適化 ----------
await doc.transform(
  prune(),
  dedup(),
  join({ keepNamed: true }),
  weld(),
  simplify({ simplifier: MeshoptSimplifier, ratio: 0.35, error: 0.0004, lockBorder: true }),
  prune(),
  textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [1024, 1024], quality: 85 }),
);
let tris = 0;
for (const mesh of root.listMeshes()) for (const p of mesh.listPrimitives()) tris += (p.getIndices()?.getCount() ?? p.getAttribute('POSITION').getCount()) / 3;
console.log('triangles after', tris, 'materials', root.listMaterials().length, 'meshes', root.listMeshes().length);
await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
await io.write(DST, doc);
console.log('written', DST, (fs.statSync(DST).size / 1e6).toFixed(2), 'MB');
