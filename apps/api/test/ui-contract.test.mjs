/**
 * Contrats de l'interface.
 *
 * Origine : « TypeError: r is not a function » apparaissait pendant la
 * navigation. Sur un bundle minifié ce message ne désigne rien — impossible
 * de savoir quelle fonction manquait. La cause générique est toujours la
 * même : une valeur attendue comme fonction (prop de rappel, valeur de
 * contexte) vaut `undefined` ou `null` au moment de l'appel.
 *
 * Ces vérifications sont statiques : elles lisent les sources sans monter de
 * DOM, ce qui évite d'ajouter jsdom à un projet volontairement sans
 * dépendance. Elles couvrent les trois mécanismes par lesquels le bug peut
 * réapparaître.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const WEB = join(ROOT, 'apps/web/src');
const read = (p) => readFileSync(join(WEB, p), 'utf8');
const pages = () => readdirSync(join(WEB, 'pages')).filter((f) => f.endsWith('.jsx'));

describe('Contexte des notifications', () => {
  test('useToast ne peut jamais renvoyer null', () => {
    const lib = read('lib.jsx');
    assert.ok(!/createContext\(null\)/.test(lib),
      'createContext(null) : un composant hors Provider recevrait null et ' +
      'toast.success(…) lèverait « is not a function »');
    assert.ok(/noopToast/.test(lib), 'aucune valeur de repli définie');
  });

  test('le repli couvre les trois méthodes utilisées', () => {
    const lib = read('lib.jsx');
    const block = lib.slice(lib.indexOf('const noopToast'), lib.indexOf('const ToastCtx'));
    for (const m of ['info', 'success', 'error']) {
      assert.ok(new RegExp(`\\b${m}\\s*:`).test(block),
        `le repli n'implémente pas toast.${m}()`);
    }
  });

  test('l\'objet toast est mémoïsé', () => {
    // Sans useMemo, `toast` change de référence à chaque rendu du Provider :
    // tout useEffect qui en dépend se relance en boucle.
    const lib = read('lib.jsx');
    const provider = lib.slice(lib.indexOf('export function ToastProvider'));
    assert.ok(/useMemo/.test(provider.slice(0, 900)),
      'ToastProvider recrée `toast` à chaque rendu');
  });
});

describe('Props de rappel', () => {
  /* Les pages sont montées depuis App.jsx, mais certaines le sont aussi
     depuis d'autres écrans avec un jeu de props réduit. Toute prop appelée
     comme une fonction doit tolérer son absence. */
  const CALLBACKS = ['go', 'onNewAppt', 'onChanged', 'onClose'];

  for (const file of pages()) {
    test(`${file} — les rappels appelés tolèrent l'absence`, () => {
      const src = read(join('pages', file));

      for (const cb of CALLBACKS) {
        // La prop est-elle destructurée dans une signature de composant ?
        const declared = new RegExp(
          `function\\s+\\w+\\s*\\(\\{[^}]*\\b${cb}\\b[^}]*\\}`).test(src);
        if (!declared) continue;

        // Est-elle appelée directement, hors d'un appel optionnel `?.()` ?
        const calledDirectly = new RegExp(`(?<!\\?\\.)\\b${cb}\\s*\\(`).test(src);
        if (!calledDirectly) continue;

        // Alors il faut soit un repli explicite, soit l'appel optionnel.
        const guarded =
          new RegExp(`${cb}\\s*=\\s*${cb}\\s*\\|\\|`).test(src) ||
          new RegExp(`${cb}\\s*=\\s*\\(\\)\\s*=>`).test(src) ||
          new RegExp(`\\b${cb}\\?\\.\\(`).test(src);

        assert.ok(guarded,
          `${file} appelle ${cb}() sans repli : si la prop n'est pas fournie, ` +
          `l'écran entier tombe en erreur. Ajoutez « ${cb} = ${cb} || (() => {}); » ` +
          `ou utilisez ${cb}?.().`);
      }
    });
  }
});

