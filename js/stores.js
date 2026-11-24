// Lieux de stockage du coffre chiffré. Les deux implémentations exposent la même interface :
//   open(), getMeta(k), setMeta(k, v), getRecord(id), putRecord(rec), deleteRecord(id),
//   allMetas(), allRecords(), clearAll(), label
// Un enregistrement : { id, m: { iv, ct }, f: { iv, ct } | null }  (tout est déjà chiffré par Vault).

export const b64 = {
  to: (buf) => {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  },
  from: (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0)),
};

const tx = (db, store, mode, fn) =>
  new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const r = fn(t.objectStore(store));
    t.oncomplete = () => resolve(r && r.result !== undefined ? r.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });

/** Stockage dans le navigateur (IndexedDB) : données liées à cet ordinateur et à ce navigateur. */
export class IdbStore {
  constructor() { this.kind = 'navigateur'; this.label = 'ce navigateur'; this.db = null; }

  open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('mes-papiers-retraite', 1);
      req.onupgradeneeded = () => { req.result.createObjectStore('meta'); req.result.createObjectStore('records', { keyPath: 'id' }); };
      req.onsuccess = () => { this.db = req.result; resolve(); };
      req.onerror = () => reject(req.error);
    });
  }
  getMeta(k) { return tx(this.db, 'meta', 'readonly', (s) => s.get(k)); }
  setMeta(k, v) { return tx(this.db, 'meta', 'readwrite', (s) => s.put(v, k)); }
  getRecord(id) { return tx(this.db, 'records', 'readonly', (s) => s.get(id)); }
  putRecord(rec) { return tx(this.db, 'records', 'readwrite', (s) => s.put(rec)); }
  deleteRecord(id) { return tx(this.db, 'records', 'readwrite', (s) => s.delete(id)); }
  async allMetas() { return (await this.allRecords()).map((r) => ({ id: r.id, m: r.m, hasFile: !!r.f })); }
  allRecords() { return tx(this.db, 'records', 'readonly', (s) => s.getAll()); }
  async clearAll() { await tx(this.db, 'records', 'readwrite', (s) => s.clear()); await tx(this.db, 'meta', 'readwrite', (s) => s.clear()); }
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const ID_OK = /^[\w-]{1,80}$/;

/**
 * Stockage dans un dossier choisi par l'utilisateur (clé USB, disque externe…) via l'API
 * File System Access (Chrome, Edge). Un fichier chiffré par enregistrement :
 *   coffre.json        sel + témoin de la phrase secrète
 *   <id>.json          métadonnées chiffrées      <id>.mpr   fichier chiffré
 */
export class DossierStore {
  constructor(dirHandle) { this.kind = 'dossier'; this.dir = dirHandle; this.label = `dossier « ${dirHandle.name} »`; }

  async open() {}

