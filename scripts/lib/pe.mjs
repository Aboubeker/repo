/**
 * PE/COFF et Authenticode — maison, aucune dépendance.
 *
 * Pourquoi : le node.exe officiel est SIGNÉ (bloc de certificats en fin de
 * fichier). L'injection du blob SEA (postject) modifie le binaire et rend la
 * signature fausse ; Windows REFUSE alors d'exécuter un binaire signé dont
 * la signature ne vérifie plus. Il faut donc retirer la signature avant
 * l'injection.
 *
 * signtool remove ne fonctionne que sous Windows ; ce module fait la même
 * chose depuis n'importe quelle plateforme (fabrication croisée comprise) :
 *   1. effacer l'entrée « Certificate Table » du répertoire de données PE,
 *   2. tronquer le bloc de signature (toujours en fin de fichier).
 */

/* ------------------------------------------------------------- analyse -- */

/**
 * Analyse l'en-tête PE d'un buffer.
 *
 * @returns {null|{machine:number, pe32plus:boolean, sectionsEnd:number,
 *   dataDirectories:Array<{rva:number,size:number}>,
 *   certificate:{rva:number,size:number}, signed:boolean}}
 *   null si le buffer n'est pas un PE (pas MZ/PE).
 */
export function parsePe(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 0x40) return null;
  if (buf[0] !== 0x4D || buf[1] !== 0x5A) return null;   // « MZ »

  const e_lfanew = buf.readUInt32LE(0x3c);
  if (e_lfanew <= 0 || e_lfanew + 24 >= buf.length) return null;
  // Signature PE : « PE\0\0 »
  if (buf.readUInt32LE(e_lfanew) !== 0x00004550) return null;

  const machine = buf.readUInt16LE(e_lfanew + 4);
  const nSections = buf.readUInt16LE(e_lfanew + 6);
  const optSize = buf.readUInt16LE(e_lfanew + 20);
  const opt = e_lfanew + 24;
  if (opt + optSize > buf.length) return null;

  const magic = buf.readUInt16LE(opt);
  const pe32plus = magic === 0x20b;
  const pe32 = magic === 0x10b;
  if (!pe32 && !pe32plus) return null;

  const nRva = buf.readUInt32LE(opt + (pe32plus ? 108 : 92));
  const ddOff = opt + (pe32plus ? 112 : 96);
  const dataDirectories = [];
  for (let i = 0; i < nRva; i++) {
    dataDirectories.push({
      rva: buf.readUInt32LE(ddOff + i * 8),
      size: buf.readUInt32LE(ddOff + i * 8 + 4),
    });
  }

  // Fin des données brutes des sections : tout ce qui suit est l'« overlay »
  // (données annexes). Le bloc de certificats y vit, comme l'exige
  // Authenticode.
  const secOff = e_lfanew + 24 + optSize;
  let sectionsEnd = 0;
  for (let i = 0; i < nSections; i++) {
    const s = secOff + i * 40;
    if (s + 40 > buf.length) break;
    const rawSize = buf.readUInt32LE(s + 16);
    const rawPtr = buf.readUInt32LE(s + 20);
    sectionsEnd = Math.max(sectionsEnd, rawPtr + rawSize);
  }

  // Certificate Table : entrée n°4 du répertoire de données (constant de
  // l'API : IMAGE_DIRECTORY_ENTRY_SECURITY).
  const certificate = dataDirectories[4] || { rva: 0, size: 0 };
  return {
    machine,
    pe32plus,
    sectionsEnd,
    dataDirectories,
    certificate,
    signed: certificate.size > 0,
  };
}

/** Vrai si le buffer porte une signature Authenticode lisible. */
export function hasSignature(buf) {
  const pe = parsePe(buf);
  return !!(pe && pe.signed);
}

/* ------------------------------------------------------- suppression -- */

/**
 * Retire la signature Authenticode d'un PE.
 *
 * Le bloc de certificats est garanti par le format en fin de fichier
 * (WIN_CERTIFICATE.dwLength le borne) ; on tronque donc au début du bloc,
 * exactement ce que fait « signtool remove ». Si le certificat n'est pas
 * dans l'overlay (cas dérogatoire, jamais vu chez Node), on refuse plutôt
 * que de tronquer un binaire de manière hasardeuse.
 *
 * @returns {{buffer:Buffer, changed:boolean, removedBytes:number,
 *   certificate:{rva:number,size:number}|null}}
 */
export function stripSignature(buf) {
  const pe = parsePe(buf);
  if (!pe) throw new Error('binaire non PE : impossible de traiter la signature');
  if (!pe.signed) {
    return { buffer: buf, changed: false, removedBytes: 0, certificate: null };
  }

  const cert = pe.certificate;
  if (cert.rva < pe.sectionsEnd) {
    throw new Error(
      'certificat situé dans les sections (pas dans l\'overlay) : ' +
      'suppression manuelle requise sous Windows (signtool remove)');
  }
  if (cert.rva + cert.size > buf.length) {
    throw new Error(
      `bloc de certificat incohérent (rva ${cert.rva} + taille ${cert.size} > fichier ${buf.length})`);
  }

  const out = Buffer.alloc(cert.rva);
  buf.copy(out, 0, 0, cert.rva);

  // Effacer l'entrée « Certificate Table » du répertoire de données.
  const pe32plus = pe.pe32plus;
  const e_lfanew = buf.readUInt32LE(0x3c);
  const optSize = buf.readUInt16LE(e_lfanew + 20);
  const opt = e_lfanew + 24;
  const ddOff = opt + (pe32plus ? 112 : 96);
  out.writeUInt32LE(0, ddOff + 4 * 8);
  out.writeUInt32LE(0, ddOff + 4 * 8 + 4);

  return {
    buffer: out,
    changed: true,
    removedBytes: buf.length - cert.rva,
    certificate: { rva: cert.rva, size: cert.size },
  };
}
