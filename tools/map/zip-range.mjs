// 大きな zip を丸ごと落とさず、必要なファイルだけを HTTP の範囲指定で取り出す
import zlib from 'node:zlib';

async function range(url, start, end) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
      if (res.status !== 206) throw new Error(`range request failed: HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      if (attempt === 3) throw e;
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
    }
  }
}

export async function listZip(url) {
  const head = await fetch(url, { method: 'HEAD' });
  const size = Number(head.headers.get('content-length'));
  const tailLen = Math.min(size, 128 * 1024);
  const tail = await range(url, size - tailLen, size - 1);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('zip の終端が見つからない');
  let cdSize = tail.readUInt32LE(eocd + 12), cdOff = tail.readUInt32LE(eocd + 16), count = tail.readUInt16LE(eocd + 10);
  // ZIP64
  if (cdOff === 0xffffffff || count === 0xffff) {
    const loc = eocd - 20;
    if (tail.readUInt32LE(loc) !== 0x07064b50) throw new Error('ZIP64 の目印が見つからない');
    const z64off = Number(tail.readBigUInt64LE(loc + 8));
    const z = await range(url, z64off, z64off + 55);
    count = Number(z.readBigUInt64LE(32));
    cdSize = Number(z.readBigUInt64LE(40));
    cdOff = Number(z.readBigUInt64LE(48));
  }
  const cd = await range(url, cdOff, cdOff + cdSize - 1);
  const entries = [];
  let p = 0;
  while (p < cd.length && cd.readUInt32LE(p) === 0x02014b50) {
    const method = cd.readUInt16LE(p + 10);
    let csize = cd.readUInt32LE(p + 20), usize = cd.readUInt32LE(p + 24);
    const nlen = cd.readUInt16LE(p + 28), xlen = cd.readUInt16LE(p + 30), clen = cd.readUInt16LE(p + 32);
    let off = cd.readUInt32LE(p + 42);
    const name = cd.toString('utf8', p + 46, p + 46 + nlen);
    // ZIP64 の追加情報
    let x = p + 46 + nlen;
    const xend = x + xlen;
    while (x < xend) {
      const id = cd.readUInt16LE(x), sz = cd.readUInt16LE(x + 2);
      if (id === 0x0001) {
        let q = x + 4;
        if (usize === 0xffffffff) { usize = Number(cd.readBigUInt64LE(q)); q += 8; }
        if (csize === 0xffffffff) { csize = Number(cd.readBigUInt64LE(q)); q += 8; }
        if (off === 0xffffffff) { off = Number(cd.readBigUInt64LE(q)); q += 8; }
      }
      x += 4 + sz;
    }
    entries.push({ name, method, csize, usize, off });
    p = xend + clen;
  }
  return { size, entries };
}

export async function readEntry(url, e) {
  const lh = await range(url, e.off, e.off + 29);
  const nlen = lh.readUInt16LE(26), xlen = lh.readUInt16LE(28);
  const start = e.off + 30 + nlen + xlen;
  const data = e.csize ? await range(url, start, start + e.csize - 1) : Buffer.alloc(0);
  if (e.method === 0) return data;
  if (e.method === 8) return zlib.inflateRawSync(data);
  throw new Error(`未対応の圧縮方式 ${e.method}: ${e.name}`);
}
