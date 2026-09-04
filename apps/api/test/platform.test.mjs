/**
 * Tests de portabilité multi-plateforme.
 *
 * Ces cas couvrent des régressions qui ne se manifestent que sous Windows et
 * qu'une exécution sous Linux ne révèle jamais. Ils s'exécutent partout, en
 * simulant les valeurs produites par chaque système.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('Portabilité Windows / Linux / macOS', () => {

  test('la détection du point d\'entrée résiste aux chemins Windows', () => {
    // Sous Windows argv[1] = « C:\...\main.mjs » alors que import.meta.url
    // vaut « file:///C:/.../main.mjs ». La concaténation naïve échouait,
    // le serveur ne démarrait jamais et le processus sortait en silence.
    const winPath = 'C:\\Users\\User\\project\\apps\\api\\src\\main.mjs';
    const canonical = 'file:///C:/Users/User/project/apps/api/src/main.mjs';

    assert.notEqual(`file://${winPath}`, canonical,
      'la concaténation naïve doit bien être reconnue comme incorrecte');

    // La forme canonique est celle que produit pathToFileURL. On part d'un
    // chemin absolu *natif* : sous Windows, un chemin POSIX comme
    // « /home/... » serait ancre sur le lecteur courant (file:///E:/home/...),
    // ce qui ferait echouer le test pour une raison etrangere a ce qu'il
    // verifie. resolve() donne un chemin valide sur chaque systeme.
    const nativePath = resolve(ROOT, 'apps/api/src/main.mjs');
    const href = pathToFileURL(nativePath).href;

    assert.ok(href.startsWith('file:///'),
      'pathToFileURL doit produire une URL file:// canonique');
    assert.ok(!href.includes('\\'),
      'aucune barre inversee ne doit subsister dans une URL de fichier');
    assert.equal(fileURLToPath(href), nativePath,
      'la conversion doit etre reversible sur la plateforme courante');
  });

  test('main.mjs utilise pathToFileURL et non une concaténation de chaînes', () => {
    const src = readFileSync(resolve(ROOT, 'apps/api/src/main.mjs'), 'utf8');
    assert.match(src, /pathToFileURL\(/,
      'main.mjs doit comparer les URL via pathToFileURL()');
    assert.doesNotMatch(src, /import\.meta\.url === `file:\/\/\$\{/,
      'la comparaison « file://${...} » casse sous Windows');
  });

  test('le serveur démarre réellement via son point d\'entrée', () => {
    // Vérification de bout en bout : on lance main.mjs comme le fait
    // « npm start » et on s'assure qu'il écoute au lieu de sortir aussitôt.
    const r = spawnSync(process.execPath, [
      '-e', `
      process.env.PORT = '0';
      const { createServer } = await import(${JSON.stringify(
        pathToFileURL(resolve(ROOT, 'apps/api/src/main.mjs')).href)});
      const s = createServer();
      await new Promise((res) => s.listen(0, '127.0.0.1', res));
      const p = s.address().port;
      const r = await fetch('http://127.0.0.1:' + p + '/api/health');
      console.log('HEALTH:' + r.status);
      s.close(); process.exit(0);
      `,
      '--input-type=module',
    ], { encoding: 'utf8', cwd: ROOT, timeout: 30_000,
         env: { ...process.env, NODE_ENV: 'test' } });

    assert.match(r.stdout, /HEALTH:200/,
      `le serveur doit répondre. stdout=${r.stdout} stderr=${r.stderr}`);
  });

  test('les binaires PostgreSQL sont résolus pour la plateforme courante', () => {
    const src = readFileSync(resolve(ROOT, 'apps/api/src/modules/backup.service.mjs'), 'utf8');
    assert.doesNotMatch(src, /@embedded-postgres\/linux-x64/,
      'le chemin des binaires ne doit pas être figé sur linux-x64');
    assert.match(src, /process\.platform/,
      'la plateforme doit être détectée à l\'exécution');

    const dbSrc = readFileSync(resolve(ROOT, 'scripts/db.mjs'), 'utf8');
    assert.doesNotMatch(dbSrc, /'node_modules\/@embedded-postgres\/linux-x64/,
      'db.mjs ne doit pas figer linux-x64');
    assert.match(dbSrc, /win32.*\.exe|\.exe.*win32/s,
      'db.mjs doit ajouter le suffixe .exe sous Windows');
  });

  test('le paquet PostgreSQL de cette plateforme est bien installé', () => {
    const platform = { linux: 'linux', darwin: 'darwin', win32: 'windows' }[process.platform];
    const arch = { x64: 'x64', arm64: 'arm64' }[process.arch];
    const dir = resolve(ROOT, `node_modules/@embedded-postgres/${platform}-${arch}`);
    assert.ok(existsSync(dir),
      `le paquet @embedded-postgres/${platform}-${arch} doit être installé`);
  });

  test('.env ne contient pas de BOM UTF-8', () => {
    // PowerShell 5.1 (Set-Content -Encoding UTF8) ajoute un BOM qui rend la
    // première variable illisible pour « node --env-file ».
    const envPath = resolve(ROOT, '.env');
    if (!existsSync(envPath)) return;   // absent en intégration continue
    const raw = readFileSync(envPath);
    const hasBom = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
    assert.equal(hasBom, false, '.env ne doit pas commencer par un BOM UTF-8');
  });

  test('les scripts npm évitent la syntaxe shell propre à Unix', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
    for (const [name, cmd] of Object.entries(pkg.scripts)) {
      // « VAR=x commande » échoue sous PowerShell et cmd.exe.
      assert.doesNotMatch(cmd, /^[A-Z_]+=[^ ]* /,
        `le script « ${name} » utilise une affectation de variable Unix : ${cmd}`);
    }
  });
});

/* ======================================================================
   Chaîne de mise à jour
   ----------------------------------------------------------------------
   Le navigateur ne lit jamais les sources : il lit `apps/web/dist`, produit
   par Vite. Une mise à jour qui récupère le code sans recompiler laisse donc
   l'utilisateur devant l'ancienne interface tout en le croyant à jour.
   Symptôme observé : montants encore en euros après un `npm run update`
   pourtant réussi. Ces tests verrouillent la correction.
   ====================================================================== */
