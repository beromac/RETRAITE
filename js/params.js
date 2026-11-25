// Paramètres légaux et hypothèses de calcul.
// Sources vérifiées en novembre 2026 : LFSS 2026 (loi n° 2025-1403), Agirc-Arrco, Urssaf / Assurance retraite.
// Tout ce qui est approximatif est signalé « (approx.) » et reste modifiable.

/** SMIC horaire brut au 1er janvier de chaque année (sert à valider les trimestres : 150 h). */
export const SMIC_H = {
  2010: 8.86, 2011: 9.0, 2012: 9.22, 2013: 9.43, 2014: 9.53, 2015: 9.61, 2016: 9.67,
  2017: 9.76, 2018: 9.88, 2019: 10.03, 2020: 10.15, 2021: 10.25, 2022: 10.57,
  2023: 11.27, 2024: 11.65, 2025: 11.88, 2026: 12.02,
};

/** Plafond annuel de la Sécurité sociale (PASS). */
export const PASS = {
  2010: 34620, 2011: 35352, 2012: 36372, 2013: 37032, 2014: 37548, 2015: 38040, 2016: 38616,
  2017: 39228, 2018: 39732, 2019: 40524, 2020: 41136, 2021: 41136, 2022: 41136,
  2023: 43992, 2024: 46368, 2025: 47100, 2026: 48060,
};

/** Retraite complémentaire Agirc-Arrco (salariés du privé), valeurs 2026. */
export const AGIRC = {
  prixAchat: 20.1877,   // « salaire de référence » : coût d'achat d'un point
  valeurService: 1.4386, // valeur annuelle d'un point (gelée en 2025 et 2026)
  tauxT1: 0.062,        // taux d'acquisition des points, tranche 1 (jusqu'au PASS)
  tauxT2: 0.17,         // tranche 2 (de 1 à 8 PASS)
};

/**
 * Auto-entrepreneurs : part du chiffre d'affaires retenue comme « revenu cotisé » pour valider
 * les trimestres. Facteurs déduits des seuils publiés pour 2026 (approx.) : l'Urssaf calcule
 * en réalité à partir des cotisations payées. En cas de doute, saisir les trimestres de
 * l'attestation Urssaf directement dans l'onglet Carrière.
 */
export const ACTIVITES = {
  vente:    { label: 'Vente de marchandises / hébergement (BIC)', facteur: 0.2991 },
  services: { label: 'Prestations de services (BIC)',             facteur: 0.516 },
  bnc_ssi:  { label: 'Professions libérales BNC (SSI)',           facteur: 0.668 },
  bnc_cipav:{ label: 'Professions libérales réglementées (CIPAV)', facteur: 0.668, cipav: true },
};

/**
 * Périodes assimilées (régime général) : nombre de jours d'indemnisation pour valider 1 trimestre ; 4 trimestres par an au maximum,
 * tous statuts confondus. Sources : Assurance retraite, Unédic. Chômage non indemnisé et points Agirc-Arrco de maladie non modélisés.
 */
export const JOURS_PAR_TRIMESTRE = { maladie: 60, at: 60, invalidite: 90, maternite: 90, chomage: 50 };
export const NATURES_IJ = {
  maladie: 'Maladie',
  at: 'Accident du travail / maladie professionnelle',
  maternite: 'Maternité, paternité, adoption',
  invalidite: 'Pension d’invalidité',
};

export const DEFAUTS = {
  revalorisation: 0.02,     // hypothèse annuelle de revalorisation des salaires passés (approx.)
  tauxNetSurBrut: 0.91,     // pension nette avant impôt ≈ brut × 0,91 (CSG, CRDS, CASA ; approx.)
  agePleinAuto: 67 * 12,    // âge du taux plein automatique (en mois)
  decoteParTrimestre: 0.00625,
  surcoteParTrimestre: 0.0125,
  tauxBase: 0.5,
};

/** Valeur d'un barème pour une année ; au-delà du dernier connu on reste sur la dernière valeur. */
export function parAnnee(table, annee) {
  if (table[annee] !== undefined) return table[annee];
  const ys = Object.keys(table).map(Number).sort((a, b) => a - b);
  if (annee > ys[ys.length - 1]) return table[ys[ys.length - 1]];
  return table[ys[0]];
}

/**
 * Âge légal (en mois) et durée d'assurance requise pour le taux plein, selon la date de naissance.
 * Calendrier suspendu jusqu'au 1er janvier 2028 par la LFSS 2026 (génération 1964 à 1968).
 * Au-delà de 2028 la trajectoire de la réforme de 2023 doit reprendre : à surveiller.
 */
export function parametresLegaux(naissance) {
  const y = naissance.getFullYear();
  const m = naissance.getMonth() + 1;
  const avantSept1961 = y < 1961 || (y === 1961 && m < 9);
  if (avantSept1961) return { ageMois: 62 * 12, trimestres: 167, note: 'Génération antérieure à septembre 1961 : valeurs approximatives, vérifier sur info-retraite.fr.' };
  if (y === 1961) return { ageMois: 62 * 12 + 3, trimestres: 168 };
  if (y === 1962) return { ageMois: 62 * 12 + 6, trimestres: 169 };
  if (y === 1963) return { ageMois: 62 * 12 + 9, trimestres: 170 };
  if (y === 1964) return { ageMois: 62 * 12 + 9, trimestres: 170 };
  if (y === 1965) return m <= 3 ? { ageMois: 62 * 12 + 9, trimestres: 170 } : { ageMois: 63 * 12, trimestres: 171 };
  if (y === 1966) return { ageMois: 63 * 12 + 3, trimestres: 172 };
  if (y === 1967) return { ageMois: 63 * 12 + 6, trimestres: 172 };
  if (y === 1968) return { ageMois: 63 * 12 + 9, trimestres: 172 };
  return { ageMois: 64 * 12, trimestres: 172 };
}

export function formatAge(mois) {
  const a = Math.floor(mois / 12);
  const r = mois % 12;
  return r ? `${a} ans et ${r} mois` : `${a} ans`;
}
