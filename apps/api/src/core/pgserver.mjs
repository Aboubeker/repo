/**
 * Pilotage du cluster PostgreSQL embarqué.
 *
 * Un SEUL module connaît la mécanique initdb / pg_ctl, partagé entre :
 *   - scripts/db.mjs            (dépôt de développement),
 *   - l'exécutable distribué    (--db-start, --db-stop, --db-status, --setup).
 *
 * Le binaire est cherché dans cet ordre :
 *   1. CLINIRDV_PG_BIN          (imposé par l'exploitation ou le test),
 *   2. <racine>/pg/bin          (poste installé : l'installateur y dépose
 *                                les fichiers du paquet @embedded-postgres),
 *   3. node_modules/@embedded-postgres/<plateforme>-<arch>/native/bin
 *                                (dépôt, npm installe le paquet local).
 *
 * La configuration (port, utilisateur, mot de passe, dossier de données) est
 * lue à l'appel, pas à l'import : le .env est chargé en amont par
 * core/db.mjs, et un même processus peut servir plusieurs contextes.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { ROOT } from './root.mjs';

// Suffixe des binaires sous Windows (win32 -> .exe, autres plateformes -> '').
const EXE = process.platform === 'win32' ? '.exe' : '';

/** Cherche le dossier des binaires PostgreSQL ; null si introuvable. */
export function pgBinDir() {
  if (process.env.CLINIRDV_PG_BIN && existsSync(process.env.CLINIRDV_PG_BIN)) {
    return process.env.CLINIRDV_PG_BIN;
  }
  const installed = join(ROOT, 'pg', 'bin');
  if (existsSync(installed)) return installed;
  const platform = { linux: 'linux', darwin: 'darwin', win32: 'windows' }[process.platform];
  const arch = { x64: 'x64', arm64: 'arm64', ia32: 'ia32' }[process.arch];
  if (!platform || !arch) return null;
  const dev = resolve(ROOT, `node_modules/@embedded-postgres/${platform}-${arch}/native/bin`);
  return existsSync(dev) ? dev : null;
}

/** Configuration du cluster, lue à chaud (le .env a déjà été chargé). */
export function pgConfig() {
  const data = process.env.PGDATA || resolve(ROOT, '.pgdata');
  return {
    bin: pgBinDir(),
    data,
    port: process.env.PGPORT || '55432',
    user: process.env.PGUSER || 'clinirdv',
    password: process.env.PGPASSWORD || 'clinirdv',
    database: process.env.PGDATABASE || 'clinirdv',
    log: resolve(data, '..', '.pgdata.log'),
  };
}

/**
 * Exécute un utilitaire PostgreSQL.
 *
 * `detach: true` est indispensable pour « pg_ctl start » : le serveur lancé
 * hérite des tubes d'entrée/sortie du processus parent et ne les referme
 * jamais. Sous Windows, spawnSync attendrait donc indéfiniment la fin d'un
 * flux qui reste ouvert tant que PostgreSQL tourne. On coupe les tubes
 * (`ignore`) : la sortie du serveur part déjà dans le journal (« -l »).
 */
function run(binDir, cmd, args, { detach = false } = {}) {
  return spawnSync(resolve(binDir, cmd + EXE), args, {
    encoding: 'utf8',
    windowsHide: true,
    ...(detach ? { stdio: 'ignore' } : {}),
  });
}

/** 'running' | 'stopped' — jamais d'exception pour un simple état. */
export function pgStatus() {
  const cfg = pgConfig();
  if (!cfg.bin || !existsSync(cfg.data)) return 'stopped';
  const r = run(cfg.bin, 'pg_ctl', ['-D', cfg.data, 'status']);
  return r.status === 0 ? 'running' : 'stopped';
}

/** Crée le cluster s'il est absent (initdb). Idempotent. */
export function pgInit() {
  const cfg = pgConfig();
  if (!cfg.bin) throw new Error(
    'PostgreSQL embarqué introuvable. Vérifiez CLINIRDV_PG_BIN ou le dossier pg/ à côté de l\'exécutable.');
  if (existsSync(cfg.data)) {
    // Dossier VIDE : initdb qui se serait arrêté en cours de route. On le
    // retire pour qu'il recrée le cluster proprement ; un dossier contenant
    // déjà un cluster signifie que l'initialisation est faite.
    if (readdirSync(cfg.data).length > 0) return false;
    rmSync(cfg.data, { recursive: true });
  }
  // Le fichier de mot de passe est HORS du dossier du cluster : initdb exige
  // un dossier vide ou inexistant, un fichier déposé dedans ferait échouer
  // l'initialisation.
  const pwFile = resolve(cfg.data, '..', '.initdb-pwfile');
  writeFileSync(pwFile, cfg.password, { mode: 0o600 });
  const r = run(cfg.bin, 'initdb', [
    '-D', cfg.data, '-U', cfg.user, '--pwfile', pwFile,
    '--encoding=UTF8', '--locale=C', '-A', 'scram-sha-256',
  ]);
  rmSync(pwFile, { force: true });
  if (r.status !== 0) {
    throw new Error(`initdb a échoué : ${(r.stderr || r.stdout || '').trim().split('\n').pop()}`);
  }
  // Écoute uniquement en local (contrainte on-premise : jamais exposé au
  // réseau public), port fixé pour que l'application et le pilote se
  // retrouvent sans négociation.
  writeFileSync(join(cfg.data, 'postgresql.auto.conf'),
    `listen_addresses = '127.0.0.1'\nport = ${cfg.port}\nfsync = on\n`);
  return true;
}

/** Démarre le cluster (et l'initialise si besoin). Idempotent. */
export async function pgStart() {
  pgInit();
  const cfg = pgConfig();
  if (pgStatus() !== 'running') {
    const r = run(cfg.bin, 'pg_ctl',
      ['-D', cfg.data, '-l', cfg.log, '-w', '-o', `-p ${cfg.port}`, 'start'],
      { detach: true });
    if (r.status !== 0) {
      throw new Error(`PostgreSQL ne démarre pas (code ${r.status}). Consultez ${cfg.log}.`);
    }
  }
  await pgEnsureDatabase();
  return true;
}

/** Crée la base applicative si elle est absente. Idempotent. */
export async function pgEnsureDatabase() {
  const cfg = pgConfig();
  const client = new pg.Client({
    host: '127.0.0.1', port: Number(cfg.port), user: cfg.user,
    password: cfg.password, database: 'postgres',
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  try {
    const { rows } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [cfg.database]);
    if (!rows.length) {
      await client.query(`CREATE DATABASE ${cfg.database}`);
    }
  } finally {
    await client.end();
  }
}

/** Arrête proprement le cluster (pg_ctl stop fast). Idempotent. */
export function pgStop() {
  const cfg = pgConfig();
  if (!cfg.bin || !existsSync(cfg.data) || pgStatus() !== 'running') return false;
  const r = run(cfg.bin, 'pg_ctl', ['-D', cfg.data, '-w', '-m', 'fast', 'stop'],
    { stdio: 'inherit' });
  return r.status === 0;
}

/** Supprime puis recrée le cluster. Détruit les données — usage dev. */
export async function pgReset() {
  pgStop();
  const cfg = pgConfig();
  rmSync(cfg.data, { recursive: true, force: true });
  rmSync(cfg.log, { force: true });
  await pgStart();
  return true;
}
