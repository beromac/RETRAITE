// Moteur de calcul retraite : fonctions pures, sans accès au DOM (testables avec Node).
import { SMIC_H, PASS, AGIRC, ACTIVITES, DEFAUTS, parAnnee, parametresLegaux } from './params.js';

const r2 = (x) => Math.round(x * 100) / 100;

/** Trimestres liés aux enfants (régime général) selon le sexe du parent. */
export function enfantsDroits(sexe, enfants = []) {
  let trimestres = 0;
  let enfantsAvecMajoration = 0;
  const detail = [];
  for (const e of enfants) {
    const avant2010 = Number(e.annee) < 2010;
    let t = 0;
    if (sexe === 'F') {
      // 4 maternité/adoption + 2 éducation automatiques ; +2 éducation si non attribués au père
      t = avant2010 ? 8 : 6 + (e.edu === 'pere' ? 0 : 2);
    } else {
      // le père n'obtient rien avant 2010 ; après, seulement les 2 trimestres d'éducation partageables
      t = !avant2010 && e.edu === 'pere' ? 2 : 0;
    }
    trimestres += t;
    if (t > 0) enfantsAvecMajoration += 1;
    detail.push({ annee: e.annee, trimestres: t });
  }
  return { trimestres, enfantsAvecMajoration, detail };
}

/** Agrège les documents par année et fusionne les corrections manuelles. */
export function construireCarriere(docs = [], overrides = {}, annee = new Date().getFullYear()) {
  const par = new Map();
  const ligne = (y) => {
    if (!par.has(y)) par.set(y, { year: y, salaire: 0, ca: 0, revenuInd: 0, revenuIndCipav: 0, mois: new Set(), nbDocs: 0 });
    return par.get(y);
  };
  for (const d of docs) {
    if (!d.year) continue;
    const l = ligne(Number(d.year));
    l.nbDocs += 1;
    if (d.type === 'payslip') {
      l.salaire += Number(d.brut) || 0;
      if (d.month) l.mois.add(Number(d.month));
    } else if (d.type === 'urssaf') {
      const ca = Number(d.ca) || 0;
      const act = ACTIVITES[d.activite] || ACTIVITES.services;
      l.ca += ca;
      if (act.cipav) l.revenuIndCipav += ca * act.facteur;
      else l.revenuInd += ca * act.facteur;
    }
  }
  for (const y of Object.keys(overrides)) ligne(Number(y));
  const annees = [...par.keys()];
  if (!annees.length) return [];
  const min = Math.min(...annees);
  const max = Math.max(...annees, annee);
  const rows = [];
  for (let y = min; y <= max; y++) {
    const l = par.get(y) || { year: y, salaire: 0, ca: 0, revenuInd: 0, revenuIndCipav: 0, mois: new Set(), nbDocs: 0 };
    const ov = overrides[y] || {};
    const seuil = 150 * parAnnee(SMIC_H, y);
    // Trimestres déclarés par l'Urssaf (attestation) saisis à la main : ils s'ajoutent aux trimestres de salarié, 4 par an au maximum.
    const urssafSaisi = ov.urssaf != null && ov.urssaf !== '' ? Math.max(0, Math.min(4, Math.floor(Number(ov.urssaf)))) : null;
    const revInd = l.revenuInd + l.revenuIndCipav;
    const indepRetenu = urssafSaisi != null ? Math.max(revInd, urssafSaisi * seuil) : revInd;
    const total = l.salaire + indepRetenu;
    const trimAuto = urssafSaisi != null
      ? Math.min(4, Math.min(4, Math.floor(l.salaire / seuil)) + urssafSaisi)
      : Math.min(4, Math.floor(total / seuil));
    const revenuEff = ov.revenu != null && ov.revenu !== '' ? Number(ov.revenu) : total;
    const trimEff = ov.trim != null && ov.trim !== '' ? Number(ov.trim) : (ov.revenu != null && ov.revenu !== '' ? Math.min(4, Math.floor(revenuEff / seuil)) : trimAuto);
    const baseSam = ov.revenu != null && ov.revenu !== '' ? revenuEff : l.salaire + (urssafSaisi != null ? Math.max(l.revenuInd, urssafSaisi * seuil) : l.revenuInd);
    rows.push({
      year: y,
      salaire: r2(l.salaire),
      ca: r2(l.ca),
      revenuInd: r2(l.revenuInd + l.revenuIndCipav),
      mois: l.mois.size,
      nbDocs: l.nbDocs,
      trimAuto,
      revenuEff: r2(revenuEff),
      trimEff,
      revenuSam: r2(Math.min(baseSam, parAnnee(PASS, y))),
      urssafSaisi,
      override: !!(ov.revenu != null && ov.revenu !== '') || !!(ov.trim != null && ov.trim !== '') || urssafSaisi != null,
    });
  }
  return rows;
}