describe('Chaîne de mise à jour', () => {
  const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

  test('« npm run update » recompile l\'interface', () => {
    const s = read('scripts/update.mjs');
    assert.ok(/build:web/.test(s),
      'update.mjs récupère le code sans recompiler : l\'utilisateur verra ' +
      'l\'ancienne interface après une mise à jour réussie');
  });

  test('« npm run app » détecte un bundle périmé', () => {
    const s = read('scripts/app.mjs');
    // Il ne suffit pas de tester l'existence de dist/index.html : après un
    // git pull le fichier existe toujours, mais il est obsolète.
    assert.ok(/mtimeMs/.test(s),
      'app.mjs ne compare pas la date du bundle à celle des sources');
  });

  test('les comptes affichés au démarrage existent réellement', () => {
    // Les scripts annonçaient s.martin / a.bernard, renommés depuis en
    // s.amrani / a.benali : l'utilisateur ne pouvait pas se connecter.
    const seed = read('apps/api/src/db/seed.mjs');
    for (const f of ['scripts/app.mjs', 'install.sh', 'install.ps1']) {
      const shown = [...read(f).matchAll(/^\s{4}([a-z]\.[a-z]+)\s{2,}/gm)]
        .map((m) => m[1]);
      for (const account of shown) {
        assert.ok(seed.includes(`'${account}'`),
          `${f} annonce le compte « ${account} », absent du jeu de données`);
      }
    }
  });
});

/*
 * Panneau de controle Windows.
 *
 * L'utilisateur d'une clinique ne doit jamais ouvrir un terminal : le
 * raccourci du Bureau ouvre une fenetre graphique. Ces contrats verrouillent
 * les proprietes qu'une relecture ne garantit pas dans la duree, d'autant
 * qu'aucun PowerShell n'est disponible en integration continue.
 */
