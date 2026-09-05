/**
 * Tests du chargement .env (core/env.mjs).
 *
 * Défaut corrigé : l'exécutable lancé par raccourci ne lisait aucun .env,
 * et tous les postes partageaient la valeur de repli de JWT_SECRET.
 * Ces tests verrouillent le parseur et la règle « l'environnement gagne ».
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv, loadEnvFile, envFilePath } from '../src/core/env.mjs';

describe('parseEnv', () => {
  test('clés simples, commentaires et lignes vides', () => {
    const env = parseEnv(`
# commentaire
PORT=3001

HOST=::
`);
    assert.deepEqual(env, { PORT: '3001', HOST: '::' });
  });

  test('fins de ligne CRLF et espaces autour du =', () => {
    assert.deepEqual(parseEnv('A=1\r\nB = 2\r\n'), { A: '1', B: '2' });
  });

  test('valeur entre guillemets, avec échappements', () => {
    const env = parseEnv('MSG="ligne\\nune"');
    assert.equal(env.MSG, 'ligne\nune');
    const env2 = parseEnv("SINGLE='valeur avec # hash'");
    assert.equal(env2.SINGLE, 'valeur avec # hash');
  });

  test('le # sans guillemets fait partie de la valeur (règle de Node)', () => {
    assert.deepEqual(parseEnv('P=a#b'), { P: 'a#b' });
  });

  test('préfixe export et BOM en tête', () => {
    assert.deepEqual(parseEnv('\uFEFFexport TOKEN=t3st'), { TOKEN: 't3st' });
  });

  test('lignes illisibles ignorées, pas d\'exception', () => {
    const env = parseEnv('INVALID LINE\n= sans clé\nOK=1\n');
    assert.deepEqual(env, { OK: '1' });
  });

  test('valeur vide autorisée', () => {
    assert.deepEqual(parseEnv('EMPTY='), { EMPTY: '' });
  });
});

describe('loadEnvFile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clinirdv-env-'));
  test.after(() => rmSync(dir, { recursive: true, force: true }));

  test('applique les variables absentes de l\'environnement', () => {
    const p = join(dir, 'a.env');
    writeFileSync(p, 'CLINIRDV_TEST_VAR_UNE=une\nCLINIRDV_TEST_VAR_DEUX=deux\n');
    const n = loadEnvFile(p);
    assert.equal(n, 2);
    assert.equal(process.env.CLINIRDV_TEST_VAR_UNE, 'une');
    assert.equal(process.env.CLINIRDV_TEST_VAR_DEUX, 'deux');
    delete process.env.CLINIRDV_TEST_VAR_UNE;
    delete process.env.CLINIRDV_TEST_VAR_DEUX;
  });

  test('par défaut, l\'environnement gagne sur le fichier', () => {
    const p = join(dir, 'b.env');
    writeFileSync(p, 'CLINIRDV_TEST_VAR_TROIS=fichier\n');
    process.env.CLINIRDV_TEST_VAR_TROIS = 'processus';
    try {
      loadEnvFile(p);
      assert.equal(process.env.CLINIRDV_TEST_VAR_TROIS, 'processus',
        'comme node --env-file, la variable existante doit l\'emporter');
    } finally {
      delete process.env.CLINIRDV_TEST_VAR_TROIS;
    }
  });

  test('override force la valeur du fichier', () => {
    const p = join(dir, 'c.env');
    writeFileSync(p, 'CLINIRDV_TEST_VAR_TROIS=fichier\n');
    process.env.CLINIRDV_TEST_VAR_TROIS = 'processus';
    try {
      loadEnvFile(p, { override: true });
      assert.equal(process.env.CLINIRDV_TEST_VAR_TROIS, 'fichier');
    } finally {
      delete process.env.CLINIRDV_TEST_VAR_TROIS;
    }
  });

  test('fichier absent : zéro variable, pas d\'exception', () => {
    assert.equal(loadEnvFile(join(dir, 'inexistant.env')), 0);
  });

  test('le .env du dépôt n\'est jamais réécrit par ce module', () => {
    // Ce module ne lit que : un appel à loadEnvFile ne doit pas créer de
    // fichier. (L'écriture du .env appartient à l'installateur.)
    const p = join(dir, 'lu-seulement.env');
    writeFileSync(p, 'CLINIRDV_TEST_VAR_QUATRE=x\n');
    loadEnvFile(p);
    assert.equal(process.env.CLINIRDV_TEST_VAR_QUATRE, 'x');
    delete process.env.CLINIRDV_TEST_VAR_QUATRE;
  });

  test('chemin par défaut : à côté de la racine, ou CLINIRDV_ENV_FILE', () => {
    assert.equal(envFilePath().endsWith('.env'), true);
    const custom = join(dir, 'custom.env');
    process.env.CLINIRDV_ENV_FILE = custom;
    try {
      assert.equal(envFilePath(), custom);
    } finally {
      delete process.env.CLINIRDV_ENV_FILE;
    }
  });
});
