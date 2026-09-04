/**
 * ZIP minimal, maison — aucune dépendance.
 *
 * Sert à la fabrication de l'installateur unique :
 *   - writeZip({ prepend }) accole l'archive DERRIERE un programme :
 *     les décalages du ZIP sont ABSOLUS dans le fichier final, si bien que
 *     tout lecteur partant de l'EOCD (fin de fichier) sait la retrouver ;
 *   - extractZip relit avec vérification du CRC de chaque entrée, anti-
 *     traversée de chemin, symlinks et droits d'exécution ;
 *   - verifyZip relit SANS écrire (auto-contrôle de fabrication croisée,
 *     où un .exe ne peut pas être exécuté).
 *
 * Compression : deflate (node:zlib, intégré à Node) pour les fichiers,
 * stockage brut pour les répertoires et les symlinks.
 */
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync,
  rmSync, statSync, symlinkSync, writeFileSync, chmodSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

/* ------------------------------------------------------------------ CRC -- */

let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  CRC_TABLE = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    CRC_TABLE[n] = c >>> 0;
  }
  return CRC_TABLE;
}

export function crc32(buf) {
  const t = crcTable();
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/* ------------------------------------------------------- horodatage DOS -- */

/** Date/heure DOS (années minimales : 1980, secondes coupées). */
function dosDateTime(d) {
  if (!(d instanceof Date)) d = new Date(2024, 0, 1);
  const y = Math.max(1980, d.getFullYear());
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/* ------------------------------------------------------------ collecte -- */

/**
 * Collecte l'arbre de rootDir en entrées ZIP déterministes (tri alphabétique).
 *
 * @param {string} rootDir racine collectée (les noms sont relatifs à celle-ci)
 * @param {object} [opts]
 * @param {string} [opts.prefix] préfixe des noms (ex. « pg » pour déposer
 *   l'arbre sous pg/ à l'extraction)
 * @param {boolean} [opts.verbatimSymlinks] si true, les symlinks sont
 *   archivés comme tels (type + cible) ; sinon ils sont MATÉRIALISÉS
 *   (contenu du fichier pointé) — indispensable sur Windows, où créer un
 *   symlink exige le mode développeur.
 * @returns {Array<{name:string, type:'file'|'dir'|'symlink',
 *   data:Buffer|null, mode:number, mtime:Date|null}>}
 */
export function collectEntries(rootDir, { prefix = '', verbatimSymlinks = false } = {}) {
  const root = resolve(rootDir);
  if (!existsSync(root)) throw new Error(`dossier à collecter absent : ${root}`);
  const out = [];

  const walk = (dir, rel) => {
    const names = readdirSync(dir, { withFileTypes: true })
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      const abs = join(dir, name);
      const relName = rel ? `${rel}/${name}` : name;
      const zipName = prefix ? `${prefix}/${relName}` : relName;

      let lst;
      try { lst = lstatSync(abs); } catch { continue; }   // entrée disparue

      if (lst.isSymbolicLink()) {
        const target = readlinkSync(abs);
        if (verbatimSymlinks) {
          out.push({ name: zipName, type: 'symlink', data: Buffer.from(target, 'utf8'),
                     mode: 0o777, mtime: null });
        } else {
          // Matérialisation : le contenu du fichier pointé est archivé.
          // Un lien brisé ou vers un non-fichier est une erreur de build,
          // pas un silence.
          const resolved = resolve(dirname(abs), target);
          const rt = statSync(resolved);
          if (!rt.isFile()) throw new Error(`symlink vers un non-fichier : ${zipName} -> ${target}`);
          out.push({ name: zipName, type: 'file', data: readFileSync(resolved),
                     mode: rt.mode & 0o777, mtime: rt.mtime });
        }
        continue;
      }

      if (lst.isDirectory()) {
        out.push({ name: zipName + '/', type: 'dir', data: null,
                   mode: (lst.mode & 0o777) || 0o755, mtime: lst.mtime });
        walk(abs, relName);
      } else if (lst.isFile()) {
        out.push({ name: zipName, type: 'file', data: readFileSync(abs),
                   mode: lst.mode & 0o777, mtime: lst.mtime });
      }
    }
  };

  walk(root, '');
  return out;
}

/* ------------------------------------------------------------- écriture -- */

/**
 * Produit un ZIP.
 *
 * @param {Array} entries entrées (collectEntries ou construites à la main)
 * @param {object} [opts]
 * @param {Buffer} [opts.prepend] octets à placer AVANT l'archive (le
 *   programme). Les décalages du ZIP sont alors ABSOLUS dans le fichier
 *   final, ce qui permet à un lecteur standard de retrouver l'archive en
 *   partant de l'EOCD.
 * @returns {Buffer} [prepend][archive ZIP]
 */
export function writeZip(entries, { prepend = null } = {}) {
  const shift = prepend ? prepend.length : 0;
  const locals = [];
  const central = [];
  let pos = shift;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const isDir = e.type === 'dir';
    const isLink = e.type === 'symlink';
    const data = isDir ? Buffer.alloc(0) : (e.data || Buffer.alloc(0));
    const method = (!isDir && !isLink && data.length) ? 8 : 0;
    const stored = method === 8 ? deflateRawSync(data, { level: 6 }) : data;
    const crc = crc32(data);
    const { time, date } = dosDateTime(e.mtime);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);            // version nécessaire
    lh.writeUInt16LE(0, 6);             // drapeaux
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 16);
    lh.writeUInt32LE(stored.length, 20);
    lh.writeUInt32LE(data.length, 24);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);            // extra : aucun
    locals.push(lh, nameBuf, stored);

    // Attributs externes : bits de type Unix (0o100000 fichier, 0o400000
    // répertoire, 0o120000 symlink) + permissions, sur 16 bits.
    const unixType = isDir ? 0o40000 : isLink ? 0o120000 : 0o100000;
    const mode = isLink ? 0o777 : (e.mode & 0o777) || (isDir ? 0o755 : 0o644);
    const external = ((unixType | mode) << 16) >>> 0;

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(0x031e, 4);        // fait par : unix, version 2.0
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(stored.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);            // extra
    ch.writeUInt16LE(0, 32);            // commentaire
    ch.writeUInt16LE(0, 34);            // disque
    ch.writeUInt16LE(0, 36);            // attributs internes
    ch.writeUInt32LE(external, 38);
    ch.writeUInt32LE(pos, 42);          // offset du local (déjà décalé)
    central.push(ch, nameBuf);

    pos += lh.length + nameBuf.length + stored.length;
  }

  const cdStart = pos;
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat(
    (prepend ? [prepend] : []).concat(Buffer.concat(locals), cd, eocd));
}