describe('Panneau de controle Windows', () => {
  const panel = () => readFileSync(resolve(ROOT, 'scripts/CliniRDV-Controle.ps1'), 'utf8');
  const launcher = () => readFileSync(resolve(ROOT, 'CliniRDV.cmd'), 'utf8');

  test('le panneau offre demarrage, arret et mise a jour', () => {
    const src = panel();
    for (const frag of ['$btnStart', '$btnStop', '$btnUpdate']) {
      assert.ok(src.includes(frag), `${frag} doit exister`);
    }
    assert.equal((src.match(/add_Click/g) || []).length, 5,
      'chaque bouton doit avoir son gestionnaire');
    assert.match(src, /ShowDialog/, 'la fenetre doit etre affichee');
  });

  test('le port vient de .env, jamais code en dur', () => {
    const src = panel();
    assert.match(src, /Select-String[^\n]*PORT/,
      'le port doit etre lu depuis .env');
    assert.ok(!src.includes('localhost:3001'),
      'un port fige ferait mentir l\'ecran si l\'exploitant l\'a change');
  });

  test('l\'arret passe par db.mjs, pas par un simple kill', () => {
    // Tuer le process laisserait un verrou PostgreSQL et la base
    // refuserait de redemarrer.
    assert.match(panel(), /db\.mjs'\)\s*stop/,
      'PostgreSQL doit etre arrete par son propre outil');
  });

  test('les fichiers Windows restent en ASCII sans BOM', () => {
    for (const [name, src] of [['CliniRDV.cmd', launcher()],
                               ['CliniRDV-Controle.ps1', panel()]]) {
      assert.ok(!src.startsWith('\uFEFF'),
        `${name} : un BOM ferait echouer la premiere commande`);
      const bad = [...src].filter((ch) => ch.charCodeAt(0) > 127);
      assert.deepEqual(bad, [],
        `${name} : la console Windows (page 850) afficherait ces caracteres en charabia`);
    }
  });

  test('le raccourci du Bureau ouvre le panneau', () => {
    const install = readFileSync(resolve(ROOT, 'install.ps1'), 'utf8');
    assert.match(install, /\$target\s*=\s*Join-Path \$PSScriptRoot 'CliniRDV\.cmd'/,
      'le raccourci doit cibler le panneau de controle');
    assert.match(launcher(), /-WindowStyle Hidden/,
      'aucune fenetre noire ne doit apparaitre');
  });
});

/*
 * Paquet d'installation distribue.
 *
 * Le paquet est fabrique sur un runner Windows et n'est donc pas verifiable
 * ici de bout en bout. Ces contrats verrouillent ce qui, s'il regressait,
 * livrerait le code source au client ou produirait un executable muet.
 */
describe('Paquet d\'installation', () => {
  const build = () => readFileSync(resolve(ROOT, 'scripts/build-package.mjs'), 'utf8');

  test('la racine est resolue par un seul module', () => {
    // Chaque fichier calculait sa propre racine en remontant un nombre de
    // niveaux different : une fois le code regroupe, ces chemins ne veulent
    // plus rien dire et les migrations sont introuvables.
    for (const f of ['apps/api/src/main.mjs', 'apps/api/src/db/migrate.mjs',
                     'apps/api/src/modules/backup.service.mjs']) {
      const src = readFileSync(resolve(ROOT, f), 'utf8');
      assert.match(src, /import \{[^}]*ROOT[^}]*\} from '[^']*core\/root\.mjs'/,
        `${f} doit importer ROOT depuis core/root.mjs`);
      assert.doesNotMatch(src, /const ROOT = resolve\(dirname\(fileURLToPath/,
        `${f} ne doit plus recalculer sa propre racine`);
    }
  });

  test('l\'executable se reconnait comme point d\'entree', () => {
    // process.versions.sea n'est pas renseigne partout : s'y fier laissait le
    // serveur se terminer sans le moindre message.
    const root = readFileSync(resolve(ROOT, 'apps/api/src/core/root.mjs'), 'utf8');
    assert.match(root, /node:sea/, 'la detection doit passer par node:sea');
    assert.match(readFileSync(resolve(ROOT, 'apps/api/src/main.mjs'), 'utf8'),
      /const isMain = isPackaged \|\|/,
      'l\'executable doit demarrer le serveur sans comparer import.meta.url');
  });

  test('aucun await au niveau racine : le format CommonJS l\'interdit', () => {
    for (const f of ['apps/api/src/main.mjs', 'apps/api/src/db/migrate.mjs']) {
      const src = readFileSync(resolve(ROOT, f), 'utf8');
      const bad = src.split('\n').filter((l) => /^\s{0,2}await /.test(l));
      assert.deepEqual(bad, [],
        `${f} : un await racine casserait la fabrication de l'executable`);
    }
  });

  test('les sourcemaps ne sont jamais distribuees', () => {
    // Une .map reconstitue le code React d'origine, commentaires compris.
    assert.match(build(), /endsWith\('\.map'\)/,
      'les sourcemaps doivent etre exclues du paquet');
    assert.match(build(), /sourceMappingURL/,
      'la reference residuelle doit etre retiree des fichiers livres');
  });

  test('le code distribue est minifie', () => {
    assert.match(build(), /--minify/,
      'le bundle doit etre minifie : sans cela le code reste lisible');
  });

  test('le paquet embarque les migrations', () => {
    // Elles sont lues a l'execution : sans elles, aucune base ne peut etre
    // creee sur le poste du client.
    assert.match(build(), /infra\/db/, 'infra/db doit etre copie dans le paquet');
    assert.match(readFileSync(resolve(ROOT, 'apps/api/src/main.mjs'), 'utf8'),
      /--migrate/, 'l\'executable doit savoir preparer la base');
  });

  test('la chaine de publication est declaree', () => {
    const wf = readFileSync(resolve(ROOT, '.github/workflows/release.yml'), 'utf8');
    assert.match(wf, /runs-on: windows-latest/,
      'un .exe Windows ne peut pas etre produit depuis Linux');
    assert.match(wf, /npm test/,
      'aucun paquet ne doit etre publie sans que la suite soit verte');
    assert.match(wf, /SHA256/,
      'une empreinte doit permettre de verifier l\'archive telechargee');
  });
});

