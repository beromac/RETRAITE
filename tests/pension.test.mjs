// Lancer : node tests/pension.test.mjs
import assert from 'node:assert/strict';
import { parametresLegaux } from '../js/params.js';
import { enfantsDroits, construireCarriere, estimer, scenarios } from '../js/pension.js';

let ok = 0;
const test = (nom, fn) => { fn(); ok++; console.log('  ok -', nom); };

test('âge légal et durée selon la génération (LFSS 2026)', () => {
  assert.deepEqual(parametresLegaux(new Date(1964, 5, 1)), { ageMois: 62 * 12 + 9, trimestres: 170 });
  assert.deepEqual(parametresLegaux(new Date(1965, 1, 1)), { ageMois: 62 * 12 + 9, trimestres: 170 });
  assert.deepEqual(parametresLegaux(new Date(1965, 6, 1)), { ageMois: 63 * 12, trimestres: 171 });
  assert.deepEqual(parametresLegaux(new Date(1966, 0, 1)), { ageMois: 63 * 12 + 3, trimestres: 172 });
  assert.deepEqual(parametresLegaux(new Date(1969, 0, 1)), { ageMois: 64 * 12, trimestres: 172 });
  assert.deepEqual(parametresLegaux(new Date(1985, 0, 1)), { ageMois: 64 * 12, trimestres: 172 });
});

test('trimestres enfants : mère, père, avant/après 2010', () => {
  assert.equal(enfantsDroits('F', [{ annee: 2005 }, { annee: 2008 }]).trimestres, 16);
  assert.equal(enfantsDroits('M', [{ annee: 2005 }, { annee: 2008 }]).trimestres, 0);
  assert.equal(enfantsDroits('F', [{ annee: 2012, edu: 'mere' }]).trimestres, 8);
  assert.equal(enfantsDroits('F', [{ annee: 2012, edu: 'pere' }]).trimestres, 6);
  assert.equal(enfantsDroits('M', [{ annee: 2012, edu: 'pere' }]).trimestres, 2);
  assert.equal(enfantsDroits('M', [{ annee: 2012, edu: 'mere' }]).trimestres, 0);
});

test('validation des trimestres : salaire et auto-entrepreneur', () => {
  const docs = [];
  for (let m = 1; m <= 12; m++) docs.push({ type: 'payslip', year: 2024, month: m, brut: 2000 });
  docs.push({ type: 'urssaf', year: 2025, ca: 12100, activite: 'services' });
  docs.push({ type: 'urssaf', year: 2026, ca: 24115, activite: 'vente' });
  const rows = construireCarriere(docs, {}, 2026);
  const r24 = rows.find((r) => r.year === 2024);
  const r25 = rows.find((r) => r.year === 2025);
  const r26 = rows.find((r) => r.year === 2026);
  assert.equal(r24.trimEff, 4);
  assert.equal(r24.mois, 12);
  assert.equal(r25.trimEff, 3); // 12100 × 0,516 = 6244 € ; 150 h SMIC 2025 = 1782 €
  assert.equal(r26.trimEff, 4); // seuil publié : 24 115 € de CA en vente pour 4 trimestres
});

test('trimestres Urssaf saisis : s\'ajoutent au salariat, plafonnés à 4', () => {
  // 2 trimestres de salarié (6 mois à 2 000 €) + 3 déclarés Urssaf = 4 (plafond)
  const docs = [];
  for (let m = 1; m <= 2; m++) docs.push({ type: 'payslip', year: 2022, month: m, brut: 2000 });
  const r = construireCarriere(docs, { 2022: { urssaf: 3 }, 2021: { urssaf: 3 } }, 2022);
  assert.equal(r.find((x) => x.year === 2022).trimEff, 4);
  const r21 = r.find((x) => x.year === 2021);
  assert.equal(r21.trimEff, 3);                 // aucun salaire, 3 trimestres Urssaf
  assert.ok(r21.revenuSam >= 3 * 150 * 10.25);  // revenu minimal cohérent pour le calcul du SAM
  assert.equal(r21.urssafSaisi, 3);
});

test('une correction manuelle remplace le calcul automatique', () => {
  const rows = construireCarriere([{ type: 'payslip', year: 2023, month: 1, brut: 100 }], { 2023: { trim: 3, revenu: 15000 } }, 2023);
  assert.equal(rows[0].trimEff, 3);
  assert.equal(rows[0].revenuEff, 15000);
});

