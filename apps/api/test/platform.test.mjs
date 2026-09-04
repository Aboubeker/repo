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
