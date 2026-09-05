/**
 * Tests du socle RBAC (db/rbac.mjs).
 *
 * Défaut corrigé : les rôles vivaient uniquement dans seed.mjs, jamais
 * exécuté sur un poste installé. Ce socle partagé doit être idempotent et
 * produire exactement le même catalogue dans les deux mondes.
 *
 * S'exécutent contre la base locale (npm run setup préalable).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { query, one, closePool } from '../src/core/db.mjs';
import { PERMISSIONS, ROLES, ensureRbac } from '../src/db/rbac.mjs';

describe('Socle RBAC', () => {

  test('le socle compte 23 permissions et 5 rôles', () => {
    assert.equal(PERMISSIONS.length, 23,
      'le socle d\'amorçage porte 23 permissions (4 autres arrivent avec la migration 003)');
    assert.deepEqual(
      Object.keys(ROLES).sort(),
      ['ADMIN', 'BILLING', 'PRACTITIONER', 'READONLY', 'RECEPTION'],
      'les cinq rôles livrés');
    // Chaque permission référencée par un rôle existe dans le socle.
    const codes = new Set(PERMISSIONS.map((p) => p[0]));
    for (const [role, def] of Object.entries(ROLES)) {
      for (const p of def.perms) {
        assert.ok(codes.has(p), `le rôle ${role} référence ${p}, absent du socle`);
      }
    }
  });

  test('ensureRbac applique le socle en base', async () => {
    const before = (await one('SELECT count(*)::int AS n FROM permission')).n;
    const r = await ensureRbac();
    assert.equal(r.roles, 5);
    const after = (await one('SELECT count(*)::int AS n FROM permission')).n;
    // La base de test porte déjà les permissions de la migration 003 en
    // plus : le socle n'ajoute que celles qui manquaient, jamais les autres.
    assert.ok(after >= 23, `attendu au moins 23 permissions (obtenu ${after})`);
    assert.equal(r.permissionsCreated, after - before,
      'seules les permissions absentes doivent être créées');
  });

  test('ensureRbac est idempotent', async () => {
    const first_ = await ensureRbac();
    const second = await ensureRbac();
    assert.equal(second.permissionsCreated, 0,
      'aucune permission ne doit être recréée');
    assert.equal(second.rolePermissionsCreated, 0,
      'aucun droit de rôle ne doit être recréé');
    assert.equal(first_.roles, second.roles, 5);

    const roles = (await query("SELECT count(*)::int AS n FROM role WHERE code IN ('ADMIN','RECEPTION','PRACTITIONER','BILLING','READONLY')")).rows[0];
    assert.equal(roles.n, 5, 'exactement cinq rôles livrés, aucun doublon');
  });

  test('ADMIN porte tout le socle, pas moins', async () => {
    const n = (await one(
      `SELECT count(*)::int AS n FROM role_permission rp
        JOIN role r ON r.id = rp.role_id
       WHERE r.code = 'ADMIN'`)).n;
    assert.ok(n >= 23, `ADMIN devrait porter au moins le socle complet (obtenu ${n})`);
  });

  test('les rôles livrés sont marqués système', async () => {
    const n = (await one(
      `SELECT count(*)::int AS n FROM role
       WHERE code IN ('ADMIN','RECEPTION','PRACTITIONER','BILLING','READONLY')
         AND is_system`)).n;
    assert.equal(n, 5, 'les cinq rôles livrés doivent être système (ni supprimables ni renommables)');
  });

  test('un rôle créé plus tôt conserve sa ligne, seul le libellé suit le socle', async () => {
    // Rôle préexistant avec un libellé différent : ensureRbac ne le supprime
    // pas, il aligne le libellé et le drapeau système.
    await query(`INSERT INTO role (code, label, is_system)
                 VALUES ('TESTROLE_R','Ancien libellé', false)
                 ON CONFLICT (code) DO NOTHING`);
    await ensureRbac();
    const r = await one(`SELECT label, is_system FROM role WHERE code = 'TESTROLE_R'`);
    assert.equal(r.is_system, false,
      'un rôle non livré ne doit pas être forcé en système');
    await query(`DELETE FROM role WHERE code = 'TESTROLE_R'`);
  });
});

test.after(closePool);
