#!/usr/bin/env node
/**
 * Lanceur « tout-en-un » : vérifie les prérequis, démarre PostgreSQL si besoin,
 * lance le serveur applicatif et ouvre la page de connexion dans le navigateur.
 *
 *   npm run app
 *
 * Objectif : une seule commande, une fenêtre de connexion à l'écran.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, copyFileSync, writeFileSync,
         readdirSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const color = process.stdout.isTTY;
const c = (n, s) => (color ? `\x1b[${n}m${s}\x1b[0m` : s);
const bold = (s) => c(1, s);
const step = (m) => console.log(`${c(36, '▸')} ${m}`);
const ok = (m) => console.log(`  ${c(32, '✓')} ${m}`);
const die = (m, fix) => {
  console.error(`\n  ${c(31, '✗ ' + m)}`);
  if (fix) console.error(`  ${c(33, '→')} ${fix}`);
  console.error(`  ${c(90, 'Diagnostic détaillé : node scripts/doctor.mjs')}\n`);
  process.exit(1);
};

const node = process.execPath;
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/* ------------------------------------------------------------------ .env */
const envPath = resolve(ROOT, '.env');
if (!existsSync(envPath)) {
  const example = resolve(ROOT, '.env.example');
  if (!existsSync(example)) die('.env et .env.example sont absents.', 'Vérifiez que le dépôt est complet.');
  copyFileSync(example, envPath);
  const txt = readFileSync(envPath, 'utf8')
    .replace(/^JWT_SECRET=.*$/m, `JWT_SECRET=${randomBytes(48).toString('hex')}`);
  writeFileSync(envPath, txt, { encoding: 'utf8' });   // Node n'écrit jamais de BOM
  ok('.env créé avec un secret aléatoire');
}

// Réparation d'un .env porteur d'un BOM (écrit par une ancienne version du
// script PowerShell) : le BOM rend la première variable illisible.
const rawEnv = readFileSync(envPath);
if (rawEnv.length >= 3 && rawEnv[0] === 0xef && rawEnv[1] === 0xbb && rawEnv[2] === 0xbf) {
  writeFileSync(envPath, rawEnv.toString('utf8').replace(/^\uFEFF/, ''), { encoding: 'utf8' });
  ok('.env réparé (BOM UTF-8 supprimé)');
}

const env = {};
for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const PORT = Number(env.PORT || 3001);
const PGPORT = Number(env.PGPORT || 55432);

/* ----------------------------------------------------------- prérequis */
if (!existsSync(resolve(ROOT, 'node_modules')))
  die('Les dépendances ne sont pas installées.', 'npm install');

const probe = (port, timeout = 1200) => new Promise((res) => {
  const s = connect({ host: '127.0.0.1', port });
  const done = (v) => { s.destroy(); res(v); };
  s.setTimeout(timeout);
  s.on('connect', () => done(true));
  s.on('timeout', () => done(false));
  s.on('error', () => done(false));
});