describe('Fonctions de nettoyage de useEffect', () => {
  /*
   * Cause réelle du « r is not a function » signalé pendant la navigation.
   *
   * `useEffect(load, [])` où `load` est écrit en flèche concise —
   * `const load = () => api.x().then(setD)` — retourne une promesse. React
   * interprète toute valeur de retour comme la fonction de nettoyage et
   * l'appelle au démontage du composant, c'est-à-dire au changement d'écran.
   * D'où une erreur qui ne survient jamais à l'affichage, toujours en
   * quittant la page, et dont la pile ne contient que des frames internes
   * à React : aucun code applicatif n'y apparaît.
   */
  for (const file of pages()) {
    test(`${file} — useEffect ne reçoit pas de fonction rendant une promesse`, () => {
      const src = read(join('pages', file));

      for (const m of src.matchAll(/useEffect\(\s*(\w+)\s*,/g)) {
        const fn = m[1];

        // Un même fichier contient plusieurs composants, donc plusieurs
        // fonctions de même nom. Seule compte la définition qui PRÉCÈDE
        // immédiatement ce useEffect : c'est celle qui est dans la portée.
        const before = src.slice(0, m.index);
        const defs = [...before.matchAll(
          new RegExp(`const\\s+${fn}\\s*=\\s*(?:async\\s*)?\\([^)]*\\)\\s*=>\\s*(\\{?)`, 'g'))];
        if (defs.length === 0) continue;

        const nearest = defs[defs.length - 1];
        const hasBlockBody = nearest[1] === '{';

        assert.ok(hasBlockBody,
          `${file} ligne ~${before.split('\n').length} : useEffect(${fn}, …) où ` +
          `« ${fn} » est une flèche concise. Elle retourne une promesse, que ` +
          `React appellera comme fonction de nettoyage au démontage → ` +
          `TypeError à la navigation. Entourez le corps d'accolades.`);
      }
    });
  }
});

describe('Barrière d\'erreur', () => {
  test('le rapport conserve la pile et l\'arbre de composants', () => {
    const main = read('main.jsx');
    assert.ok(/componentStack/.test(main),
      'sans componentStack, une erreur minifiée reste impossible à localiser');
    assert.ok(/error\?\.stack|error\.stack/.test(main),
      'la pile d\'appel n\'est pas conservée');
  });

  test('l\'utilisateur peut transmettre le rapport sans ouvrir la console', () => {
    assert.ok(/clipboard/.test(read('main.jsx')),
      'aucun moyen de copier le rapport d\'erreur');
  });
});

describe('Imports', () => {
  test('tout symbole importé de lib.jsx y est réellement exporté', () => {
    const lib = read('lib.jsx');
    const exported = new Set();
    for (const m of lib.matchAll(/export\s+(?:const|function|class)\s+(\w+)/g)) {
      exported.add(m[1]);
    }
    for (const m of lib.matchAll(/export\s*\{([^}]+)\}\s*from/g)) {
      for (const raw of m[1].split(',')) {
        const n = raw.trim().split(/\s+as\s+/).pop()?.trim();
        if (n) exported.add(n);
      }
    }

    const files = [...pages().map((f) => join('pages', f)), 'App.jsx', 'main.jsx'];
    for (const f of files) {
      const src = read(f);
      for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*'[^']*lib\.jsx'/g)) {
        for (const raw of m[1].split(',')) {
          const n = raw.trim().split(/\s+as\s+/)[0]?.trim();
          if (!n) continue;
          assert.ok(exported.has(n),
            `${f} importe « ${n} » de lib.jsx, qui ne l'exporte pas — ` +
            `la valeur vaudrait undefined à l'exécution`);
        }
      }
    }
  });

  test('tout appel api.X() correspond à une méthode déclarée', () => {
    const apiSrc = read('api.js');
    const defined = new Set(
      [...apiSrc.matchAll(/^\s{2}(\w+)\s*:/gm)].map((m) => m[1]));

    const files = [...pages().map((f) => join('pages', f)), 'App.jsx'];
    for (const f of files) {
      for (const m of read(f).matchAll(/\bapi\.(\w+)\s*\(/g)) {
        assert.ok(defined.has(m[1]),
          `${f} appelle api.${m[1]}(), absent de api.js`);
      }
    }
  });
});

