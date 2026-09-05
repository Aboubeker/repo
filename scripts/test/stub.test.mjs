/**
 * Tests du moteur d'installation (scripts/installer/stub.mjs).
 *
 * Tout est rejoué hors Windows : SELF est un faux exécutable
 * [octets de programme][archive ZIP] (CLINIRDV_INSTALLER_SELF), et le
 * contenu de l'archive contient un « CliniRDV » factice (script shell) qui
 * vérifie le contrat de --setup (fichier de mot de passe, cwd) sans rien
 * installer. Le contrat de sortie (PROGRESS / ERREUR) est contrôlé ici,
 * pas seulement supposé.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { writeZip, readZipIndex, extractSingleEntry } from '../lib/archive.mjs';
import { parseEnv } from '../../apps/api/src/core/env.mjs';
import {
  selfPath, inspectTarget, writeEnvFile, busyPort, pickFreePgPort,
  validatePassword, validatePort, install, readSelfArchive,
} from '../installer/stub.mjs';

const dir = mkdtempSync(join(tmpdir(), 'clinirdv-stub-'));
after(() => {
  delete process.env.CLINIRDV_INSTALLER_SELF;
  rmSync(dir, { recursive: true, force: true });
});

/* -------------------------------------------------------- faux SELF ----- */

const FAKE_APP = `#!/bin/sh
echo "FAKE-SETUP dans $(pwd)"
if [ -z "$CLINIRDV_ADMIN_PASSWORD_FILE" ]; then
  echo "fichier de mot de passe absent" >&2
  exit 3
fi
cp "$CLINIRDV_ADMIN_PASSWORD_FILE" "$PWD/.pw-seen"
exit 0
`;

const FAKE_SELF = join(dir, 'self.exe');
before(() => {
  // Le moteur est testé EN PROCESSUS (install() direct) et en processus
  // fils (CLI) : SELF est défini globalement ici.
  process.env.CLINIRDV_INSTALLER_SELF = FAKE_SELF;
  const zip = writeZip([
    { name: 'CliniRDV', type: 'file', data: Buffer.from(FAKE_APP), mode: 0o755 },
    { name: 'Assistant-Installation.ps1', type: 'file',
      data: Buffer.from('# assistant factice\n'), mode: 0o644 },
    { name: 'infra/db/001_x.sql', type: 'file', data: Buffer.from('SELECT 1;'), mode: 0o644 },
    { name: 'pg/bin/note.txt', type: 'file', data: Buffer.from('pg'), mode: 0o644 },
    { name: 'pg/lib/', type: 'dir', data: null, mode: 0o755 },
  ]);
  const program = Buffer.from('MZ-faux-programme-de-tete');
  writeFileSync(FAKE_SELF, Buffer.concat([program, zip]));
});

const withSelf = (env = {}) => ({ ...process.env, CLINIRDV_INSTALLER_SELF: FAKE_SELF, ...env });

/* ---------------------------------------------------------------- tests -- */

describe('selfPath / readSelfArchive', () => {
  test('CLINIRDV_INSTALLER_SELF l\'emporte sur execPath', () => {
    process.env.CLINIRDV_INSTALLER_SELF = '/fake/self';
    try { assert.equal(selfPath(), '/fake/self'); }
    finally { process.env.CLINIRDV_INSTALLER_SELF = FAKE_SELF; }
  });

  test('un fichier sans archive est rejeté', () => {
    const plain = join(dir, 'plain');
    writeFileSync(plain, 'rien d\'une archive');
    process.env.CLINIRDV_INSTALLER_SELF = plain;
    try {
      assert.throws(() => readSelfArchive(), /EOCD/);
    } finally {
      process.env.CLINIRDV_INSTALLER_SELF = FAKE_SELF;
    }
  });
});

