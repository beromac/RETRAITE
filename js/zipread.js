// Lecture d'un ZIP (méthodes « stocké » et « deflate »), sans dépendance : décompression native du navigateur.
async function inflate(data) {
  const flux = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(flux).arrayBuffer());
}

function nomZip(bytes, utf8) {
  if (utf8) return new TextDecoder('utf-8').decode(bytes);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return new TextDecoder('windows-1252').decode(bytes); }
}

/** → { fichiers: [{ name, bytes }], ignores: [noms] } */
export async function lireZip(buffer) {
  const dv = new DataView(buffer);
  const u8 = new Uint8Array(buffer);
  let eocd = -1;
  for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Archive ZIP illisible.');
  const total = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  if (total === 0xffff || p === 0xffffffff) throw new Error('ZIP trop volumineux (format ZIP64 non géré).');
  const fichiers = [];
  const ignores = [];
  for (let n = 0; n < total; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nl = dv.getUint16(p + 28, true);
    const el = dv.getUint16(p + 30, true);
    const cl = dv.getUint16(p + 32, true);
    const off = dv.getUint32(p + 42, true);
    const name = nomZip(u8.subarray(p + 46, p + 46 + nl), !!(flags & 0x800));
    p += 46 + nl + el + cl;
    if (name.endsWith('/') || name.startsWith('__MACOSX/') || /(^|\/)(\._|\.DS_Store|Thumbs\.db)/.test(name)) continue;
    if (flags & 1) { ignores.push(`${name} (protégé par mot de passe)`); continue; }
    const start = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true);
    const brut = u8.subarray(start, start + csize);
    try {
      if (method === 0) fichiers.push({ name, bytes: brut.slice() });
      else if (method === 8) fichiers.push({ name, bytes: await inflate(brut) });
      else ignores.push(`${name} (compression non prise en charge)`);
    } catch { ignores.push(`${name} (illisible)`); }
  }
  return { fichiers, ignores };
}
