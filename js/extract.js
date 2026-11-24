// Aide à l'import : lecture du texte des PDF (pdf.js chargé à la demande), reconnaissance
// des champs d'un bulletin de paie / d'une déclaration Urssaf, et extraction des pièces
// jointes d'un fichier .eml. Tout est « au mieux » : l'utilisateur valide toujours les valeurs.

// pdf.js 6.x (build « legacy », Apache-2.0) et pdf-lib 1.17.1 (MIT) sont embarqués dans /vendor : tout fonctionne hors ligne.
// Version portable (un seul fichier .html ouvert depuis une clé) : les bibliothèques sont incluses dans la page
// en base64 (balises #emb-*) puis chargées via des URL « blob: », car le navigateur interdit de charger
// des modules ou des workers depuis file://.
const embarque = (id, type) => {
  const b64 = document.getElementById(id)?.textContent?.trim();
  if (!b64) return null;
  return URL.createObjectURL(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type }));
};
const vendor = (chemin) => new URL(`../vendor/${chemin}`, import.meta.url).href;
let pdfjsPromise = null;

function chargerPdfJs() {
  if (!pdfjsPromise) {
    const principal = embarque('emb-pdfjs', 'text/javascript');
    const worker = embarque('emb-pdfjs-worker', 'text/javascript');
    pdfjsPromise = import(/* @vite-ignore */ principal || vendor('pdfjs/pdf.min.mjs')).then((m) => {
      m.GlobalWorkerOptions.workerSrc = worker || vendor('pdfjs/pdf.worker.min.mjs');
      return m;
    });
  }
  return pdfjsPromise;
}

/**
 * Reconstitue les lignes d'une page d'après la position des morceaux de texte : les PDF de paie les
 * stockent souvent dans le désordre (libellés d'abord, montants ensuite). Colonnes séparées par 3 espaces.
 */
export function lignesDePage(items) {
  const morceaux = items
    .filter((i) => i.str && i.str.trim())
    .map((i) => ({ s: i.str, x: i.transform[4], y: i.transform[5], w: i.width || 0 }))
    .sort((a, b) => b.y - a.y || a.x - b.x);
  const lignes = [];
  for (const m of morceaux) {
    const l = lignes[lignes.length - 1];
    if (l && Math.abs(l.y - m.y) <= 3) l.items.push(m); else lignes.push({ y: m.y, items: [m] });
  }
  const ECHELLE = 4; // points PDF par caractère : l'indentation reproduit les colonnes de la page
  return lignes.map((l) => {
    l.items.sort((a, b) => a.x - b.x);
    let out = '', fin = null;
    for (const m of l.items) {
      const col = Math.round(m.x / ECHELLE);
      if (fin === null) out = ' '.repeat(col);
      else {
        const ecart = m.x - fin;
        if (ecart > 8) out += ' '.repeat(Math.max(3, col - out.length));
        else if (ecart > 1.2) out += ' ';
      }
      out += m.s.trim();
      fin = m.x + m.w;
    }
    return out;
  }).join('\n');
}

export async function texteDuPdf(buffer, maxPages = 3) {
  const pdfjs = await chargerPdfJs();
  const doc = await pdfjs.getDocument({ data: buffer.slice(0) }).promise;
  let out = '';
  for (let p = 1; p <= Math.min(doc.numPages, maxPages); p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    out += lignesDePage(content.items) + '\n';
  }
  return out;
}

export function nombreFr(s) {
  if (!s) return null;
  let t = String(s).replace(/[\s  ]/g, '');
  if (t.includes(',') && t.includes('.')) t = t.replace(/\./g, '').replace(',', '.');
  else t = t.replace(',', '.');
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : null;
}

const MOIS_NOMS = ['janvier', 'février', 'fevrier', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'aout', 'septembre', 'octobre', 'novembre', 'décembre', 'decembre'];
const MOIS_NUM = { janvier: 1, février: 2, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7, août: 8, aout: 8, septembre: 9, octobre: 10, novembre: 11, décembre: 12, decembre: 12 };

/** Devine type, période et montants à partir du texte brut. */
const MONTANT = /-?\d{1,3}(?:[ \u00a0\u202f]\d{3})*,\d{2}|-?\d+,\d{2}/g;

