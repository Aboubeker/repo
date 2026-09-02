#!/usr/bin/env node
/**
 * Diagnostic complet de l'installation locale.
 *
 *   node scripts/doctor.mjs
 *
 * Vérifie chaque maillon de la chaîne (configuration, base de données, schéma,
 * interface compilée, port applicatif) et affiche pour chaque échec la cause
 * probable et la commande de correction. N'effectue aucune modification.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const color = process.stdout.isTTY;
const c = (n, s) => (color ? `\x1b[${n}m${s}\x1b[0m` : s);
const bold = (s) => c(1, s);

let failures = 0;
let warnings = 0;

const ok   = (m, d) => console.log(`  ${c(32, '✓')} ${m}${d ? c(90, `  ${d}`) : ''}`);
const bad  = (m, fix) => { failures++; console.log(`  ${c(31, '✗')} ${bold(m)}`);
                           if (fix) fix.split('\n').forEach((l) => console.log(`      ${c(33, '→')} ${l}`)); };
const warn = (m, d) => { warnings++; console.log(`  ${c(33, '!')} ${m}${d ? c(90, `  ${d}`) : ''}`); };
const head = (m) => console.log(`\n${c(36, bold('▸ ' + m))}`);

/** Lit .env sans dépendance externe, en signalant les pièges d'encodage. */
function readEnvFile() {
  const p = resolve(ROOT, '.env');
  if (!existsSync(p)) return { missing: true, vars: {} };
  const raw = readFileSync(p);
  const hasBom = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
  const text = raw.toString('utf8').replace(/^\uFEFF/, '');
  const vars = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m) vars[m[1]] = m[2].trim();
  }
  return { missing: false, hasBom, vars, path: p };
}

/** Teste si un port TCP accepte une connexion sur 127.0.0.1. */
const probePort = (port, timeout = 1500) => new Promise((res) => {
  const s = connect({ host: '127.0.0.1', port });
  const done = (v) => { s.destroy(); res(v); };
  s.setTimeout(timeout);
  s.on('connect', () => done(true));
  s.on('timeout', () => done(false));
  s.on('error', () => done(false));
});

/** Vérifie qu'un port est libre pour l'écoute sur l'interface demandée. */
const canListen = (port, host) => new Promise((res) => {
  const srv = createServer();
  srv.on('error', (e) => res({ ok: false, code: e.code }));
  srv.listen(port, host, () => srv.close(() => res({ ok: true })));
});

console.log(bold('\n  CliniRDV — diagnostic de l\'installation locale'));
console.log(c(90, `  ${process.platform}/${process.arch} · Node ${process.version} · ${ROOT}`));

/* ------------------------------------------------------------ 1. Node.js */
head('Environnement');
const major = Number(process.versions.node.split('.')[0]);
if (major >= 20) ok(`Node.js ${process.version}`);
else bad(`Node.js ${process.version} trop ancien (minimum v20)`,
         'Installez Node.js 20+ depuis https://nodejs.org');

/* ------------------------------------------------------- 2. dépendances */
if (existsSync(resolve(ROOT, 'node_modules'))) ok('Dépendances npm installées');
else bad('node_modules absent', 'npm install');

const platform = { linux: 'linux', darwin: 'darwin', win32: 'windows' }[process.platform];
const arch = { x64: 'x64', arm64: 'arm64' }[process.arch];
const pgPkg = `node_modules/@embedded-postgres/${platform}-${arch}`;
if (existsSync(resolve(ROOT, pgPkg))) ok('PostgreSQL embarqué présent', pgPkg);
else bad(`PostgreSQL embarqué absent pour ${platform}-${arch}`,
         'npm install\nSi le problème persiste : rm -rf node_modules puis npm install');

/* ---------------------------------------------------------------- 3. .env */
head('Configuration (.env)');
const env = readEnvFile();
if (env.missing) {
  bad('.env introuvable',
      'Windows :  Copy-Item .env.example .env\nLinux/macOS :  cp .env.example .env');
} else {
  if (env.hasBom) {
    bad('.env commence par un BOM UTF-8 — la première variable est illisible',
        'Windows :  Remove-Item .env ; .\\install.ps1\nCela corrompt NODE_ENV et peut empêcher le démarrage.');
  } else ok('.env présent et correctement encodé');

  for (const k of ['PORT', 'PGPORT', 'PGUSER', 'PGDATABASE', 'JWT_SECRET']) {
    if (!env.vars[k]) bad(`Variable ${k} absente de .env`, 'Régénérez le fichier depuis .env.example');
  }
  if (env.vars.JWT_SECRET === 'change-me')
    warn('JWT_SECRET vaut encore « change-me »', 'à changer avant toute mise en production');
  if (env.vars.HOST && !['0.0.0.0', '127.0.0.1', 'localhost', '::'].includes(env.vars.HOST))
    warn(`HOST=${env.vars.HOST} est inhabituel`, 'utilisez 127.0.0.1 pour un poste isolé');
}

const PORT = Number(env.vars.PORT || 3001);
const PGPORT = Number(env.vars.PGPORT || 55432);
const HOST = env.vars.HOST || '0.0.0.0';