function ajouterMois(date, mois) {
  const d = new Date(date.getFullYear(), date.getMonth() + mois, date.getDate());
  return d;
}

/**
 * Estimation pour un âge de départ donné (en mois).
 * Tous les montants sont exprimés en euros de l'année en cours (pas d'inflation future).
 */
export function estimer(entree, ageDepartMois) {
  const {
    sexe, naissance, enfants = [], elevesNeufAns = true, rows = [], now = new Date(),
    revalorisation = DEFAUTS.revalorisation, continuer = true, revenuProjete = null,
    trimestresAutres = 0, pointsAgirc = null, pensionAutreAnnuelle = 0,
  } = entree;
  const legal = parametresLegaux(naissance);
  const anneeCourante = now.getFullYear();
  const dateDepart = ajouterMois(naissance, ageDepartMois);
  const anneeDepart = dateDepart.getFullYear();
  const moisAvantDepart = dateDepart.getMonth();
  const coef = (y) => Math.pow(1 + revalorisation, Math.max(0, anneeCourante - y));
  const smicRef = parAnnee(SMIC_H, anneeCourante);
  const passRef = parAnnee(PASS, anneeCourante);

  // Revenu annuel projeté par défaut : moyenne revalorisée des 3 dernières années complètes.
  const passees = rows.filter((r) => r.year < anneeCourante && r.revenuEff > 0).slice(-3);
  const projAuto = passees.length
    ? passees.reduce((s, r) => s + r.revenuEff * coef(r.year), 0) / passees.length
    : 0;
  const proj = revenuProjete != null && revenuProjete !== '' ? Number(revenuProjete) : projAuto;

  let trimAcquis = 0;
  const salaires = [];     // revenus revalorisés plafonnés, pour le SAM
  let points = 0;
  const ligneCourante = rows.find((r) => r.year === anneeCourante);

  for (const r of rows) {
    if (r.year >= anneeCourante) continue;
    trimAcquis += r.trimEff;
    salaires.push(r.revenuSam * coef(r.year));
    // Points Agirc-Arrco calculés sur les seuls salaires (hors indépendants)
    const brut = Math.min(r.salaire, 8 * parAnnee(PASS, r.year));
    const t1 = Math.min(brut, parAnnee(PASS, r.year)) * AGIRC.tauxT1;
    const t2 = Math.max(0, brut - parAnnee(PASS, r.year)) * AGIRC.tauxT2;
    points += ((t1 + t2) * coef(r.year)) / AGIRC.prixAchat;
  }

  let trimProj = 0;
  let pointsProj = 0;
  const projetes = [];
  for (let y = anneeCourante; y <= anneeDepart; y++) {
    const part = y < anneeDepart ? 1 : moisAvantDepart / 12;
    const donnees = y === anneeCourante && ligneCourante ? ligneCourante.revenuEff : 0;
    const donneesSam = y === anneeCourante && ligneCourante ? ligneCourante.revenuSam : 0;
    const revProj = continuer ? proj * part : 0;
    const rev = Math.max(donnees, revProj);
    const trim = Math.min(4, Math.floor(rev / (150 * smicRef)));
    trimProj += trim;
    const revSam = Math.min(Math.max(donneesSam, Math.min(revProj, passRef)), passRef);
    if (revSam > 0 || continuer) projetes.push(revSam);
    const salairePts = Math.min(rev, 8 * passRef);
    const t1 = Math.min(salairePts, passRef) * AGIRC.tauxT1;
    const t2 = Math.max(0, salairePts - passRef) * AGIRC.tauxT2;
    pointsProj += (t1 + t2) / AGIRC.prixAchat;
  }
  salaires.push(...projetes);

  const droitsEnfants = enfantsDroits(sexe, enfants);
  const trimTotal = trimAcquis + trimProj + droitsEnfants.trimestres + Number(trimestresAutres || 0);

  // Années retenues pour le SAM : 25, réduites pour le parent bénéficiant d'une majoration enfant
  // (24 avec un enfant, 23 avec deux et plus) pour les départs à compter du 1er septembre 2026.
  let nbAnneesSam = 25;
  const apres092026 = dateDepart >= new Date(2026, 8, 1);
  if (apres092026) {
    if (droitsEnfants.enfantsAvecMajoration >= 2) nbAnneesSam = 23;
    else if (droitsEnfants.enfantsAvecMajoration === 1) nbAnneesSam = 24;
  }
  const meilleures = [...salaires].sort((a, b) => b - a).slice(0, nbAnneesSam);
  const sam = meilleures.reduce((s, v) => s + v, 0) / nbAnneesSam;

  // Taux : décote / surcote
  const manqueDuree = Math.max(0, legal.trimestres - trimTotal);
  const manqueAge = Math.max(0, Math.ceil((DEFAUTS.agePleinAuto - ageDepartMois) / 3));
  const decoteTrim = Math.min(manqueDuree, manqueAge, 20);
  const surcoteTrim = Math.max(0, Math.min(trimTotal - legal.trimestres, Math.floor((ageDepartMois - legal.ageMois) / 3)));
  const prorata = Math.min(1, trimTotal / legal.trimestres);
  let taux = DEFAUTS.tauxBase - DEFAUTS.decoteParTrimestre * decoteTrim;
  let base = taux * sam * prorata;
  if (surcoteTrim > 0) base *= 1 + DEFAUTS.surcoteParTrimestre * surcoteTrim;
  const majoration3 = enfants.length >= 3 && elevesNeufAns;
  if (majoration3) base *= 1.1;

  // Complémentaire Agirc-Arrco (salariés) : points connus + points projetés
  const pointsTotal = pointsAgirc != null && pointsAgirc !== ''
    ? Number(pointsAgirc) + pointsProj
    : points + pointsProj;
  let compl = pointsTotal * AGIRC.valeurService;
  if (majoration3) compl *= 1.1;

  const brutAnnuel = base + compl + Number(pensionAutreAnnuelle || 0);
  return {
    ageDepartMois,
    dateDepart,
    trimestres: trimTotal,
    trimAcquis, trimProj,
    trimEnfants: droitsEnfants.trimestres,
    trimRequis: legal.trimestres,
    tauxPlein: trimTotal >= legal.trimestres || ageDepartMois >= DEFAUTS.agePleinAuto,
    decoteTrim, surcoteTrim,
    taux: r2(taux * 100) / 100,
    nbAnneesSam, sam: r2(sam),
    base: r2(base / 12), compl: r2(compl / 12),
    brutMensuel: r2(brutAnnuel / 12),
    netMensuel: r2((brutAnnuel / 12) * DEFAUTS.tauxNetSurBrut),
    tauxRemplacement: sam > 0 ? Math.round((brutAnnuel / sam) * 1000) / 10 : null,
    majoration3,
    points: Math.round(pointsTotal),
    revenuProjete: r2(proj),
  };
}

/** Tableau complet : un scénario par trimestre d'âge, de l'âge légal à 67 ans. */
export function scenarios(entree) {
  const legal = parametresLegaux(entree.naissance);
  const now = entree.now || new Date();
  const ageActuelMois = (now.getFullYear() - entree.naissance.getFullYear()) * 12 + (now.getMonth() - entree.naissance.getMonth());
  let debut = legal.ageMois;
  if (ageActuelMois > debut) debut = Math.ceil(ageActuelMois / 3) * 3;
  const out = [];
  for (let a = debut; a <= DEFAUTS.agePleinAuto; a += 3) out.push(estimer(entree, a));
  if (!out.length) out.push(estimer(entree, Math.max(ageActuelMois, legal.ageMois)));
  return out;
}

export function syntheseRetraite(entree) {
  const legal = parametresLegaux(entree.naissance);
  const liste = scenarios(entree);
  const legalEst = liste[0];
  const pleinTaux = liste.find((s) => s.trimestres >= s.trimRequis) || null;
  const auto67 = liste[liste.length - 1];
  return { legal, liste, legalEst, pleinTaux, auto67, droitsEnfants: enfantsDroits(entree.sexe, entree.enfants) };
}
