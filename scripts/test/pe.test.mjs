/**
 * Tests du traitement PE/Authenticode (scripts/lib/pe.mjs).
 *
 * Un PE est un format strict : les tests construisent des binaires
 * synthétiques de bout en bout (en-têtes contrôlés) et rejouent les cas
 * réels — node.exe officiel signé, binaire non signé, certificat hors
 * overlay — ainsi que le non-PE. Si CLINIRDV_TEST_NODE_EXE pointe sur un
 * vrai node.exe Windows signé, il est utilisé en plus du synthétique.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { parsePe, hasSignature, stripSignature } from '../lib/pe.mjs';

/* ------------------------------------------------- PE synthétique -- */

/**
 * Construit un PE32+ minimal, valide et contrôlé :
 *   - une section .text (VA 0x1000, données brutes 0x200..0x1200),
 *   - un répertoire de données avec export (rva 0x1000) et, au besoin,
 *     une entrée Certificate Table,
 *   - optionnellement un bloc WIN_CERTIFICATE en fin de fichier (overlay).
 */
function buildPe({ signed = false, certInSection = false } = {}) {
  const CERT_RVA = 0x1200;
  const CERT_LEN = 96;
  const total = CERT_RVA + (signed ? CERT_LEN : 0);
  const buf = Buffer.alloc(total, 0);

  // DOS header
  buf.write('MZ', 0, 'ascii');
  buf.writeUInt32LE(0x40, 0x3c);   // e_lfanew

  // Signature PE + en-tête COFF
  buf.writeUInt32LE(0x00004550, 0x40);          // « PE\0\0 »
  buf.writeUInt16LE(0x8664, 0x44);              // machine : x64
  buf.writeUInt16LE(1, 0x46);                   // une section
  buf.writeUInt16LE(0xF0, 0x54);                // SizeOfOptionalHeader (offset COFF 16)

  // En-tête optionnel PE32+
  const OPT = 0x58;
  buf.writeUInt16LE(0x20b, OPT);                // magic PE32+
  // 16 répertoires de données : le Certificate Table est l'entrée n°4,
  // il ne serait pas lu avec un compte plus bas (l'optionnel PE32+ fait
  // exactement 240 octets pour 16 entrées).
  buf.writeUInt32LE(16, OPT + 108);
  const DD = OPT + 112;
  buf.writeUInt32LE(0x1000, DD + 0 * 8);        // [0] export : rva 0x1000
  buf.writeUInt32LE(0x10, DD + 0 * 8 + 4);      //     export : taille 0x10
  if (signed) {
    const rva = certInSection ? 0x1100 : CERT_RVA;
    buf.writeUInt32LE(rva, DD + 4 * 8);         // [4] Certificate Table
    buf.writeUInt32LE(certInSection ? 32 : CERT_LEN, DD + 4 * 8 + 4);
  }

  // Table de sections (après l'optionnel : 0x58 + 0xF0 = 0x148)
  const SEC = 0x148;
  buf.write('.text\0\0\0', SEC, 'ascii');
  buf.writeUInt32LE(0x1000, SEC + 8);           // VirtualSize
  buf.writeUInt32LE(0x1000, SEC + 12);          // VirtualAddress
  buf.writeUInt32LE(0x1000, SEC + 16);          // SizeOfRawData
  buf.writeUInt32LE(0x200, SEC + 20);           // PointerToRawData
  buf.writeUInt32LE(0x60000020, SEC + 36);      // Characteristics (DWORD)

  // Données brutes de la section : 0x200..0x1200 (marque visible après strip)
  buf.fill(0xAB, 0x200, CERT_RVA);

  if (signed) {
    const rva = certInSection ? 0x1100 : CERT_RVA;
    // WIN_CERTIFICATE
    const len = certInSection ? 32 : CERT_LEN;
    buf.writeUInt32LE(len, rva);                // dwLength
    buf.writeUInt16LE(0x0200, rva + 4);         // wRevision
    buf.writeUInt16LE(0x0002, rva + 6);         // wCertType = X509
    buf.fill(0xCD, rva + 8, rva + len);         // « certificat » fictif
  }

  return buf;
}