/* -------------------------------------------------------------- lecture -- */

/**
 * Localise et lit l'index (EOCD + répertoire central) d'une archive, même
 * accolée derrière d'autres octets : la recherche part de la fin du buffer.
 *
 * Deux conventions d'offsets sont acceptées :
 *   1. ABSOLUS dans le fichier final (writeZip avec prepend) — le cas de
 *      fabrication de cet installateur ;
 *   2. relatifs au début de l'archive (conforme à la spec) — le cas d'une
 *      archive « standard » accolée derrière un programme par un outil
 *      tiers. Le vrai début de l'archive est alors retrouvé par essai :
 *      chaque occurrence de la signature d'un entête local est un candidat,
 *      et seul celui dont le répertoire central s'enchaîne exactement sur
 *      cdSize octets (signatures incluses) est retenu.
 *
 * Les offsets d'entrée sont TOUJOURS absolus dans le buffer renvoyé.
 *
 * @returns {{entries:Array, count:number, cdOffset:number, eocdOffset:number}}
 */
export function readZipIndex(buf) {
  // L'EOCD est en fin de fichier (recherche limitée comme les lecteurs
  // standards : 64 Ko + commentaire maximal).
  const min = Math.max(0, buf.length - 65557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('EOCD introuvable : pas une archive ZIP lisible');

  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);

  /** Relie le répertoire central à partir de p0 ; null si incohérent. */
  const parseCentral = (p0) => {
    const out = [];
    let p = p0;
    let firstCentralNameLen = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) return null;
      const method = buf.readUInt16LE(p + 10);
      const crc = buf.readUInt32LE(p + 16);
      const compSize = buf.readUInt32LE(p + 20);
      const uncompSize = buf.readUInt32LE(p + 24);
      const nameLen = buf.readUInt16LE(p + 28);
      const extraLen = buf.readUInt16LE(p + 30);
      const commentLen = buf.readUInt16LE(p + 32);
      const external = buf.readUInt32LE(p + 38);
      const localOffset = buf.readUInt32LE(p + 42);
      if (i === 0) firstCentralNameLen = nameLen;
      const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
      const mode = external >>> 16;

      out.push({
        name, method, crc, compSize, uncompSize, localOffset,
        mode,
        isDir: (mode & 0xF000) === 0x4000 || name.endsWith('/'),
        isSymlink: (mode & 0xF000) === 0xA000,
        fileMode: mode & 0o777,
      });
      p += 46 + nameLen + extraLen + commentLen;
    }
    if (p - p0 !== cdSize) return null;
    return { out, firstCentralNameLen };
  };

  // Convention 1 : offsets absolus (fabrication maison).
  let parsed = parseCentral(cdOffset);
  let base = 0;

  // Convention 2 : offsets relatifs — recherche du vrai début de l'archive.
  if (!parsed) {
    const sigLocal = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
    for (let i = buf.indexOf(sigLocal); i >= 0; i = buf.indexOf(sigLocal, i + 1)) {
      const p0 = cdOffset + i;
      if (p0 + cdSize > eocd) break;
      const cand = parseCentral(p0);
      if (!cand) continue;
      // Le premier entête local du candidat doit porter le même nom que le
      // premier du répertoire central — sinon c'est un faux positif.
      if (i + 30 > buf.length) continue;
      if (buf.readUInt16LE(i + 26) !== cand.firstCentralNameLen) continue;
      parsed = cand;
      base = i;
      break;
    }
  }
  if (!parsed) {
    throw new Error(`entête central corrompu (début d'archive introuvable, offset déclaré ${cdOffset})`);
  }

  for (const e of parsed.out) e.localOffset += base;
  return { entries: parsed.out, count, cdOffset: cdOffset + base, eocdOffset: eocd };
}

