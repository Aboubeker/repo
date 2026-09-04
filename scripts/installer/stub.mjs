#!/usr/bin/env node
/**
 * Moteur d'installation CliniRDV.
 *
 * Ce fichier est embarqué dans CliniRDV-Installateur.exe (SEA) et y vit
 * avec l'archive de la distribution (accolée derrière le programme). Il est
 * aussi exécuté directement depuis le dépôt pour les tests — c'est pourquoi
 * SELF passe par une variable d'environnement :
 *
 *   SELF = process.env.CLINIRDV_INSTALLER_SELF || process.execPath
 *
 * Contrat de sortie (lu ligne à ligne par Assistant-Installation.ps1) :
 *   stdout : « PROGRESS <pct> <message> » pour la barre de progression,
 *            autres lignes d'information en clair ;
 *   stderr : les erreurs, préfixées « ERREUR » ;
 *   code    : 0 succès, 1 échec.
 *
 * Ce moteur ne contient aucune « deuxième logique d'installation » : la
 * préparation de la base (cluster, migrations, rôles, administrateur) est
 * exécutée par l'exécutable d'application lui-même (« --setup »).
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, unlinkSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { isPackaged } from '../../apps/api/src/core/root.mjs';
import { parseEnv } from '../../apps/api/src/core/env.mjs';
import {
  readZipIndex, extractZip, extractSingleEntry, verifyZip,
} from '../lib/archive.mjs';

/* ------------------------------------------------------------ erreurs -- */

export class InstallerError extends Error {}

/* ---------------------------------------------------------------- SELF -- */

/**
 * Chemin de l'installateur lui-même.
 * Dans le .exe : process.execPath. En test : CLINIRDV_INSTALLER_SELF pointe
 * sur un faux exécutable [octets de programme][archive] — sans cela rien
 * n'est testable hors Windows.
 */
export function selfPath() {
  return process.env.CLINIRDV_INSTALLER_SELF || process.execPath;
}

/** Nom de l'exécutable d'application (CLINIRDV_EXE_NAME permet le test). */
export function exeName() {
  return process.env.CLINIRDV_EXE_NAME || (process.platform === 'win32' ? 'CliniRDV.exe' : 'CliniRDV');
}

/** Lit l'archive accolée dans SELF ; lève si l'archive est absente. */
export function readSelfArchive() {
  const buf = readFileSync(selfPath());
  readZipIndex(buf);   // lève « EOCD introuvable » si ce n'est pas un SELF
  return buf;
}

/* ---------------------------------------------------------- inspection -- */

/**
 * État d'un dossier candidat : existence, .env, base, exécutable, port.
 * Sert à la détection d'une installation existante (mise à jour) et à
 * refuser d'écraser une base sans le dire.
 */
export function inspectTarget(dir) {
  const d = resolve(dir);
  const envFile = join(d, '.env');
  let port = null;
  if (existsSync(envFile)) {
    const p = parseEnv(readFileSync(envFile, 'utf8')).PORT;
    if (p) port = Number(p);
  }
  return {
    dir: d,
    exists: existsSync(d),
    hasEnv: existsSync(envFile),
    hasDatabase: existsSync(join(d, '.pgdata')),
    hasExecutable: existsSync(join(d, exeName())),
    port,
  };
}

/* --------------------------------------------------------------- ports -- */

/** Un port est-il déjà en écoute (test TCP, jamais un kill) ? */
export function busyPort(port, host = '127.0.0.1', timeout = 1200) {
  return new Promise((res) => {
    const s = connect({ host, port });
    const done = (v) => { try { s.destroy(); } catch {} res(v); };
    s.setTimeout(timeout);
    s.on('connect', () => done(true));
    s.on('timeout', () => done(false));
    s.on('error', () => done(false));
  });
}

/** Premier port libre de la plage (PostgreSQL embarqué, jamais sur le réseau). */
export async function pickFreePgPort(start = 55432, range = 20) {
  for (let p = start; p < start + range; p++) {
    if (!(await busyPort(p))) return p;
  }
  throw new InstallerError(`Aucun port libre entre ${start} et ${start + range - 1} pour PostgreSQL.`);
}

/* -------------------------------------------------------------- .env ---- */