describe('writeEnvFile', () => {
  test('création : 48 octets de secret JWT, 24 octets de mot de passe PG', () => {
    const d = join(dir, 'env-new');
    mkdirSync(d);
    const r = writeEnvFile(d, { clinicName: 'Clinique Test', port: 3111, pgPort: 55433 });
    assert.equal(r.created, true);
    const env = parseEnv(readFileSync(r.path, 'utf8'));
    assert.equal(env.CLINIC_NAME, 'Clinique Test');
    assert.equal(env.PORT, '3111');
    assert.equal(env.PGPORT, '55433');
    assert.match(env.JWT_SECRET, /^[0-9a-f]{96}$/, '48 octets en hexadécimal');
    assert.match(env.PGPASSWORD, /^[0-9a-f]{48}$/, '24 octets en hexadécimal');
    assert.equal(env.PGHOST, '127.0.0.1', 'la base n\'est jamais exposée');
  });

  test('jamais d\'écrasement : le .env existant est conservé à l\'identique', () => {
    const d = join(dir, 'env-kept');
    mkdirSync(d);
    const original = 'JWT_SECRET=secret-originel\nPORT=4000\n';
    writeFileSync(join(d, '.env'), original);
    const r = writeEnvFile(d, { clinicName: 'Autre', port: 3112, pgPort: 55434 });
    assert.equal(r.kept, true);
    assert.equal(r.created, false);
    assert.equal(readFileSync(join(d, '.env'), 'utf8'), original,
      'le .env existant ne doit subir AUCUNE modification');
  });
});

describe('ports', () => {
  test('busyPort : vrai sur un port en écoute, faux sur un port libre', async () => {
    const server = createServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    assert.equal(await busyPort(port), true);
    server.close();
    assert.equal(await busyPort(port + 1), false);
  });

  test('pickFreePgPort : évite le port occupé', async () => {
    // Port haut obtenu dynamiquement : 55432 est occupé par la base de
    // dev dans le sandbox, un port fixe serait une fausse faute.
    const server = createServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const busy = server.address().port;
    try {
      const p = await pickFreePgPort(busy, 5);
      assert.equal(p, busy + 1, 'le premier occupé doit être sauté');
    } finally {
      server.close();
    }
  });
});

describe('validations', () => {
  test('mot de passe : la politique est celle de l\'application', () => {
    assert.deepEqual(validatePassword('Test1234!abc'), []);
    assert.ok(validatePassword('court').length > 0);
    assert.ok(validatePassword('aaaaaaaaaaaaaaaa').length > 0,
      'une seule classe de caractères est insuffisante');
  });

  test('port : entier 1024..65535', () => {
    assert.equal(validatePort(3001), null);
    assert.equal(validatePort('3001'), null);
    assert.ok(validatePort(80));
    assert.ok(validatePort('abc'));
    assert.ok(validatePort(70000));
  });
});

