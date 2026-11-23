import assert from 'node:assert/strict';
import { extraireEmployeur, analyserTexte, regrouperPages } from '../js/extract.js';
let ok = 0; const test = (n, f) => { f(); ok++; console.log('  ok -', n); };

test('champ « Employeur »', () => {
  assert.equal(extraireEmployeur('BULLETIN DE PAIE Employeur : Boulangerie Martin SIRET 123 45678900012 APE 1071C'), 'Boulangerie Martin');
  assert.equal(extraireEmployeur('Raison sociale : Garage Dupont & Fils  N° SIRET 12345678900012'), 'Garage Dupont & Fils');
});
test('forme juridique', () => {
  assert.equal(extraireEmployeur('Bulletin de paie SAS LOGISTIQUE DU NORD 12 rue des Lilas 59000 LILLE'), 'SAS LOGISTIQUE DU NORD');
  assert.equal(extraireEmployeur('ACME FRANCE SARL 10 avenue Foch 75016 Paris'), 'ACME FRANCE SARL');
});
test('nom placé avant le SIRET', () => {
  assert.equal(extraireEmployeur('Bulletin de paie MAIRIE DE LYON SIRET 21690123400017'), 'MAIRIE DE LYON');
});
test('employeur connu : orthographe conservée', () => {
  assert.equal(extraireEmployeur('bulletin de paie  société generale SA agence', ['Société Générale']), 'Société Générale');
  assert.equal(extraireEmployeur('Employeur : DUPONT SAS SIRET 123', ['Dupont SAS']), 'Dupont SAS');
});
test('aucun employeur inventé', () => {
  assert.equal(extraireEmployeur('Net à payer 1 900,00 salaire brut 2 450,00'), '');
});
test('analyserTexte : employeur seulement pour les bulletins', () => {
  const a = analyserTexte('Bulletin de paie Période du 01/10/2025 au 31/10/2025 Employeur : Café Lune SIRET 1 Salaire brut 2 450,50 Net à payer 1 900,00');
  assert.equal(a.type, 'payslip'); assert.equal(a.employer, 'Café Lune'); assert.equal(a.year, 2025); assert.equal(a.month, 10);
  const u = analyserTexte('URSSAF déclaration de chiffre d’affaires micro-entrepreneur 1er trimestre 2025 chiffre d’affaires 12 100');
  assert.equal(u.employer, '');
});
test('découpage auto d’un PDF de plusieurs bulletins', () => {
  const p = (m, extra = '') => `Bulletin de paie Période du 01/${m}/2020 au 28/${m}/2020 ${extra}`;
  const pages = [p('01'), 'suite détail cotisations', p('02'), p('03'), 'suite'];
  assert.deepEqual(regrouperPages(pages, 'auto'), [[0, 1], [2], [3, 4]]);
  assert.deepEqual(regrouperPages(pages, 'page'), [[0], [1], [2], [3], [4]]);
  assert.deepEqual(regrouperPages(pages, 'n:2'), [[0, 1], [2, 3], [4]]);
  assert.deepEqual(regrouperPages(pages, 'tout'), [[0, 1, 2, 3, 4]]);
  assert.deepEqual(regrouperPages(['a', 'b'], 'auto'), [[0], [1]]);
});

// Mise en page à colonnes (lignes reconstituées d'après les coordonnées), données fictives.
const BULLETIN_COLONNES = [
  '                                                  BULLETIN DE PAIE',
  '                                                  01/09/2021 au 30/09/2021',
  '                          EMPLOYEUR                             DOSSIER/SALARIE                  EMPLOI',
  '                                                                DUPONT/MARIE/N1/0/0              Opticien',
  ' SAS EXEMPLE OPTIQUE',
  '                                                                N° SECURITE SOCIALE              QUALIFICATION',
  ' Route des Tilleuls',
  '                                                                2 80 01 00 000 000 00            Coeff 220',
  ' 64000 PAU',
  ' Siret / Ape :   SALARIE',
  'Salaire de base   78,00   23,0000   1 794,00',
  'Prime sur ventes   50,00',
  'TOTAL BRUT   78,00   1 844,00',
  'NET A PAYER AVANT IMPOT SUR LE REVENU   1 416,72',
  'Dont évolution de la rémunération liée à la suppression des cotisations   27,20',
  '                                                       NET A PAYER   1 416,72 €',
].join('\n');

test('bulletin à colonnes : période, employeur de la colonne de gauche, brut et net en fin de ligne', () => {
  const a = analyserTexte(BULLETIN_COLONNES, 'x.pdf', []);
  assert.deepEqual({ type: a.type, year: a.year, month: a.month, brut: a.brut, net: a.net, employer: a.employer },
    { type: 'payslip', year: 2021, month: 9, brut: 1844, net: 1416.72, employer: 'SAS EXEMPLE OPTIQUE' });
});

console.log(`\n${ok} tests réussis`);
