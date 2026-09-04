/**
 * Racine du projet, valable aussi bien depuis les sources que depuis
 * l'exécutable distribué.
 *
 * Chaque module calculait sa propre racine en remontant un nombre de niveaux
 * dépendant de son emplacement (`../../..`, `../../../..`). Une fois le code
 * regroupé en un seul fichier par le bundler, ces chemins ne veulent plus rien
 * dire et `import.meta.url` est vide : migrations, jeu de données initial et
 * sauvegardes cherchaient leurs fichiers à côté de la plaque.
 *
 * La racine est donc résolue ici, une seule fois, selon le mode d'exécution.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

/**
 * Vrai lorsque le code tourne depuis l'exécutable distribué.
 *
 * `process.versions.sea` n'est pas renseigné par toutes les versions de Node :
 * s'y fier laissait le serveur se croire lancé depuis les sources, ne pas se
 * reconnaître comme point d'entrée, et se terminer sans le moindre message.
 * `node:sea` est l'interface prévue pour cette question.
 */
function detectPackaged() {
  if (process.env.CLINIRDV_PACKAGED === '1') return true;
  try {
    // createRequire fonctionne dans les deux mondes : en module ESM depuis
    // les sources, et dans le fichier CommonJS produit pour l'exécutable.
    return createRequire(import.meta.url || `file://${process.cwd()}/`)
      ('node:sea').isSea();
  } catch {
    return false;
  }
}

export const isPackaged = detectPackaged();

function resolveRoot() {
  // Chemin impose a l'exploitation : fait autorite dans tous les cas.
  if (process.env.CLINIRDV_ROOT) return resolve(process.env.CLINIRDV_ROOT);

  // Exécutable : les ressources (infra/db, apps/web/dist) sont déposées à
  // côté du binaire, et non dans une arborescence de sources.
  if (isPackaged) return dirname(process.execPath);

  // Sources : ce fichier est à apps/api/src/core/, la racine est 4 niveaux
  // au-dessus. Un seul endroit à corriger s'il déménage.
  //
  // import.meta.url est vide une fois le code regroupé en CommonJS, et
  // fileURLToPath(undefined) leve une erreur qui empeche le demarrage. On ne
  // l'evalue donc que si la valeur existe reellement.
  const here = import.meta.url;
  if (!here) return resolve(process.cwd());
  return resolve(dirname(fileURLToPath(here)), '../../../..');
}

export const ROOT = resolveRoot();
