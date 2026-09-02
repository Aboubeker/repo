/**
 * Adaptation au contexte algérien — règles vérifiables.
 *
 * Ces tests portent sur des règles fixées par la réglementation (droit de
 * timbre, format du NIN, week-end légal) et non sur des choix d'interface.
 * Une régression ici produirait des documents non conformes, pas seulement
 * un affichage discutable.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// locale.js est du JavaScript pur sans dépendance navigateur : importable tel
// quel par Node. pathToFileURL est indispensable pour que le chemin Windows
// (C:\...) soit accepté par import() — voir platform.test.mjs.
const locale = await import(pathToFileURL(join(ROOT, 'apps/web/src/locale.js')).href);

describe('Droit de timbre (art. 100 du code du timbre)', () => {
  test('ne s\'applique qu\'aux règlements en espèces', () => {
    assert.equal(locale.stampDuty(10_000, 'CARD'), 0);
    assert.equal(locale.stampDuty(10_000, 'TRANSFER'), 0);
    assert.equal(locale.stampDuty(10_000, 'INSURANCE'), 0);
    assert.ok(locale.stampDuty(10_000, 'CASH') > 0);
  });

  test('1 DA par tranche de 100 DA entamée', () => {
    assert.equal(locale.stampDuty(1000, 'CASH'), 10);
    // 1001 DA = 11 tranches entamées, pas 10.
    assert.equal(locale.stampDuty(1001, 'CASH'), 11);
    assert.equal(locale.stampDuty(3000, 'CASH'), 30);
  });

  test('plancher de 5 DA et exonération en dessous de 20 DA', () => {
    assert.equal(locale.stampDuty(15, 'CASH'), 0, 'exonéré jusqu\'à 20 DA');
    assert.equal(locale.stampDuty(400, 'CASH'), 5, 'plancher de 5 DA');
  });

  test('plafond de 2 500 DA', () => {
    assert.equal(locale.stampDuty(1_000_000, 'CASH'), 2500);
    assert.equal(locale.stampDuty(50_000_000, 'CASH'), 2500);
  });
});

describe('Numéro d\'identification national (NIN)', () => {
  test('accepte exactement 18 chiffres', () => {
    assert.equal(locale.validateNIN('123456789012345678').valid, true);
  });
  test('refuse une longueur incorrecte', () => {
    assert.equal(locale.validateNIN('12345').valid, false);
    assert.equal(locale.validateNIN('1234567890123456789').valid, false);
  });
  test('refuse les caractères non numériques', () => {
    assert.equal(locale.validateNIN('12345678901234567A').valid, false);
  });
  test('un NIN vide reste acceptable (champ facultatif)', () => {
    assert.equal(locale.validateNIN('').valid, true);
    assert.equal(locale.validateNIN(null).valid, true);
  });
});

describe('Téléphone algérien', () => {
  test('accepte les mobiles 05 / 06 / 07', () => {
    for (const n of ['0555123456', '0661234567', '0770123456']) {
      assert.equal(locale.validatePhone(n).valid, true, n);
    }
  });
  test('accepte le format international +213', () => {
    const r = locale.validatePhone('+213555123456');
    assert.equal(r.valid, true);
    assert.equal(r.value, '0555123456', 'normalisé en format national');
  });
  test('accepte les fixes à indicatif de wilaya', () => {
    assert.equal(locale.validatePhone('021234567').valid, true);
  });
  test('refuse un numéro trop court ou à préfixe inconnu', () => {
    assert.equal(locale.validatePhone('0812345678').valid, false);
    assert.equal(locale.validatePhone('055512').valid, false);
  });
});

describe('Semaine ouvrable', () => {
  test('le week-end légal est vendredi et samedi', () => {
    assert.deepEqual(locale.WEEKEND_DAYS, [5, 6]);
  });
  test('le dimanche est un jour ouvré', () => {
    // 2026-09-06 est un dimanche.
    assert.equal(locale.isWeekend('2026-09-06T09:00:00'), false);
    assert.equal(locale.isoDay('2026-09-06T09:00:00'), 7);
  });
  test('le vendredi est chômé', () => {
    // 2026-09-04 est un vendredi.
    assert.equal(locale.isWeekend('2026-09-04T09:00:00'), true);
  });
  test('la semaine commence le dimanche', () => {
    const start = locale.startOfWeekDZ(new Date('2026-09-02T12:00:00')); // mercredi
    assert.equal(start.getDay(), 0, 'dimanche');
  });
});

describe('Monnaie', () => {
  test('les montants sont libellés en dinars, sans décimale', () => {
    const s = locale.fmtMoney(3500);
    assert.ok(/3\s?500/.test(s), `montant illisible : ${s}`);
    assert.ok(!s.includes(','), 'pas de décimale sur un prix de consultation');
    assert.ok(!/€/.test(s), 'aucune trace d\'euro');
  });
  test('montant en toutes lettres pour les quittances', () => {
    assert.equal(locale.amountToWords(0), 'zéro dinar algérien');
    assert.match(locale.amountToWords(3500), /trois mille cinq cents dinars/);
    assert.match(locale.amountToWords(1500), /mille cinq cents/);
    assert.match(locale.amountToWords(21), /vingt et un/);
    assert.match(locale.amountToWords(80), /quatre-vingts/);
  });
});

describe('Découpage administratif', () => {
  test('les 58 wilayas sont présentes', () => {
    assert.equal(locale.WILAYAS.length, 58);
    assert.ok(locale.WILAYAS.some((w) => w.includes('Alger')));
    assert.ok(locale.WILAYAS.some((w) => w.includes('El Meniaa')),
      'les 10 wilayas créées en 2019 doivent figurer');
  });
});

describe('Absence de références à l\'euro et au calendrier européen', () => {
  const read = (p) => readFileSync(join(ROOT, p), 'utf8');

  test('aucun formatage en euros dans le front', () => {
    for (const f of ['apps/web/src/lib.jsx', 'apps/web/src/locale.js']) {
      assert.ok(!/currency:\s*'EUR'/.test(read(f)), `${f} référence encore l'euro`);
    }
  });

  test('le seed ne code plus la semaine européenne', () => {
    const seed = read('apps/api/src/db/seed.mjs');
    assert.ok(!/if \(dow > 5\) continue/.test(seed),
      'le seed considère encore samedi-dimanche comme le week-end');
    assert.ok(/Africa\/Algiers/.test(seed), 'fuseau horaire non localisé');
  });
});
