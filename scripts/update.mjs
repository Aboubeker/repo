#!/usr/bin/env node
/**
 * Met à jour la copie locale depuis le dépôt, en gérant le cas courant où
 * « git pull » échoue parce que npm a modifié package.json / package-lock.json.
 *
 *   npm run update
 *
 * Les fichiers réellement personnels (.env, base de données) ne sont jamais
 * touchés : ils sont hors du suivi Git.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const color = process.stdout.isTTY;
const c = (n, s) => (color ? `\x1b[${n}m${s}\x1b[0m` : s);
const bold = (s) => c(1, s);
const step = (m) => console.log(`${c(36, '▸')} ${m}`);
const ok = (m) => console.log(`  ${c(32, '✓')} ${m}`);
const warn = (m) => console.log(`  ${c(33, '!')} ${m}`);

const git = (...args) =>
  spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', shell: false });

const fail = (m, fix) => {
  console.error(`\n  ${c(31, '✗ ' + m)}`);
  if (fix) fix.split('\n').forEach((l) => console.error(`  ${c(33, '→')} ${l}`));
  console.error('');
  process.exit(1);
};

if (!existsSync(resolve(ROOT, '.git')))
  fail('Ce dossier n\'est pas un dépôt Git.',
       'Retéléchargez le projet avec « git clone ».');

if (git('--version').status !== 0)
  fail('Git n\'est pas installé ou introuvable.', 'https://git-scm.com/downloads');

/* --------------------------------------------------- état local */
step('Vérification des modifications locales');
const status = git('status', '--porcelain');
const changed = status.stdout.split('\n').map((l) => l.trim()).filter(Boolean);

// Fichiers que npm réécrit systématiquement : ils n'ont aucune valeur pour
// l'utilisateur et ne doivent jamais bloquer une mise à jour.
const GENERATED = ['package-lock.json', 'package.json'];
const generated = [];
const personal = [];
for (const line of changed) {
  const file = line.slice(2).trim().replace(/^"|"$/g, '');
  (GENERATED.includes(file) ? generated : personal).push(file);
}

if (generated.length) {
  step('Annulation des modifications générées par npm');
  for (const f of generated) {
    git('checkout', '--', f);
    ok(`${f} restauré`);
  }
}

if (personal.length) {
  warn(`${personal.length} fichier(s) modifié(s) localement :`);
  personal.forEach((f) => console.log(`      ${f}`));
  step('Mise de côté de vos modifications (git stash)');
  const r = git('stash', 'push', '-m', 'clinirdv-update');
  if (r.status !== 0) fail('Impossible de mettre de côté les modifications.', r.stderr.trim());
  ok('Modifications sauvegardées — récupérables avec « git stash pop »');
}

/* ------------------------------------------------------ mise à jour */
step('Récupération de la dernière version');
const branch = git('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim();
const fetched = git('fetch', 'origin', branch);
if (fetched.status !== 0)
  fail('Impossible de contacter le dépôt distant.',
       'Vérifiez votre connexion Internet, puis réessayez.\n' + fetched.stderr.trim());

const before = git('rev-parse', 'HEAD').stdout.trim();
const merged = git('merge', '--ff-only', 'FETCH_HEAD');
if (merged.status !== 0) {
  // L'historique local a divergé : on se recale sur la version publiée.
  warn('Historique local divergent — réalignement sur la version publiée');
  const reset = git('reset', '--hard', 'FETCH_HEAD');
  if (reset.status !== 0) fail('Échec du réalignement.', reset.stderr.trim());
}
const after = git('rev-parse', 'HEAD').stdout.trim();

if (before === after) {
  ok('Vous avez déjà la dernière version');
} else {
  const log = git('log', '--oneline', `${before}..${after}`).stdout.trim();
  ok('Mise à jour effectuée');
  if (log) log.split('\n').forEach((l) => console.log(`      ${c(90, l)}`));
}

/* ------------------------------------------------------ dépendances */
step('Mise à jour des dépendances');
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const install = spawnSync(npmCmd, ['install', '--no-audit', '--no-fund'],
  { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
if (install.status !== 0) fail('Échec de « npm install ».');
ok('Dépendances à jour');

console.log(`
  ${c(32, bold('Mise à jour terminée.'))}

  Lancez ensuite :  ${bold('npm run app')}
  En cas de souci :  ${bold('npm run doctor')}
`);
