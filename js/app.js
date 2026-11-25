import { Vault } from './vault.js';
import { IdbStore, DossierStore, prefsGet, prefsSet, prefsDel, dossierPossible } from './stores.js';
import { creerZip } from './zip.js';
import { texteDuPdf, analyserTexte, piecesJointesEml, pagesPdf, regrouperPages, decouperPdf, cleEmployeur } from './extract.js';
import { lireZip } from './zipread.js';
import { construireCarriere, syntheseRetraite, enfantsDroits } from './pension.js';
import { ACTIVITES, DEFAUTS, NATURES_IJ, JOURS_PAR_TRIMESTRE, parametresLegaux, formatAge } from './params.js';

// ───────────────────────── Utilitaires ─────────────────────────
const $ = (s, r = document) => r.querySelector(s);
const eur = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const eur2 = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });
const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const TYPES = { payslip: 'Bulletin de paie', urssaf: 'Déclaration Urssaf', ij: 'Indemnités journalières (Assurance Maladie)', chomage: 'Chômage (France Travail)', autre: 'Autre document' };

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'hidden' || k === 'selected') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

const uid = () => crypto.randomUUID();
async function sha256(buf) {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const num = (v) => (v === '' || v == null ? null : Number(String(v).replace(',', '.')));
const dateFr = (d) => d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
const estAndroid = /Android/i.test(navigator.userAgent);

// ───────────────────────── État ─────────────────────────
const vault = new Vault();
const PORTABLE = location.protocol === 'file:';
let stockage = null;
const state = { docs: [], profile: defaultProfile(), career: {}, tab: 'docs', filtre: { type: '', annee: '', emp: '', q: '', exact: false, vue: 'annee' }, queue: [], auto: false, total: 0, fait: 0, doublons: [], dossiers: {} };
let lockTimer;

function defaultProfile() {
  return {
    sexe: 'F', naissance: '', enfants: [], elevesNeufAns: true, trimestresAutres: 0,
    pointsAgirc: '', pensionAutreAnnuelle: 0, revalorisation: DEFAUTS.revalorisation * 100,
    continuer: true, revenuProjete: '',
  };
}

async function charger() {
  const metas = await vault.metas();
  state.docs = metas.filter((m) => m.kind === 'doc');
  const p = metas.find((m) => m.kind === 'profile');
  state.profile = { ...defaultProfile(), ...(p ? p.data : {}) };
  const c = metas.find((m) => m.kind === 'career');
  state.career = c ? c.data : {};
}
const saveProfile = () => vault.put('profile', { kind: 'profile', data: state.profile });
const saveCareer = () => vault.put('career', { kind: 'career', data: state.career });

// ───────────────────────── Verrouillage ─────────────────────────
function armerAutoVerrou() {
  const reset = () => {
    clearTimeout(lockTimer);
    if (vault.unlocked) lockTimer = setTimeout(verrouiller, 10 * 60 * 1000);
  };
  ['pointerdown', 'keydown', 'touchstart'].forEach((e) => addEventListener(e, reset, { passive: true }));
  reset();
}

function verrouiller() {
  vault.lock();
  state.docs = [];
  state.career = {};
  state.profile = defaultProfile();
  state.tab = 'docs';
  $('#tabs').hidden = true;
  $('#btn-lock').hidden = true;
  renderLock(true);
}

// ───────────────────────── Lieu de stockage (navigateur ou dossier / clé USB) ─────────────────────────
function ecran(titre, ...contenu) {
  const view = $('#view');
  view.replaceChildren(h('div', { class: 'card lock' }, h('h2', {}, titre), ...contenu));
}

async function choisirDossier() {
  const dir = await window.showDirectoryPicker({ mode: 'readwrite', id: 'mpr-donnees' });
  const st = new DossierStore(dir);
  await st.tester();
  await prefsSet('mode', 'dossier');
  await prefsSet('dir', dir);
  return st;
}
async function utiliserNavigateur() {
  await prefsSet('mode', 'navigateur');
  await prefsDel('dir');
  return new IdbStore();
}

/** Premier lancement : où enregistrer le coffre ? */
function ecranChoixStockage() {
  return new Promise((resolve) => {
    const err = h('p', { class: 'muted', style: 'color:var(--accent)' });
    const essayer = (fn) => async () => { err.textContent = ''; try { resolve(await fn()); } catch (e) { if (e?.name !== 'AbortError') err.textContent = `Impossible d’utiliser ce dossier : ${e?.message || e}`; } };
    ecran('Où enregistrer vos données ?',
      PORTABLE ? h('p', { class: 'muted' }, 'Vous utilisez la version portable : elle fonctionne sans internet, directement depuis la clé.') : null,
      dossierPossible()
        ? h('div', {}, h('p', {}, h('strong', {}, 'Sur une clé USB ou dans un dossier'), ' (recommandé pour une clé)'),
          h('p', { class: 'muted' }, 'Vos documents chiffrés sont écrits dans le dossier que vous choisissez et rien n’est laissé sur l’ordinateur. Choisissez (ou créez) un dossier vide sur la clé, par exemple « donnees ». Sur un autre ordinateur, choisissez le même dossier pour retrouver vos données.'),
          h('button', { class: 'primary', onclick: essayer(choisirDossier) }, 'Choisir un dossier…'))
        : h('div', { class: 'notice' }, 'Votre navigateur ne peut pas écrire sur une clé USB. Ouvrez l’application avec Chrome ou Edge pour enregistrer sur la clé, ou utilisez le stockage dans ce navigateur et la sauvegarde chiffrée.'),
      h('hr'),
      h('p', {}, h('strong', {}, 'Dans ce navigateur uniquement')),
      h('p', { class: 'muted' }, 'Les données restent sur cet ordinateur, dans ce navigateur. Elles disparaissent si vous effacez les données de navigation : pensez à la sauvegarde chiffrée.'),
      h('button', { onclick: essayer(utiliserNavigateur) }, 'Utiliser ce navigateur'),
      err);
  });
}

/** Dossier mémorisé mais inaccessible (clé débranchée, autorisation à renouveler…). */
function ecranDossierIndisponible(handle, raison) {
  return new Promise((resolve) => {
    const err = h('p', { class: 'muted', style: 'color:var(--accent)' }, raison || '');
    const reessayer = async () => {
      err.textContent = '';
      try {
        if ((await handle.queryPermission({ mode: 'readwrite' })) !== 'granted' && (await handle.requestPermission({ mode: 'readwrite' })) !== 'granted') throw new Error('autorisation refusée');
        const st = new DossierStore(handle);
        await st.tester();
        resolve(st);
      } catch (e) { err.textContent = `Dossier toujours inaccessible (${e?.message || e}). Vérifiez que la clé est branchée.`; }
    };
    ecran(`Dossier « ${handle.name} » indisponible`,
      h('p', { class: 'muted' }, 'Branchez la clé USB contenant vos données, puis autorisez à nouveau l’accès au dossier.'),
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: reessayer }, 'Autoriser / réessayer'),
        h('button', { onclick: async () => { await prefsDel('mode'); await prefsDel('dir'); resolve(await ecranChoixStockage()); } }, 'Choisir un autre dossier')),
      err);
  });
}

async function ouvrirStockage() {
  if (await prefsGet('forcerChoix')) { await prefsDel('forcerChoix'); return ecranChoixStockage(); }
  const mode = await prefsGet('mode');
  if (mode === 'dossier' && dossierPossible()) {
    const handle = await prefsGet('dir');
    if (handle) {
      try {
        if ((await handle.queryPermission({ mode: 'readwrite' })) === 'granted') { const st = new DossierStore(handle); await st.tester(); return st; }
        return await ecranDossierIndisponible(handle, '');
      } catch (e) { return await ecranDossierIndisponible(handle, `Accès impossible : ${e?.message || e}`); }
    }
  }
  if (mode === 'navigateur') return new IdbStore();
  // Version en ligne : navigateur par défaut (le dossier / la clé reste proposé dans l'onglet Sauvegarde). Version portable : on demande.
  return PORTABLE ? ecranChoixStockage() : utiliserNavigateur();
}

