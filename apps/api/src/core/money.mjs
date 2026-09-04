/**
 * Formatage monétaire côté serveur.
 *
 * Le front dispose déjà de `apps/web/src/locale.js`, mais l'API produit elle
 * aussi des chaînes contenant des montants : résumés d'audit et messages
 * d'erreur métier. Ces chaînes sont écrites **définitivement** dans la table
 * `audit_entry` — une erreur de devise y reste gravée et fausse la relecture
 * plusieurs années après les faits.
 *
 * Aucune dépendance à Intl ici : la sortie doit être stable quelle que soit
 * l'ICU embarquée par Node sur le poste d'installation. Un serveur compilé
 * avec `small-icu` renverrait sinon un format différent de celui du navigateur.
 */

export const CURRENCY_CODE = 'DZD';
export const CURRENCY_SYMBOL = 'DA';

/**
 * Montant en dinars, séparateur de milliers en espace insécable.
 *
 * Le dinar se subdivise légalement en centimes, mais aucun tarif de
 * consultation ne les emploie : on n'affiche des décimales que si le montant
 * en comporte réellement (cas d'un avoir au prorata, par exemple).
 *
 * @param {number|string} amount
 * @returns {string} par exemple « 3 500 DA » ou « 1 250,50 DA »
 */
export function fmtMoney(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return `0 ${CURRENCY_SYMBOL}`;

  const negative = n < 0;
  const abs = Math.abs(n);
  const hasCents = Math.round(abs * 100) % 100 !== 0;

  const fixed = abs.toFixed(hasCents ? 2 : 0);
  const [intPart, decPart] = fixed.split('.');
  // U+202F : espace fine insécable, séparateur de milliers en typographie
  // française. Empêche un montant d'être coupé en fin de ligne.
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f');

  // U+00A0 devant le symbole : le montant et « DA » ne doivent jamais être
  // séparés par un retour à la ligne. Identique au front (locale.js) — les
  // deux formats sont comparés octet à octet par locale.test.mjs.
  return `${negative ? '-' : ''}${grouped}${decPart ? ',' + decPart : ''}\u00a0${CURRENCY_SYMBOL}`;
}
