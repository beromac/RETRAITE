import { Vault } from './vault.js';
import { creerZip } from './zip.js';
import { texteDuPdf, analyserTexte, piecesJointesEml } from './extract.js';
import { construireCarriere, syntheseRetraite, enfantsDroits } from './pension.js';
import { ACTIVITES, DEFAUTS, parametresLegaux, formatAge } from './params.js';

// ───────────────────────── Utilitaires ─────────────────────────
const $ = (s, r = document) => r.querySelector(s);
const eur = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const eur2 = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });
const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const TYPES = { payslip: 'Bulletin de paie', urssaf: 'Déclaration Urssaf', autre: 'Autre document' };

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
const num = (v) => (v === '' || v == null ? null : Number(String(v).replace(',', '.')));
const dateFr = (d) => d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
const estAndroid = /Android/i.test(navigator.userAgent);

// ───────────────────────── État ─────────────────────────
const vault = new Vault();
const state = { docs: [], profile: defaultProfile(), career: {}, tab: 'docs', filtre: { type: '', annee: '', q: '' }, queue: [] };
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

async function renderLock(exists) {
  const view = $('#view');
  view.replaceChildren();
  const pass = h('input', { type: 'password', autocomplete: exists ? 'current-password' : 'new-password', placeholder: 'Phrase secrète', required: true });
  const pass2 = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Confirmer la phrase secrète' });
  const err = h('p', { class: 'muted', style: 'color:var(--accent)' });
  const form = h('form', { class: 'card lock' },
    h('h2', {}, exists ? 'Déverrouiller le coffre' : 'Créer votre coffre'),
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

async function importer(fichiers) {
  const items = [];
  for (const f of fichiers) {
    const nom = f.name || '';
    if (/\.eml$/i.test(nom)) {
      const pj = piecesJointesEml(await f.text());
      if (!pj.length) toast(`Aucune pièce jointe PDF trouvée dans ${nom}`);
      for (const p of pj) items.push({ name: p.name, type: p.type, buffer: p.bytes.buffer });
    } else {
      items.push({ name: nom, type: f.type || 'application/pdf', buffer: await f.arrayBuffer() });
    }
  }
  state.queue.push(...items);
  if (!$('#dlg').open) traiterFile();
}

async function traiterFile() {
  const item = state.queue.shift();
  if (!item) { render(); return; }
  let suggestion = {};
  if (/pdf/i.test(item.type) || /\.pdf$/i.test(item.name)) {
    try { suggestion = analyserTexte(await texteDuPdf(item.buffer), item.name); }
    catch { suggestion = analyserTexte('', item.name); }
  } else suggestion = analyserTexte('', item.name);
  ouvrirFormulaire({ ...suggestion, fileName: item.name, mime: item.type, size: item.buffer.byteLength }, item.buffer, state.queue.length);
}

function ouvrirFormulaire(doc, buffer, restants = 0) {
  const dlg = $('#dlg');
  const form = $('#dlg-form');
  const estNouveau = !!buffer;
  const f = {
    type: h('select', {}, Object.entries(TYPES).map(([k, v]) => h('option', { value: k, selected: doc.type === k }, v))),
    year: h('input', { type: 'number', min: 1970, max: 2100, value: doc.year ?? '', required: true }),
    month: h('select', {}, h('option', { value: '' }, '—'), MOIS.map((m, i) => h('option', { value: i + 1, selected: doc.month === i + 1 }, m))),
    quarter: h('select', {}, h('option', { value: '' }, '—'), [1, 2, 3, 4].map((q) => h('option', { value: q, selected: doc.quarter === q }, `${q}${q === 1 ? 'er' : 'e'} trimestre`))),
    employer: h('input', { type: 'text', value: doc.employer || '', placeholder: 'Employeur' }),
    brut: h('input', { type: 'text', inputmode: 'decimal', value: doc.brut ?? '' }),
    net: h('input', { type: 'text', inputmode: 'decimal', value: doc.net ?? '' }),
    ca: h('input', { type: 'text', inputmode: 'decimal', value: doc.ca ?? '' }),
    activite: h('select', {}, Object.entries(ACTIVITES).map(([k, v]) => h('option', { value: k, selected: (doc.activite || 'services') === k }, v.label))),
    note: h('input', { type: 'text', value: doc.note || '' }),
  };
  const zonePaie = h('div', { class: 'fields' },
    h('label', {}, 'Mois', f.month), h('label', {}, 'Employeur', f.employer),
    h('label', {}, 'Salaire brut (€)', f.brut), h('label', {}, 'Net à payer (€)', f.net));
  const zoneUrssaf = h('div', { class: 'fields' },
    h('label', {}, 'Trimestre (si déclaration trimestrielle)', f.quarter), h('label', {}, 'Mois (si mensuelle)', f.month.cloneNode(true)),
    h('label', {}, 'Chiffre d’affaires déclaré (€)', f.ca), h('label', {}, 'Activité', f.activite));
  const majZones = () => {
    zonePaie.hidden = f.type.value !== 'payslip';
    zoneUrssaf.hidden = f.type.value !== 'urssaf';
  };
  f.type.addEventListener('change', majZones);
  majZones();
  const moisUrssaf = zoneUrssaf.querySelectorAll('select')[1];
  if (doc.month) moisUrssaf.value = doc.month;

  const annuler = h('button', { type: 'button', onclick: () => { dlg.close(); traiterFile(); } }, estNouveau ? 'Ignorer' : 'Annuler');
  form.replaceChildren(
    h('h2', {}, estNouveau ? 'Nouveau document' : 'Modifier le document'),
    h('p', { class: 'muted' }, estNouveau
      ? `${doc.fileName}${restants ? ` · encore ${restants} à traiter` : ''} — vérifiez les valeurs reconnues automatiquement.`
      : doc.fileName),
    h('div', { class: 'fields' }, h('label', {}, 'Type', f.type), h('label', {}, 'Année', f.year)),
    zonePaie, zoneUrssaf,
    h('label', {}, 'Note (facultatif)', f.note),
    h('div', { class: 'row spread' }, annuler, h('button', { class: 'primary', type: 'submit' }, 'Enregistrer')),
  );
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const type = f.type.value;
    const moisSel = type === 'urssaf' ? moisUrssaf.value : f.month.value;
    const meta = {
      kind: 'doc', type, year: Number(f.year.value), month: moisSel ? Number(moisSel) : null,
      quarter: type === 'urssaf' && f.quarter.value ? Number(f.quarter.value) : null,
      employer: f.employer.value.trim(), brut: num(f.brut.value), net: num(f.net.value), ca: num(f.ca.value),
      activite: f.activite.value, note: f.note.value.trim(),
      fileName: doc.fileName, mime: doc.mime, size: doc.size, addedAt: doc.addedAt || new Date().toISOString(),
    };
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
  const t = d.type === 'payslip' ? 'bulletin-paie' : d.type === 'urssaf' ? 'urssaf' : 'document';
  return `${d.year}-${p}_${t}${d.employer ? '_' + d.employer.replace(/[^\w-]+/g, '-') : ''}${ext}`;
};

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
  const input = h('input', { type: 'file', multiple: true, accept: 'application/pdf,image/*,.eml', hidden: true });
  input.addEventListener('change', () => { importer([...input.files]); input.value = ''; });
  const drop = h('div', { class: 'drop' },
    h('p', {}, h('strong', {}, 'Déposez vos PDF ici'), ' ou ', h('button', { class: 'primary', onclick: () => input.click() }, 'Ajouter des documents')),
    h('p', { class: 'muted' }, 'Bulletins de paie, déclarations ou attestations Urssaf. Vous pouvez aussi déposer un mail enregistré (.eml) : les pièces jointes PDF sont extraites.'),
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
  const f = state.filtre;
  const rafraichir = () => { f.type = fType.value; f.annee = fAnnee.value; f.q = fQ.value; render(); };
  const fType = h('select', { onchange: rafraichir }, h('option', { value: '' }, 'Tous les types'), Object.entries(TYPES).map(([k, v]) => h('option', { value: k, selected: f.type === k }, v)));
  const fAnnee = h('select', { onchange: rafraichir }, h('option', { value: '' }, 'Toutes les années'), annees.map((a) => h('option', { value: a, selected: String(f.annee) === String(a) }, a)));
  const fQ = h('input', { type: 'search', placeholder: 'Rechercher (employeur, note…)', value: f.q, onchange: rafraichir });
  root.append(h('div', { class: 'card' }, h('div', { class: 'fields' }, h('label', {}, 'Type', fType), h('label', {}, 'Année', fAnnee), h('label', {}, 'Recherche', fQ))));

  const liste = state.docs.filter((d) => (!f.type || d.type === f.type) && (!f.annee || String(d.year) === String(f.annee))
    && (!f.q || `${d.employer} ${d.note} ${d.fileName}`.toLowerCase().includes(f.q.toLowerCase())));
  liste.sort((a, b) => b.year - a.year || (b.month || b.quarter * 3 || 0) - (a.month || a.quarter * 3 || 0));

  if (!state.docs.length) root.append(h('p', { class: 'muted' }, 'Aucun document pour l’instant. Ajoutez vos premiers bulletins ou déclarations ci-dessus.'));
  let annee = null;
  for (const d of liste) {
    if (d.year !== annee) { annee = d.year; root.append(h('div', { class: 'year-title' }, annee)); }
    const montants = d.type === 'payslip'
      ? [d.brut != null ? `brut ${eur2.format(d.brut)}` : null, d.net != null ? `net ${eur2.format(d.net)}` : null]
      : d.type === 'urssaf' ? [d.ca != null ? `CA ${eur2.format(d.ca)}` : null, ACTIVITES[d.activite]?.label] : [];
    root.append(h('div', { class: 'card doc' },
      h('div', { class: 'title' }, libelle(d)),
      h('div', { class: 'muted' }, [d.employer, ...montants, d.note].filter(Boolean).join(' · ') || d.fileName),
      h('div', { class: 'row' },
        h('button', { class: 'small', onclick: () => ouvrir(d) }, 'Ouvrir'),
        h('button', { class: 'small', onclick: () => telecharger(d) }, 'Télécharger'),
        h('button', { class: 'small', onclick: () => imprimer(d) }, 'Imprimer'),
        h('button', { class: 'small', onclick: () => ouvrirFormulaire(d) }, 'Modifier'),
        h('button', { class: 'small danger', onclick: () => supprimer(d) }, 'Supprimer')),
    ));
  }
  return root;
}

// ───────────────────────── Vue : carrière ─────────────────────────
function viewCarriere() {
  const root = h('div');
  root.append(h('h2', {}, 'Ma carrière année par année'));
  root.append(h('p', { class: 'muted' }, 'Calculée à partir de vos documents. Pour les années sans papier (ou si votre relevé de carrière info-retraite.fr dit autre chose), corrigez directement le revenu ou le nombre de trimestres : la correction remplace le calcul.'));
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
      h('td', {}, h('input', { type: 'text', inputmode: 'decimal', value: ov.revenu ?? '', placeholder: String(Math.round(r.salaire + r.revenuInd)), onchange: (e) => maj('revenu', e.target.value) })),
      h('td', {}, h('input', { class: 'narrow', type: 'text', inputmode: 'numeric', value: ov.trim ?? '', placeholder: String(r.trimAuto), onchange: (e) => maj('trim', e.target.value) })),
      h('td', {}, h('strong', {}, r.trimEff)),
    ));
  }
  root.append(h('div', { class: 'card scroll' }, h('table', {},
    h('thead', {}, h('tr', {}, ['Année', 'Salaires bruts', 'CA auto-entr.', 'Revenu retenu (€)', 'Trimestres (corr.)', 'Trimestres'].map((t) => h('th', {}, t)))),
    tbody)));

  const total = rows.reduce((s, r) => s + r.trimEff, 0);
  root.append(h('div', { class: 'stat hl' }, h('div', { class: 'k' }, 'Trimestres validés d’après ces données'), h('div', { class: 'v' }, total), h('div', { class: 's' }, `soit ${(total / 4).toFixed(1).replace('.', ',')} années · hors trimestres enfants, chômage, maladie, etc.`)));

  const ajout = h('div', { class: 'card' },
    h('h3', {}, 'Ajouter une année manquante'),
    (() => {
      const y = h('input', { type: 'number', min: 1970, max: anneeCourante, placeholder: 'Année' });
      const t = h('input', { type: 'number', min: 0, max: 4, placeholder: 'Trimestres' });
      const r = h('input', { type: 'text', inputmode: 'decimal', placeholder: 'Revenu (€)' });
      return h('div', { class: 'row' }, h('div', { style: 'width:110px' }, y), h('div', { style: 'width:110px' }, t), h('div', { style: 'width:140px' }, r),
        h('button', { class: 'primary', onclick: async () => {
          if (!y.value) return toast('Indiquez l’année');
          state.career[Number(y.value)] = { ...(t.value !== '' ? { trim: Number(t.value) } : {}), ...(r.value !== '' ? { revenu: num(r.value) } : {}) };
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
    h('p', { class: 'muted' }, 'Non modélisés : adoption, enfant handicapé, carrière longue, congés parentaux, majorations Agirc-Arrco plafonnées.'));
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
      h('h3', {}, 'Sauvegarde chiffrée'),
      h('p', { class: 'muted' }, 'Un seul fichier, chiffré avec votre phrase secrète, pour passer de votre ordinateur à votre téléphone ou garder une copie de secours. Il peut être stocké sans risque sur un cloud ou une clé USB.'),
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: async () => { sauverBlob(new Blob([await vault.exportBackup()], { type: 'application/json' }), `mes-papiers-retraite_${new Date().toISOString().slice(0, 10)}.json`); } }, 'Exporter la sauvegarde'),
        h('button', { onclick: () => fichier.click() }, 'Importer une sauvegarde'), fichier)),
    h('div', { class: 'card' },
      h('h3', {}, 'Tout télécharger en clair (ZIP)'),
      h('p', { class: 'muted' }, 'Tous vos documents rangés par année, non chiffrés : à utiliser pour un dossier de retraite ou une impression en lot. Ne conservez pas ce fichier sur un appareil partagé.'),
      h('button', { onclick: async () => {
        const files = [];
        for (const d of state.docs) {
          const buf = await vault.file(d.id);
          if (buf) files.push({ name: `${d.year}/${nomFichier(d)}`, data: new Uint8Array(buf) });
        }
        if (!files.length) return toast('Rien à télécharger');
        sauverBlob(creerZip(files), 'mes-papiers-retraite.zip');
      } }, 'Télécharger le ZIP')),
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
    $('#view').append(h('div', { class: 'notice' }, 'Ce navigateur ne permet pas le stockage chiffré. Utilisez une version récente de Chrome, Edge, Firefox ou Safari, en HTTPS.'));
    return;
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  const { exists } = await vault.init();
  renderLock(exists);
})();