async function copierSurCle() {
  if (!dossierPossible()) return toast('Ce navigateur ne peut pas écrire sur une clé USB : utilisez Chrome ou Edge.');
  let dir;
  try { dir = await window.showDirectoryPicker({ mode: 'readwrite', id: 'mpr-donnees' }); } catch { return; }
  try {
    const dest = new DossierStore(dir);
    await dest.tester();
    if (await dest.contientCoffre()) return alert('Ce dossier contient déjà un coffre. Choisissez un dossier vide.');
    const n = await vault.copierVers(dest);
    alert(`${n} élément${n > 1 ? 's' : ''} copié${n > 1 ? 's' : ''} dans le dossier « ${dir.name} ».\n\nVotre phrase secrète reste la même. Ouvrez maintenant l’application depuis la clé et choisissez ce dossier comme lieu de stockage.`);
  } catch (e) { toast(`Copie impossible : ${e?.message || e}`); }
}

async function renderLock(exists) {
  const view = $('#view');
  view.replaceChildren();
  const pass = h('input', { type: 'password', autocomplete: exists ? 'current-password' : 'new-password', placeholder: 'Phrase secrète', required: true });
  const pass2 = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Confirmer la phrase secrète' });
  const err = h('p', { class: 'muted', style: 'color:var(--accent)' });
  const form = h('form', { class: 'card lock' },
    h('h2', {}, exists ? 'Déverrouiller le coffre' : 'Créer votre coffre'),
    h('p', { class: 'muted' }, `Stockage : ${stockage.label}.`),
    exists
      ? h('p', { class: 'muted' }, 'Vos documents sont chiffrés sur cet appareil.')
      : h('p', { class: 'muted' }, 'Choisissez une phrase secrète d’au moins 10 caractères. Elle chiffre tout ce que vous enregistrez ici. Elle ne peut pas être récupérée : si vous l’oubliez, les documents sont perdus. Notez-la en lieu sûr.'),
    h('label', {}, 'Phrase secrète', pass),
    exists ? null : h('label', {}, 'Confirmation', pass2),
    err,
    h('button', { class: 'primary', type: 'submit' }, exists ? 'Déverrouiller' : 'Créer le coffre'),
  );
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    err.textContent = '';
    if (!exists) {
      if (pass.value.length < 10) { err.textContent = 'La phrase secrète doit contenir au moins 10 caractères.'; return; }
      if (pass.value !== pass2.value) { err.textContent = 'Les deux phrases ne correspondent pas.'; return; }
      await vault.create(pass.value);
      navigator.storage?.persist?.();
    } else if (!(await vault.unlock(pass.value))) {
      err.textContent = 'Phrase secrète incorrecte.';
      return;
    }
    await charger();
    $('#tabs').hidden = false;
    $('#btn-lock').hidden = false;
    armerAutoVerrou();
    await recupererPartages();
    render();
  });
  view.append(form);
  pass.focus();
}

// ───────────────────────── Import de documents ─────────────────────────
async function recupererPartages() {
  if (!('caches' in window)) return;
  if (!(await caches.has('inbox'))) return;
  const cache = await caches.open('inbox');
  const reqs = await cache.keys();
  const fichiers = [];
  for (const r of reqs) {
    const resp = await cache.match(r);
    const blob = await resp.blob();
    fichiers.push(new File([blob], decodeURIComponent(resp.headers.get('x-name') || 'document.pdf'), { type: blob.type }));
    await cache.delete(r);
  }
  await caches.delete('inbox');
  if (fichiers.length) { history.replaceState(null, '', location.pathname); importer(fichiers); }
}

const MIMES = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
const extDe = (n) => (n.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() || '';
const baseNom = (n) => n.split('/').pop();

/** Déplie un fichier déposé en documents unitaires (PDF, image) : .zip et .eml sont ouverts. */
async function deplier(nom, octets, profondeur = 0) {
  const ext = extDe(nom);
  if (ext === 'zip' && profondeur < 2) {
    const { fichiers, ignores } = await lireZip(octets.buffer ? octets.buffer.slice(octets.byteOffset, octets.byteOffset + octets.byteLength) : octets);
    if (ignores.length) toast(`Ignoré : ${ignores.slice(0, 2).join(', ')}${ignores.length > 2 ? '…' : ''}`);
    const out = [];
    for (const f of fichiers) out.push(...await deplier(f.name, f.bytes, profondeur + 1));
    return out;
  }
  if (ext === 'eml') {
    const texte = typeof octets === 'string' ? octets : new TextDecoder().decode(octets);
    const pj = piecesJointesEml(texte);
    if (!pj.length) toast(`Aucune pièce jointe PDF trouvée dans ${baseNom(nom)}`);
    return pj.map((p) => ({ name: p.name, type: p.type, buffer: p.bytes.buffer }));
  }
  if (!MIMES[ext]) return [];
  const u8 = octets instanceof Uint8Array ? octets : new Uint8Array(octets);
  return [{ name: baseNom(nom), type: MIMES[ext], buffer: u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) }];
}

async function importer(fichiers) {
  let items = [];
  try {
    for (const f of fichiers) items.push(...await deplier(f.name || '', new Uint8Array(await f.arrayBuffer())));
  } catch (e) { toast(e.message || 'Import impossible'); return; }
  if (!items.length) { toast('Aucun PDF ou image trouvé'); return; }
  await assurerHashes();

  // Nombre de pages de chaque PDF (pour proposer le découpage)
  let multi = false;
  for (const it of items) {
    if (extDe(it.name) !== 'pdf' && !/pdf/i.test(it.type)) continue;
    try { it.pages = await pagesPdf(it.buffer); } catch { it.pages = null; }
    if (it.pages && it.pages.length > 1) multi = true;
  }
  const choix = items.length > 1 || multi ? await demanderOptionsImport(items, multi) : { mode: 'tout', auto: false };
  if (!choix) return;
  state.auto = choix.auto;

  if (multi && choix.mode !== 'tout') {
    const eclates = [];
    for (const it of items) {
      if (!it.pages || it.pages.length < 2) { eclates.push(it); continue; }
      try {
        const groupes = regrouperPages(it.pages, choix.mode);
        const morceaux = await decouperPdf(it.buffer, groupes);
        morceaux.forEach((m, i) => {
          const a = m.pages[0] + 1, b = m.pages[m.pages.length - 1] + 1;
          eclates.push({ name: `${baseNom(it.name).replace(/\.pdf$/i, '')}_p${a}${b > a ? '-' + b : ''}.pdf`, type: 'application/pdf', buffer: m.buffer, texte: m.pages.map((k) => it.pages[k]).join('\n') });
        });
      } catch (e) {
        toast('Découpage impossible (PDF protégé ou abîmé ?) : il est gardé entier.');
        eclates.push(it);
      }
    }
    items = eclates;
  }
  state.total = items.length;
  state.fait = 0;
  state.doublons = [];
  state.queue.push(...items);
  if (!$('#dlg').open) traiterFile();
}

function demanderOptionsImport(items, multi) {
  return new Promise((resolve) => {
    const dlg = $('#dlg'), form = $('#dlg-form');
    const pages = items.reduce((s, i) => s + (i.pages ? i.pages.length : 1), 0);
    const mode = h('select', {},
      h('option', { value: 'auto' }, 'Détecter automatiquement chaque bulletin'),
      h('option', { value: 'page' }, 'Une page = un document'),
      h('option', { value: 'n:2' }, '2 pages = un document'),
      h('option', { value: 'n:3' }, '3 pages = un document'),
      h('option', { value: 'tout' }, 'Garder chaque PDF entier'));
    const auto = h('input', { type: 'checkbox', checked: true });
    form.replaceChildren(
      h('h2', {}, 'Importer plusieurs documents'),
      h('p', { class: 'muted' }, `${items.length} fichier${items.length > 1 ? 's' : ''}, ${pages} page${pages > 1 ? 's' : ''} au total.`),
      multi ? h('label', {}, 'Certains PDF contiennent plusieurs pages. Comment les découper ?', mode) : null,
      h('label', {}, auto, 'Enregistrer sans confirmation quand l’année et le type sont reconnus (sinon je vérifie chaque document)'),
      h('p', { class: 'muted' }, 'Vous pourrez corriger chaque document ensuite avec « Modifier ».'),
      h('div', { class: 'row spread' },
        h('button', { type: 'button', onclick: () => { dlg.close(); resolve(null); } }, 'Annuler'),
        h('button', { class: 'primary', type: 'submit' }, 'Importer')));
    form.onsubmit = (ev) => { ev.preventDefault(); dlg.close(); resolve({ mode: multi ? mode.value : 'tout', auto: auto.checked }); };
    dlg.oncancel = () => resolve(null);
    dlg.showModal();
  });
}

