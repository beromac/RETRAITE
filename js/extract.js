// Aide à l'import : lecture du texte des PDF (pdf.js chargé à la demande), reconnaissance
// des champs d'un bulletin de paie / d'une déclaration Urssaf, et extraction des pièces
// jointes d'un fichier .eml. Tout est « au mieux » : l'utilisateur valide toujours les valeurs.

const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/';
let pdfjsPromise = null;

function chargerPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(/* @vite-ignore */ PDFJS + 'pdf.min.mjs').then((m) => {
      m.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.mjs';
      return m;
    });
  }
  return pdfjsPromise;
}

export async function texteDuPdf(buffer, maxPages = 3) {
  const pdfjs = await chargerPdfJs();
  const doc = await pdfjs.getDocument({ data: buffer.slice(0) }).promise;
  let out = '';
  for (let p = 1; p <= Math.min(doc.numPages, maxPages); p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    out += content.items.map((i) => i.str).join(' ') + '\n';
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
export function analyserTexte(texte, nomFichier = '', employeursConnus = []) {
  const t = texte.replace(/\s+/g, ' ');
  const res = { type: 'autre', year: null, month: null, quarter: null, brut: null, net: null, ca: null, employer: '' };
  const estUrssaf = /urssaf|micro-?entrepreneur|auto-?entrepreneur|chiffre d'affaires|chiffre d’affaires/i.test(t);
  const estPaie = /bulletin de (paie|salaire)|net à payer|salaire brut|net a payer/i.test(t) || /paie|bulletin|payslip/i.test(nomFichier);
  res.type = estPaie && !/attestation de chiffre|déclaration de chiffre/i.test(t) ? 'payslip' : estUrssaf ? 'urssaf' : estPaie ? 'payslip' : 'autre';

  // Période : « du 01/10/2025 au 31/10/2025 », « Octobre 2025 », « 10/2025 », trimestre
  let m = t.match(/p[ée]riode[^0-9]{0,15}(?:du\s*)?(\d{2})[\/.-](\d{2})[\/.-](\d{4})/i) || t.match(/\bdu\s+(\d{2})[\/.-](\d{2})[\/.-](\d{4})\s+au\b/i);
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
  if (brut) res.brut = nombreFr(brut[1]);
  if (net) res.net = nombreFr(net[1]);
  if (ca) res.ca = nombreFr(ca[1]);
  if (res.type === 'payslip') res.employer = extraireEmployeur(t, employeursConnus);
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
  const triesConnus = [...new Set(connus.filter(Boolean))].sort((a, b) => b.length - a.length);
  for (const c of triesConnus) if (c.length >= 3 && tn.includes(sansAccent(c))) return c;

  const champ = t.match(new RegExp(`(?:employeur|raison sociale|d[ée]nomination(?: sociale)?|nom de l['’](?:entreprise|employeur|soci[ée]t[ée]))\\s*[:\\-]?\\s*(${MOTS}(?: ${MOTS}){0,7})`, 'i'))
    || t.match(new RegExp(`(?:entreprise|soci[ée]t[ée])\\s*:\\s*(${MOTS}(?: ${MOTS}){0,7})`, 'i'));
  if (champ) { const n = nettoyerNom(champ[1]); if (n && !/^(de|du|la|le|l['’])$/i.test(n)) return n; }

  const FORMES = '(?:SAS|SASU|SARL|EURL|SNC|SELARL|SCOP|SCI|GIE|SA|Association)';
  const apres = t.match(new RegExp(`\\b${FORMES}\\s+([A-ZÀ-Ý][A-ZÀ-Ý'’.&-]*(?: [A-ZÀ-Ý][A-ZÀ-Ý'’.&-]*){0,3})\\b`));
  if (apres) { const forme = apres[0].match(new RegExp(`^${FORMES}`))[0]; const n = nettoyerNom(apres[1]); if (n) return `${n} ${forme}`; }
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
    out.push(content.items.map((i) => i.str).join(' '));
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
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js';
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
