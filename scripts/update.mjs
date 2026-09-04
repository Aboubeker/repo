#!/usr/bin/env node
/**
 * Met à jour la copie locale depuis le dépôt, en gérant le cas courant où
 * « git pull » échoue parce que npm a modifié package.json / package-lock.json.
 *
 *   npm run update
 *
 * Les fichiers réellement personnels (.env, base de données) ne sont jamais
 * touchés : ils sont hors du suivi Git.
 *
 * Le script est écrit pour un poste d'exploitation sans informaticien : il ne
 * pose aucune question, ne détruit rien, et refuse d'annoncer un succès qu'il
 * n'a pas obtenu. Ses fonctions de décision sont exportées afin d'être
 * vérifiées par les tests de contrat ; le déroulé n'a lieu que lorsque le
 * fichier est le point d'entrée (voir le garde en fin de fichier).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const color = process.stdout.isTTY;
const c = (n, s) => (color ? `\x1b[${n}m${s}\x1b[0m` : s);
const bold = (s) => c(1, s);
const step = (m) => console.log(`${c(36, '▸')} ${m}`);
const ok = (m) => console.log(`  ${c(32, '✓')} ${m}`);
const warn = (m) => console.log(`  ${c(33, '!')} ${m}`);
const info = (m) => console.log(`      ${c(90, m)}`);

const git = (...args) =>
  spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', shell: false });

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npmRun = (...args) =>
  spawnSync(npmCmd, args, { cwd: ROOT, stdio: 'inherit',
                            shell: process.platform === 'win32' });

/* ======================================================================
   Décisions isolées et testables
   ====================================================================== */

/**
 * Trie la sortie de « git status --porcelain » en trois familles.
 *
 * Le découpage se fait sur les colonnes du format porcelain (XY<espace>chemin)
 * et non sur une ligne préalablement rognée : sans les deux caractères d'état,
 * un fichier non suivi (« ?? ») est indiscernable d'un fichier modifié, alors
 * que « git stash » ne sauvegarde que le second.
 */
export function classifyChanges(porcelain) {
  // Fichiers que npm réécrit systématiquement : ils n'ont aucune valeur pour
  // l'utilisateur et ne doivent jamais bloquer une mise à jour.
  const GENERATED = ['package-lock.json', 'package.json'];
  const generated = [];
  const personal = [];
  const untracked = [];
  for (const raw of String(porcelain).split('\n')) {
    if (!raw.trim()) continue;
    const code = raw.slice(0, 2);
    const file = raw.slice(3).trim().replace(/^"|"$/g, '');
    if (code === '??') untracked.push(file);
    else if (GENERATED.includes(file)) generated.push(file);
    else personal.push(file);
  }
  return { generated, personal, untracked };
}

/**
 * Branche de référence du dépôt distant — la seule qui reçoive les versions
 * publiées.
 *
 * Mettre à jour « la branche courante » était un piège : une copie restée sur
 * une branche de session déjà fusionnée ne bouge plus jamais, et le script
 * annonçait « Vous avez déjà la dernière version » alors que main avait trois
 * commits et une migration d'avance. Une erreur silencieuse, précisément celle
 * que cet outil existe pour éviter.
 *
 * On interroge d'abord la référence locale origin/HEAD (instantanée, hors
 * ligne), puis le dépôt distant, et l'on retombe sur « main » en dernier
 * recours — en le signalant, car c'est alors une supposition.
 */
export function resolveDefaultBranch(gitRun) {
  const local = gitRun('symbolic-ref', '--short', 'refs/remotes/origin/HEAD');
  if (local.status === 0) {
    const name = String(local.stdout || '').trim().replace(/^origin\//, '');
    if (name) return { branch: name, source: 'local' };
  }
  const remote = gitRun('ls-remote', '--symref', 'origin', 'HEAD');
  if (remote.status === 0) {
    const m = String(remote.stdout || '').match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m);
    if (m) return { branch: m[1], source: 'distant' };
  }
  return { branch: 'main', source: 'defaut' };
}