/** Décode le corps d'une entrée à partir de son entête local. */
function readEntryData(buf, entry) {
  const o = entry.localOffset;
  if (buf.readUInt32LE(o) !== 0x04034b50) {
    throw new Error(`entête local corrompu pour « ${entry.name} »`);
  }
  const nameLen = buf.readUInt16LE(o + 26);
  const extraLen = buf.readUInt16LE(o + 28);
  const dataStart = o + 30 + nameLen + extraLen;
  const stored = buf.subarray(dataStart, dataStart + entry.compSize);
  return entry.method === 8 ? inflateRawSync(stored) : Buffer.from(stored);
}

/* ----------------------------------------------------------- extraction -- */

/**
 * Joint sûr : refuse les noms absolus, les « .. » et tout ce qui mènerait
 * hors du dossier cible (traversée de chemin — le mal classique des
 * archives d'installateurs).
 */
export function safeJoin(dest, name) {
  if (name.includes('\0')) throw new Error(`nom invalide (octet nul) : ${name}`);
  if (name.startsWith('/')) throw new Error(`nom absolu refusé : ${name}`);
  for (const part of name.split('/')) {
    if (part === '..') throw new Error(`traversée de chemin refusée : ${name}`);
  }
  const root = resolve(dest);
  const out = resolve(root, name);
  if (out !== root && !out.startsWith(root + sep)) {
    throw new Error(`chemin en dehors du dossier cible : ${name}`);
  }
  return out;
}

/**
 * Extrait une archive dans dest (créée si absente).
 *
 * - CRC vérifié pour chaque entrée (corruption = arrêt net) ;
 * - anti-traversée de chemin ;
 * - symlinks : recréés sur POSIX ; sur Windows (où symlinkSync exige le
 *   mode développeur), le fichier pointé est matérialisé s'il est dans
 *   l'archive ;
 * - droits d'exécution restaurés sur POSIX (mode Unix de l'entrée).
 *
 * @param {object} [opts]
 * @param {boolean} [opts.overwrite=true] autoriser l'écrasement
 * @param {function} [opts.onEntry] appelée avec l'entrée après traitement
 *   (progression de l'installateur : « PROGRESS <pct> »).
 * @returns {{files:number, dirs:number, symlinks:number, bytes:number}}
 */
