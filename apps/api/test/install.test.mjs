/**
 * Tests de l'installation d'une base vierge (db/install.mjs).
 *
 * C'est le chemin « --setup » de l'exécutable distribué : cluster,
 * migrations, socle RBAC, administrateur. S'exécutent contre la base
 * locale (npm run setup préalable) ; chaque étape y est idempotente, ce
 * qui est précisément la propriété exigée pour rejouer une installation
 * sur un poste déjà en service.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query, one, closePool } from '../src/core/db.mjs';
import { createAdmin, runInstall } from '../src/db/install.mjs';
import { ensureRbac } from '../src/db/rbac.mjs';

/*
 * Nom trié APRÈS tous les comptes de démonstration : /api/branding ne propose
 * que les 6 premiers comptes actifs (LIMIT 6), et la suite d'API itère dessus
 * en parallèle pour vérifier leurs connexions. Un compte de test qui y
 * apparaîtrait croiserait ces itérations (et leur verrouillage anti-force-
 * brute). « zz- » le place hors de la fenêtre.
 *
 * Le suffixe horodaté rend le nom UNIQUE PAR EXÉCUTION : la suite d'API
 * restaure la base depuis une sauvegarde pendant les tests, ce qui ressuscite
 * les lignes supprimées — un nom fixe finirait par exister avant
 * createAdmin et casserait l'assertion « created » sans aucune faute de code.
 */
const RUN_STAMP = Date.now();
const TEST_USER = `zz-e2e-${RUN_STAMP}`;
const TEST_PW = 'Clinique2026!';

// Nettoyage en début ET en fin de fichier : un plantage entre les deux ne
// doit pas laisser de résidu qui casserait l'exécution suivante.
before(async () => {
  await query(`DELETE FROM user_account WHERE username LIKE $1`, ['zz-e2e-%']);
});
after(async () => {
  await query(`DELETE FROM user_account WHERE username LIKE $1`, ['zz-e2e-%']);
  await closePool();
});

describe('createAdmin', () => {

  test('crée un superutilisateur portant le rôle ADMIN', async () => {
    const r = await createAdmin({ username: TEST_USER, password: TEST_PW });
    assert.equal(r.created, true);

    const u = await one(`SELECT is_superuser FROM user_account WHERE username = $1`, [TEST_USER]);
    assert.equal(u.is_superuser, true);
    const role = await one(
      `SELECT r.code FROM user_account ua
         JOIN user_role ur ON ur.user_id = ua.id
         JOIN role r ON r.id = ur.role_id
        WHERE ua.username = $1`, [TEST_USER]);
    assert.equal(role.code, 'ADMIN',
      'sans rôle, l\'administrateur reçoivait « Permission requise : patient.read »');
  });

  test('est idempotent : un second appel ne recrée rien', async () => {
    const r = await createAdmin({ username: TEST_USER, password: TEST_PW });
    assert.equal(r.created, false);
    const n = (await one(`SELECT count(*)::int AS n FROM user_account WHERE username = $1`, [TEST_USER])).n;
    assert.equal(n, 1);
  });

  test('refuse un mot de passe hors politique', async () => {
    await assert.rejects(
      () => createAdmin({ username: TEST_USER + '_2', password: 'court' }),
      /mot de passe/);
    await assert.rejects(
      () => createAdmin({ username: TEST_USER + '_2', password: 'aaaaaaaaaaaaaaaa' }),
      /mot de passe/);
  });

  test('refuse l\'absence de mot de passe', async () => {
    await assert.rejects(
      () => createAdmin({ username: TEST_USER + '_2' }),
      /manquant/);
  });
});

describe('runInstall', () => {

  test('rejoue l\'installation complète sur une base en service (tout est idempotent)', async () => {
    const r = await runInstall({ username: 'admin', password: TEST_PW });
    // Sur la base de test : 0 migration en attente, socle déjà appliqué,
    // administrateur existant. Aucun état n'est détérioré, tout l'ordre est
    // respecté (migrations -> RBAC -> administrateur).
    assert.equal(r.applied, 0);
    assert.equal(r.rbac.roles, 5);
    assert.equal(r.admin.created, false,
      'l\'administrateur de la base de test existe déjà');
  });

  test('le mot de passe lu dans un fichier temporaire est supprimé après usage', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clinirdv-install-'));
    try {
      const pwFile = join(dir, 'pw.tmp');
      writeFileSync(pwFile, TEST_PW + '\n', { mode: 0o600 });
      process.env.CLINIRDV_ADMIN_PASSWORD_FILE = pwFile;
      try {
        const r = await runInstall({ username: 'admin' });
        assert.equal(r.admin.created, false);
      } finally {
        delete process.env.CLINIRDV_ADMIN_PASSWORD_FILE;
      }
      const { existsSync } = await import('node:fs');
      assert.equal(existsSync(pwFile), false,
        'le fichier de mot de passe ne doit jamais survivre à l\'installation');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('le mot de passe absent partout est un échec explicite', async () => {
    await assert.rejects(
      () => runInstall({ username: TEST_USER + '_3' }),
      /mot de passe/);
  });
});

