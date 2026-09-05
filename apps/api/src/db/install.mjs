/**
 * Première vie d'une installation vierge (exécutable distribué, « --setup »).
 *
 * Déroulé, dans cet ordre :
 *   1. démarrage du cluster PostgreSQL embarqué (core/pgserver.mjs),
 *   2. application des migrations (7, infra/db),
 *   3. socle RBAC (23 permissions, 5 rôles) — AVANT la création de
 *      l'administrateur, sinon celui-ci n'aurait aucun rôle à porter,
 *   4. création du compte administrateur (superutilisateur + rôle ADMIN).
 *
 * Le mot de passe de l'administrateur n'est jamais passé en argument de
 * commande (visible dans la liste des processus) : l'installateur l'écrit
 * dans un fichier temporaire à droits restreints et signale son chemin par
 * CLINIRDV_ADMIN_PASSWORD_FILE, qui est supprimé dès l'usage — même si la
 * création échoue.
 */
import { readFileSync, unlinkSync } from 'node:fs';
import { pool } from '../core/db.mjs';
import { hashPassword, validatePasswordStrength } from '../core/auth.mjs';
import { runMigrations } from './migrate.mjs';
import { ensureRbac } from './rbac.mjs';
import { pgStart } from '../core/pgserver.mjs';

/**
 * Crée le compte administrateur d'amorçage.
 *
 * Superutilisateur : ses permissions sont le catalogue complet (voir
 * loadPermissions dans core/auth.mjs), donc les futures migrations qui
 * ajoutent des permissions l'incluent automatiquement.
 *
 * @param {object} params
 * @param {string} [params.username='admin']
 * @param {string} params.password — contrôlé par la politique (12 caractères,
 *   3 classes).
 * @param {string} [params.fullName='Administrateur']
 * @param {import('pg').PoolClient} [params.client] client de transaction.
 * @returns {Promise<{created:boolean, username:string}>}
 */
export async function createAdmin({
  username = 'admin', password, fullName = 'Administrateur', client,
} = {}) {
  if (!password) throw new Error('mot de passe de l\'administrateur manquant');
  const errors = validatePasswordStrength(password);
  if (errors.length) {
    throw new Error(`mot de passe administrateur refusé : ${errors.join(' ; ')}`);
  }

  const c = client || await pool.connect();
  const owned = !client;
  try {
    const existing = await c.query(
      `SELECT id FROM user_account WHERE username = $1 AND deleted_at IS NULL`,
      [username]);
    if (existing.rows.length) return { created: false, username };

    const u = (await c.query(
      `INSERT INTO user_account (username, full_name, password_hash, email, is_superuser)
       VALUES ($1,$2,$3,$4,true)
       RETURNING id`,
      [username, fullName, hashPassword(password), `${username}@clinique.local`]
    )).rows[0];

    const role = (await c.query(`SELECT id FROM role WHERE code = 'ADMIN'`)).rows[0];
    if (!role) throw new Error("rôle ADMIN absent : appelez d'abord ensureRbac()");
    await c.query(
      `INSERT INTO user_role (user_id, role_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [u.id, role.id]);

    return { created: true, username };
  } finally {
    if (owned) c.release();
  }
}

/**
 * Installation complète d'une base vierge.
 *
 * @param {object} params
 * @param {string} [params.username='admin']
 * @param {string} [params.password] mot de passe (privilégié : déjà en mémoire)
 * @param {string} [params.passwordFile] chemin du fichier temporaire ; le
 *   paramètre d'environnement CLINIRDV_ADMIN_PASSWORD_FILE est relu ici pour
 *   que l'exécutable n'ait rien d'autre à savoir.
 * @param {string} [params.fullName='Administrateur']
 */
export async function runInstall({
  username = 'admin', password, passwordFile, fullName,
} = {}) {
  let pw = password;
  const file = passwordFile || process.env.CLINIRDV_ADMIN_PASSWORD_FILE;
  if (!pw && file) {
    try {
      pw = readFileSync(file, 'utf8').trim();
    } catch (e) {
      throw new Error(`fichier de mot de passe illisible (${file}) : ${e.message}`);
    }
  }
  // Le fichier ne doit pas survivre à l'installation, ni à son échec.
  const cleanup = () => { if (file) unlinkSync(file, { force: true }); };

  try {
    if (!pw) throw new Error(
      "mot de passe administrateur manquant (CLINIRDV_ADMIN_PASSWORD_FILE)");

    await pgStart();
    const applied = await runMigrations();
    const rbac = await ensureRbac();
    const admin = await createAdmin({ username, password: pw, fullName });
    return { applied, rbac, admin };
  } finally {
    cleanup();
  }
}