/**
 * Fichiers non suivis qu'une version publiée s'apprête à recouvrir.
 *
 * « git merge » refuse d'écraser un fichier non suivi, mais le repli
 * « git reset --hard » employé sur historique divergent, lui, l'écrase sans
 * un mot. Constaté au banc d'essai : un fichier déposé dans le dossier et
 * portant le nom d'un fichier nouvellement publié disparaissait purement et
 * simplement. On les repère à l'avance pour les mettre à l'abri.
 */
export function untrackedCollisions(gitRun, untracked, ref) {
  return untracked.filter((f) => gitRun('cat-file', '-e', `${ref}:${f}`).status === 0);
}

/** Nom de la branche courante, ou null en HEAD détachée. */
export function currentBranch(gitRun) {
  const r = gitRun('rev-parse', '--abbrev-ref', 'HEAD');
  if (r.status !== 0) return null;
  const name = String(r.stdout || '').trim();
  return !name || name === 'HEAD' ? null : name;
}

/**
 * Branches de session « arena/* » locales déjà fusionnées dans la version
 * courante : ce sont des restes sans contenu propre.
 *
 * Elles sont seulement listées. Supprimer une branche de l'utilisateur sans
 * son accord n'est jamais acceptable — et une branche non fusionnée est
 * exclue d'office, elle pourrait porter du travail.
 */
