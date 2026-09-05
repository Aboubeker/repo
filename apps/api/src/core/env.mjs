/**
 * Chargement du fichier .env local.
 *
 * Défaut corrigé : l'exécutable distribué, lancé par un raccourci du Bureau,
 * ne lisait aucun .env — Node ne charge « --env-file » que si on le lui
 * demande, et rien ne le lui demandait. La valeur de repli du code
 * s'appliquait alors (JWT_SECRET = 'dev-secret-change-me') et TOUS les postes
 * partageaient le même secret JWT : un jeton valable sur une clinique
 * l'était sur toutes.
 *
 * core/db.mjs et core/auth.mjs importent donc ce module en tête, avant toute
 * lecture de process.env. Chaque installation génère son propre secret de
 * 48 octets dans son .env (voir scripts/installer/stub.mjs) ; ce module ne
 * fait que le charger.
 *
 * Règles, alignées sur « node --env-file » :
 *   - une variable déjà présente dans l'environnement gagne sur le fichier
 *     (le processus reste pilotable par le poste de lancement) ;
 *   - jamais d'écrasement d'un .env existant : ici on ne lit, on n'écrit pas.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './root.mjs';

/**
 * Analyse le contenu d'un fichier .env en un objet { CLÉ: valeur }.
 *
 * Tolère : lignes vides, commentaires « # », préfixe « export », guillemets
 * simples ou doubles autour de la valeur (avec échappements \" \\ \n \t dans
 * les guillemets doubles), fins de ligne CRLF, BOM UTF-8 en tête.
 * Ne tolère pas : les commentaires en ligne de valeur (Node ne les supporte
 * pas non plus — un « # » fait partie de la valeur).
 */
export function parseEnv(text) {
  const out = {};
  const clean = String(text).replace(/^\uFEFF/, '');
  for (const rawLine of clean.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2);
    if (quoted) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') {
        value = value
          .replace(/\\n/g, '\n')
          .replace(/\\t/g, '\t')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\');
      }
    }
    out[key] = value;
  }
  return out;
}

/**
 * Emplacement du .env de cette installation.
 *
 * En développement : la racine du dépôt. Dans l'exécutable : à côté du
 * binaire (le dossier d'installation), comme le résout core/root.mjs.
 * CLINIRDV_ENV_FILE permet d'imposer un chemin (tests, déploiements atypiques).
 */
export function envFilePath() {
  return process.env.CLINIRDV_ENV_FILE || join(ROOT, '.env');
}

/**
 * Charge un fichier .env dans process.env.
 *
 * @param {string} [path] fichier à charger (défaut : envFilePath()).
 * @param {object} [opts]
 * @param {boolean} [opts.override] si true, les valeurs du fichier écrasent
 *   l'environnement courant (défaut : non, comme « node --env-file »).
 * @returns {number} nombre de variables appliquées à process.env
 *   (0 si le fichier est absent ou vide).
 */
export function loadEnvFile(path = envFilePath(), { override = false } = {}) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return 0;   // pas de .env : les valeurs de repli du code s'appliquent
  }
  let applied = 0;
  for (const [key, value] of Object.entries(parseEnv(text))) {
    if (override || process.env[key] === undefined) {
      if (process.env[key] !== value) {
        process.env[key] = value;
        applied++;
      }
    }
  }
  return applied;
}