/** Empreinte (SHA-256) des documents enregistrés avant l'existence de la détection de doublons. */
async function assurerHashes() {
  const sans = state.docs.filter((d) => !d.hash && d._hasFile);
  if (!sans.length) return;
  if (sans.length > 5) toast('Vérification des doublons…');
  for (const d of sans) {
    const buf = await vault.file(d.id);
    if (!buf) continue;
    d.hash = await sha256(buf);
    const { id, _hasFile, ...meta } = d;
    await vault.updateMeta(id, meta);
  }
}
const doublonExact = (hash) => state.docs.find((d) => d.hash && d.hash === hash);
/** Même type, même période, même employeur (fichier différent, par ex. re-téléchargé). */
function doublonProbable(m) {
  if (!m.type || m.type === 'autre' || !m.year) return null;
  return state.docs.find((d) => d.type === m.type && d.year === m.year && (d.month || null) === (m.month || null) && (d.quarter || null) === (m.quarter || null)
    && cleEmployeur(groupeDe(d)) === cleEmployeur(groupeDe({ type: m.type, employer: m.employer }))) || null;
}
const memesMontants = (a, b) => (b.type === 'urssaf' ? b.ca != null && a.ca === b.ca
  : b.type === 'ij' || b.type === 'chomage' ? b.jours != null && a.jours === b.jours && a.montant === b.montant
  : b.brut != null && a.brut === b.brut && a.net === b.net);

async function traiterFile() {
  const item = state.queue.shift();
  if (!item) {
    const nd = state.doublons.length;
    if (state.total > 1 || nd) {
      const parties = [];
      if (state.fait || !nd) parties.push(`${state.fait} document${state.fait > 1 ? 's' : ''} enregistré${state.fait > 1 ? 's' : ''}`);
      if (nd) parties.push(nd === 1 && state.total === 1 ? `déjà enregistré : ${state.doublons[0]}` : `${nd} doublon${nd > 1 ? 's' : ''} ignoré${nd > 1 ? 's' : ''}`);
      toast(parties.join(' · '));
    }
    state.auto = false; state.total = 0; state.fait = 0; state.doublons = [];
    await charger(); render(); return;
  }
  item.hash = await sha256(item.buffer);
  const exact = doublonExact(item.hash);
  if (exact) { state.doublons.push(libelle(exact)); return traiterFile(); }
  let suggestion = {};
  if (item.texte != null) suggestion = analyserTexte(item.texte, item.name, employeursConnus());
  else if (/pdf/i.test(item.type) || /\.pdf$/i.test(item.name)) {
    try { suggestion = analyserTexte(await texteDuPdf(item.buffer), item.name, employeursConnus()); }
    catch { suggestion = analyserTexte('', item.name); }
  } else suggestion = analyserTexte('', item.name);

  if (state.auto && suggestion.year && suggestion.type !== 'autre' && (!['ij', 'chomage'].includes(suggestion.type) || suggestion.jours != null)) {
    const meta = {
      kind: 'doc', type: suggestion.type, year: suggestion.year, month: suggestion.month || null, quarter: suggestion.quarter || null,
      employer: suggestion.employer || '', brut: suggestion.brut ?? null, net: suggestion.net ?? null, ca: suggestion.ca ?? null,
      activite: 'services', nature: suggestion.nature || 'maladie', jours: suggestion.jours ?? null, montant: suggestion.montant ?? null, sjr: suggestion.sjr ?? null,
      note: '', fileName: item.name, mime: item.type, size: item.buffer.byteLength, addedAt: new Date().toISOString(), hash: item.hash,
    };
    const prob = doublonProbable(meta);
    if (prob && memesMontants(prob, meta)) { state.doublons.push(libelle(prob)); return traiterFile(); }
    if (prob) { state.fait += 1; return ouvrirFormulaire({ ...suggestion, fileName: item.name, mime: item.type, size: item.buffer.byteLength, hash: item.hash }, item.buffer, state.queue.length, prob); }
    const id = uid();
    await vault.put(id, meta, item.buffer);
    state.docs.push({ id, ...meta });
    state.fait += 1;
    return traiterFile();
  }
  state.fait += 1;
  ouvrirFormulaire({ ...suggestion, fileName: item.name, mime: item.type, size: item.buffer.byteLength, hash: item.hash }, item.buffer, state.queue.length, doublonProbable(suggestion));
}

function ouvrirFormulaire(doc, buffer, restants = 0, doublon = null) {
  const dlg = $('#dlg');
  const form = $('#dlg-form');
  const estNouveau = !!buffer;
  const f = {
    type: h('select', {}, Object.entries(TYPES).map(([k, v]) => h('option', { value: k, selected: doc.type === k }, v))),
    year: h('input', { type: 'number', min: 1970, max: 2100, value: doc.year ?? '', required: true }),
    month: h('select', {}, h('option', { value: '' }, '—'), MOIS.map((m, i) => h('option', { value: i + 1, selected: doc.month === i + 1 }, m))),
    quarter: h('select', {}, h('option', { value: '' }, '—'), [1, 2, 3, 4].map((q) => h('option', { value: q, selected: doc.quarter === q }, `${q}${q === 1 ? 'er' : 'e'} trimestre`))),
    employer: h('input', { type: 'text', value: doc.employer || '', placeholder: 'Employeur', list: 'liste-employeurs', autocomplete: 'off' }),
    brut: h('input', { type: 'text', inputmode: 'decimal', value: doc.brut ?? '' }),
    net: h('input', { type: 'text', inputmode: 'decimal', value: doc.net ?? '' }),
    ca: h('input', { type: 'text', inputmode: 'decimal', value: doc.ca ?? '' }),
    activite: h('select', {}, Object.entries(ACTIVITES).map(([k, v]) => h('option', { value: k, selected: (doc.activite || 'services') === k }, v.label))),
    nature: h('select', {}, Object.entries(NATURES_IJ).map(([k, v]) => h('option', { value: k, selected: (doc.nature || 'maladie') === k }, v))),
    jours: h('input', { type: 'text', inputmode: 'numeric', value: doc.jours ?? '' }),
    montant: h('input', { type: 'text', inputmode: 'decimal', value: doc.montant ?? '' }),
    sjr: h('input', { type: 'text', inputmode: 'decimal', value: doc.sjr ?? '' }),
    note: h('input', { type: 'text', value: doc.note || '' }),
  };
  const zonePaie = h('div', { class: 'fields' },
    h('label', {}, 'Mois', f.month), h('label', {}, 'Employeur', f.employer),
    h('label', {}, 'Salaire brut (€)', f.brut), h('label', {}, 'Net à payer (€)', f.net));
  const zoneUrssaf = h('div', { class: 'fields' },
    h('label', {}, 'Trimestre (si déclaration trimestrielle)', f.quarter), h('label', {}, 'Mois (si mensuelle)', f.month.cloneNode(true)),
    h('label', {}, 'Chiffre d’affaires déclaré (€)', f.ca), h('label', {}, 'Activité', f.activite));
  const moisAssimSel = f.month.cloneNode(true);
  const labNature = h('label', {}, 'Nature des indemnités', f.nature);
  const labSjr = h('label', {}, 'Salaire journalier de référence (€, attestation France Travail)', f.sjr);
  const zoneAssim = h('div', { class: 'fields' },
    labNature, h('label', {}, 'Mois (laisser vide si le document couvre l’année)', moisAssimSel),
    h('label', {}, 'Jours indemnisés', f.jours), h('label', {}, 'Montant total (€)', f.montant), labSjr);
  const majZones = () => {
    const t = f.type.value;
    zonePaie.hidden = t !== 'payslip';
    zoneUrssaf.hidden = t !== 'urssaf';
    zoneAssim.hidden = t !== 'ij' && t !== 'chomage';
    labNature.hidden = t !== 'ij';
    labSjr.hidden = t !== 'chomage';
  };
  f.type.addEventListener('change', majZones);
  majZones();
  const moisUrssaf = zoneUrssaf.querySelectorAll('select')[1];
  if (doc.month) { moisUrssaf.value = doc.month; moisAssimSel.value = doc.month; }

  const annuler = h('button', { type: 'button', onclick: () => { dlg.close(); traiterFile(); } }, estNouveau ? 'Ignorer' : 'Annuler');
  form.replaceChildren(
    h('h2', {}, estNouveau ? 'Nouveau document' : 'Modifier le document'),
    h('p', { class: 'muted' }, estNouveau
      ? `${doc.fileName}${restants ? ` · encore ${restants} à traiter` : ''} — vérifiez les valeurs reconnues automatiquement.`
      : doc.fileName),
    h('div', { class: 'fields' }, h('label', {}, 'Type', f.type), h('label', {}, 'Année', f.year)),
    zonePaie, zoneUrssaf, zoneAssim,
    h('p', { class: 'muted', hidden: !(doc.type === 'ij' || doc.type === 'chomage') }, `Ces jours valident des trimestres : ${JOURS_PAR_TRIMESTRE.maladie} jours de maladie, ${JOURS_PAR_TRIMESTRE.maternite} jours de maternité ou d’invalidité, ${JOURS_PAR_TRIMESTRE.chomage} jours de chômage indemnisé = 1 trimestre (4 par an au maximum).`),
    h('datalist', { id: 'liste-employeurs' }, employeursConnus().map((e) => h('option', { value: e }))),
    h('label', {}, 'Note (facultatif)', f.note),
    doublon ? h('div', { class: 'notice' }, h('strong', {}, 'Doublon possible : '), `un document « ${libelle(doublon)} » (${groupeDe(doublon)}) est déjà enregistré pour cette période${doublon.brut != null ? `, brut ${eur2.format(doublon.brut)}` : ''}. Choisissez de l’ignorer, de le garder en plus ou de remplacer l’ancien.`) : null,
    h('div', { class: 'row spread' }, annuler,
      doublon && estNouveau ? h('button', { type: 'button', onclick: () => sauver(doublon.id) }, 'Remplacer l’ancien') : null,
      h('button', { class: 'primary', type: 'submit' }, doublon && estNouveau ? 'Garder les deux' : 'Enregistrer')),
  );
  form.onsubmit = (ev) => { ev.preventDefault(); sauver(null); };
  const sauver = async (remplaceId) => {
    const type = f.type.value;
    const moisSel = type === 'urssaf' ? moisUrssaf.value : (type === 'ij' || type === 'chomage') ? moisAssimSel.value : f.month.value;
    const meta = {
      kind: 'doc', type, year: Number(f.year.value), month: moisSel ? Number(moisSel) : null,
      quarter: type === 'urssaf' && f.quarter.value ? Number(f.quarter.value) : null,
      employer: f.employer.value.trim(), brut: num(f.brut.value), net: num(f.net.value), ca: num(f.ca.value),
      activite: f.activite.value, nature: f.nature.value, jours: num(f.jours.value), montant: num(f.montant.value), sjr: num(f.sjr.value), note: f.note.value.trim(),
      fileName: doc.fileName, mime: doc.mime, size: doc.size, addedAt: doc.addedAt || new Date().toISOString(), hash: doc.hash,
    };
    if (remplaceId) await vault.remove(remplaceId);
    if (estNouveau) await vault.put(uid(), meta, buffer);
    else await vault.updateMeta(doc.id, meta);
    await charger();
    dlg.close();
    toast('Document enregistré');
    if (estNouveau) traiterFile(); else render();
  };
  dlg.oncancel = () => { state.queue.length = 0; render(); };
  if (!dlg.open) dlg.showModal();
}

