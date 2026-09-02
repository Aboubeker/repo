/**
 * Sauvegarde et restauration locales.
 * Les archives sont écrites sur un volume local (ou un NAS monté) : aucun
 * transfert vers un service en ligne. Chaque exécution est tracée en base.
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { many, one, query } from '../core/db.mjs';
import { notFound, unprocessable } from '../core/errors.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const BACKUP_DIR = process.env.BACKUP_DIR || resolve(ROOT, 'storage/backups');
// Le paquet PostgreSQL embarqué dépend de la plateforme : le résoudre
// dynamiquement évite de chercher des binaires Linux sous Windows ou macOS.
const PG_PLATFORM = { linux: 'linux', darwin: 'darwin', win32: 'windows' }[process.platform];
const PG_ARCH = { x64: 'x64', arm64: 'arm64', ia32: 'ia32' }[process.arch];
const PG_BIN = resolve(ROOT, `node_modules/@embedded-postgres/${PG_PLATFORM}-${PG_ARCH}/native/bin`);
const EXE = process.platform === 'win32' ? '.exe' : '';

function pgTool(name) {
  const local = resolve(PG_BIN, name + EXE);
  return existsSync(local) ? local : name;   // repli sur le binaire système
}

export async function runBackup({ kind = 'MANUAL' } = {}) {
  mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = resolve(BACKUP_DIR, `clinirdv-${kind.toLowerCase()}-${stamp}.sql`);

  const run = await one(
    `INSERT INTO backup_run (kind, status, target_path) VALUES ($1,'RUNNING',$2) RETURNING *`,
    [kind, target]);

  try {
    await dumpDatabase(target);
    const size = statSync(target).size;
    const checksum = createHash('sha256').update(readFileSync(target)).digest('hex');
    return one(
      `UPDATE backup_run SET status='SUCCESS', finished_at=now(), size_bytes=$2, checksum=$3
        WHERE id=$1 RETURNING *`, [run.id, size, checksum]);
  } catch (err) {
    return one(
      `UPDATE backup_run SET status='FAILED', finished_at=now(), error=$2 WHERE id=$1 RETURNING *`,
      [run.id, err.message]);
  }
}

async function dumpDatabase(target) {
  // Voie privilégiée : pg_dump, s'il est présent sur le serveur.
  try {
    await pgDump(target);
    return;
  } catch (err) {
    if (!/ENOENT|indisponible/.test(err.message)) throw err;
  }
  // Repli intégré : export SQL natif, sans dépendance externe. Garantit qu'une
  // sauvegarde reste possible sur une machine dépourvue des outils clients.
  await nativeDump(target);
}

function pgDump(target) {
  return new Promise((res, rej) => {
    const child = spawn(pgTool('pg_dump'), [
      '-h', process.env.PGHOST || '127.0.0.1',
      '-p', String(process.env.PGPORT || 55432),
      '-U', process.env.PGUSER || 'clinirdv',
      '-d', process.env.PGDATABASE || 'clinirdv',
      '--clean', '--if-exists', '-f', target,
    ], { env: { ...process.env, PGPASSWORD: process.env.PGPASSWORD } });

    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => rej(new Error(`pg_dump indisponible (${e.message})`)));
    child.on('close', (code) => code === 0 ? res() : rej(new Error(stderr || `pg_dump code ${code}`)));
  });
}

/** Export SQL des données, dans un ordre respectant les dépendances. */
async function nativeDump(target) {
  const ORDER = [
    'role', 'permission', 'role_permission', 'specialty', 'room', 'equipment',
    'practitioner', 'practitioner_specialty', 'user_account', 'user_role',
    'tariff', 'appointment_type', 'availability_rule', 'absence', 'clinic_closure',
    'resource_unavailability', 'patient', 'patient_contact', 'patient_insurance',
    'medical_history_entry', 'consent', 'appointment', 'appointment_resource',
    'appointment_status_history', 'encounter', 'waiting_list_entry',
    'cash_session', 'invoice', 'invoice_line', 'payment',
    'notification_template', 'notification', 'app_setting', 'audit_log', 'backup_run',
  ];
  const out = [];
  out.push('-- CliniRDV — sauvegarde logique locale');
  out.push(`-- Générée le ${new Date().toISOString()}`);
  out.push('SET session_replication_role = replica;');
  out.push('BEGIN;');

  for (const table of ORDER) {
    const { rows: cols } = await query(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
          AND is_generated = 'NEVER'
        ORDER BY ordinal_position`, [table]);
    if (!cols.length) continue;
    const names = cols.map((c) => `"${c.column_name}"`).join(', ');
    const { rows } = await query(`SELECT ${names} FROM "${table}"`);
    out.push(`\n-- ${table} (${rows.length} lignes)`);
    out.push(`DELETE FROM "${table}";`);
    for (const row of rows) {
      const values = cols.map((c) => literal(row[c.column_name])).join(', ');
      out.push(`INSERT INTO "${table}" (${names}) VALUES (${values});`);
    }
  }

  // Repositionne les séquences pour éviter les collisions de clés après restauration
  const { rows: seqs } = await query(
    `SELECT sequencename FROM pg_sequences WHERE schemaname = 'public'`);
  for (const s of seqs) {
    const { rows: [v] } = await query(`SELECT last_value, is_called FROM "${s.sequencename}"`);
    out.push(`SELECT setval('${s.sequencename}', ${v.last_value}, ${v.is_called});`);
  }

  out.push('COMMIT;');
  out.push('SET session_replication_role = DEFAULT;');
  writeFileSync(target, out.join('\n'), 'utf8');
}

function literal(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof Date) return `'${v.toISOString()}'`;
  if (Array.isArray(v)) return `'{${v.map((x) => `"${String(x).replace(/"/g, '\\"')}"`).join(',')}}'`;
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

export async function listBackups() {
  return many('SELECT * FROM backup_run ORDER BY started_at DESC LIMIT 50');
}

/**
 * La restauration est une opération d'exploitation : elle nécessite l'arrêt de
 * l'application. L'API valide et prépare l'opération, puis renvoie la procédure
 * exacte à exécuter — elle ne remplace pas la base sous les utilisateurs connectés.
 */
export async function restoreBackup(id) {
  const run = await one('SELECT * FROM backup_run WHERE id = $1', [id]);
  if (!run) throw notFound('Sauvegarde introuvable.');
  if (run.status !== 'SUCCESS') throw unprocessable('Cette sauvegarde a échoué : restauration impossible.');
  if (!existsSync(run.target_path)) throw unprocessable('Fichier de sauvegarde absent du disque.');

  const actual = createHash('sha256').update(readFileSync(run.target_path)).digest('hex');
  if (run.checksum && actual !== run.checksum)
    throw unprocessable('Somme de contrôle invalide : la sauvegarde est corrompue.', 'CHECKSUM_MISMATCH');

  return {
    verified: true,
    checksum: actual,
    sizeBytes: run.size_bytes,
    path: run.target_path,
    /*
     * Marche à suivre, affichée telle quelle dans l'interface.
     *
     * Elle mentionnait « npm run stop », un script qui n'existe pas : la
     * procédure échouait dès la première ligne. L'arrêt se fait par Ctrl+C
     * dans la fenêtre du serveur.
     *
     * L'étape de sauvegarde préalable est délibérément la première : c'est le
     * seul moyen de revenir en arrière si l'archive restaurée ne contient pas
     * ce que l'on croyait.
     */
    procedure: [
      '1. Sauvegarder l\'état actuel (onglet Sauvegardes › Lancer une sauvegarde),',
      '   afin de pouvoir revenir en arrière si besoin.',
      '2. Arrêter l\'application : Ctrl+C dans la fenêtre du serveur.',
      '3. Vérifier que plus aucun poste n\'utilise l\'application.',
      `4. psql -h 127.0.0.1 -p ${process.env.PGPORT || 55432} -U ${process.env.PGUSER} ` +
        `-d ${process.env.PGDATABASE} -f "${run.target_path}"`,
      '5. Relancer l\'application : npm run app',
      '6. Contrôler le résultat : onglet Sauvegardes › Contrôle d\'intégrité.',
    ],
  };
}

/** Contrôles d'intégrité exécutés après restauration. */
export async function integrityCheck() {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  const orphans = await one(
    `SELECT count(*)::int AS n FROM appointment a
      WHERE NOT EXISTS (SELECT 1 FROM patient p WHERE p.id = a.patient_id)`);
  add('Aucun rendez-vous orphelin', orphans.n === 0, `${orphans.n} trouvé(s)`);

  const overlaps = await one(
    `SELECT count(*)::int AS n FROM appointment a1 JOIN appointment a2
        ON a1.practitioner_id = a2.practitioner_id AND a1.id < a2.id
       AND a1.blocked_period && a2.blocked_period
      WHERE a1.status IN ('SCHEDULED','CONFIRMED','CHECKED_IN','IN_PROGRESS')
        AND a2.status IN ('SCHEDULED','CONFIRMED','CHECKED_IN','IN_PROGRESS')`);
  add('Aucun double-booking praticien', overlaps.n === 0, `${overlaps.n} conflit(s)`);

  const badPayments = await one(
    `SELECT count(*)::int AS n FROM invoice i
      WHERE i.paid_amount <> (SELECT coalesce(sum(CASE WHEN is_refund THEN -amount ELSE amount END),0)
                                FROM payment p WHERE p.invoice_id = i.id)`);
  add('Cohérence factures / paiements', badPayments.n === 0, `${badPayments.n} écart(s)`);

  const gaps = await one(
    `SELECT count(*)::int AS n FROM invoice WHERE status <> 'DRAFT' AND number IS NULL`);
  add('Numérotation des factures complète', gaps.n === 0, `${gaps.n} sans numéro`);

  return { ok: checks.every((c) => c.ok), checks };
}
