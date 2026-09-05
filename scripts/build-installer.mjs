#!/usr/bin/env node
/**
 * Fabrication croisée de l'installateur unique de CliniRDV.
 *
 *   node scripts/build-installer.mjs
 *   node scripts/build-installer.mjs --node-host /chemin/node.exe --pg-dir /chemin/native
 *
 * Produit « release/CliniRDV-Installateur[.exe] » : un seul fichier qui
 * contient
 *   1. le moteur d'installation (SEA — stub.mjs, code non lisible),
 *   2. l'assistant graphique (déposé au lancement, uniquement sous Windows),
 *   3. DERRIÈRE tout cela, l'archive de la distribution : l'exécutable
 *      applicatif, l'interface compilée, les migrations SQL et PostgreSQL
 *      (le « pg/ ») — de sorte que l'installation est possible SANS aucun
 *      autre logiciel, ni Node, ni npm, ni PostgreSQL préinstallé.
 *
 * Fabrication croisée : le script tourne sous Linux et produit un .exe
 * Windows. Le blob SEA est généré par le Node local (portable entre
 * plateformes à version majeure égale) ; seuls le binaire d'hôte et
 * PostgreSQL sont spécifiques de la plateforme cible.
 *
 * Vérifications de sortie (l'échec est net, jamais un fichier douteux) :
 *   - l'archive s'intègre (CRC de chaque entrée relus),
 *   - l'exécutable ne porte plus de signature (sinon Windows le refuse),
 *   - le fusible SEA est armé (le runtime reconnaîtra le blob injecté),
 *   - le blob SEA est présent dans l'exécutable final.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,
  statSync, cpSync,
} from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectEntries, writeZip, extractZip, verifyZip, readZipIndex } from './lib/archive.mjs';
import { hasSignature, stripSignature, parsePe } from './lib/pe.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};

const NODE_HOST = flag('--node-host') || process.execPath;
const PG_DIR = flag('--pg-dir')
  || (process.platform === 'linux' && process.arch === 'x64'
    ? resolve(ROOT, 'node_modules/@embedded-postgres/linux-x64/native')
    : null);
const OUT = resolve(flag('--out') || join(ROOT, 'release'));
const IS_WIN_TARGET = NODE_HOST.toLowerCase().endsWith('.exe');
const APP_EXE = IS_WIN_TARGET ? 'CliniRDV.exe' : 'CliniRDV';
const INSTALLER = IS_WIN_TARGET ? 'CliniRDV-Installateur.exe' : 'CliniRDV-Installateur';

const FUSE_ARMED = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2:1';
const FUSE_NAME = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const step = (m) => console.log(`\n▸ ${m}`);
const ok = (m) => console.log(`  ✓ ${m}`);
const die = (m) => { console.error(`\n  ✗ ${m}\n`); process.exit(1); };
const run = (cmd, cmdArgs, opts = {}) => execFileSync(cmd, cmdArgs, {
  cwd: ROOT, stdio: 'inherit', ...opts,
});
const bin = (n) => resolve(ROOT, 'node_modules/.bin', n);

if (!existsSync(NODE_HOST)) die(`binaire d'hôte absent : ${NODE_HOST}`);
if (!PG_DIR || !existsSync(join(PG_DIR, 'bin'))) {
  die(`PostgreSQL à archiver introuvable (dossier « native/ » sans bin/) : ` +
      `précisez --pg-dir. Sous Linux : node_modules/@embedded-postgres/linux-x64/native`);
}
for (const b of ['esbuild', 'postject']) {
  if (!existsSync(bin(b))) die(`outil absent : ${b} — lancez « npm install »`);
}

// Hors de OUT : collectEntries(OUT) archiverait sinon les produits
// intermédiaires (blob SEA, bundle, pg.zip).
const BUILD = join(ROOT, '.build-installer');
rmSync(BUILD, { recursive: true, force: true });
mkdirSync(BUILD, { recursive: true });
process.on('exit', () => rmSync(BUILD, { recursive: true, force: true }));

/* ------------------------------------------------ 1. Paquet applicatif -- */
step(`1/5  Paquet applicatif (binaire d'hôte : ${NODE_HOST})`);
run(process.execPath, ['scripts/build-package.mjs', '--node-host', NODE_HOST]);
const appExePath = join(OUT, APP_EXE);
if (!existsSync(appExePath)) die(`le paquet n'a pas produit ${APP_EXE}`);
ok(`release/ prêt (${APP_EXE} inclus)`);

/* --------------------------------------------- 2. PostgreSQL dans le lot -- */
step('2/5  Archivage de PostgreSQL (symlinks matérialisés)');
const pgEntries = collectEntries(PG_DIR, { prefix: 'pg', verbatimSymlinks: false });
const pgBytes = pgEntries.reduce((n, e) => n + (e.data ? e.data.length : 0), 0);
const pgZipPath = join(BUILD, 'pg.zip');
writeFileSync(pgZipPath, writeZip(pgEntries));
extractZip(readFileSync(pgZipPath), OUT);
pgEntries.length = 0;   // libère les buffers avant l'archivage final
if (!existsSync(join(OUT, 'pg/bin'))) die('pg/bin absent après archivage');
ok(`pg/ déposé (${pgBytes / 1048576 | 0} Mo, symlinks matérialisés)`);

