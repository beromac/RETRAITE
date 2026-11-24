// Coffre chiffré : AES-GCM, clé dérivée de la phrase secrète par PBKDF2. Rien ne quitte l'appareil.
// Le lieu de stockage (navigateur ou dossier d'une clé USB) est fourni par un « store » (voir stores.js).
// Seuls les identifiants des enregistrements sont en clair.
import { b64 } from './stores.js';


const ITER = 310000;
const enc = new TextEncoder();
const dec = new TextDecoder();

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
  constructor() { this.store = null; this.key = null; }

  async init(store) {
    this.store = store;
    await store.open();
    return { exists: !!(await store.getMeta('salt')) };
  }

  get unlocked() { return !!this.key; }

  async create(phrase) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveKey(phrase, salt);
    const check = await chiffrer(key, enc.encode('ok'));
    await this.store.setMeta('salt', salt);
    await this.store.setMeta('check', check);
    this.key = key;
  }

  async unlock(phrase) {
    const salt = await this.store.getMeta('salt');
    const check = await this.store.getMeta('check');
    if (!salt || !check) return false;
    const key = await deriveKey(phrase, salt);
    try {
      if (dec.decode(await dechiffrer(key, check)) !== 'ok') return false;
    } catch { return false; }
    this.key = key;
    return true;
  }

  lock() { this.key = null; }

  /** Enregistre un objet JSON (meta) et, en option, un fichier binaire. */
  async put(id, meta, fileBuffer = null) {
    const m = await chiffrer(this.key, enc.encode(JSON.stringify(meta)));
    const f = fileBuffer ? await chiffrer(this.key, fileBuffer) : null;
    await this.store.putRecord({ id, m, f });
  }

  async updateMeta(id, meta) {
    const rec = await this.store.getRecord(id);
    if (!rec) return;
    rec.m = await chiffrer(this.key, enc.encode(JSON.stringify(meta)));
    await this.store.putRecord(rec);
  }

  async remove(id) { await this.store.deleteRecord(id); }

  async metas() {
    const out = [];
    for (const r of await this.store.allMetas()) {
      try { out.push({ id: r.id, ...JSON.parse(dec.decode(await dechiffrer(this.key, r.m))), _hasFile: r.hasFile }); } catch { /* ignoré */ }
    }
    return out;
  }

  async file(id) {
    const rec = await this.store.getRecord(id);
    if (!rec || !rec.f) return null;
    return dechiffrer(this.key, rec.f);
  }

  async wipe() {
    await this.store.clearAll();
    this.key = null;
  }

  /** Sauvegarde chiffrée (JSON) : à conserver sur une clé USB ou à transférer vers un autre appareil. */
  async exportBackup() {
    const salt = await this.store.getMeta('salt');
    const recs = await this.store.allRecords();
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
      await this.store.putRecord({ id: r.id, m, f });
      n++;
    }
    return n;
  }

  /**
   * Copie tout le coffre (même phrase secrète, sans la déchiffrer) vers un autre store vide :
   * sert à mettre ses données sur une clé USB.
   */
  async copierVers(dest) {
    await dest.open();
    await dest.setMeta('salt', await this.store.getMeta('salt'));
    await dest.setMeta('check', await this.store.getMeta('check'));
    let n = 0;
    for (const r of await this.store.allRecords()) { await dest.putRecord(r); n++; }
    return n;
  }
}