/**
 * Écrit le .env de l'installation.
 *
 * NE CRITE JAMAIS : si un .env existe (mise à jour), il est conservé à
 * l'identique — c'est lui qui porte le secret JWT et le mot de passe du
 * cluster ; les réécrire orphelinerait la base existante.
 *
 * @returns {{created:boolean, kept:boolean, path:string}}
 */
export function writeEnvFile(dir, { clinicName, port, pgPort }) {
  const path = join(dir, '.env');
  if (existsSync(path)) return { created: false, kept: true, path };

  const vars = {
    NODE_ENV: 'production',
    PORT: String(port),
    HOST: '::',
    PGHOST: '127.0.0.1',
    PGPORT: String(pgPort),
    PGUSER: 'clinirdv',
    // 24 octets aléatoires : le mot de passe du cluster, propre à ce poste.
    PGPASSWORD: randomBytes(24).toString('hex'),
    PGDATABASE: 'clinirdv',
    // 48 octets aléatoires, tirés par installation : c'est ce qui rend un
    // jeton d'un poste invalide sur tous les autres (défaut corrigé).
    JWT_SECRET: randomBytes(48).toString('hex'),
    ACCESS_TOKEN_TTL: '900',
    REFRESH_TOKEN_TTL: '28800',
    CLINIC_NAME: clinicName,
    CLINIC_TZ: 'Africa/Algiers',
  };
  writeFileSync(path,
    Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n') + '\n',
    { encoding: 'utf8', mode: 0o600 });   // utf8 sans BOM (Node ne write jamais de BOM)
  return { created: true, kept: false, path };
}

/* ------------------------------------------------------------ règles ---- */

/**
 * Politique du mot de passe administrateur — MIRE de celle de
 * core/auth.mjs (validatePasswordStrength) : 12 caractères, 3 classes sur 4.
 * L'assistant ne peut pas importer de JavaScript ; le moteur, lui, rejette
 * aussi (défense en profondeur).
 */
export function validatePassword(pw) {
  const errors = [];
  if (!pw || pw.length < 12) errors.push('12 caractères minimum');
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/]
    .filter((re) => re.test(pw || '')).length;
  if (classes < 3) errors.push('3 types de caractères minimum (minuscule, majuscule, chiffre, symbole)');
  return errors;
}

/** Validation du port applicatif : entier 1024..65535 (les < 1024 sont réservés). */
export function validatePort(port) {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1024 || n > 65535) {
    return 'Port invalide : entier entre 1024 et 65535.';
  }
  return null;
}

/* ------------------------------------------------------------- raccourci */

function createDesktopShortcut(targetDir) {
  if (process.platform !== 'win32') {
    return { created: false,
             reason: 'Raccourci Bureau indisponible hors Windows (lancez « CliniRDV.cmd »).' };
  }
  const q = targetDir.replace(/\\/g, '\\\\').replace(/'/g, "''");
  const ps = [
    "$ws = New-Object -ComObject WScript.Shell",
    "$desktop = [Environment]::GetFolderPath('Desktop')",
    "$lnk = $ws.CreateShortcut((Join-Path $desktop 'CliniRDV.lnk'))",
    `$lnk.TargetPath = '${q}\\CliniRDV.cmd'`,
    `$lnk.WorkingDirectory = '${q}'`,
    '$lnk.Save()',
  ].join('\n');
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
    { encoding: 'utf8', windowsHide: true });
  return { created: r.status === 0 };
}

/* ----------------------------------------------------------- installation */

/**
 * Installation complète (ou mise à jour) dans le dossier cible.
 *
 * @param {object} params
 * @param {string} params.target dossier d'installation
 * @param {string} params.clinicName nom de la clinique
 * @param {number|string} params.port port applicatif
 * @param {string} params.adminPassword mot de passe administrateur
 * @param {boolean} [params.update] true pour une mise à jour d'une
 *   installation existante (conservation du .env et de la base)
 * @param {function} [params.progress] (pct, message)
 * @param {function} [params.log] (ligne)
 */