// L'assistant graphique et l'assembleur font partie de la distribution
// (le moteur GUI déploie l'assistant depuis l'archive ; l'assembleur
// reconstitue l'exécutable depuis ses 2 parties, limite GitHub comprise).
for (const [src, dst] of [
  ['scripts/installer/Assistant-Installation.ps1', 'Assistant-Installation.ps1'],
  ['scripts/installer/Assembler-Installateur.bat', 'Assembler-Installateur.bat'],
]) {
  cpSync(join(ROOT, src), join(OUT, dst));
}

/* ---------------------------------------- 3. Moteur d'installation (SEA) -- */
step("3/5  Moteur d'installation (SEA)");
const stubBundle = join(BUILD, 'stub-bundle.cjs');
run(bin('esbuild'), [
  'scripts/installer/stub.mjs',
  '--bundle', '--platform=node', '--format=cjs', '--minify',
  '--log-override:empty-import-meta=silent',
  `--outfile=${stubBundle}`,
]);
const seaConfig = join(BUILD, 'sea-config.json');
writeFileSync(seaConfig, JSON.stringify({
  main: stubBundle,
  output: join(BUILD, 'sea-prep.blob'),
  disableExperimentalSEAWarning: true,
}, null, 2));
run(process.execPath, ['--experimental-sea-config', seaConfig]);
// Le blob est un bytecode V8 : la preuve de son injection, c'est qu'il est
// présent À L'IDENTIQUE dans le fichier final (note ELF ou ressource PE).
const seaBlob = readFileSync(join(BUILD, 'sea-prep.blob'));

const installerSrc = join(BUILD, INSTALLER);
cpSync(NODE_HOST, installerSrc);
let installerBuf;
{
  const r = stripSignature(readFileSync(installerSrc));
  if (r.changed) {
    writeFileSync(installerSrc, r.buffer);
    ok(`signature Authenticode effacée (${r.removedBytes} octets retirés) : ` +
       `sinon Windows refuse le binaire modifié`);
  } else {
    ok('aucune signature à effacer');
  }
  installerBuf = readFileSync(installerSrc);
}
run(bin('postject'), [
  installerSrc, 'NODE_SEA_BLOB', join(BUILD, 'sea-prep.blob'),
  '--sentinel-fuse', FUSE_NAME,
]);
installerBuf = readFileSync(installerSrc);
ok(`${INSTALLER} sans archive (${(installerBuf.length / 1048576).toFixed(0)} Mo)`);

/* --------------------------------------------- 4. L'archive de la distro -- */
step('4/5  Archive de la distribution accolée');
const distEntries = collectEntries(OUT, { verbatimSymlinks: false });

// Le dépôt vit sous Linux : les scripts .cmd/.bat sont en LF. cmd.exe gère
// le LF pour les commandes simples, mais les blocs multi-lignes « if (…) »
// deviennent capricieux. CRLF pour les scripts, à l'archivage uniquement.
let converted = 0;
for (const e of distEntries) {
  if (e.type !== 'file' || !/\.(cmd|bat)$/i.test(e.name)) continue;
  e.data = Buffer.from(e.data.toString('utf8')
    .replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'), 'utf8');
  converted++;
}
if (converted) ok(`${converted} script(s) .cmd converti(s) en CRLF`);
rmSync(installerSrc, { force: true });   // ne s'archive pas lui-même
const finalPath = join(OUT, INSTALLER);
// writeFileSync recréerait le fichier en 0644 : le bit exécutable est
// celui du binaire d'hôte, pas un détail.
writeFileSync(finalPath, writeZip(distEntries, { prepend: installerBuf }),
              { mode: 0o755 });
ok(`${distEntries.length} entrées archivées derrière le moteur`);

/* ------------------------------------------------- 5. Vérifications ------ */
step('5/5  Vérifications du fichier final');
const finalBuf = readFileSync(finalPath);

// L'archive s'intègre et contient bien ce qu'elle doit.
const v = verifyZip(finalBuf);
ok(`archive saine : ${v.entries} entrées, ${v.files} fichiers, ` +
   `${(v.bytes / 1048576).toFixed(1)} Mo (tous les CRC relus)`);
const names = new Set(readZipIndex(finalBuf).entries.map((e) => e.name));
for (const required of [APP_EXE, 'CliniRDV.cmd', 'pg/bin/', 'infra/db/',
                        'apps/web/dist/', 'Assistant-Installation.ps1']) {
  if (!names.has(required)) die(`entrée obligatoire absente de l'archive : ${required}`);
}
ok('entrées obligatoires présentes (exécutable, lanceur, pg/, infra/, web)');

// L'exécutable est un PE sans signature, avec le fusible armé et le blob.
if (!finalBuf.includes(FUSE_ARMED)) die(`fusible SEA non armé (${FUSE_NAME}:1 introuvable)`);
if (!finalBuf.includes(seaBlob)) die('blob SEA absent du fichier final (injection perdue)');
ok('fusible SEA armé, blob présent à l\'identique');
if (IS_WIN_TARGET) {
  parsePe(finalBuf);   // lève si le PE est illisible
  if (hasSignature(finalBuf)) die('signature résiduelle : Windows refuserait ce binaire');
  ok('PE valide, sans signature');
}

console.log(`
  Installateur prêt : ${finalPath}
  ${statSync(finalPath).size >= 1048576
    ? `(${(statSync(finalPath).size / 1048576).toFixed(0)} Mo)`
    : `(${(statSync(finalPath).size / 1024).toFixed(0)} ko)`}

  Sous Windows : double-cliquer sur ${INSTALLER} ouvre l'assistant graphique.
  Le contenu est installé localement ; aucune donnée ne sort du poste.
`);