export function extractZip(buf, dest, { overwrite = true, onEntry } = {}) {
  const { entries } = readZipIndex(buf);
  const root = resolve(dest);
  mkdirSync(root, { recursive: true });

  let files = 0, dirs = 0, symlinks = 0, bytes = 0;

  // Passe 1 : répertoires (les noms finissent par « / »).
  for (const e of entries) {
    if (!e.isDir) continue;
    mkdirSync(safeJoin(root, e.name.replace(/\/+$/, '') || '.'), { recursive: true });
    dirs++;
    onEntry?.(e);
  }

  // Passe 2 : fichiers (vérification CRC + écriture + droits).
  for (const e of entries) {
    if (e.isDir || e.isSymlink) continue;
    const data = readEntryData(buf, e);
    if (crc32(data) !== e.crc) {
      throw new Error(`CRC invalide pour « ${e.name} » : archive corrompue`);
    }
    const out = safeJoin(root, e.name);
    mkdirSync(dirname(out), { recursive: true });
    if (existsSync(out) && !overwrite) throw new Error(`fichier déjà présent : ${e.name}`);
    writeFileSync(out, data);
    if (process.platform !== 'win32') chmodSync(out, e.fileMode || 0o644);
    files++;
    bytes += data.length;
    onEntry?.(e);
  }

  // Passe 3 : symlinks (après les fichiers : la cible est disponible pour
  // la matérialisation sous Windows).
  for (const e of entries) {
    if (!e.isSymlink) continue;
    const o = e.localOffset;
    const nameLen = buf.readUInt16LE(o + 26);
    const extraLen = buf.readUInt16LE(o + 28);
    const target = buf.toString('utf8', o + 30 + nameLen + extraLen,
                                o + 30 + nameLen + extraLen + e.compSize);
    const out = safeJoin(root, e.name);
    mkdirSync(dirname(out), { recursive: true });
    if (existsSync(out) || isLink(out)) rmSync(out, { force: true });
    if (process.platform === 'win32') {
      // Matérialisation : la cible doit être dans l'archive.
      const parts = [];
      for (const part of dirname(e.name).split('/')) if (part && part !== '.') parts.push(part);
      for (const part of target.split('/')) {
        if (part === '..') parts.pop();
        else if (part && part !== '.') parts.push(part);
      }
      const targetEntry = entries.find((x) => x.name === parts.join('/') && !x.isDir);
      if (!targetEntry) {
        throw new Error(`symlink hors de l'archive, impossible à matérialiser : ${e.name} -> ${target}`);
      }
      const data = readEntryData(buf, targetEntry);
      if (crc32(data) !== targetEntry.crc) throw new Error(`CRC invalide pour « ${targetEntry.name} »`);
      writeFileSync(out, data);
    } else {
      symlinkSync(target, out);
    }
    symlinks++;
    onEntry?.(e);
  }

  return { files, dirs, symlinks, bytes };
}

/**
 * Extrait UNE SEULE entrée (vérification CRC + joint sûr) — sans le reste
 * de l'archive. L'installateur en GUI s'en sert pour déposer l'assistant
 * PowerShell dans un dossier temporaire sans extraire les ~40 Mo de
 * PostgreSQL.
 *
 * @returns {string} chemin du fichier écrit.
 */
export function extractSingleEntry(buf, entryName, destDir) {
  const { entries } = readZipIndex(buf);
  const e = entries.find((x) => x.name === entryName);
  if (!e) throw new Error(`entrée absente de l'archive : ${entryName}`);
  if (e.isDir) throw new Error(`entrée est un répertoire : ${entryName}`);
  const root = resolve(destDir);
  const out = safeJoin(root, entryName);
  mkdirSync(dirname(out), { recursive: true });
  const data = readEntryData(buf, e);
  if (crc32(data) !== e.crc) {
    throw new Error(`CRC invalide pour « ${entryName} » : archive corrompue`);
  }
  writeFileSync(out, data);
  if (process.platform !== 'win32') chmodSync(out, e.fileMode || 0o644);
  return out;
}

function isLink(p) {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

/* ------------------------------------------------------------ contrôle -- */

/**
 * Auto-contrôle sans écriture : relit TOUTES les entrées (décompression +
 * CRC + taille). C'est le substitut de « exécuter le binaire » en
 * fabrication croisée, où un .exe Windows ne s'exécute pas sous Linux.
 *
 * @returns {{entries:number, files:number, dirs:number, symlinks:number,
 *   bytes:number}}
 */
export function verifyZip(buf) {
  const { entries, count } = readZipIndex(buf);
  let files = 0, dirs = 0, symlinks = 0, bytes = 0;
  for (const e of entries) {
    if (e.isDir) { dirs++; continue; }
    const data = readEntryData(buf, e);
    if (data.length !== e.uncompSize) {
      throw new Error(`taille incohérente pour « ${e.name} » (${data.length} ≠ ${e.uncompSize})`);
    }
    if (crc32(data) !== e.crc) {
      throw new Error(`CRC invalide pour « ${e.name} » : archive corrompue`);
    }
    if (e.isSymlink) symlinks++; else files++;
    bytes += data.length;
  }
  return { entries: count, files, dirs, symlinks, bytes };
}
