#!/usr/bin/env node
/**
 * Contrôleur du serveur PostgreSQL local embarqué.
 * Aucune installation système requise : le binaire PostgreSQL est fourni avec
 * l'application, ce qui garantit un déploiement on-premise totalement autonome.
 *
 *   node scripts/db.mjs start | stop | status | reset
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = resolve(ROOT, 'node_modules/@embedded-postgres/linux-x64/native/bin');
const DATA = process.env.PGDATA || resolve(ROOT, '.pgdata');
const PORT = process.env.PGPORT || '55432';
const USER = process.env.PGUSER || 'clinirdv';
const PASSWORD = process.env.PGPASSWORD || 'clinirdv';
const DB = process.env.PGDATABASE || 'clinirdv';
const LOG = resolve(ROOT, '.pgdata.log');

function run(cmd, args, opts = {}) {
  const r = spawnSync(resolve(BIN, cmd), args, { encoding: 'utf8', ...opts });
  if (r.error) throw r.error;
  return r;
}

function isRunning() {
  return run('pg_ctl', ['-D', DATA, 'status']).status === 0;
}

function initCluster() {
  if (existsSync(DATA)) return;
  console.log('• Initialisation du cluster PostgreSQL local…');
  mkdirSync(DATA, { recursive: true });
  const pwFile = resolve(ROOT, '.pgpass.tmp');
  writeFileSync(pwFile, PASSWORD, { mode: 0o600 });
  const r = run('initdb', [
    '-D', DATA, '-U', USER, '--pwfile', pwFile,
    '--encoding=UTF8', '--locale=C', '-A', 'scram-sha-256',
  ]);
  rmSync(pwFile, { force: true });
  if (r.status !== 0) { console.error(r.stderr); process.exit(1); }
  // Écoute uniquement en local (contrainte on-premise : jamais exposé au réseau public)
  writeFileSync(resolve(DATA, 'postgresql.auto.conf'),
    `listen_addresses = '127.0.0.1'\nport = ${PORT}\nfsync = on\n`);
}

async function start() {
  initCluster();
  if (!isRunning()) {
    console.log(`• Démarrage de PostgreSQL sur 127.0.0.1:${PORT}…`);
    const r = run('pg_ctl', ['-D', DATA, '-l', LOG, '-w', '-o', `-p ${PORT}`, 'start']);
    if (r.status !== 0) { console.error(r.stdout, r.stderr); process.exit(1); }
  }
  await ensureDatabase();
  console.log('✓ PostgreSQL prêt.');
}

async function ensureDatabase() {
  const { default: pg } = await import('pg');
  const client = new pg.Client({
    host: '127.0.0.1', port: Number(PORT), user: USER,
    password: PASSWORD, database: 'postgres',
  });
  await client.connect();
  const { rows } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [DB]);
  if (!rows.length) {
    await client.query(`CREATE DATABASE ${DB}`);
    console.log(`• Base « ${DB} » créée.`);
  }
  await client.end();
}

function stop() {
  if (!existsSync(DATA) || !isRunning()) { console.log('• PostgreSQL est déjà arrêté.'); return; }
  run('pg_ctl', ['-D', DATA, '-w', '-m', 'fast', 'stop'], { stdio: 'inherit' });
  console.log('✓ PostgreSQL arrêté.');
}

async function reset() {
  stop();
  rmSync(DATA, { recursive: true, force: true });
  rmSync(LOG, { force: true });
  console.log('✓ Cluster supprimé.');
  await start();
}

const cmd = process.argv[2] || 'start';
if (cmd === 'start') await start();
else if (cmd === 'stop') stop();
else if (cmd === 'reset') await reset();
else if (cmd === 'status') console.log(isRunning() ? 'running' : 'stopped');
else { console.error('Usage: db.mjs start|stop|status|reset'); process.exit(1); }
