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
export function analyserTexte(texte, nomFichier = '') {
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
  const emp = t.match(/(?:employeur|raison sociale|entreprise)\s*:?\s*([A-ZÉÈÀ][\wÉÈÀéèàç'’.& -]{2,40})/);
  if (emp) res.employer = emp[1].trim();
  return res;
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