export function analyserTexte(texte, nomFichier = '', employeursConnus = []) {
  const t = texte.replace(/\s+/g, ' ');
  const res = { type: 'autre', year: null, month: null, quarter: null, brut: null, net: null, ca: null, employer: '' };
  const estUrssaf = /urssaf|micro-?entrepreneur|auto-?entrepreneur|chiffre d'affaires|chiffre d’affaires/i.test(t);
  const estPaie = /bulletin de (paie|salaire)|net à payer|salaire brut|net a payer/i.test(t) || /paie|bulletin|payslip/i.test(nomFichier);
  res.type = estPaie && !/attestation de chiffre|déclaration de chiffre/i.test(t) ? 'payslip' : estUrssaf ? 'urssaf' : estPaie ? 'payslip' : 'autre';

  // Période : « du 01/10/2025 au 31/10/2025 », « Octobre 2025 », « 10/2025 », trimestre
  const plage = t.match(/(\d{2})[\/.-](\d{2})[\/.-](\d{4})\s+(?:au|à|-)\s+(\d{2})[\/.-](\d{2})[\/.-](\d{4})/);
  let m = plage ? [null, null, plage[5], plage[6]]
    : t.match(/p[ée]riode[^0-9]{0,15}(?:du\s*)?(\d{2})[\/.-](\d{2})[\/.-](\d{4})/i) || t.match(/\bdu\s+(\d{2})[\/.-](\d{2})[\/.-](\d{4})\s+au\b/i);
  if (m) { res.month = Number(m[2]); res.year = Number(m[3]); }
  if (!res.year) {
    const nom = t.match(new RegExp(`\\b(${MOIS_NOMS.join('|')})\\s+(\\d{4})\\b`, 'i'));
    if (nom) { res.month = MOIS_NUM[nom[1].toLowerCase()]; res.year = Number(nom[2]); }
  }
  if (!res.year) {
    const mm = t.match(/\b(0[1-9]|1[0-2])[\/.-](20\d{2})\b/);
    if (mm) { res.month = Number(mm[1]); res.year = Number(mm[2]); }
  }
  if (!res.year) {
    const f = nomFichier.match(/(20\d{2})[-_.]?(0[1-9]|1[0-2])?/);
    if (f) { res.year = Number(f[1]); if (f[2]) res.month = Number(f[2]); }
  }
  const q = t.match(/(\d)(?:er|e|ème|eme)?\s*trimestre\s*(20\d{2})/i) || t.match(/trimestre\s*(\d)\D{0,10}(20\d{2})/i);
  if (q && res.type === 'urssaf') { res.quarter = Number(q[1]); res.year = Number(q[2]); res.month = null; }

  const nb = '([0-9][0-9\\s\\u00a0\\u202f.,]*[0-9])';
  const brut = t.match(new RegExp(`(?:salaire brut|total brut|brut mensuel|brut)\\D{0,25}${nb}`, 'i'));
  const net = t.match(new RegExp(`net (?:à|a) payer(?: avant imp[ôo]t)?\\D{0,40}${nb}`, 'i'));
  const ca = t.match(new RegExp(`chiffre d['’]affaires[^0-9]{0,60}${nb}`, 'i'));
  // Montants : on lit le dernier montant de la ligne (colonnes « base … montant »), sinon l'ancienne recherche par texte.
  const lignes = texte.split(/\r?\n/);
  const dernier = (re) => {
    for (const l of lignes) if (re.test(l)) { const a = l.match(MONTANT); if (a) return nombreFr(a[a.length - 1]); }
    return null;
  };
  res.brut = dernier(/total brut|salaire brut|brut total/i) ?? (brut ? nombreFr(brut[1]) : null);
  res.net = dernier(/net\s*(?:à|a)\s*payer\s*avant/i) ?? dernier(/net\s*(?:à|a)\s*payer/i) ?? (net ? nombreFr(net[1]) : null);
  if (ca) res.ca = nombreFr(ca[1]);
  if (res.type === 'payslip') res.employer = extraireEmployeur(texte, employeursConnus);
  return res;
}

const sansAccent = (x) => x.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
export const cleEmployeur = sansAccent;

const MOTS = "[A-Za-zÀ-ÿ0-9'’.&-]+(?=\\s|$)";
const STOP = /\s+(?:N°|(?:SIRET|SIREN|No|APE|NAF|Code|Adresse|Convention|URSSAF|Effectif|Matricule|Salari[ée]|Bulletin|P[ée]riode|Date|Emploi|Statut|Qualification|Tel|T[ée]l|www|http)\b).*$/i;