export async function install({
  target, clinicName, port, adminPassword,
  update = false,
  progress = () => {}, log = () => {},
} = {}) {
  /* 1 — validation des paramètres ------------------------------- */
  progress(5, 'Vérification des paramètres');
  if (!target || !String(target).trim()) throw new InstallerError('dossier cible manquant');
  if (!clinicName || !String(clinicName).trim()) throw new InstallerError('nom de la clinique manquant');
  const portErr = validatePort(port);
  if (portErr) throw new InstallerError(portErr);
  const pwErrs = validatePassword(adminPassword);
  if (pwErrs.length) throw new InstallerError(`mot de passe refusé : ${pwErrs.join(' ; ')}`);

  const targetDir = resolve(target);
  const info = inspectTarget(targetDir);
  if (update) {
    if (!info.hasExecutable) {
      throw new InstallerError(`aucune installation existante dans ${targetDir}`);
    }
    log('Installation existante : mise à jour en cours (base et .env conservés).');
  } else if (info.hasDatabase) {
    throw new InstallerError(
      'Une base de données existe déjà dans ce dossier. Relancez l\'installateur ' +
      'sur cette installation pour la mettre à jour, ou choisissez un autre dossier.');
  }

  mkdirSync(targetDir, { recursive: true });

  /* 2 — extraction de l'archive accolée -------------------------- */
  progress(10, 'Extraction des fichiers');
  const buf = readSelfArchive();
  const total = readZipIndex(buf).count;
  let done = 0;
  const r = extractZip(buf, targetDir, {
    onEntry: () => {
      done++;
      if (done % 5 === 0 || done === total) {
        progress(10 + Math.floor(45 * done / total), 'Extraction des fichiers');
      }
    },
  });
  log(`${r.files} fichiers extraits.`);

  /* 3 — configuration (.env JAMAIS écrasé) ------------------------ */
  progress(60, 'Configuration');
  let pgPort;
  if (info.hasEnv) {
    const e = parseEnv(readFileSync(join(targetDir, '.env'), 'utf8'));
    pgPort = Number(e.PGPORT) || 55432;
    if (await busyPort(pgPort)) pgPort = await pickFreePgPort();
  } else {
    pgPort = await pickFreePgPort();
  }
  const env = writeEnvFile(targetDir, {
    clinicName: String(clinicName).trim(), port: Number(port), pgPort,
  });
  if (env.kept) {
    log('.env existant conservé : le secret JWT et les identifiants de la base restent ceux de l\'installation initiale.');
  }

  /* 4 — port applicatif libre ------------------------------------ */
  progress(65, `Vérification du port ${port}`);
  if (await busyPort(Number(port))) {
    throw new InstallerError(
      `Le port ${port} est déjà utilisé par une autre application sur ce poste.`);
  }

  /* 5 — préparation de la base par l'exécutable ------------------- */
  progress(70, 'Préparation de la base de données (migrations, rôles, administrateur)');
  const pwFile = join(targetDir, '.admin-password.tmp');
  writeFileSync(pwFile, adminPassword, { mode: 0o600 });
  const exe = join(targetDir, exeName());
  let spawned;
  try {
    if (!existsSync(exe)) throw new InstallerError(`exécutable absent après extraction : ${exe}`);
    spawned = spawnSync(exe, ['--setup'], {
      cwd: targetDir, encoding: 'utf8', windowsHide: true,
      timeout: 10 * 60 * 1000,
      env: { ...process.env, CLINIRDV_ADMIN_PASSWORD_FILE: pwFile },
    });
  } finally {
    // Le fichier de mot de passe ne survit jamais, même à un échec.
    unlinkSync(pwFile, { force: true });
  }
  if (spawned.error) throw new InstallerError(`lancement impossible : ${spawned.error.message}`);
  if (spawned.stdout) {
    for (const line of spawned.stdout.split(/\r?\n/)) if (line.trim()) log(line.trim());
  }
  if (spawned.status !== 0) {
    if (spawned.stderr) {
      for (const line of spawned.stderr.split(/\r?\n/)) {
        if (line.trim()) console.error(`ERREUR ${line.trim()}`);
      }
    }
    throw new InstallerError(`préparation de la base échouée (code ${spawned.status})`);
  }

  /* 6 — raccourci Bureau ------------------------------------------ */
  progress(90, 'Raccourci sur le Bureau');
  const sc = createDesktopShortcut(targetDir);
  if (sc.created) log('Raccourci « CliniRDV » déposé sur le Bureau.');
  else if (sc.reason) log(sc.reason);

  progress(100, 'Installation terminée');
  return { targetDir, pgPort, env, shortcut: sc };
}