describe('install() — le contrat complet', () => {
  const target = join(dir, 'install-1');

  test('installation vierge : extraction, .env, --setup, progression', async () => {
    const progress = [];
    const lines = [];
    await install({
      target, clinicName: 'Clinique Test', port: 3111,
      adminPassword: 'Test1234!abc',
      progress: (pct, msg) => progress.push([pct, msg]),
      log: (l) => lines.push(l),
    });

    // Progression : de 5 à 100, jamais décroissante, 100 en dernier.
    assert.ok(progress.length >= 4);
    assert.equal(progress[0][0], 5);
    assert.equal(progress[progress.length - 1][0], 100);
    for (let i = 1; i < progress.length; i++) {
      assert.ok(progress[i][0] >= progress[i - 1][0], 'progression monotone');
    }

    // Fichiers extraits, avec leur arborescence.
    assert.ok(existsSync(join(target, 'pg/bin/note.txt')));
    assert.ok(existsSync(join(target, 'infra/db/001_x.sql')));

    // .env créé avec les bonnes valeurs.
    const env = parseEnv(readFileSync(join(target, '.env'), 'utf8'));
    assert.equal(env.CLINIC_NAME, 'Clinique Test');
    assert.equal(env.PORT, '3111');
    assert.match(env.JWT_SECRET, /^[0-9a-f]{96}$/);

    // L'exécutable a tourné AVEC le mot de passe, dans le bon cwd…
    const pwSeen = readFileSync(join(target, '.pw-seen'), 'utf8');
    assert.equal(pwSeen, 'Test1234!abc');
    assert.ok(lines.some((l) => l.includes(`FAKE-SETUP dans ${target}`)),
      'le --setup doit tourner dans le dossier d\'installation');
    // …et le fichier de mot de passe n'existe plus.
    assert.equal(existsSync(join(target, '.admin-password.tmp')), false,
      'le fichier de mot de passe ne doit jamais survivre à l\'installation');
  });

  test('mise à jour : le .env (donc le secret JWT) est conservé', async () => {
    const before = readFileSync(join(target, '.env'), 'utf8');
    await install({
      target, clinicName: 'Clinique Test', port: 3111,
      adminPassword: 'Test1234!abc', update: true,
    });
    assert.equal(readFileSync(join(target, '.env'), 'utf8'), before,
      'une mise à jour ne doit jamais changer le secret JWT ni les identifiants');
  });

  test('mise à jour sans installation existante : refus', async () => {
    await assert.rejects(
      () => install({ target: join(dir, 'vide'), clinicName: 'X', port: 3112,
                      adminPassword: 'Test1234!abc', update: true }),
      /aucune installation/);
  });

  test('installation vierge sur un dossier porteur d\'une base : refus', async () => {
    const d = join(dir, 'avec-base');
    mkdirSync(join(d, '.pgdata'), { recursive: true });
    await assert.rejects(
      () => install({ target: d, clinicName: 'X', port: 3113, adminPassword: 'Test1234!abc' }),
      /base de données/);
  });

  test('port occupé : échec net, pas de forçage', async () => {
    const server = createServer();
    await new Promise((r) => server.listen(3211, '127.0.0.1', r));
    try {
      await assert.rejects(
        () => install({ target: join(dir, 'port-busy'), clinicName: 'X', port: 3211,
                        adminPassword: 'Test1234!abc' }),
        /port 3211/);
    } finally {
      server.close();
    }
  });

  test('paramètres invalides : refusés avant tout effet', async () => {
    await assert.rejects(
      () => install({ target: join(dir, 'x1'), clinicName: 'X', port: 80,
                      adminPassword: 'Test1234!abc' }), /Port/);
    await assert.rejects(
      () => install({ target: join(dir, 'x2'), clinicName: 'X', port: 3114,
                      adminPassword: 'court' }), /mot de passe/);
    assert.equal(existsSync(join(dir, 'x1')), false);
    assert.equal(existsSync(join(dir, 'x2')), false);
  });
});

describe('CLI', () => {
  const stub = new URL('../installer/stub.mjs', import.meta.url).pathname;

  test('--inspect renvoie l\'état du dossier', () => {
    const d = join(dir, 'inspect');
    mkdirSync(join(d, '.pgdata'), { recursive: true });
    writeFileSync(join(d, '.env'), 'PORT=3500\n');
    const r = spawnSync(process.execPath, [stub, '--inspect', d], {
      encoding: 'utf8', env: withSelf(),
    });
    assert.equal(r.status, 0, r.stderr);
    const info = JSON.parse(r.stdout);
    assert.equal(info.hasDatabase, true);
    assert.equal(info.port, 3500);
  });

  test('--verify-archive relit l\'archive de SELF sans écrire', () => {
    const r = spawnSync(process.execPath, [stub, '--verify-archive'], {
      encoding: 'utf8', env: withSelf(),
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Archive saine/);
  });

  test('--silent rejette une erreur sur stderr préfixée ERREUR', () => {
    const r = spawnSync(process.execPath,
      [stub, '--silent', '--target', join(dir, 'err'), '--name', 'X',
       '--port', '80', '--admin-password', 'Test1234!abc'],
      { encoding: 'utf8', env: withSelf() });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^ERREUR /m);
  });

  test('mode console (non-Windows) : les quatre valeurs au clavier', () => {
    const d = join(dir, 'console');
    const r = spawnSync(process.execPath, [stub], {
      encoding: 'utf8', env: withSelf(),
      input: `Clinique Console\n${d}\n3115\nTest1234!abc\n`,
      timeout: 30_000,
    });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.ok(existsSync(join(d, '.env')));
    const env = parseEnv(readFileSync(join(d, '.env'), 'utf8'));
    assert.equal(env.CLINIC_NAME, 'Clinique Console');
    assert.equal(env.PORT, '3115');
  });
});