function nettoyerNom(n) {
  let x = n.replace(STOP, '').replace(/\s+\d{5}\b.*$/, '').replace(/^[\s:;,.\-–]+|[\s:;,.\-–]+$/g, '').replace(/\s+/g, ' ');
  const mots = x.split(' ');
  if (mots.length > 6) x = mots.slice(0, 6).join(' ');
  return x.length >= 2 && x.length <= 60 ? x : '';
}

/** Cherche le nom de l'employeur : nom déjà connu, champ « Employeur », forme juridique, ou nom placé avant le SIRET. */
export function extraireEmployeur(texte, connus = []) {
  const t = texte.replace(/\s+/g, ' ');
  const tn = sansAccent(t);
  const lignes = texte.split(/\r?\n/);
  const triesConnus = [...new Set(connus.filter(Boolean))].sort((a, b) => b.length - a.length);
  for (const c of triesConnus) if (c.length >= 3 && tn.includes(sansAccent(c))) return c;

  // Bulletin à colonnes : « EMPLOYEUR   SALARIÉ   EMPLOI » puis, plus bas, le nom dans la colonne de gauche.
  const ENTETES = /^(?:salari[ée]|n°|emploi|dossier|qualification|date|matricule|convention|siret|code|adresse|p[ée]riode|bulletin)/i;
  const segments = (l) => [...l.matchAll(/\S(?:.*?\S)?(?=\s{3,}|$)/g)].map((m) => ({ texte: m[0], col: m.index }));
  for (let i = 0; i < lignes.length; i++) {
    if (!/\bEMPLOYEUR\b/.test(lignes[i]) || /employeur\s*[:\-]\s*\S/i.test(lignes[i])) continue;
    const entete = segments(lignes[i]);
    const k = entete.findIndex((x) => /\bEMPLOYEUR\b/.test(x.texte));
    const limite = k >= 0 && entete[k + 1] ? entete[k + 1].col - 4 : Infinity;
    for (let j = i + 1; j < Math.min(i + 7, lignes.length); j++) {
      const seg = segments(lignes[j]).find((x) => x.col < limite);
      if (!seg || ENTETES.test(seg.texte) || !/[A-Za-zÀ-ÿ]{2}/.test(seg.texte)) continue;
      const n = nettoyerNom(seg.texte);
      if (n) return n;
    }
  }

  const champ = t.match(new RegExp(`(?:employeur|raison sociale|d[ée]nomination(?: sociale)?|nom de l['’](?:entreprise|employeur|soci[ée]t[ée]))\\s*:\\s*(${MOTS}(?: ${MOTS}){0,7})`, 'i'))
    || t.match(new RegExp(`(?:entreprise|soci[ée]t[ée])\\s*:\\s*(${MOTS}(?: ${MOTS}){0,7})`, 'i'));
  if (champ) { const n = nettoyerNom(champ[1]); if (n && !/^(de|du|la|le|l['’])$/i.test(n)) return n; }

  const FORMES = '(?:SAS|SASU|SARL|EURL|SNC|SELARL|SCOP|SCI|GIE|SA|Association)';
  const apres = t.match(new RegExp(`\\b${FORMES}\\s+([A-ZÀ-Ý][A-ZÀ-Ý'’.&-]*(?: [A-ZÀ-Ý][A-ZÀ-Ý'’.&-]*){0,3})\\b`));
  if (apres) { const forme = apres[0].match(new RegExp(`^${FORMES}`))[0]; const n = nettoyerNom(apres[1]); if (n) return `${forme} ${n}`; }
  const avant = t.match(new RegExp(`\\b([A-ZÀ-Ý][A-ZÀ-Ý0-9'’.&-]+(?: [A-ZÀ-Ý0-9'’.&-]+){0,3}) ${FORMES}\\b`));
  if (avant) { const n = nettoyerNom(avant[0]); if (n) return n; }

  const siret = t.match(new RegExp(`((?:[A-ZÀ-Ý0-9'’.&-]{2,} ){1,4})(?:N° )?SIRET`));
  if (siret) { const n = nettoyerNom(siret[1]); if (n && !/\d{4,}/.test(n)) return n; }
  return '';
}

/** Extrait les pièces jointes PDF/images d'un fichier .eml (MIME base64). */
export function piecesJointesEml(texte) {
  const out = [];
  const re = /(?:^|\r?\n)((?:Content-[A-Za-z-]+:[^\r\n]*(?:\r?\n[ \t][^\r\n]*)*\r?\n)+)\r?\n/g;
  let m;
  while ((m = re.exec(texte))) {
    const entetes = m[1];
    if (!/content-transfer-encoding:\s*base64/i.test(entetes)) continue;
    const type = (entetes.match(/content-type:\s*([^;\r\n]+)/i) || [])[1]?.trim().toLowerCase() || '';
    if (!/(pdf|image\/|octet-stream)/.test(type)) continue;
    const nom = (entetes.match(/(?:file)?name\*?=\s*"?([^";\r\n]+)"?/i) || [])[1] || `piece-jointe-${out.length + 1}.pdf`;
    const debut = m.index + m[0].length;
    const finMatch = texte.slice(debut).search(/\r?\n--/);
    const corps = texte.slice(debut, finMatch === -1 ? undefined : debut + finMatch).replace(/[^A-Za-z0-9+/=]/g, '');
    try {
      const bytes = Uint8Array.from(atob(corps), (c) => c.charCodeAt(0));
      if (bytes.length > 500) out.push({ name: decodeURIComponent(nom.replace(/\+/g, ' ')), type: type === 'application/octet-stream' ? 'application/pdf' : type, bytes });
    } catch { /* base64 invalide : ignoré */ }
  }
  return out;
}

// ───────────── Découpage d'un PDF regroupant plusieurs documents ─────────────

/** Texte de chaque page (tableau), pour détecter où commence chaque bulletin. */
export async function pagesPdf(buffer, maxPages = 400) {
  const pdfjs = await chargerPdfJs();
  const doc = await pdfjs.getDocument({ data: buffer.slice(0) }).promise;
  const out = [];
  for (let p = 1; p <= Math.min(doc.numPages, maxPages); p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    out.push(lignesDePage(content.items));
  }
  return out;
}

const cle = (t) => { const a = analyserTexte(t); return a.year ? `${a.year}-${a.month || 0}` : null; };

/**
 * Regroupe les pages en documents. mode : 'tout' | 'page' | 'auto' | 'n:K'.
 * 'auto' : une nouvelle page d'en-tête « bulletin de paie » avec une autre période démarre un nouveau bulletin ;
 * sans en-tête reconnu, chaque page est un document.
 */
export function regrouperPages(textes, mode) {
  const n = textes.length;
  const idx = [...Array(n).keys()];
  if (mode === 'tout') return [idx];
  if (mode === 'page') return idx.map((i) => [i]);
  if (mode.startsWith('n:')) {
    const k = Math.max(1, Number(mode.slice(2)) || 1);
    const g = [];
    for (let i = 0; i < n; i += k) g.push(idx.slice(i, i + k));
    return g;
  }
  const debut = textes.map((t) => /bulletin de (paie|salaire|paye)/i.test(t));
  if (!debut.some(Boolean)) return idx.map((i) => [i]);
  const groupes = [];
  let courantCle = null;
  for (const i of idx) {
    const k = cle(textes[i]);
    const nouveau = !groupes.length || (debut[i] && (k === null || courantCle === null || k !== courantCle));
    if (nouveau) { groupes.push([i]); courantCle = k; }
    else groupes[groupes.length - 1].push(i);
  }
  return groupes;
}

let pdfLibPromise = null;
function chargerPdfLib() {
  if (window.PDFLib) return Promise.resolve(window.PDFLib);
  if (!pdfLibPromise) {
    pdfLibPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = embarque('emb-pdflib', 'text/javascript') || vendor('pdf-lib.min.js');
      s.onload = () => resolve(window.PDFLib);
      s.onerror = () => { pdfLibPromise = null; reject(new Error('pdf-lib indisponible')); };
      document.head.append(s);
    });
  }
  return pdfLibPromise;
}

/** Découpe un PDF selon des groupes de pages (indices) → [{ buffer, pages: [i...] }]. */
export async function decouperPdf(buffer, groupes) {
  const { PDFDocument } = await chargerPdfLib();
  const source = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const out = [];
  for (const pages of groupes) {
    const doc = await PDFDocument.create();
    (await doc.copyPages(source, pages)).forEach((p) => doc.addPage(p));
    const bytes = await doc.save();
    out.push({ buffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), pages });
  }
  return out;
}