/*
 * Regressions signalees en exploitation sur un poste Windows :
 * connexion impossible (erreur 500) et journal du panneau illisible.
 */
describe('Panneau de controle — demarrage et lisibilite', () => {
  const panel = () => readFileSync(resolve(ROOT, 'scripts/CliniRDV-Controle.ps1'), 'utf8');

  test('le bouton Demarrer lance aussi la base de donnees', () => {
    // « npm start » ne demarre que le serveur web : la base restait arretee
    // et toute connexion echouait en erreur 500.
    const src = panel();
    assert.match(src, /'npm', 'run', 'app'/,
      'le demarrage doit passer par « npm run app », qui demarre PostgreSQL');
    assert.doesNotMatch(src, /'npm', 'start'/,
      '« npm start » laisse la base a l\'arret');
  });

  test('la sortie des commandes est lue en UTF-8', () => {
    const src = panel();
    assert.match(src, /OutputEncoding = \[Text\.Encoding\]::UTF8/,
      'sans cela les accents s\'affichent en caracteres parasites');
    assert.match(src, /chcp 65001/,
      'la console appelee doit elle aussi passer en UTF-8');
    assert.doesNotMatch(src, /& cmd\.exe \/c "npm run/,
      'les commandes doivent passer par Invoke-Tool');
  });

  test('les symboles absents de la police sont convertis', () => {
    const src = panel();
    assert.match(src, /function Format-LogLine/,
      'les symboles decoratifs s\'afficheraient en carres vides');
    assert.match(src, /Write-Log[\s\S]{0,120}Format-LogLine/,
      'Write-Log doit appliquer la conversion');
  });
});

describe('Base de donnees injoignable', () => {
  test('l\'erreur dit quoi faire, au lieu d\'« erreur interne »', () => {
    const src = readFileSync(resolve(ROOT, 'apps/api/src/core/errors.mjs'), 'utf8');
    assert.match(src, /ECONNREFUSED/,
      'un refus de connexion a la base doit etre reconnu');
    assert.match(src, /DATABASE_UNAVAILABLE/,
      'le code d\'erreur doit etre explicite');
    assert.match(src, /panneau de contr/,
      'le message doit indiquer la marche a suivre');
    // 503 et non 500 : le service est temporairement indisponible, la
    // requete redeviendra valide une fois la base demarree.
    assert.match(src, /AppError\(503, 'DATABASE_UNAVAILABLE'/,
      'un service indisponible se signale par 503');
  });
});