test('carrière complète : taux plein sans décote ni surcote', () => {
  const rows = [];
  for (let y = 1995; y <= 2025; y++) rows.push({ year: y, salaire: 36000, revenuEff: 36000, revenuSam: Math.min(36000, 40000), trimEff: 4, mois: 12 });
  const entree = { sexe: 'M', naissance: new Date(1975, 5, 10), enfants: [], rows, now: new Date(2026, 10, 23), revalorisation: 0, continuer: true };
  const legal = parametresLegaux(entree.naissance); // 64 ans, 172 trimestres
  const e = estimer(entree, legal.ageMois);
  assert.ok(e.trimestres >= 172, `trimestres=${e.trimestres}`);
  assert.equal(e.decoteTrim, 0);
  assert.equal(e.taux, 0.5);
  assert.ok(Math.abs(e.sam - 36000) < 1);
  assert.ok(Math.abs(e.base - (0.5 * 36000) / 12) < 1, `base=${e.base}`);
  assert.ok(e.tauxPlein);
});

test('décote : départ à l\'âge légal avec une carrière incomplète', () => {
  const rows = [];
  for (let y = 2005; y <= 2025; y++) rows.push({ year: y, salaire: 30000, revenuEff: 30000, revenuSam: 30000, trimEff: 4, mois: 12 });
  const entree = { sexe: 'M', naissance: new Date(1975, 5, 10), enfants: [], rows, now: new Date(2026, 10, 23), revalorisation: 0, continuer: true };
  const legal = parametresLegaux(entree.naissance);
  const e = estimer(entree, legal.ageMois);
  assert.ok(e.trimestres < 172);
  assert.ok(e.decoteTrim > 0);
  assert.ok(e.taux < 0.5);
  const e67 = estimer(entree, 67 * 12);
  assert.equal(e67.decoteTrim, 0);
  assert.ok(e67.brutMensuel > e.brutMensuel);
});

test('les enfants augmentent la durée et la pension d\'une mère', () => {
  const rows = [];
  for (let y = 2000; y <= 2025; y++) rows.push({ year: y, salaire: 28000, revenuEff: 28000, revenuSam: 28000, trimEff: 4, mois: 12 });
  const base = { naissance: new Date(1978, 2, 1), rows, now: new Date(2026, 10, 23), revalorisation: 0, continuer: true };
  const sans = estimer({ ...base, sexe: 'F', enfants: [] }, 64 * 12);
  const avec = estimer({ ...base, sexe: 'F', enfants: [{ annee: 2005 }, { annee: 2008 }, { annee: 2011, edu: 'mere' }] }, 64 * 12);
  const pere = estimer({ ...base, sexe: 'M', enfants: [{ annee: 2005 }, { annee: 2008 }, { annee: 2011, edu: 'mere' }] }, 64 * 12);
  assert.equal(avec.trimEnfants, 24);
  assert.equal(avec.nbAnneesSam, 23);
  assert.equal(pere.trimEnfants, 0);
  assert.equal(pere.nbAnneesSam, 25);
  assert.ok(avec.majoration3 && pere.majoration3, 'la majoration de 10 % bénéficie aux deux parents');
  assert.ok(avec.brutMensuel > pere.brutMensuel);
  assert.ok(pere.brutMensuel > sans.brutMensuel);
});

test('scénarios : de l\'âge légal à 67 ans, pension croissante', () => {
  const rows = [];
  for (let y = 2000; y <= 2025; y++) rows.push({ year: y, salaire: 30000, revenuEff: 30000, revenuSam: 30000, trimEff: 4, mois: 12 });
  const liste = scenarios({ sexe: 'M', naissance: new Date(1980, 0, 1), enfants: [], rows, now: new Date(2026, 10, 23), revalorisation: 0, continuer: true });
  assert.equal(liste[0].ageDepartMois, 64 * 12);
  assert.equal(liste[liste.length - 1].ageDepartMois, 67 * 12);
  for (let i = 1; i < liste.length; i++) assert.ok(liste[i].brutMensuel >= liste[i - 1].brutMensuel - 0.01);
});

console.log(`\n${ok} tests réussis`);
