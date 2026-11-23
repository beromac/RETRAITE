// Coffre local chiffré : IndexedDB + AES-GCM (clé dérivée de la phrase secrète par PBKDF2).
// Rien ne quitte l'appareil. Seuls les identifiants des enregistrements sont en clair.

const DB_NAME = 'mes-papiers-retraite';
const ITER = 310000;
const enc = new TextEncoder();
const dec = new TextDecoder();

const b64 = {
  to: (buf) => {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  },
  from: (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0)),
};

function ouvrirDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('meta');
      db.createObjectStore('records', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const tx = (db, store, mode, fn) =>
  new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const r = fn(s);
    t.oncomplete = () => resolve(r && r.result !== undefined ? r.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });

async function deriveKey(phrase, salt, iterations = ITER) {
  const base = await crypto.subtle.importKey('raw', enc.encode(phrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function chiffrer(key, data) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  return { iv, ct };
}
const dechiffrer = (key, { iv, ct }) => crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);

export class Vault {
  constructor() { this.db = null; this.key = null; }

  async init() {
    this.db = await ouvrirDB();
    const salt = await tx(this.db, 'meta', 'readonly', (s) => s.get('salt'));
    return { exists: !!salt };
  }

  get unlocked() { return !!this.key; }

  async create(phrase) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveKey(phrase, salt);
    const check = await chiffrer(key, enc.encode('ok'));
    await tx(this.db, 'meta', 'readwrite', (s) => { s.put(salt, 'salt'); s.put(check, 'check'); });
    this.key = key;
  }

  async unlock(phrase) {
    const salt = await tx(this.db, 'meta', 'readonly', (s) => s.get('salt'));
    const check = await tx(this.db, 'meta', 'readonly', (s) => s.get('check'));
    const key = await deriveKey(phrase, salt);
    try {
      const v = dec.decode(await dechiffrer(key, check));
      if (v !== 'ok') return false;
    } catch { return false; }
    this.key = key;
    return true;
  }

  lock() { this.key = null; }

  /** Enregistre un objet JSON (meta) et, en option, un fichier binaire. */
  async put(id, meta, fileBuffer = null) {
    const m = await chiffrer(this.key, enc.encode(JSON.stringify(meta)));
    const f = fileBuffer ? await chiffrer(this.key, fileBuffer) : null;
    await tx(this.db, 'records', 'readwrite', (s) => s.put({ id, m, f }));
  }

  async updateMeta(id, meta) {
    const rec = await tx(this.db, 'records', 'readonly', (s) => s.get(id));
    if (!rec) return;
    rec.m = await chiffrer(this.key, enc.encode(JSON.stringify(meta)));
    await tx(this.db, 'records', 'readwrite', (s) => s.put(rec));
  }

  async remove(id) { await tx(this.db, 'records', 'readwrite', (s) => s.delete(id)); }

  async metas() {
    const recs = await tx(this.db, 'records', 'readonly', (s) => s.getAll());
    const out = [];
    for (const r of recs) {
      try { out.push({ id: r.id, ...JSON.parse(dec.decode(await dechiffrer(this.key, r.m))), _hasFile: !!r.f }); } catch { /* ignoré */ }
    }
    return out;
  }

  async file(id) {
    const rec = await tx(this.db, 'records', 'readonly', (s) => s.get(id));
    if (!rec || !rec.f) return null;
    return dechiffrer(this.key, rec.f);
  }

  async wipe() {
    await tx(this.db, 'records', 'readwrite', (s) => s.clear());
    await tx(this.db, 'meta', 'readwrite', (s) => s.clear());
    this.key = null;
  }

  /** Sauvegarde chiffrée (JSON) : à conserver sur une clé USB ou à transférer vers un autre appareil. */
  async exportBackup() {
    const salt = await tx(this.db, 'meta', 'readonly', (s) => s.get('salt'));
    const recs = await tx(this.db, 'records', 'readonly', (s) => s.getAll());
    const pack = (x) => (x ? { iv: b64.to(x.iv), ct: b64.to(x.ct) } : null);
    return JSON.stringify({
      format: 'mes-papiers-retraite', version: 1, iterations: ITER, salt: b64.to(salt),
      records: recs.map((r) => ({ id: r.id, m: pack(r.m), f: pack(r.f) })),
    });
  }

  /** Importe une sauvegarde : déchiffrée avec sa phrase, rechiffrée avec la clé courante. */
  async importBackup(text, phrase) {
    const data = JSON.parse(text);
    if (data.format !== 'mes-papiers-retraite') throw new Error('Fichier de sauvegarde non reconnu.');
    const key = await deriveKey(phrase, b64.from(data.salt), data.iterations || ITER);
    const unpack = (x) => ({ iv: b64.from(x.iv), ct: b64.from(x.ct) });
    let n = 0;
    for (const r of data.records) {
      let metaBytes;
      try { metaBytes = await dechiffrer(key, unpack(r.m)); } catch { throw new Error('Phrase secrète de la sauvegarde incorrecte.'); }
      const file = r.f ? await dechiffrer(key, unpack(r.f)) : null;
      const m = await chiffrer(this.key, metaBytes);
      const f = file ? await chiffrer(this.key, file) : null;
      await tx(this.db, 'records', 'readwrite', (s) => s.put({ id: r.id, m, f }));
      n++;
    }
    return n;
  }
}