  async #lire(nom) {
    try { return await (await (await this.dir.getFileHandle(nom)).getFile()).arrayBuffer(); }
    catch (e) { if (e.name === 'NotFoundError') return null; throw e; }
  }
  async #ecrire(nom, donnees) {
    const fh = await this.dir.getFileHandle(nom, { create: true });
    const w = await fh.createWritable();
    await w.write(donnees);
    await w.close();
  }
  async #supprimer(nom) {
    try { await this.dir.removeEntry(nom); } catch (e) { if (e.name !== 'NotFoundError') throw e; }
  }
  async #coffre() {
    const buf = await this.#lire('coffre.json');
    return buf ? JSON.parse(dec.decode(buf)) : {};
  }

  async getMeta(k) {
    const v = (await this.#coffre())[k];
    if (!v) return undefined;
    return k === 'salt' ? b64.from(v) : { iv: b64.from(v.iv), ct: b64.from(v.ct) };
  }
  async setMeta(k, v) {
    const c = await this.#coffre();
    c.format = 'mes-papiers-retraite-coffre'; c.version = 1;
    c[k] = k === 'salt' ? b64.to(v) : { iv: b64.to(v.iv), ct: b64.to(v.ct) };
    await this.#ecrire('coffre.json', enc.encode(JSON.stringify(c)));
  }

  async getRecord(id) {
    if (!ID_OK.test(id)) return undefined;
    const j = await this.#lire(`${id}.json`);
    if (!j) return undefined;
    const { m } = JSON.parse(dec.decode(j));
    const bin = await this.#lire(`${id}.mpr`);
    let f = null;
    if (bin) { const u = new Uint8Array(bin); f = { iv: u.slice(0, 12), ct: u.slice(12).buffer }; }
    return { id, m: { iv: b64.from(m.iv), ct: b64.from(m.ct) }, f };
  }
  async putRecord(rec) {
    if (!ID_OK.test(rec.id)) throw new Error('Identifiant invalide');
    if (rec.f) {
      const iv = new Uint8Array(rec.f.iv), ct = new Uint8Array(rec.f.ct);
      const all = new Uint8Array(iv.length + ct.length);
      all.set(iv, 0); all.set(ct, iv.length);
      await this.#ecrire(`${rec.id}.mpr`, all);
    } else await this.#supprimer(`${rec.id}.mpr`);
    await this.#ecrire(`${rec.id}.json`, enc.encode(JSON.stringify({ id: rec.id, m: { iv: b64.to(rec.m.iv), ct: b64.to(rec.m.ct) } })));
  }
  async deleteRecord(id) {
    if (!ID_OK.test(id)) return;
    await this.#supprimer(`${id}.mpr`);
    await this.#supprimer(`${id}.json`);
  }
  async #ids() {
    const noms = [];
    for await (const [nom, h] of this.dir.entries()) if (h.kind === 'file') noms.push(nom);
    const bins = new Set(noms.filter((n) => n.endsWith('.mpr')).map((n) => n.slice(0, -4)));
    const ids = noms.filter((n) => n.endsWith('.json') && n !== 'coffre.json').map((n) => n.slice(0, -5)).filter((i) => ID_OK.test(i));
    return { ids, bins };
  }
  async allMetas() {
    const { ids, bins } = await this.#ids();
    const out = [];
    for (const id of ids) {
      const j = await this.#lire(`${id}.json`);
      if (!j) continue;
      try { const { m } = JSON.parse(dec.decode(j)); out.push({ id, m: { iv: b64.from(m.iv), ct: b64.from(m.ct) }, hasFile: bins.has(id) }); } catch { /* fichier abîmé : ignoré */ }
    }
    return out;
  }
  async allRecords() {
    const { ids } = await this.#ids();
    const out = [];
    for (const id of ids) { const r = await this.getRecord(id); if (r) out.push(r); }
    return out;
  }
  async clearAll() {
    const { ids } = await this.#ids();
    for (const id of ids) await this.deleteRecord(id);
    await this.#supprimer('coffre.json');
  }
  /** Vrai si le dossier contient déjà un coffre. */
  async contientCoffre() { return !!(await this.#lire('coffre.json')); }
  /** Vérifie qu'on peut bien écrire dans le dossier (clé protégée en écriture, permission refusée…). */
  async tester() { await this.#ecrire('ecriture-test.tmp', enc.encode('ok')); await this.#supprimer('ecriture-test.tmp'); }
}

// ───────── Préférence « où sont mes données ? » (mémorisée dans ce navigateur) ─────────
function prefsDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('mpr-prefs', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
export async function prefsGet(k) { try { return await tx(await prefsDb(), 'kv', 'readonly', (s) => s.get(k)); } catch { return undefined; } }
export async function prefsSet(k, v) { try { await tx(await prefsDb(), 'kv', 'readwrite', (s) => s.put(v, k)); } catch { /* navigateur sans stockage : on ne mémorise pas */ } }
export async function prefsDel(k) { try { await tx(await prefsDb(), 'kv', 'readwrite', (s) => s.delete(k)); } catch { /* idem */ } }

export const dossierPossible = () => typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