/* -------------------------------------------------------------- modes --- */

/**
 * Lecture ligne à ligne avec mise en file : rl.question() est inutilisable
 * ici — quand les lignes arrivent en lot (pipe), tout ce qui n'est pas
 * attendu au moment de l'événement est perdu, et la promesse ne se résout
 * jamais. Le lecteur ci-dessous fonctionne au clavier et en pipe.
 */
function createLineReader(stream) {
  const rl = createInterface({ input: stream });
  const buffered = [];
  let notify = null;
  rl.on('line', (l) => {
    if (notify) { const n = notify; notify = null; n(l); }
    else buffered.push(l);
  });
  return {
    next: () => buffered.length ? Promise.resolve(buffered.shift())
                                : new Promise((r) => { notify = r; }),
    close: () => rl.close(),
  };
}

/** Mode console (non-Windows) : les quatre valeurs au clavier. */
async function runConsole() {
  const { next, close } = createLineReader(process.stdin);
  console.log('\n  CliniRDV — installation (mode console)\n');
  const ask = (q) => { process.stdout.write(q); return next(); };
  try {
    const clinicName = (await ask('Nom de la clinique : ')).trim();
    const target = (await ask("Dossier d'installation : ")).trim();
    const port = (await ask('Port (3001) : ')).trim() || '3001';
    const adminPassword = await ask('Mot de passe administrateur (12 caractères min.) : ');
    await install({
      target, clinicName, port, adminPassword,
      progress: (pct, msg) => console.log(`PROGRESS ${pct} ${msg}`),
      log: (l) => console.log(`  ${l}`),
    });
  } finally {
    close();
  }
}

/** Mode GUI (Windows) : dépose l'assistant dans un temp et le lance. */
function runGui() {
  const self = selfPath();
  const tmp = join(tmpdir(), `CliniRDV-Install-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  try {
    extractSingleEntry(readSelfArchive(), 'Assistant-Installation.ps1', tmp);
    const ps1 = join(tmp, 'Assistant-Installation.ps1');
    const child = spawnSync('powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1],
      { stdio: 'inherit', windowsHide: true,
        env: { ...process.env, CLINIRDV_INSTALLER_SELF: self } });
    process.exit(child.status ?? 1);
  } catch (e) {
    console.error(`ERREUR ${e.message}`);
    process.exit(1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/* ---------------------------------------------------------------- CLI --- */

const isMain = isPackaged || (process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href);

if (isMain) {
  const args = process.argv.slice(2);
  const flag = (name, def = null) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : def;
  };
  const has = (name) => args.includes(name);

  if (has('--inspect')) {
    console.log(JSON.stringify(inspectTarget(flag('--inspect') || '.'), null, 2));
  } else if (has('--verify-archive')) {
    const v = verifyZip(readSelfArchive());
    console.log(`Archive saine : ${v.entries} entrées, ${v.files} fichiers, ` +
      `${(v.bytes / 1048576).toFixed(1)} Mo (CRC vérifiés).`);
  } else if (has('--silent')) {
    (async () => {
      const progress = (pct, msg) => console.log(`PROGRESS ${pct} ${msg}`);
      const log = (l) => console.log(l);
      try {
        let pw = flag('--admin-password');
        const pwFile = flag('--admin-password-file');
        if (!pw && pwFile) {
          pw = readFileSync(pwFile, 'utf8').trim();
          unlinkSync(pwFile, { force: true });   // lu par l'assistant, plus utile
        }
        const r = await install({
          target: flag('--target'),
          clinicName: flag('--name'),
          port: flag('--port', '3001'),
          adminPassword: pw,
          update: has('--update'),
          progress, log,
        });
        console.log(`SUCCES installation terminee dans ${r.targetDir}`);
      } catch (e) {
        console.error(`ERREUR ${e.message}`);
        process.exitCode = 1;
      }
    })();
  } else if (process.platform === 'win32') {
    runGui();
  } else {
    (async () => {
      try { await runConsole(); }
      catch (e) { console.error(`ERREUR ${e.message}`); process.exitCode = 1; }
    })();
  }
}