/* -------------------------------------------------------- PostgreSQL */
step('Base de données');
if (await probe(PGPORT)) {
  ok(`PostgreSQL déjà en service sur le port ${PGPORT}`);
} else {
  const r = spawnSync(node, [resolve(ROOT, 'scripts/db.mjs'), 'start'],
    { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) die('PostgreSQL n\'a pas démarré.', 'Consultez .pgdata.log');
  if (!(await probe(PGPORT, 8000))) die(`PostgreSQL ne répond pas sur le port ${PGPORT}.`,
    'node scripts/db.mjs reset');
  ok('PostgreSQL démarré');
}

/* ------------------------------------------- schéma et jeu de données */
let needMigrate = false, needSeed = false;
try {
  const { default: pg } = await import('pg');
  const client = new pg.Client({
    host: '127.0.0.1', port: PGPORT, user: env.PGUSER, password: env.PGPASSWORD,
    database: env.PGDATABASE, connectionTimeoutMillis: 5000,
  });
  await client.connect();
  const { rows: [t] } = await client.query(
    `SELECT count(*)::int AS n FROM information_schema.tables
      WHERE table_schema='public' AND table_type='BASE TABLE'`);
  needMigrate = t.n === 0;
  if (!needMigrate) {
    const { rows: [u] } = await client.query('SELECT count(*)::int AS n FROM user_account')
      .catch(() => [{ n: 0 }]);
    needSeed = !u || u.n === 0;
  }
  await client.end();
} catch (e) {
  die(`Connexion à la base impossible : ${e.message}`,
      'node scripts/db.mjs reset && npm run migrate && npm run seed');
}

const runNpm = (script, label) => {
  step(label);
  const r = spawnSync(npmCmd, ['run', script], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) die(`Échec de « npm run ${script} ».`);
};
if (needMigrate) { runNpm('migrate', 'Application du schéma'); runNpm('seed', 'Chargement des données'); }
else if (needSeed) runNpm('seed', 'Chargement des données de démonstration');
else ok('Schéma et données en place');

/* -------------------------------------------------------- interface web */
/*
 * L'interface est recompilée si `dist` est absent OU périmé.
 *
 * Comparer la date du bundle à celle de la source la plus récente évite le
 * piège classique : après un `git pull`, `dist/index.html` existe toujours,
 * donc l'ancienne condition « si le fichier est absent » considérait
 * l'interface à jour et servait le bundle périmé. L'utilisateur voyait alors
 * l'ancienne version malgré une mise à jour réussie.
 */
const distIndex = resolve(ROOT, 'apps/web/dist/index.html');
const webSrc = resolve(ROOT, 'apps/web');

/** Date de modification la plus récente sous `apps/web/src` + config Vite. */
function newestSourceTime(dir) {
  let newest = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'dist' || e.name === 'node_modules') continue;
      const p = resolve(d, e.name);
      if (e.isDirectory()) walk(p);
      else newest = Math.max(newest, statSync(p).mtimeMs);
    }
  };
  try { walk(dir); } catch { return Infinity; }   // au moindre doute, on rebâtit
  return newest;
}

if (!existsSync(distIndex)) {
  runNpm('build:web', 'Compilation de l\'interface');
} else if (newestSourceTime(webSrc) > statSync(distIndex).mtimeMs) {
  runNpm('build:web', 'Interface périmée — recompilation');
} else {
  ok('Interface compilée');
}

/* ----------------------------------------------------- port disponible */
if (await probe(PORT))
  die(`Le port ${PORT} est déjà utilisé.`,
      `Une instance tourne peut-être déjà : ouvrez http://localhost:${PORT}\n` +
      `      Sinon, changez PORT dans .env.`);

/* ------------------------------------------------- serveur applicatif */
step('Démarrage du serveur');
const server = spawn(node, ['--env-file=.env', 'apps/api/src/main.mjs'],
  { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] });

server.on('exit', (code) => { if (code) process.exit(code); });

const stop = () => { server.kill('SIGTERM'); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

/* --------------------------- attente puis ouverture du navigateur */
const url = `http://localhost:${PORT}`;
const deadline = Date.now() + 30_000;
let up = false;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 400));
  if (server.exitCode !== null) process.exit(server.exitCode);
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2500) });
    if (res.ok) { up = true; break; }
  } catch { /* pas encore prêt */ }
}
if (!up) die('Le serveur n\'a pas répondu dans le délai imparti.');

const opener = { win32: ['cmd', ['/c', 'start', '', url]],
                 darwin: ['open', [url]] }[process.platform] || ['xdg-open', [url]];
try {
  const child = spawn(opener[0], opener[1], { stdio: 'ignore', detached: true });
  // spawn émet « error » de façon asynchrone : sans ce gestionnaire, l'absence
  // du navigateur (xdg-open sur un serveur sans bureau) ferait planter le
  // lanceur alors que l'application, elle, fonctionne parfaitement.
  child.on('error', () => {
    console.log(c(90, '  (ouverture automatique du navigateur impossible — ouvrez l\'adresse ci-dessous)'));
  });
  child.unref();
} catch { /* l'URL reste affichée ci-dessous */ }

console.log(`
  ${c(32, bold('CliniRDV est prêt.'))}

  ${bold('Page de connexion :')} ${bold(c(36, url))}

  ${bold('Comptes de démonstration')} — mot de passe ${bold('Clinique2026!')}
    admin      Administrateur (accès complet)
    s.amrani   Réceptionniste (agenda, file d'attente, encaissement)
    a.benali   Praticien (dossiers médicaux)
    c.compta   Facturation (factures, caisse)

  ${c(90, 'Ctrl+C pour arrêter le serveur.')}
`);
