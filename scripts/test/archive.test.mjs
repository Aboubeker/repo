/**
 * Tests du ZIP maison (scripts/lib/archive.mjs).
 *
 * Aucune dépendance externe : les tests rejouent les pires cas —
 * traversée de chemin, corruption CRC, symlinks, archive accolée derrière
 * un programme — et, quand python3 est disponible, croisent la lecture
 * avec le zipfile standard de Python (un second implementeur ne doit pas
 * trouver d'erreur là où nous en trouvons une).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync,
  lstatSync, symlinkSync, chmodSync, mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  crc32, collectEntries, writeZip, readZipIndex, extractZip, verifyZip,
  safeJoin,
} from '../lib/archive.mjs';

const dir = mkdtempSync(join(tmpdir(), 'clinirdv-zip-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const hasPython = spawnSync('python3', ['--version'], { encoding: 'utf8' }).status === 0;

describe('crc32', () => {
  test('valeur de référence IEEE 802.3', () => {
    assert.equal(crc32(Buffer.from('123456789', 'ascii')), 0xCBF43926);
  });
  test('vide', () => {
    assert.equal(crc32(Buffer.alloc(0)), 0);
  });
});

describe('collectEntries', () => {
  const src = join(dir, 'collect-src');
  before(() => {
    mkdirSync(join(src, 'sub'), { recursive: true });
    writeFileSync(join(src, 'b.txt'), 'bonjour');
    writeFileSync(join(src, 'a.txt'), 'a');
    writeFileSync(join(src, 'sub/c.txt'), 'c');
    const ex = join(src, 'run.sh');
    writeFileSync(ex, '#!/bin/sh\ntrue\n', { mode: 0o755 });
    symlinkSync('b.txt', join(src, 'lien.txt'));
    mkdirSync(join(src, 'vide'), { recursive: true });
  });

  test('tri déterministe, répertoires marqués « / »', () => {
    const entries = collectEntries(src, { verbatimSymlinks: true });
    const names = entries.map((e) => e.name);
    assert.deepEqual([...names].sort(), names, 'doit être trié');
    assert.ok(names.includes('sub/'));
    assert.ok(names.includes('vide/'));
    assert.ok(names.includes('sub/c.txt'));
  });

  test('verbatimSymlinks : le lien est archivé comme symlink', () => {
    const e = collectEntries(src, { verbatimSymlinks: true })
      .find((x) => x.name === 'lien.txt');
    assert.equal(e.type, 'symlink');
    assert.equal(e.data.toString(), 'b.txt');
  });

  test('sans verbatimSymlinks : le lien est matérialisé en fichier', () => {
    const e = collectEntries(src, { verbatimSymlinks: false })
      .find((x) => x.name === 'lien.txt');
    assert.equal(e.type, 'file');
    assert.equal(e.data.toString(), 'bonjour');
  });

  test('préfixe pour implanter l\'arbre', () => {
    const e = collectEntries(src, { prefix: 'pg', verbatimSymlinks: true });
    assert.ok(e.every((x) => x.name.startsWith('pg/')));
  });

  test('dossier absent : erreur explicite', () => {
    assert.throws(() => collectEntries(join(dir, 'inexistant')), /absent/);
  });
});

describe('writeZip / readZipIndex / extractZip', () => {
  test('aller-retour : contenus, dossiers, droit d\'exécution', () => {
    const src = join(dir, 'rt-src');
    const dst = join(dir, 'rt-dst');
    mkdirSync(join(src, 'bin'), { recursive: true });
    writeFileSync(join(src, 'fichier.txt'), 'contenu UTF-8 : àéè — ç');
    const tool = join(src, 'bin/outil');
    writeFileSync(tool, 'payload', { mode: 0o755 });
    writeFileSync(join(src, 'bin/plain'), 'x', { mode: 0o644 });
    const empty = join(src, 'vide.bin');
    writeFileSync(empty, '');

    const zip = writeZip(collectEntries(src));
    assert.ok(zip.length > 22, 'une archive n\'est jamais nulle');

    const idx = readZipIndex(zip);
    assert.ok(idx.count >= 5);

    const r = extractZip(zip, dst);
    assert.ok(r.files >= 4);
    assert.equal(readFileSync(join(dst, 'fichier.txt'), 'utf8'), 'contenu UTF-8 : àéè — ç');
    assert.equal(lstatSync(join(dst, 'bin/outil')).mode & 0o777, 0o755,
      'le droit d\'exécution doit survivre au trajet');
    assert.equal(lstatSync(join(dst, 'bin/plain')).mode & 0o777, 0o644);
    assert.equal(readFileSync(join(dst, 'vide.bin'), 'utf8'), '');
  });

  test('déflate : un fichier compressé relit à l\'identique', () => {
    const src = join(dir, 'big-src');
    const dst = join(dir, 'big-dst');
    mkdirSync(src);
    const data = Buffer.alloc(1024 * 256);
    for (let i = 0; i < data.length; i += 13) data[i] = (i % 251);
    writeFileSync(join(src, 'big.bin'), data);

    const zip = writeZip(collectEntries(src));
    assert.ok(zip.length < data.length, 'le deflate doit réellement compresser');
    extractZip(zip, dst);
    assert.deepEqual(readFileSync(join(dst, 'big.bin')), data);
  });

  test('symlink recréé sur POSIX, cible intacte', () => {
    const src = join(dir, 'ln-src');
    const dst = join(dir, 'ln-dst');
    mkdirSync(src);
    writeFileSync(join(src, 'cible.txt'), 'cible');
    symlinkSync('cible.txt', join(src, 'lien'));

    const zip = writeZip(collectEntries(src, { verbatimSymlinks: true }));
    const r = extractZip(zip, dst);
    assert.equal(r.symlinks, 1);
    const st = lstatSync(join(dst, 'lien'));
    assert.ok(st.isSymbolicLink(), 'le lien doit être un vrai symlink sur POSIX');
    assert.equal(readFileSync(join(dst, 'lien'), 'utf8'), 'cible');
  });

  test('archive accolée derrière un programme (prepend)', () => {
    const program = Buffer.from('MZ-fake-programme-à-tête-PE\x00\x00\x00');
    const zip = writeZip([
      { name: 'salut.txt', type: 'file', data: Buffer.from('dans l\'archive'), mode: 0o644 },
      { name: 'dossier/', type: 'dir', data: null, mode: 0o755 },
      { name: 'dossier/x', type: 'file', data: Buffer.from('x'), mode: 0o644 },
    ], { prepend: program });

    // Le fichier commence par le programme…
    assert.deepEqual(Buffer.from(zip.subarray(0, program.length)), program);
    // …et l'archive se lit quand même (EOCD en fin de fichier).
    const dst = join(dir, 'pre-dst');
    extractZip(zip, dst);
    assert.equal(readFileSync(join(dst, 'salut.txt'), 'utf8'), 'dans l\'archive');
    assert.equal(readFileSync(join(dst, 'dossier/x'), 'utf8'), 'x');
    const v = verifyZip(zip);
    assert.equal(v.files, 2);
  });

  test('python3 zipfile croise la lecture (si disponible)', { skip: !hasPython }, () => {
    const program = Buffer.from('PROGRAMME-FICTIF');
    const zip = writeZip([
      { name: 'a.txt', type: 'file', data: Buffer.from('alpha'), mode: 0o644 },
      { name: 'd/', type: 'dir', data: null, mode: 0o755 },
      { name: 'd/b.txt', type: 'file', data: Buffer.from('bravo'), mode: 0o755 },
    ], { prepend: program });
    const p = join(dir, 'py-check.zip');
    writeFileSync(p, zip);
    const r = spawnSync('python3', ['-c', `
import zipfile, sys
z = zipfile.ZipFile(${JSON.stringify(p)})
bad = z.testzip()
assert bad is None, bad
names = sorted(z.namelist())
assert names == ['a.txt', 'd/', 'd/b.txt'], names
assert z.read('d/b.txt') == b'bravo'
assert z.getinfo('d/b.txt').external_attr >> 16 & 0o777 == 0o755
print('PY-OK')
`], { encoding: 'utf8' });
    assert.match(r.stdout, /PY-OK/,
      `python3 zipfile ne lit pas notre archive : ${r.stderr}`);
  });

  test('python3 zipfile lit aussi l\'archive NON accolée', { skip: !hasPython }, () => {
    const zip = writeZip([{ name: 'seul.txt', type: 'file', data: Buffer.from('seul'), mode: 0o644 }]);
    const p = join(dir, 'py-plain.zip');
    writeFileSync(p, zip);
    const r = spawnSync('python3', ['-c',
      `import zipfile; z = zipfile.ZipFile(${JSON.stringify(p)}); assert z.testzip() is None; assert z.read('seul.txt') == b'seul'`],
      { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  });
});

describe('verifyZip', () => {
  test('archive saine : toutes les entrées relues', () => {
    const zip = writeZip([
      { name: 'a', type: 'file', data: Buffer.alloc(1000, 7), mode: 0o644 },
      { name: 'd/', type: 'dir', data: null, mode: 0o755 },
      { name: 'd/b', type: 'file', data: Buffer.from('bé'), mode: 0o644 },
    ]);
    const v = verifyZip(zip);
    assert.deepEqual({ files: v.files, dirs: v.dirs, symlinks: v.symlinks },
      { files: 2, dirs: 1, symlinks: 0 });
    // 1000 (a) + 3 (bé en UTF-8)
    assert.equal(v.bytes, 1003);
  });

  test('corruption d\'une entrée déflatée : détectée (décompression ou CRC)', () => {
    const zip = writeZip([{ name: 'a', type: 'file', data: Buffer.alloc(4096, 9), mode: 0o644 }]);
    // Le premier octet de données se trouve juste après l'entête locale
    // (30) + le nom (1).
    zip[31] ^= 0xFF;
    assert.throws(() => verifyZip(zip),
      'une corruption du flux deflate doit toujours être détectée');
  });

  test('corruption d\'une entrée stockée : détectée par le CRC', () => {
    // Les symlinks sont stockés bruts (méthode 0) : un octet altéré tombe
    // sur le CRC sans passer par la décompression.
    const zip = writeZip([
      { name: 'cible', type: 'file', data: Buffer.from('x'), mode: 0o644 },
      { name: 'lien', type: 'symlink', data: Buffer.from('cible'), mode: 0o777 },
    ]);
    const idx = readZipIndex(zip);
    const link = idx.entries.find((e) => e.name === 'lien');
    const o = link.localOffset + 30 + 4;   // entête (30) + nom (4)
    zip[o] ^= 0xFF;
    assert.throws(() => verifyZip(zip), /CRC/);
  });

  test('archive non ZIP : erreur propre', () => {
    assert.throws(() => verifyZip(Buffer.from('pas une archive')), /EOCD/);
  });
});

describe('safeJoin et anti-traversée', () => {
  test('chemin valide accepté', () => {
    const out = safeJoin('/cible', 'a/b/c.txt');
    assert.equal(resolve(out), resolve('/cible/a/b/c.txt'));
  });

  test('« .. » refusé', () => {
    assert.throws(() => safeJoin('/cible', '../../etc/passwd'), /traversée|dehors/i);
  });

  test('nom absolu refusé', () => {
    assert.throws(() => safeJoin('/cible', '/etc/passwd'), /absolu/);
  });

  test('octet nul refusé', () => {
    assert.throws(() => safeJoin('/cible', 'a\0b'), /nul/);
  });

  test('extraction : une entrée malveillante ne sort jamais du dossier', () => {
    const zip = writeZip([
      { name: 'bon.txt', type: 'file', data: Buffer.from('ok'), mode: 0o644 },
      { name: '../escape.txt', type: 'file', data: Buffer.from('x'), mode: 0o644 },
    ]);
    const dst = join(dir, 'mal-dst');
    assert.throws(() => extractZip(zip, dst), /traversée|dehors/i);
    assert.equal(existsSync(join(dir, 'escape.txt')), false,
      'aucun fichier ne doit exister hors du dossier cible');
  });
});