// ───────────────────────── Actions sur les documents ─────────────────────────
const libelle = (d) => {
  const periode = d.type === 'urssaf' && d.quarter && !d.month ? `${d.quarter}${d.quarter === 1 ? 'er' : 'e'} trimestre ${d.year}` : d.month ? `${MOIS[d.month - 1]} ${d.year}` : String(d.year);
  return `${TYPES[d.type]} · ${periode}`;
};
const nomFichier = (d) => {
  const ext = (d.fileName.match(/\.[a-z0-9]+$/i) || ['.pdf'])[0];
  const p = d.month ? String(d.month).padStart(2, '0') : d.quarter ? `T${d.quarter}` : '00';
  const t = { payslip: 'bulletin-paie', urssaf: 'urssaf', ij: 'indemnites-journalieres', chomage: 'chomage' }[d.type] || 'document';
  return `${d.year}-${p}_${t}${d.type === 'payslip' && d.employer ? '_' + sansSeparateurs(d.employer) : ''}${ext}`;
};
const sansSeparateurs = (x) => x.replace(/[^\p{L}\p{N}-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const nomDossier = (x) => x.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Sans nom';

/** Employeurs déjà utilisés (pour garder une orthographe unique et proposer l'autocomplétion). */
function employeursConnus() {
  const vus = new Map();
  for (const d of state.docs) if (d.type === 'payslip' && d.employer?.trim()) { const k = cleEmployeur(d.employer); if (!vus.has(k)) vus.set(k, d.employer.trim()); }
  return [...vus.values()].sort((a, b) => a.localeCompare(b, 'fr'));
}
/** Nom du sous-dossier d'un document : employeur, « Auto-entrepreneur » ou « Autres documents ». */
function groupeDe(d) {
  if (d.type === 'urssaf') return 'Auto-entrepreneur (Urssaf)';
  if (d.type === 'ij') return 'Assurance Maladie (indemnités journalières)';
  if (d.type === 'chomage') return 'France Travail (chômage)';
  if (d.employer?.trim()) return d.employer.trim();
  return d.type === 'payslip' ? 'Employeur non renseigné' : 'Autres documents';
}
/** Chemin type d'un document dans un ZIP : année / employeur / fichier. */
function cheminZip(d, pris) {
  const base = `${d.year}/${nomDossier(groupeDe(d))}/${nomFichier(d)}`;
  let chemin = base, i = 2;
  while (pris.has(chemin.toLowerCase())) chemin = base.replace(/(\.[a-z0-9]+)$/i, `-${i++}$1`);
  pris.add(chemin.toLowerCase());
  return chemin;
}
async function zipDe(docs, nom) {
  const files = [], pris = new Set();
  for (const d of docs) { const buf = await vault.file(d.id); if (buf) files.push({ name: cheminZip(d, pris), data: new Uint8Array(buf) }); }
  if (!files.length) return toast('Rien à télécharger');
  sauverBlob(creerZip(files), nom);
}
async function renommerEmployeur(ancien, docs) {
  const nouveau = prompt(`Renommer l’employeur « ${ancien} » (tous ses bulletins seront mis à jour ; saisissez un nom existant pour fusionner deux dossiers) :`, ancien);
  if (nouveau == null || !nouveau.trim() || nouveau.trim() === ancien) return;
  const canon = employeursConnus().find((e) => cleEmployeur(e) === cleEmployeur(nouveau)) || nouveau.trim();
  for (const d of docs) { const { id, _hasFile, ...meta } = d; await vault.updateMeta(id, { ...meta, employer: canon }); }
  await charger(); render(); toast('Employeur mis à jour');
}

async function blobDe(d) {
  const buf = await vault.file(d.id);
  if (!buf) return null;
  return new Blob([buf], { type: d.mime || 'application/pdf' });
}

async function telecharger(d) {
  const blob = await blobDe(d);
  if (!blob) return toast('Fichier introuvable');
  sauverBlob(blob, nomFichier(d));
}
function sauverBlob(blob, nom) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: nom });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
async function ouvrir(d) {
  const blob = await blobDe(d);
  if (!blob) return toast('Fichier introuvable');
  window.open(URL.createObjectURL(blob), '_blank', 'noopener');
}
async function imprimer(d) {
  const blob = await blobDe(d);
  if (!blob) return toast('Fichier introuvable');
  const url = URL.createObjectURL(blob);
  if (estAndroid || !/pdf|image/.test(blob.type)) {
    // Sur Android, le lecteur PDF du téléphone propose « Imprimer » dans son menu.
    window.open(url, '_blank', 'noopener');
    toast('Utilisez le menu ⋮ puis « Imprimer »');
    return;
  }
  const frame = h('iframe', { style: 'position:fixed;width:0;height:0;border:0;right:0;bottom:0', src: url });
  frame.onload = () => { try { frame.contentWindow.focus(); frame.contentWindow.print(); } catch { window.open(url, '_blank'); } };
  document.body.append(frame);
  setTimeout(() => { frame.remove(); URL.revokeObjectURL(url); }, 120000);
}
async function supprimer(d) {
  if (!confirm(`Supprimer définitivement « ${libelle(d)} » ?`)) return;
  await vault.remove(d.id);
  await charger();
  render();
}