/* ---------------------------------------------------- 4. base de données */
head('Base de données PostgreSQL');
const dataDir = resolve(ROOT, '.pgdata');
if (!existsSync(dataDir)) {
  bad('Cluster PostgreSQL non initialisé (.pgdata absent)', 'node scripts/db.mjs start');
} else {
  ok('Cluster présent', '.pgdata');
  const pgUp = await probePort(PGPORT);
  if (pgUp) {
    ok(`PostgreSQL répond sur 127.0.0.1:${PGPORT}`);

    // Connexion applicative réelle : valide aussi l'authentification.
    try {
      const { default: pg } = await import('pg');
      const client = new pg.Client({
        host: '127.0.0.1', port: PGPORT,
        user: env.vars.PGUSER, password: env.vars.PGPASSWORD,
        database: env.vars.PGDATABASE, connectionTimeoutMillis: 4000,
      });
      await client.connect();
      ok(`Connexion à la base « ${env.vars.PGDATABASE} » réussie`);

      const { rows: [t] } = await client.query(
        `SELECT count(*)::int AS n FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`);
      if (t.n === 0) bad('Aucune table : le schéma n\'est pas appliqué', 'npm run migrate');
      else ok(`Schéma appliqué`, `${t.n} tables`);

      try {
        const { rows: [u] } = await client.query('SELECT count(*)::int AS n FROM user_account');
        if (u.n === 0) bad('Aucun compte utilisateur : impossible de se connecter', 'npm run seed');
        else ok('Comptes utilisateurs présents', `${u.n} comptes · mot de passe : Clinique2026!`);
      } catch { bad('Table user_account absente', 'npm run migrate && npm run seed'); }

      await client.end();
    } catch (e) {
      bad(`Connexion à la base refusée : ${e.message}`,
          'Vérifiez PGUSER / PGPASSWORD / PGDATABASE dans .env\n' +
          'En dernier recours : node scripts/db.mjs reset && npm run migrate && npm run seed');
    }
  } else {
    bad(`PostgreSQL ne répond pas sur le port ${PGPORT}`,
        'node scripts/db.mjs start\nSi l\'échec persiste, consultez .pgdata.log');
    const log = resolve(ROOT, '.pgdata.log');
    if (existsSync(log)) {
      const tail = readFileSync(log, 'utf8').trim().split('\n').slice(-6);
      console.log(c(90, '\n      Dernières lignes de .pgdata.log :'));
      tail.forEach((l) => console.log(c(90, `      │ ${l}`)));
    }
  }
}

/* ------------------------------------------------------- 5. interface web */
head('Interface web');
const dist = resolve(ROOT, 'apps/web/dist');
const indexHtml = resolve(dist, 'index.html');
if (!existsSync(indexHtml)) {
  bad('Interface non compilée (apps/web/dist/index.html absent)', 'npm run build:web');
} else {
  const assets = resolve(dist, 'assets');
  const files = existsSync(assets) ? readdirSync(assets) : [];
  const js = files.filter((f) => f.endsWith('.js'));
  const css = files.filter((f) => f.endsWith('.css'));
  if (!js.length) bad('Aucun fichier JavaScript compilé', 'npm run build:web');
  else {
    const size = js.reduce((s, f) => s + statSync(resolve(assets, f)).size, 0);
    ok('Interface compilée', `${js.length} JS + ${css.length} CSS · ${Math.round(size / 1024)} ko`);
  }
}

/* ------------------------------------------------ 6. port de l'application */
head('Port de l\'application');
const appUp = await probePort(PORT);
if (appUp) {
  // Le serveur tourne déjà : on vérifie qu'il répond bien en HTTP.
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(4000) });
    const body = await res.json().catch(() => null);
    if (res.ok) {
      ok(`L'application répond sur http://localhost:${PORT}`, body?.status ? `état : ${body.status}` : '');
      console.log(`\n  ${c(32, bold('L\'application est en ligne.'))}`);
      console.log(`  Ouvrez ${bold(`http://localhost:${PORT}`)} — identifiant ${bold('admin')} / ${bold('Clinique2026!')}\n`);
    } else {
      bad(`L'application répond mais renvoie une erreur HTTP ${res.status}`,
          'Consultez la fenêtre où « npm start » s\'exécute.');
    }
  } catch {
    bad(`Le port ${PORT} est occupé par un programme qui ne répond pas en HTTP`,
        `Ce n'est probablement pas CliniRDV. Changez PORT dans .env, puis relancez.\n` +
        `Windows :  Get-Process -Id (Get-NetTCPConnection -LocalPort ${PORT}).OwningProcess`);
  }
} else {
  const free = await canListen(PORT, HOST);
  if (free.ok) {
    warn(`L'application n'est pas démarrée (port ${PORT} libre)`);
    console.log(`\n  ${c(33, 'Lancez :')} ${bold('npm start')}   ou   ${bold('npm run app')} (ouvre le navigateur)\n`);
  } else if (free.code === 'EADDRINUSE') {
    bad(`Le port ${PORT} est déjà utilisé par une autre application`,
        'Modifiez PORT dans .env (par exemple 3002), puis relancez.');
  } else if (free.code === 'EACCES') {
    bad(`Accès au port ${PORT} refusé`, 'Utilisez un port supérieur à 1024 dans .env.');
  } else if (free.code === 'EADDRNOTAVAIL') {
    bad(`L'adresse HOST=${HOST} n'existe pas sur cette machine`,
        'Mettez HOST=127.0.0.1 dans .env.');
  } else {
    bad(`Impossible d'écouter sur ${HOST}:${PORT} (${free.code})`, 'Mettez HOST=127.0.0.1 dans .env.');
  }
}

/* ------------------------------------------------------------- conclusion */
console.log(c(90, '  ' + '─'.repeat(64)));
if (failures === 0 && warnings === 0) {
  console.log(`  ${c(32, bold('Tout est correct.'))}\n`);
} else {
  console.log(`  ${failures} problème(s) bloquant(s), ${warnings} avertissement(s).`);
  if (failures > 0) {
    console.log(c(90, '  Corrigez les points marqués ✗ en suivant les flèches →, puis relancez :'));
    console.log(c(90, '      node scripts/doctor.mjs\n'));
  } else console.log('');
}
process.exit(failures > 0 ? 1 : 0);