describe('extractSingleEntry (assistant)', () => {
  test('extrait l\'assistant sans le reste de l\'archive', () => {
    const d = join(dir, 'single');
    const p = extractSingleEntry(readSelfArchive(), 'Assistant-Installation.ps1', d);
    assert.equal(readFileSync(p, 'utf8'), '# assistant factice\n');
    assert.equal(existsSync(join(d, 'pg')), false, 'le reste de l\'archive reste intact');
  });

  test('entrée absente : erreur explicite', () => {
    assert.throws(
      () => extractSingleEntry(readSelfArchive(), 'introuvable', join(dir, 'single2')),
      /absente/);
  });
});

describe('Assistant-Installation.ps1 — contrat de source', () => {
  const ps1 = () => readFileSync(new URL('../installer/Assistant-Installation.ps1', import.meta.url), 'utf8');

  test('ASCII strict, sans BOM (page de code 850)', () => {
    const src = ps1();
    assert.ok(!src.startsWith('\uFEFF'), 'un BOM ferait échouer la première commande');
    const bad = [...src].filter((ch) => ch.charCodeAt(0) > 127);
    assert.deepEqual(bad, [], 'la console Windows (page 850) afficherait ces caractères en charabia');
  });

  test('appelle le mode --silent, jamais une autre logique', () => {
    const src = ps1();
    assert.match(src, /--silent/);
    assert.match(src, /CLINIRDV_INSTALLER_SELF/);
    assert.doesNotMatch(src, /initdb|pg_ctl|CREATE DATABASE/i,
      'l\'assistant ne contient aucune mécanique d\'installation');
  });

  test('lit la progression au fil de l\'eau et vérifie le code de sortie', () => {
    const src = ps1();
    assert.match(src, /\^PROGRESS \(\\d\+\) \(\.\*\)\$/);
    assert.match(src, /BeginOutputReadLine/);
    assert.match(src, /WaitForExit\(100\)/);
    assert.match(src, /\$proc\.ExitCode/);
    assert.match(src, /if \(\$code -ne 0\)/);
  });

  test('quatre champs : nom, dossier, mot de passe deux fois, port', () => {
    const src = ps1();
    for (const frag of ['$txtName', '$txtFolder', '$txtPw', '$txtPw2', '$txtPort',
                        'FolderBrowserDialog', 'UseSystemPasswordChar']) {
      assert.ok(src.includes(frag), `${frag} doit exister`);
    }
    assert.match(src, /12 caracteres minimum/);
    assert.match(src, /\$pw -ne \$pw2/);
  });

  test('le mot de passe passe par un fichier temporaire, jamais en argument', () => {
    const src = ps1();
    assert.match(src, /--admin-password-file/);
    assert.doesNotMatch(src, /--admin-password '[^f]/,
      'le mot de passe ne doit jamais apparaître en argument de commande');
  });

  test('détecte une installation existante et propose la mise à jour', () => {
    const src = ps1();
    assert.match(src, /Test-Path \(Join-Path \$folder '\.pgdata'\)/);
    assert.match(src, /--update/);
  });

  // Régression v1.0.0 : une apostrophe non échappée dans une chaîne
  // PowerShell (« 'Dossier d'installation' ») refermait la chaîne au milieu
  // du mot et cascadait en dizaine d'erreurs de parsing sur Windows —
  // la console clignotait et se fermait sans que l'assistant ne s'ouvre.
  test('chaînes PowerShell équilibrées (apostrophes échappées)', () => {
    const bad = [];
    ps1().split('\n').forEach((line, n) => {
      let inStr = null;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inStr) {
          if (ch === inStr) {
            if (line[i + 1] === inStr) i++;      // '' ou "" : échappé
            else inStr = null;
          }
        } else if (ch === '#') {
          break;                                  // commentaire
        } else if (ch === "'" || ch === '"') {
          inStr = ch;
        }
      }
      if (inStr) bad.push(n + 1);
    });
    assert.deepEqual(bad, [],
      'guillemet non fermé (apostrophe à échapper en « \'\' ») : lignes ' + bad.join(', '));
  });
});