// ───────────────────────── Vue : documents ─────────────────────────
function viewDocs() {
  const root = h('div');
  const input = h('input', { type: 'file', multiple: true, accept: 'application/pdf,image/*,.eml,.zip,application/zip', hidden: true });
  input.addEventListener('change', () => { importer([...input.files]); input.value = ''; });
  const drop = h('div', { class: 'drop' },
    h('p', {}, h('strong', {}, 'Déposez vos PDF ou un ZIP ici'), ' ou ', h('button', { class: 'primary', onclick: () => input.click() }, 'Ajouter des documents')),
    h('p', { class: 'muted' }, 'Bulletins de paie, déclarations ou attestations Urssaf. Vous pouvez aussi déposer un dossier compressé (.zip), un PDF regroupant plusieurs bulletins (découpé en documents séparés) ou un mail enregistré (.eml) dont les pièces jointes sont extraites.'),
    input,
  );
  ['dragenter', 'dragover'].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (ev) => importer([...ev.dataTransfer.files]));
  root.append(drop);

  if (estAndroid) {
    root.append(h('div', { class: 'notice info' },
      h('strong', {}, 'Depuis vos mails sur Android : '),
      'installez l’application (menu ⋮ → « Installer l’application »), puis dans Gmail ouvrez la pièce jointe → Partager → « Mes papiers retraite ».'));
  }

  const annees = [...new Set(state.docs.map((d) => d.year))].sort((a, b) => b - a);
  const emps = [...new Map(state.docs.map((d) => [cleEmployeur(groupeDe(d)), groupeDe(d)])).entries()].sort((x, y) => x[1].localeCompare(y[1], 'fr'));
  const f = state.filtre;
  const rafraichir = () => { f.type = fType.value; f.annee = fAnnee.value; f.emp = fEmp.value; f.q = fQ.value; f.exact = fMode.value === 'exact'; f.vue = fVue.value; render(); };
  const fType = h('select', { onchange: rafraichir }, h('option', { value: '' }, 'Tous les types'), Object.entries(TYPES).map(([k, v]) => h('option', { value: k, selected: f.type === k }, v)));
  const fAnnee = h('select', { onchange: rafraichir }, h('option', { value: '' }, 'Toutes les années'), annees.map((a) => h('option', { value: a, selected: String(f.annee) === String(a) }, a)));
  const fEmp = h('select', { onchange: rafraichir }, h('option', { value: '' }, 'Tous les employeurs'), emps.map(([k, v]) => h('option', { value: k, selected: f.emp === k }, v)));
  const fVue = h('select', { onchange: rafraichir }, h('option', { value: 'annee', selected: f.vue === 'annee' }, 'Année › Employeur'), h('option', { value: 'employeur', selected: f.vue === 'employeur' }, 'Employeur › Année'));
  const fQ = h('input', { type: 'search', placeholder: 'Employeur, note, nom du fichier…', value: f.q, onchange: rafraichir });
  const fMode = h('select', { onchange: rafraichir }, h('option', { value: 'contient', selected: !f.exact }, 'Contient le mot'), h('option', { value: 'exact', selected: f.exact }, 'Nom exact de l’employeur'));
  root.append(h('div', { class: 'card' }, h('div', { class: 'fields' },
    h('label', {}, 'Classer par', fVue), h('label', {}, 'Employeur', fEmp), h('label', {}, 'Année', fAnnee), h('label', {}, 'Type', fType), h('label', {}, 'Recherche', fQ), h('label', {}, 'Type de recherche', fMode))));

  const norm = (x) => cleEmployeur(x || '');
  // « Contient » : tous les mots saisis doivent apparaître (dans l'ordre que l'on veut) ; « exact » : nom d'employeur identique (guillemets acceptés).
  const requete = norm(f.q.replace(/["«»“”]/g, ''));
  const mots = requete.split(' ').filter(Boolean);
  const correspond = (d) => {
    if (!requete) return true;
    if (f.exact) return norm(groupeDe(d)) === requete;
    const texte = norm(`${groupeDe(d)} ${d.note} ${d.fileName}`);
    return mots.every((m) => texte.includes(m));
  };
  const liste = state.docs.filter((d) => (!f.type || d.type === f.type) && (!f.annee || String(d.year) === String(f.annee))
    && (!f.emp || cleEmployeur(groupeDe(d)) === f.emp)
    && correspond(d));
  const ordreDate = (a, b) => b.year - a.year || (b.month || b.quarter * 3 || 0) - (a.month || a.quarter * 3 || 0);
  liste.sort(ordreDate);

  if (!state.docs.length) root.append(h('p', { class: 'muted' }, 'Aucun document pour l’instant. Ajoutez vos premiers bulletins ou déclarations ci-dessus.'));
  else if (!liste.length) root.append(h('p', { class: 'muted' }, 'Aucun document ne correspond à ces filtres.'));

  const carte = (d) => {
    const montants = d.type === 'payslip'
      ? [d.brut != null ? `brut ${eur2.format(d.brut)}` : null, d.net != null ? `net ${eur2.format(d.net)}` : null]
      : d.type === 'urssaf' ? [d.ca != null ? `CA ${eur2.format(d.ca)}` : null, ACTIVITES[d.activite]?.label]
      : d.type === 'ij' ? [d.jours != null ? `${d.jours} jours` : null, NATURES_IJ[d.nature], d.montant != null ? eur2.format(d.montant) : null]
      : d.type === 'chomage' ? [d.jours != null ? `${d.jours} jours indemnisés` : null, d.montant != null ? eur2.format(d.montant) : null] : [];
    return h('div', { class: 'card doc' },
      h('div', { class: 'title' }, libelle(d)),
      h('div', { class: 'muted' }, [groupeDe(d), ...montants, d.note].filter(Boolean).join(' · ')),
      h('div', { class: 'row' },
        h('button', { class: 'small', onclick: () => ouvrir(d) }, 'Ouvrir'),
        h('button', { class: 'small', onclick: () => telecharger(d) }, 'Télécharger'),
        h('button', { class: 'small', onclick: () => imprimer(d) }, 'Imprimer'),
        h('button', { class: 'small', onclick: () => ouvrirFormulaire(d) }, 'Modifier'),
        h('button', { class: 'small danger', onclick: () => supprimer(d) }, 'Supprimer')));
  };
  const nb = (n) => `${n} document${n > 1 ? 's' : ''}`;
  const ouvertParDefaut = liste.length <= 30 || !!(f.q || f.annee || f.emp);
  const dossier = (cle, titre, docs, niveau, enfants, actions = []) => {
    const ouvert = state.dossiers[cle] ?? (niveau === 'sub' ? ouvertParDefaut : ouvertParDefaut || cle === `top:${premiereCle}`);
    const el = h('details', { class: `dossier ${niveau}`, open: ouvert },
      h('summary', {}, h('span', { class: 'nom' }, titre), h('span', { class: 'muted' }, ` · ${nb(docs.length)}`)),
      h('div', { class: 'row actions' }, actions),
      h('div', { class: 'contenu' }, enfants));
    el.addEventListener('toggle', () => { state.dossiers[cle] = el.open; });
    return el;
  };
  const grouper = (docs, cleFn) => { const m = new Map(); for (const d of docs) { const k = cleFn(d); if (!m.has(k)) m.set(k, []); m.get(k).push(d); } return m; };
  const actionsEmp = (nom, docs) => [
    h('button', { class: 'small', onclick: () => zipDe(docs, `${nomDossier(nom)}.zip`) }, 'Télécharger le dossier (ZIP)'),
    docs.some((d) => d.type === 'payslip') ? h('button', { class: 'small', onclick: () => renommerEmployeur(nom, docs.filter((d) => d.type === 'payslip')) }, 'Renommer') : null];

  let premiereCle = '';
  if (f.vue === 'annee') {
    const parAnnee = grouper(liste, (d) => d.year);
    premiereCle = [...parAnnee.keys()][0];
    for (const [an, docsAn] of parAnnee) {
      const sous = [...grouper(docsAn, (d) => cleEmployeur(groupeDe(d))).values()].sort((x, y) => groupeDe(x[0]).localeCompare(groupeDe(y[0]), 'fr'));
      root.append(dossier(`top:${an}`, String(an), docsAn, 'top',
        sous.map((docs) => dossier(`sub:${an}:${cleEmployeur(groupeDe(docs[0]))}`, groupeDe(docs[0]), docs, 'sub', docs.map(carte), actionsEmp(groupeDe(docs[0]), docs))),
        [h('button', { class: 'small', onclick: () => zipDe(docsAn, `${an}.zip`) }, `Télécharger ${an} (ZIP)`)]));
    }
  } else {
    const parEmp = [...grouper(liste, (d) => cleEmployeur(groupeDe(d))).values()].sort((x, y) => groupeDe(x[0]).localeCompare(groupeDe(y[0]), 'fr'));
    premiereCle = parEmp.length ? cleEmployeur(groupeDe(parEmp[0][0])) : '';
    for (const docs of parEmp) {
      const nom = groupeDe(docs[0]);
      const sous = [...grouper(docs, (d) => d.year).entries()];
      root.append(dossier(`top:${cleEmployeur(nom)}`, nom, docs, 'top',
        sous.map(([an, ds]) => dossier(`sub:${cleEmployeur(nom)}:${an}`, String(an), ds, 'sub', ds.map(carte))), actionsEmp(nom, docs)));
    }
  }
  return root;
}

// ───────────────────────── Vue : carrière ─────────────────────────
function viewCarriere() {
  const root = h('div');
  root.append(h('h2', {}, 'Ma carrière année par année'));
  root.append(h('p', { class: 'muted' }, 'Calculée à partir de vos documents. Arrêts maladie, maternité, invalidité et chômage indemnisé : ajoutez les relevés d’indemnités journalières de l’Assurance Maladie ou les attestations France Travail dans l’onglet Documents ; leurs jours valident des trimestres (60 jours de maladie, 90 de maternité ou d’invalidité, 50 de chômage = 1 trimestre, 4 par an au maximum, tous statuts confondus). Auto-entrepreneur : saisissez dans « Trim. Urssaf » le nombre de trimestres (0 à 4) indiqué par votre attestation ou votre espace Urssaf ; ils s’ajoutent à vos trimestres de salarié, dans la limite de 4 par an, et remplacent l’estimation tirée du chiffre d’affaires. Les colonnes « Revenu retenu » et « Trimestres (corr.) » remplacent, elles, tout le calcul de l’année (utile si votre relevé info-retraite.fr dit autre chose).'));
  const rows = construireCarriere(state.docs, state.career);
  const anneeCourante = new Date().getFullYear();
  if (!rows.length) { root.append(h('p', { class: 'muted' }, 'Ajoutez des documents ou une année manuellement.')); }

  const tbody = h('tbody');
  for (const r of rows.slice().reverse()) {
    const ov = state.career[r.year] || {};
    const maj = async (champ, val) => {
      const cur = { ...(state.career[r.year] || {}) };
      if (val === '' || val == null) delete cur[champ]; else cur[champ] = num(val);
      if (Object.keys(cur).length) state.career[r.year] = cur; else delete state.career[r.year];
      await saveCareer();
      render();
    };
    const incomplet = r.salaire > 0 && r.year < anneeCourante && r.mois > 0 && r.mois < 12;
    tbody.append(h('tr', {},
      h('td', {}, r.year, r.override ? h('span', { class: 'pill', style: 'margin-left:6px' }, 'corrigé') : null,
        incomplet ? h('span', { class: 'pill warn', style: 'margin-left:6px' }, `${r.mois}/12 mois`) : null),
      h('td', {}, r.salaire ? eur.format(r.salaire) : '—'),
      h('td', {}, r.ca ? eur.format(r.ca) : '—'),
      h('td', { title: 'Jours d’indemnités journalières ou de chômage indemnisé relevés dans vos documents' },
        (() => {
          const p = [r.joursMal && `${r.joursMal} j maladie`, r.joursMat && `${r.joursMat} j maternité`, r.joursInv && `${r.joursInv} j invalidité`, r.joursCho && `${r.joursCho} j chômage`].filter(Boolean);
          return p.length ? `${p.join(' · ')} → ${r.trimAssim} trim.` : '—';
        })()),
      h('td', {}, h('input', { class: 'narrow', type: 'text', inputmode: 'numeric', value: ov.urssaf ?? '', placeholder: '0-4', 'aria-label': `Trimestres déclarés Urssaf ${r.year}`, onchange: (e) => maj('urssaf', e.target.value) })),
      h('td', {}, h('input', { type: 'text', inputmode: 'decimal', value: ov.revenu ?? '', placeholder: String(Math.round(r.salaire + r.revenuInd)), onchange: (e) => maj('revenu', e.target.value) })),
      h('td', {}, h('input', { class: 'narrow', type: 'text', inputmode: 'numeric', value: ov.trim ?? '', placeholder: String(r.trimAuto), onchange: (e) => maj('trim', e.target.value) })),
      h('td', {}, h('strong', {}, r.trimEff)),
    ));
  }
  root.append(h('div', { class: 'card scroll' }, h('table', {},
    h('thead', {}, h('tr', {}, ['Année', 'Salaires bruts', 'CA auto-entr.', 'Maladie / chômage', 'Trim. Urssaf (saisie)', 'Revenu retenu (€)', 'Trimestres (corr.)', 'Trimestres'].map((t) => h('th', {}, t)))),
    tbody)));

  const total = rows.reduce((s, r) => s + r.trimEff, 0);
  root.append(h('div', { class: 'stat hl' }, h('div', { class: 'k' }, 'Trimestres validés d’après ces données'), h('div', { class: 'v' }, total), h('div', { class: 's' }, `soit ${(total / 4).toFixed(1).replace('.', ',')} années · hors trimestres enfants, chômage, maladie, etc.`)));

  const ajout = h('div', { class: 'card' },
    h('h3', {}, 'Ajouter une année manquante'),
    (() => {
      const y = h('input', { type: 'number', min: 1970, max: anneeCourante, placeholder: 'Année' });
      const t = h('input', { type: 'number', min: 0, max: 4, placeholder: 'Trim. total' });
      const u = h('input', { type: 'number', min: 0, max: 4, placeholder: 'Trim. Urssaf' });
      const r = h('input', { type: 'text', inputmode: 'decimal', placeholder: 'Revenu (€)' });
      return h('div', { class: 'row' }, h('div', { style: 'width:110px' }, y), h('div', { style: 'width:110px' }, t), h('div', { style: 'width:110px' }, u), h('div', { style: 'width:140px' }, r),
        h('button', { class: 'primary', onclick: async () => {
          if (!y.value) return toast('Indiquez l’année');
          state.career[Number(y.value)] = { ...(t.value !== '' ? { trim: Number(t.value) } : {}), ...(u.value !== '' ? { urssaf: Number(u.value) } : {}), ...(r.value !== '' ? { revenu: num(r.value) } : {}) };
          await saveCareer(); render();
        } }, 'Ajouter'));
    })(),
    h('p', { class: 'muted' }, 'Astuce : votre relevé de carrière officiel (info-retraite.fr, compte FranceConnect) donne trimestres et revenus de chaque année : reportez-les ici pour les années sans documents.'));
  root.append(ajout);
  return root;
}

// ───────────────────────── Vue : retraite ─────────────────────────
function entreeCalcul() {
  const p = state.profile;
  if (!p.naissance) return null;
  const [y, m, d] = p.naissance.split('-').map(Number);
  return {
    sexe: p.sexe, naissance: new Date(y, m - 1, d), enfants: p.enfants, elevesNeufAns: p.elevesNeufAns,
    rows: construireCarriere(state.docs, state.career), revalorisation: (Number(p.revalorisation) || 0) / 100,
    continuer: p.continuer, revenuProjete: p.revenuProjete, trimestresAutres: Number(p.trimestresAutres) || 0,
    pointsAgirc: p.pointsAgirc, pensionAutreAnnuelle: Number(p.pensionAutreAnnuelle) || 0, now: new Date(),
  };
}

function viewRetraite() {
  const p = state.profile;
  const root = h('div');
  root.append(h('h2', {}, 'Ma retraite'));
  const set = (k) => async (e) => {
    p[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    await saveProfile();
    render();
  };

  const kids = h('div');
  p.enfants.forEach((e, i) => {
    kids.append(h('div', { class: 'kid' },
      h('label', {}, 'Année de naissance', h('input', { type: 'number', min: 1950, max: 2100, value: e.annee, onchange: async (ev) => { e.annee = Number(ev.target.value); await saveProfile(); render(); } })),
      e.annee >= 2010 ? h('label', {}, 'Qui a les 2 trimestres d’éducation partageables ?', h('select', { onchange: async (ev) => { e.edu = ev.target.value; await saveProfile(); render(); } },
        h('option', { value: 'mere', selected: e.edu !== 'pere' }, 'La mère (par défaut)'), h('option', { value: 'pere', selected: e.edu === 'pere' }, 'Le père (demande faite)')))
        : h('p', { class: 'muted' }, 'Né avant 2010 : les 8 trimestres vont à la mère.'),
      h('button', { class: 'small danger', type: 'button', onclick: async () => { p.enfants.splice(i, 1); await saveProfile(); render(); } }, 'Retirer'),
    ));
  });

  root.append(h('div', { class: 'card' },
    h('h3', {}, 'Ma situation'),
    h('div', { class: 'fields' },
      h('label', {}, 'Je suis', h('select', { onchange: set('sexe') }, h('option', { value: 'F', selected: p.sexe === 'F' }, 'Une femme'), h('option', { value: 'M', selected: p.sexe === 'M' }, 'Un homme'))),
      h('label', {}, 'Date de naissance', h('input', { type: 'date', value: p.naissance, onchange: set('naissance') })),
      h('label', {}, 'Trimestres hors documents (chômage, maladie, service national, rachat…)', h('input', { type: 'number', min: 0, value: p.trimestresAutres, onchange: set('trimestresAutres') })),
      h('label', {}, 'Points Agirc-Arrco déjà acquis (relevé, facultatif)', h('input', { type: 'text', inputmode: 'numeric', value: p.pointsAgirc, onchange: set('pointsAgirc') }))),
    h('h3', { style: 'margin-top:8px' }, 'Mes enfants'),
    kids,
    h('div', { class: 'row' },
      h('button', { type: 'button', onclick: async () => { p.enfants.push({ annee: new Date().getFullYear() - 10, edu: 'mere' }); await saveProfile(); render(); } }, '+ Ajouter un enfant'),
      h('label', { style: 'margin:0' }, h('input', { type: 'checkbox', checked: p.elevesNeufAns, onchange: set('elevesNeufAns') }), 'J’ai élevé au moins 3 enfants pendant 9 ans avant leurs 16 ans (si 3 enfants ou plus)')),
  ));

  root.append(h('details', { class: 'card' },
    h('summary', {}, 'Hypothèses de projection'),
    h('div', { class: 'fields', style: 'margin-top:10px' },
      h('label', {}, 'Revalorisation annuelle des anciens salaires (%)', h('input', { type: 'text', inputmode: 'decimal', value: p.revalorisation, onchange: set('revalorisation') })),
      h('label', {}, 'Revenu annuel brut futur (€ de 2026, vide = moyenne des 3 dernières années)', h('input', { type: 'text', inputmode: 'decimal', value: p.revenuProjete, onchange: set('revenuProjete') })),
      h('label', {}, 'Autre pension annuelle brute connue (CIPAV, RCI… en €)', h('input', { type: 'text', inputmode: 'decimal', value: p.pensionAutreAnnuelle, onchange: set('pensionAutreAnnuelle') }))),
    h('label', {}, h('input', { type: 'checkbox', checked: p.continuer, onchange: set('continuer') }), 'Je continue à travailler jusqu’à mon départ')));

  const entree = entreeCalcul();
  if (!entree) {
    root.append(h('div', { class: 'notice info' }, 'Renseignez votre date de naissance pour obtenir l’estimation.'));
    root.append(blocEnfants(p));
    return root;
  }
  if (!entree.rows.length) root.append(h('div', { class: 'notice' }, 'Aucune donnée de carrière : ajoutez des documents ou des années dans l’onglet Carrière. Sans elles, l’estimation sera nulle.'));
  const s = syntheseRetraite(entree);
  const L = s.legalEst;
  const legal = s.legal;
  const dateLegale = (() => { const d = new Date(entree.naissance); d.setMonth(d.getMonth() + legal.ageMois); return d; })();

  root.append(h('div', { class: 'grid' },
    stat('Âge légal de départ', formatAge(legal.ageMois), `à partir du ${dateFr(dateLegale)}`, true),
    stat('Durée requise (taux plein)', `${legal.trimestres} trimestres`, `${(legal.trimestres / 4).toFixed(1).replace('.', ',')} ans de cotisation`),
    stat('Trimestres à l’âge légal', `${L.trimestres}`, `dont ${L.trimEnfants} liés aux enfants et ${L.trimProj} à venir`),
    stat('Âge du taux plein automatique', '67 ans', 'sans décote quelle que soit la durée')));

  if (L.nbAnneesSam < 25) root.append(h('div', { class: 'notice info' }, `Grâce aux trimestres liés à vos enfants, votre salaire annuel moyen est calculé sur vos ${L.nbAnneesSam} meilleures années au lieu de 25 (départs à partir du 1er septembre 2026).`));
  if (legal.note) root.append(h('div', { class: 'notice' }, legal.note));

  const cartes = [['Départ à l’âge légal', s.legalEst], s.pleinTaux && s.pleinTaux !== s.legalEst ? ['Départ au taux plein', s.pleinTaux] : null, ['Départ à 67 ans', s.auto67]].filter(Boolean);
  root.append(h('div', { class: 'grid' }, cartes.map(([titre, e]) => h('div', { class: 'stat hl' },
    h('div', { class: 'k' }, `${titre} · ${formatAge(e.ageDepartMois)}`),
    h('div', { class: 'v' }, `${eur.format(e.brutMensuel)} /mois brut`),
    h('div', { class: 's' }, `≈ ${eur.format(e.netMensuel)} net avant impôt · ${e.tauxPlein ? 'taux plein' : `décote de ${e.decoteTrim} trimestre${e.decoteTrim > 1 ? 's' : ''}`}${e.surcoteTrim ? ` · surcote +${e.surcoteTrim} trim.` : ''}`),
    h('div', { class: 's' }, `Base ${eur.format(e.base)} + complémentaire ${eur.format(e.compl)} · ${e.trimestres} trimestres`)))));

  const lignes = s.liste.map((e) => h('tr', { class: e === s.pleinTaux ? 'hl' : '' },
    h('td', {}, formatAge(e.ageDepartMois)), h('td', {}, e.dateDepart.toLocaleDateString('fr-FR', { month: 'short', year: 'numeric' })),
    h('td', {}, e.trimestres), h('td', {}, e.decoteTrim ? `−${(e.decoteTrim * 0.625).toFixed(2).replace('.', ',')} %` : e.surcoteTrim ? `+${(e.surcoteTrim * 1.25).toFixed(2).replace('.', ',')} %` : '—'),
    h('td', {}, eur.format(e.base)), h('td', {}, eur.format(e.compl)), h('td', {}, eur.format(e.brutMensuel)), h('td', {}, eur.format(e.netMensuel))));
  root.append(h('div', { class: 'card scroll' }, h('h3', {}, 'Selon l’âge de départ (montants mensuels, en euros de 2026)'),
    h('table', {}, h('thead', {}, h('tr', {}, ['Âge', 'Date', 'Trim.', 'Décote / surcote', 'Base', 'Compl.', 'Brut', 'Net env.'].map((t) => h('th', {}, t)))), h('tbody', {}, lignes))));

  root.append(blocEnfants(p, s.droitsEnfants));
  root.append(h('div', { class: 'notice' },
    h('strong', {}, 'Estimation indicative, pas un droit acquis. '),
    'Les calculs reposent sur vos documents et sur des hypothèses simplifiées (revalorisation, revenus futurs, régimes alignés). Les indépendants libéraux affiliés à la CIPAV et les carrières mixtes ou à l’étranger ne sont pas modélisés finement. Seule la caisse de retraite fait foi : comparez avec votre relevé et le simulateur officiel sur ',
    h('a', { href: 'https://www.info-retraite.fr', target: '_blank', rel: 'noopener' }, 'info-retraite.fr'),
    '. Le calendrier de la réforme est suspendu jusqu’au 1er janvier 2028 et peut évoluer ensuite.'));
  return root;
}

function stat(k, v, s, hl) {
  return h('div', { class: `stat${hl ? ' hl' : ''}` }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v), h('div', { class: 's' }, s));
}

function blocEnfants(p, droits = enfantsDroits(p.sexe, p.enfants)) {
  const femme = p.sexe === 'F';
  return h('div', { class: 'card' },
    h('h3', {}, 'Les enfants comptent-ils pour la retraite ?'),
    h('p', {}, 'Oui, pour les hommes comme pour les femmes, mais pas de la même façon (régime général, salariés et assimilés) :'),
    h('ul', {},
      h('li', {}, 'Mère : jusqu’à 8 trimestres par enfant (4 pour la maternité ou l’adoption, 4 pour l’éducation). Pour les enfants nés avant 2010, tout revient à la mère.'),
      h('li', {}, 'Père : 0 trimestre avant 2010. Pour un enfant né ou adopté à partir de 2010, 2 des 4 trimestres d’éducation peuvent lui être attribués si les parents le demandent dans les 6 mois suivant le 4e anniversaire de l’enfant ; sinon ils reviennent à la mère.'),
      h('li', {}, 'Père et mère : +10 % sur la pension de base à partir de 3 enfants élevés au moins 9 ans avant leurs 16 ans.'),
      h('li', {}, 'Depuis le 1er septembre 2026, le parent qui a des trimestres enfants voit son salaire annuel moyen calculé sur 24 meilleures années (1 enfant) ou 23 (2 enfants ou plus) au lieu de 25.')),
    p.enfants.length
      ? h('p', {}, h('strong', {}, `Dans votre cas (${femme ? 'femme' : 'homme'}, ${p.enfants.length} enfant${p.enfants.length > 1 ? 's' : ''}) : `), `${droits.trimestres} trimestre${droits.trimestres > 1 ? 's' : ''} ajouté${droits.trimestres > 1 ? 's' : ''} à votre durée d’assurance${droits.enfantsAvecMajoration ? '' : ' (aucun, vous n’êtes pas le parent bénéficiaire)'}.`)
      : h('p', { class: 'muted' }, 'Ajoutez vos enfants ci-dessus pour voir l’effet sur votre retraite.'),
    h('p', { class: 'muted' }, 'Non modélisés : adoption, enfant handicapé, carrière longue, congés parentaux, majorations Agirc-Arrco plafonnées, chômage non indemnisé et points Agirc-Arrco des arrêts maladie.'));
}

async function nettoyerDoublons() {
  await assurerHashes();
  const groupes = new Map();
  for (const d of state.docs) if (d.hash) { if (!groupes.has(d.hash)) groupes.set(d.hash, []); groupes.get(d.hash).push(d); }
  const aSupprimer = [];
  for (const g of groupes.values()) {
    if (g.length < 2) continue;
    g.sort((a, b) => String(a.addedAt).localeCompare(String(b.addedAt)));
    aSupprimer.push(...g.slice(1));
  }
  if (!aSupprimer.length) return toast('Aucun doublon trouvé');
  const detail = aSupprimer.slice(0, 8).map((d) => `• ${libelle(d)} (${groupeDe(d)})`).join('\n');
  if (!confirm(`${aSupprimer.length} doublon${aSupprimer.length > 1 ? 's' : ''} trouvé${aSupprimer.length > 1 ? 's' : ''} :\n${detail}${aSupprimer.length > 8 ? '\n…' : ''}\n\nLes supprimer et garder un seul exemplaire de chaque ?`)) return;
  for (const d of aSupprimer) await vault.remove(d.id);
  await charger(); render(); toast(`${aSupprimer.length} doublon${aSupprimer.length > 1 ? 's supprimés' : ' supprimé'}`);
}

// ───────────────────────── Vue : sauvegarde ─────────────────────────
function viewSauvegarde() {
  const fichier = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
  fichier.addEventListener('change', async () => {
    const f = fichier.files[0]; fichier.value = '';
    if (!f) return;
    const phrase = prompt('Phrase secrète utilisée pour créer cette sauvegarde :');
    if (!phrase) return;
    try {
      const n = await vault.importBackup(await f.text(), phrase);
      await charger(); render(); toast(`${n} éléments importés`);
    } catch (e) { toast(e.message || 'Import impossible'); }
  });
  return h('div', {},
    h('h2', {}, 'Sauvegarde et transfert'),
    h('div', { class: 'card' },
      h('h3', {}, 'Lieu de stockage'),
      h('p', {}, `Vos données chiffrées sont enregistrées dans ${stockage.label}.`),
      stockage.kind === 'navigateur' ? h('p', { class: 'muted' }, 'Elles restent sur cet ordinateur. Pour les emporter sur une clé USB, copiez le coffre vers un dossier de la clé.') : null,
      h('div', { class: 'row' },
        stockage.kind === 'navigateur' ? h('button', { class: 'primary', onclick: copierSurCle }, 'Copier mon coffre sur une clé USB…') : null,
        h('button', { onclick: async () => { if (confirm('Changer de lieu de stockage ? Vos données actuelles ne sont pas effacées : vous pourrez y revenir.')) { await prefsDel('mode'); await prefsDel('dir'); await prefsSet('forcerChoix', true); location.reload(); } } }, 'Changer de lieu de stockage'))),
    PORTABLE ? null : h('div', { class: 'card' },
      h('h3', {}, 'Version clé USB (sans internet)'),
      h('p', { class: 'muted' }, 'Un seul fichier à copier sur une clé USB. Il s’ouvre par double-clic dans Chrome ou Edge, sans installation ni connexion, et enregistre vos données chiffrées dans un dossier de la clé.'),
      h('a', { class: 'btn primary', href: 'portable/Mes-papiers-retraite.html', download: 'Mes-papiers-retraite.html', style: 'display:inline-block;text-decoration:none' }, 'Télécharger la version clé USB')),
    h('div', { class: 'card' },
      h('h3', {}, 'Sauvegarde chiffrée'),
      h('p', { class: 'muted' }, 'Un seul fichier, chiffré avec votre phrase secrète, pour passer de votre ordinateur à votre téléphone ou garder une copie de secours. Il peut être stocké sans risque sur un cloud ou une clé USB.'),
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: async () => { sauverBlob(new Blob([await vault.exportBackup()], { type: 'application/json' }), `mes-papiers-retraite_${new Date().toISOString().slice(0, 10)}.json`); } }, 'Exporter la sauvegarde'),
        h('button', { onclick: () => fichier.click() }, 'Importer une sauvegarde'), fichier)),
    h('div', { class: 'card' },
      h('h3', {}, 'Tout télécharger en clair (ZIP)'),
      h('p', { class: 'muted' }, 'Tous vos documents rangés en dossiers par année puis par employeur, non chiffrés : à utiliser pour un dossier de retraite ou une impression en lot. Ne conservez pas ce fichier sur un appareil partagé.'),
      h('button', { onclick: async () => {
        await zipDe(state.docs, 'mes-papiers-retraite.zip');
      } }, 'Télécharger le ZIP')),
    h('div', { class: 'card' },
      h('h3', {}, 'Chercher les doublons'),
      h('p', { class: 'muted' }, 'Repère les documents enregistrés plusieurs fois (fichiers identiques) et vous propose de ne garder que le plus ancien.'),
      h('button', { onclick: nettoyerDoublons }, 'Chercher les doublons')),
    h('div', { class: 'card' },
      h('h3', {}, 'Effacer toutes les données de cet appareil'),
      h('button', { class: 'danger', onclick: async () => {
        if (!confirm('Tout supprimer sur cet appareil, définitivement ?') || !confirm('Dernière confirmation : les documents non sauvegardés seront perdus.')) return;
        await vault.wipe(); location.reload();
      } }, 'Tout effacer')));
}

// ───────────────────────── Navigation ─────────────────────────
function render() {
  if (!vault.unlocked) return;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
  const vues = { docs: viewDocs, carriere: viewCarriere, retraite: viewRetraite, sauvegarde: viewSauvegarde };
  const view = $('#view');
  const y = scrollY;
  view.replaceChildren(vues[state.tab]());
  scrollTo(0, y);
}

document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => { state.tab = b.dataset.tab; render(); scrollTo(0, 0); }));
$('#btn-lock').addEventListener('click', verrouiller);

(async function demarrer() {
  if (!window.crypto?.subtle || !window.indexedDB) {
    $('#view').append(h('div', { class: 'notice' }, 'Ce navigateur ne permet pas le stockage chiffré. Utilisez une version récente de Chrome, Edge, Firefox ou Safari.'));
    return;
  }
  if (!PORTABLE && 'serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  stockage = await ouvrirStockage();
  const { exists } = await vault.init(stockage);
  renderLock(exists);
})();