describe('parsePe', () => {
  test('reconnaît un PE32+ x64', () => {
    const pe = parsePe(buildPe());
    assert.ok(pe, 'le PE synthétique doit être reconnu');
    assert.equal(pe.machine, 0x8664);
    assert.equal(pe.pe32plus, true);
    assert.equal(pe.sectionsEnd, 0x200 + 0x1000);
    assert.equal(pe.signed, false);
  });

  test('lit l\'entrée Certificate Table', () => {
    const pe = parsePe(buildPe({ signed: true }));
    assert.equal(pe.signed, true);
    assert.equal(pe.certificate.rva, 0x1200);
    assert.equal(pe.certificate.size, 96);
    assert.equal(hasSignature(buildPe({ signed: true })), true);
  });

  test('refuse un non-PE proprement', () => {
    assert.equal(parsePe(Buffer.from('rien à voir ici')), null);
    assert.equal(parsePe(Buffer.alloc(10)), null);
    const elf = Buffer.alloc(0x40);
    elf.write('\x7fELF', 0);
    assert.equal(parsePe(elf), null, 'un ELF n\'est pas un PE');
  });
});

describe('stripSignature', () => {
  test('tronque le bloc et efface l\'entrée Certificate Table', () => {
    const signed = buildPe({ signed: true });
    const { buffer, changed, removedBytes, certificate } = stripSignature(signed);

    assert.equal(changed, true);
    assert.equal(certificate.rva, 0x1200);
    assert.equal(removedBytes, 96, 'le bloc complet est retiré');
    assert.equal(buffer.length, 0x1200, 'troncature au début du bloc');

    const pe = parsePe(buffer);
    assert.equal(pe.signed, false, 'plus de certificat après suppression');
    assert.equal(pe.certificate.size, 0);
    // Les autres répertoires de données et la section sont intacts.
    assert.equal(pe.dataDirectories[0].rva, 0x1000, 'l\'export table subsiste');
    assert.equal(buffer[0x11FF], 0xAB, 'les données de section sont intactes');
    assert.equal(buffer[0x800], 0xAB);
  });

  test('un binaire non signé est rendu à l\'identique', () => {
    const plain = buildPe();
    const { buffer, changed } = stripSignature(plain);
    assert.equal(changed, false);
    assert.equal(buffer, plain, 'aucune copie inutile : même buffer');
  });

  test('certificat dans une section : refusé, jamais tronqué au hasard', () => {
    const odd = buildPe({ signed: true, certInSection: true });
    assert.throws(() => stripSignature(odd), /overlay|sections/i);
  });

  test('non-PE : erreur explicite', () => {
    assert.throws(() => stripSignature(Buffer.from('MZ mais pas PE')),
      /non PE/);
  });

  test('sur un vrai node.exe signé (si fourni)', {
    skip: !process.env.CLINIRDV_TEST_NODE_EXE || !existsSync(process.env.CLINIRDV_TEST_NODE_EXE),
  }, () => {
    const buf = readFileSync(process.env.CLINIRDV_TEST_NODE_EXE);
    const pe = parsePe(buf);
    assert.ok(pe, 'node.exe doit être un PE');
    assert.equal(pe.machine, 0x8664, 'node.exe x64');
    assert.equal(pe.signed, true, 'le node.exe officiel est signé');
    assert.ok(pe.certificate.rva >= pe.sectionsEnd,
      'le certificat vit dans l\'overlay');

    // Le bloc de certificats est borné par WIN_CERTIFICATE.dwLength et,
    // pour Authenticode, touche la fin du fichier.
    const dwLength = buf.readUInt32LE(pe.certificate.rva);
    assert.equal(pe.certificate.rva + dwLength, buf.length,
      'le bloc de signature doit atteindre la fin du fichier (stratégie de troncature)');
    assert.equal(buf.readUInt16LE(pe.certificate.rva + 6), 0x0002, 'certificat X509');

    const { buffer, changed, removedBytes } = stripSignature(buf);
    assert.equal(changed, true);
    assert.equal(buffer.length, pe.certificate.rva);
    assert.equal(removedBytes, dwLength);
    assert.equal(parsePe(buffer).signed, false);
    assert.equal(hasSignature(buffer), false);
    // Le reste du binaire est bit-à-bit identique, SAUF l'entrée
    // Certificate Table (8 octets) que l'on vient d'effacer à zéro.
    const diff = [];
    for (let i = 0; i < buffer.length; i++) {
      if (buffer[i] !== buf[i]) diff.push(i);
    }
    assert.ok(diff.length > 0 && diff.length <= 8,
      `seule l'entrée cert doit différer (obtenu ${diff.length} octets)`);
    assert.ok(diff.every((i) => buffer[i] === 0), 'l\'entrée cert est passée à zéro');
    assert.equal(Math.max(...diff) - Math.min(...diff), diff.length - 1,
      'les octets modifiés sont consécutifs (une entrée du répertoire de données)');
  });
});
