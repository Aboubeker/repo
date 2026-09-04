#!/usr/bin/env node
/**
 * Fabrique le paquet d'installation distribuable.
 *
 *   node scripts/build-package.mjs
 *
 * Produit dans « release/ » un dossier autonome contenant :
 *   - CliniRDV.exe        serveur applicatif compilé (code source non lisible)
 *   - apps/web/dist       interface déjà compilée et minifiée
 *   - infra/db            migrations SQL (indispensables à l'exécution)
 *   - Installer.cmd       installation par double-clic
 *
 * Ce que ce paquet protège, et ce qu'il ne protège pas : le code JavaScript
 * est regroupé et minifié, donc ni lisible ni maintenable par un tiers, et les
 * commentaires de conception disparaissent. Ce n'est pas du chiffrement : un
 * adversaire déterminé et outillé peut toujours analyser un binaire. L'objectif
 * réaliste est d'empêcher la reprise et la revente du code, pas de rendre la
 * rétro-ingénierie impossible.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, cpSync, writeFileSync, readFileSync,
         readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'release');
const isWin = process.platform === 'win32';
const EXE = isWin ? 'CliniRDV.exe' : 'CliniRDV';

const step = (m) => console.log(`\n\u25b8 ${m}`);
const ok = (m) => console.log(`  \u2713 ${m}`);
const die = (m) => { console.error(`\n  \u2717 ${m}\n`); process.exit(1); };
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: isWin, ...opts });

/* ------------------------------------------------------------ Nettoyage */
step('Preparation');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
ok(`Dossier ${OUT}`);

/* ------------------------------------------------- Interface compilee */
step("Compilation de l'interface");
run(isWin ? 'npm.cmd' : 'npm', ['run', 'build:web']);
const dist = resolve(ROOT, 'apps/web/dist');
if (!existsSync(dist)) die("L'interface n'a pas ete compilee.");
ok('apps/web/dist');

/* ------------------------------------------------------- Bundle serveur */
step('Regroupement et minification du serveur');
const bundle = resolve(OUT, 'server.cjs');
try {
  run(resolve(ROOT, 'node_modules/.bin/esbuild' + (isWin ? '.cmd' : '')), [
    'apps/api/src/main.mjs',
    '--bundle', '--platform=node', '--format=cjs', '--minify',
    // pg-native est optionnel et compile en natif : l'exclure evite un echec
    // de build, le pilote JavaScript pur suffit.
    '--external:pg-native',
    `--outfile=${bundle}`,
  ]);
} catch {
  // esbuild a deja imprime le detail sur la sortie d'erreur. Sans ce
  // rattrapage, Node affichait le buffer brut de execFileSync : illisible.
  die('Le regroupement a echoue (voir les erreurs esbuild ci-dessus).');
}
ok(`server.cjs (${Math.round(statSync(bundle).size / 1024)} ko, minifie)`);

/* ------------------------------------------------------- Executable SEA */
step('Fabrication de l\'executable');
const seaConfig = resolve(OUT, 'sea-config.json');
writeFileSync(seaConfig, JSON.stringify({
  main: bundle,
  output: resolve(OUT, 'sea-prep.blob'),
  disableExperimentalSEAWarning: true,
}, null, 2));

run(process.execPath, ['--experimental-sea-config', seaConfig]);

const exePath = resolve(OUT, EXE);
cpSync(process.execPath, exePath);

// La signature Authenticode doit sauter avant l'injection, sinon le binaire
// est considere comme altere et Windows refuse de l'executer.
if (isWin) {
  try {
    run('signtool', ['remove', '/s', exePath], { stdio: 'ignore' });
    ok('Signature d\'origine retiree');
  } catch { /* signtool absent : l'injection fonctionne quand meme */ }
}

const postject = resolve(ROOT, 'node_modules/.bin/postject' + (isWin ? '.cmd' : ''));
if (!existsSync(postject)) die('postject est absent. Lancez : npm install');
run(postject, [
  exePath, 'NODE_SEA_BLOB', resolve(OUT, 'sea-prep.blob'),
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
].concat(process.platform === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : []));
ok(`${EXE} (${Math.round(statSync(exePath).size / 1024 / 1024)} Mo)`);

/* ------------------------------------------------------------ Ressources */
step('Ressources');
// Les migrations sont lues a l'execution : sans elles, aucune base ne peut
// etre creee ni mise a jour.
cpSync(resolve(ROOT, 'infra/db'), resolve(OUT, 'infra/db'), { recursive: true });
// Les sourcemaps reconstituent le code React d'origine, commentaires compris :
// les livrer annulerait la protection que ce paquet est cense apporter. Elles
// restent activees en developpement, ou elles sont utiles.
cpSync(dist, resolve(OUT, 'apps/web/dist'), {
  recursive: true,
  filter: (src) => !src.endsWith('.map'),
});
cpSync(resolve(ROOT, '.env.example'), resolve(OUT, '.env.example'));

// Sans les .map, le commentaire « //# sourceMappingURL=... » ferait chercher
// au navigateur un fichier absent : une erreur 404 dans la console a chaque
// ouverture, et une piste inutile pour qui inspecte le paquet.
const assets = resolve(OUT, 'apps/web/dist/assets');
if (existsSync(assets)) {
  for (const f of readdirSync(assets)) {
    if (!/\.(js|css)$/.test(f)) continue;
    const p = join(assets, f);
    const cleaned = readFileSync(p, 'utf8')
      .replace(/\n?\/\/# sourceMappingURL=.*$/m, '')
      .replace(/\n?\/\*# sourceMappingURL=.*?\*\/\s*$/m, '');
    writeFileSync(p, cleaned);
  }
}
ok('infra/db, apps/web/dist (sans sourcemaps), .env.example');

for (const f of ['CliniRDV.cmd', 'scripts/CliniRDV-Controle.ps1']) {
  const src = resolve(ROOT, f);
  if (existsSync(src)) {
    const dst = resolve(OUT, f);
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(src, dst);
  }
}
ok('Panneau de controle');

/* ------------------------------------------------------------ Installeur */
writeFileSync(resolve(OUT, 'Installer.cmd'), [
  '@echo off',
  'REM Installation de CliniRDV a partir du paquet distribue.',
  'cd /d "%~dp0"',
  'echo.',
  'echo   ================================================',
  'echo     CliniRDV - Installation',
  'echo   ================================================',
  'echo.',
  'if not exist ".env" copy ".env.example" ".env" >nul',
  'echo   Preparation de la base de donnees...',
  'CliniRDV.exe --migrate',
  'if errorlevel 1 (',
  '  echo   [x] L\'installation a echoue.',
  '  pause',
  '  exit /b 1',
  ')',
  'echo   Installation terminee.',
  'echo.',
  'pause',
  '',
].join('\r\n'));

writeFileSync(resolve(OUT, 'LISEZ-MOI.txt'), [
  'CliniRDV - paquet d\'installation',
  '',
  'Installation :',
  '  1. Double-cliquez sur Installer.cmd',
  '  2. Puis sur CliniRDV.cmd pour ouvrir le panneau de controle',
  '',
  'Le serveur et la base de donnees restent sur ce poste.',
  'Aucune donnee n\'est transmise a l\'exterieur.',
  '',
].join('\r\n'));

rmSync(seaConfig, { force: true });
rmSync(resolve(OUT, 'sea-prep.blob'), { force: true });
rmSync(bundle, { force: true });

console.log(`\n  Paquet pret : ${OUT}\n`);