/* ====================================================================== */
describe('Document imprimable', () => {
  /*
   * Origine : le bouton « Imprimer » d'une facture produisait une page
   * vide. La facture est rendue dans une modale (« .overlay »), que la
   * feuille d'impression masquait par display:none. Le défaut est
   * invisible à l'écran et aucun navigateur n'est disponible ici : on
   * vérifie donc statiquement qu'aucune règle @media print ne masque un
   * ancêtre du document.
   */
  const printBlock = () => {
    // Les commentaires sont retirés d'abord : une mention « @media print »
    // dans un commentaire faisait analyser le mauvais texte, et le test
    // passait alors même que la facture était masquée.
    const css = read('styles.css').replace(/\/\*[\s\S]*?\*\//g, '');
    const i = css.search(/@media\s+print\s*\{/);
    assert.ok(i > -1, 'aucune règle @media print');
    // Extraction du bloc par comptage d'accolades.
    let depth = 0, start = css.indexOf('{', i), j = start;
    do { if (css[j] === '{') depth++; else if (css[j] === '}') depth--; j++; }
    while (depth > 0 && j < css.length);
    return css.slice(start + 1, j - 1);
  };

  test('le document est monté hors de l\'application, pas dans la modale', () => {
    /*
     * Le document vivait dans la modale, donc parmi les frères de la liste
     * des factures. Pour n'imprimer que lui il fallait « :has() » — et si
     * le navigateur l'ignore, la règle tombe et c'est la LISTE COMPLÈTE qui
     * s'imprime. Le portail supprime cette dépendance.
     */
    const doc = read('InvoicePrint.jsx');
    assert.ok(/createPortal/.test(doc),
      'le document doit être monté par portail hors de l\'arbre applicatif');
    assert.ok(/print-root/.test(doc),
      'le portail doit viser un conteneur dédié (#print-root)');
  });

  test('la règle d\'impression ne dépend d\'aucun sélecteur :has()', () => {
    /*
     * « :has() » n'est pas universellement supporté. Un seul sélecteur
     * invalide suffit à annuler la règle qui le porte : l'application
     * resterait visible et la liste s'imprimerait derrière la facture.
     */
    const block = printBlock();
    assert.ok(!/:has\(/.test(block),
      ':has() dans @media print : si le navigateur l\'ignore, la liste complète s\'imprime');
  });

  test('l\'application est masquée quand un document est ouvert', () => {
    const block = printBlock();
    assert.ok(/printing-doc[^{]*#root[^{]*\{[^}]*display:\s*none/.test(block),
      'body.printing-doc #root doit être masqué à l\'impression');
    assert.ok(/#print-root[^{]*\{[^}]*display:\s*block/.test(block),
      '#print-root doit rester visible à l\'impression');

    // La classe doit être posée ET retirée, sinon les autres écrans
    // deviennent inimprimables après la première facture consultée.
    const doc = read('InvoicePrint.jsx');
    assert.ok(/classList\.add\('printing-doc'\)/.test(doc), 'classe jamais posée');
    assert.ok(/classList\.remove\('printing-doc'\)/.test(doc),
      'classe jamais retirée : les autres écrans resteraient inimprimables');
  });

  test('une seule règle @media print, pour éviter les contradictions', () => {
    // Deux blocs séparés se contredisaient : l'un masquait .app, l'autre
    // le remettait en display:block selon l'ordre de cascade.
    // On ne compte que les vraies règles : « @media print { ». Les
    // occurrences en commentaire ne créent aucune cascade.
    const css = read('styles.css').replace(/\/\*[\s\S]*?\*\//g, '');
    const n = (css.match(/@media\s+print\s*\{/g) || []).length;
    assert.equal(n, 1, `${n} blocs @media print : regroupez-les`);
  });

  test('le document porte les mentions légales et le montant en lettres', () => {
    const doc = read('InvoicePrint.jsx');
    for (const needle of ['nif', 'rc', 'article_imposition', 'amountToWords',
                          'stamp_duty', 'patient_part']) {
      assert.ok(doc.includes(needle),
        `« ${needle} » absent du document imprimable : facture incomplète`);
    }
  });
});