export function staleSessionBranches(gitRun, current) {
  const fmt = '--format=%(refname:short)';
  const all = gitRun('branch', '--list', 'arena/*', fmt);
  if (all.status !== 0) return [];
  const merged = gitRun('branch', '--merged', 'HEAD', '--list', 'arena/*', fmt);
  if (merged.status !== 0) return [];
  const lines = (r) => String(r.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const mergedSet = new Set(lines(merged));
  return lines(all).filter((b) => b !== current && mergedSet.has(b));
}

/* ======================================================================
   Contrôle de la base de données
   ----------------------------------------------------------------------
   Les migrations exigent un serveur PostgreSQL joignable. Sur un poste de
   clinique, la base est normalement à l'arrêt au moment de la mise à jour :
   l'utilisateur met à jour avant de démarrer sa journée, et le bouton
   « Mettre a jour » du panneau Windows arrête tout avant de lancer ce script.
   Le résultat était « connect ECONNREFUSED 127.0.0.1:55432 » : le code était
   récupéré, mais ni le schéma migré ni l'interface recompilée. L'application
   démarrait ensuite sur une base en retard.

   Décision : le script démarre la base lui-même, puis lui rend son état
   initial. S'il l'a démarrée, il l'arrête en partant ; si elle tournait déjà,
   il n'y touche pas. Le panneau Windows retrouve donc le poste tel qu'il l'a
   laissé (serveur arrêté), et « npm run app » redémarre l'ensemble de toute
   façon. La restauration a lieu aussi lorsque le script échoue : une mise à
   jour ratée ne doit pas laisser un service en marche derrière elle.
   ====================================================================== */

const DB_SCRIPT = resolve(ROOT, 'scripts/db.mjs');
const dbRun = (action, opts = {}) =>
  spawnSync(process.execPath, [DB_SCRIPT, action],
            { cwd: ROOT, encoding: 'utf8', ...opts });

const dbIsRunning = () => /\brunning\b/.test(String(dbRun('status').stdout || ''));

let dbStartedByUpdate = false;
let dbRestored = false;

function restoreDatabaseState() {
  if (!dbStartedByUpdate || dbRestored) return;
  dbRestored = true;
  const r = dbRun('stop');
  if (r.status === 0) ok('Base de données rendue à son état initial (arrêtée)');
  else warn('La base est restée démarrée — « npm run db:stop » pour l\'arrêter');
}

// Filet de sécurité : couvre les sorties que le déroulé nominal ne prévoit pas.
process.on('exit', restoreDatabaseState);

const fail = (m, fix) => {
  restoreDatabaseState();
  console.error(`\n  ${c(31, '✗ ' + m)}`);
  if (fix) fix.split('\n').forEach((l) => console.error(`  ${c(33, '→')} ${l}`));
  console.error('');
  process.exit(1);
};

/* ======================================================================
   Déroulé
   ====================================================================== */

function main() {
  if (!existsSync(resolve(ROOT, '.git')))
    fail('Ce dossier n\'est pas un dépôt Git.',
         'Retéléchargez le projet avec « git clone ».');

  if (git('--version').status !== 0)
    fail('Git n\'est pas installé ou introuvable.', 'https://git-scm.com/downloads');

  /* ------------------------------------------------- état local */
  step('Vérification des modifications locales');
  const status = git('status', '--porcelain');
  const { generated, personal, untracked } = classifyChanges(status.stdout || '');

  if (generated.length) {
    step('Annulation des modifications générées par npm');
    for (const f of generated) {
      git('checkout', '--', f);
      ok(`${f} restauré`);
    }
  }

  if (personal.length) {
    warn(`${personal.length} fichier(s) modifié(s) localement :`);
    personal.forEach((f) => info(f));
    step('Mise de côté de vos modifications (git stash)');
    const r = git('stash', 'push', '-m', 'clinirdv-update');
    if (r.status !== 0) fail('Impossible de mettre de côté les modifications.', r.stderr.trim());
    ok('Modifications sauvegardées — récupérables avec « git stash pop »');
  }

  /* ------------------------------------------- branche de référence */
  const current = currentBranch(git);
  const { branch: target, source } = resolveDefaultBranch(git);
  if (source === 'defaut')
    warn(`Branche de référence du dépôt indéterminée — « ${target} » retenue`);

  step('Récupération de la dernière version');
  const fetched = git('fetch', 'origin', target);
  if (fetched.status !== 0)
    fail('Impossible de contacter le dépôt distant.',
         'Vérifiez votre connexion Internet, puis réessayez.\n' + fetched.stderr.trim());

  const before = git('rev-parse', 'HEAD').stdout.trim();

  if (current !== target) {
    warn(current
      ? `Cette copie est sur la branche « ${current} », qui ne reçoit plus de version publiée`
      : 'Cette copie n\'est sur aucune branche (HEAD détachée)');
    step(`Bascule sur la branche de référence « ${target} »`);
    const exists = git('rev-parse', '--verify', '--quiet', `refs/heads/${target}`).status === 0;
    const sw = exists
      ? git('checkout', target)
      : git('checkout', '-b', target, 'FETCH_HEAD');
    if (sw.status !== 0)
      fail(`Impossible de basculer sur « ${target} ».`,
           'Des fichiers non suivis occupent peut-être la place de fichiers versionnés.\n' +
           `Déplacez-les, puis relancez : git checkout ${target} && npm run update\n` +
           sw.stderr.trim());
    if (!exists) git('branch', `--set-upstream-to=origin/${target}`, target);
    ok(`Copie locale sur « ${target} »`);
  }

  const merged = git('merge', '--ff-only', 'FETCH_HEAD');
  if (merged.status !== 0) {
    // L'historique local a divergé : on se recale sur la version publiée.
    // Auparavant, ce réalignement emportait sans avertissement les fichiers
    // non suivis portant le nom d'un fichier nouvellement publié : on les
    // écarte sous un nom horodaté plutôt que de les perdre.
    warn('Historique local divergent — réalignement sur la version publiée');
    const doomed = untrackedCollisions(git, untracked, 'FETCH_HEAD');
    for (const f of doomed) {
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
      const kept = `${f}.local-${stamp}`;
      renameSync(resolve(ROOT, f), resolve(ROOT, kept));
      warn(`${f} aurait été écrasé — conservé sous ${kept}`);
    }
    const reset = git('reset', '--hard', 'FETCH_HEAD');
    if (reset.status !== 0) fail('Échec du réalignement.', reset.stderr.trim());
  }
  const after = git('rev-parse', 'HEAD').stdout.trim();

  if (before === after) {
    ok(`Vous avez déjà la dernière version (branche « ${target} »)`);
  } else {
    const log = git('log', '--oneline', `${before}..${after}`).stdout.trim();
    ok('Mise à jour effectuée');
    if (log) log.split('\n').forEach((l) => info(l));
  }

  if (untracked.length) {
    warn(`${untracked.length} fichier(s) présent(s) mais non suivi(s) — laissé(s) tels quels :`);
    untracked.slice(0, 10).forEach((f) => info(f));
  }

  /* ------------------------------------------------- dépendances */
  step('Mise à jour des dépendances');
  if (npmRun('install', '--no-audit', '--no-fund').status !== 0)
    fail('Échec de « npm install ».');
  ok('Dépendances à jour');

  /* ------------------------------------------ base de données */
  /*
   * Idempotent : « db.mjs start » n'a aucun effet si le serveur tourne déjà.
   * On interroge tout de même son état au préalable, car c'est lui qui décide
   * si la base doit être rendue arrêtée en fin de mise à jour.
   */
  step('Démarrage de la base de données');
  if (dbIsRunning()) {
    ok('PostgreSQL est déjà démarré — laissé en marche');
  } else {
    const r = dbRun('start', { stdio: 'inherit' });
    if (r.status !== 0)
      fail('Impossible de démarrer PostgreSQL : les migrations ne peuvent pas être appliquées.',
           'Lancez « npm run doctor » pour identifier le maillon en défaut.');
    dbStartedByUpdate = true;
    ok('PostgreSQL démarré pour la durée de la mise à jour');
  }

  /* ---------------------------------------------------- schéma */
  /*
   * Migrations appliquées à chaque mise à jour.
   *
   * Une version récupérée par `git pull` peut réclamer des colonnes que la base
   * locale n'a pas : sans cette étape, la mise à jour s'achevait sur un succès
   * apparent puis l'application échouait dès la connexion (« column
   * is_superuser does not exist »). `migrate` ne rejoue jamais une migration
   * déjà enregistrée : l'appeler systématiquement est sans risque et coûte
   * quelques dixièmes de seconde.
   *
   * Aucun `seed` ici : il écraserait les données réelles de la clinique.
   */
  step('Mise à jour du schéma de la base');
  if (npmRun('run', 'migrate').status !== 0)
    fail('Échec des migrations. La base n\'a pas été modifiée (chaque migration ' +
         'est appliquée dans une transaction).');
  ok('Schéma à jour');

  /* ----------------------------------------------- interface web */
  /*
   * Recompilation systématique — et non conditionnelle.
   *
   * Le navigateur ne lit jamais les sources : il lit `apps/web/dist`, produit
   * par Vite. Une mise à jour qui récupère le code sans recompiler laisse donc
   * l'utilisateur devant l'ANCIENNE interface, tout en croyant être à jour.
   * C'est exactement ce qui s'est produit : montants encore en euros et ancien
   * habillage après un `npm run update` pourtant réussi.
   *
   * Le coût est d'environ deux secondes. Aucune raison de l'éviter.
   */
  step('Recompilation de l\'interface');
  if (npmRun('run', 'build:web').status !== 0)
    fail('Échec de la compilation de l\'interface.');
  ok('Interface recompilée');

  /* ------------------------------------------------ état final */
  restoreDatabaseState();

  const stale = staleSessionBranches(git, target);
  if (stale.length) {
    warn(`${stale.length} branche(s) de session déjà fusionnée(s) subsiste(nt) localement :`);
    stale.forEach((b) => info(b));
    info('Suppression facultative : git branch -d ' + stale.join(' '));
  }

  console.log(`
  ${c(32, bold('Mise à jour terminée.'))}

  Lancez ensuite :  ${bold('npm run app')}
  En cas de souci :  ${bold('npm run doctor')}
`);
}

/*
 * Garde d'exécution : importer ce fichier (tests de contrat) ne doit rien
 * déclencher. La comparaison passe par pathToFileURL — une concaténation
 * « file://… » ne correspondrait jamais sous Windows.
 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
