/**
 * Adaptation au contexte algérien.
 *
 * Regroupe tout ce qui est spécifique au pays : monnaie, semaine ouvrable,
 * identifiants officiels, fiscalité, découpage administratif. Un seul fichier
 * à relire pour auditer la conformité locale, et un seul à modifier si la
 * réglementation change.
 */

/* --------------------------------- Monnaie -------------------------------- */
/* Le dinar algérien n'a pas de subdivision utilisée en pratique : le centime
   existe légalement mais aucun prix de consultation ne l'emploie. On affiche
   donc des montants entiers, ce qui évite « 3 500,00 DA » là où le comptoir
   écrit « 3 500 DA ». */
export const CURRENCY = 'DZD';

/* Symbole affiché. « DA » est la forme employée sur les factures, les
   affichages de prix et la signalétique en Algérie. Le sigle arabe « د.ج »
   n'apparaît que dans les documents en langue arabe : il sera introduit avec
   l'interface arabe, pas avant. */
export const CURRENCY_SYMBOL = 'DA';

/* Le formatage n'est pas délégué à Intl avec `style: 'currency'`.
   Deux raisons : la position et l'espacement du symbole varient selon la
   version d'ICU embarquée par le navigateur, et un Node compilé en
   `small-icu` retomberait sur « DZD ». Le format doit être identique à
   l'octet près entre l'écran, la facture imprimée et le journal d'audit
   produit par le serveur (voir apps/api/src/core/money.mjs). */
const groupDigits = (intPart) =>
  // U+202F : espace fine insécable, séparateur de milliers français. Évite
  // qu'un montant soit coupé en fin de ligne.
  intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f');

/**
 * Montant en dinars.
 * @param {number|string} n
 * @param {{decimals?: number}} [opts] `decimals` force l'affichage des
 *        centimes ; par défaut ils n'apparaissent que s'ils sont non nuls.
 */
export function fmtMoney(n, { decimals } = {}) {
  return `${fmtAmount(n, { decimals })}\u00a0${CURRENCY_SYMBOL}`;
}

/** Montant sans symbole, pour les colonnes déjà intitulées « DA ». */
export function fmtAmount(n, { decimals } = {}) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0';

  const abs = Math.abs(v);
  // Le dinar admet légalement des centimes, mais aucun tarif de consultation
  // ne les emploie. On ne les montre que s'ils existent réellement — cas d'un
  // avoir calculé au prorata, par exemple.
  const d = decimals ?? (Math.round(abs * 100) % 100 === 0 ? 0 : 2);
  const [i, dec] = abs.toFixed(d).split('.');
  return `${v < 0 ? '-' : ''}${groupDigits(i)}${dec ? ',' + dec : ''}`;
}

/** Montant en toutes lettres — obligatoire sur les quittances manuscrites. */
export function amountToWords(n) {
  const u = ['zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit',
    'neuf', 'dix', 'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize'];
  const t = { 20: 'vingt', 30: 'trente', 40: 'quarante', 50: 'cinquante',
    60: 'soixante', 80: 'quatre-vingt' };

  const below100 = (x) => {
    if (x < 17) return u[x];
    if (x < 20) return 'dix-' + u[x - 10];
    if (x < 100) {
      const base = x < 70 ? Math.floor(x / 10) * 10 : x < 80 ? 60 : 80;
      const rest = x - base;
      if (rest === 0) return t[base] + (base === 80 ? 's' : '');
      if (rest === 1 && base !== 80) return t[base] + ' et un';
      return t[base] + '-' + below100(rest);
    }
    return '';
  };
  const below1000 = (x) => {
    const c = Math.floor(x / 100), r = x % 100;
    if (c === 0) return below100(r);
    const head = c === 1 ? 'cent' : u[c] + ' cent';
    if (r === 0) return head + (c > 1 ? 's' : '');
    return head + ' ' + below100(r);
  };

  let x = Math.floor(Math.abs(Number(n) || 0));
  if (x === 0) return 'zéro dinar algérien';
  const parts = [];
  const scales = [[1e9, 'milliard'], [1e6, 'million'], [1000, 'mille']];
  for (const [v, name] of scales) {
    const q = Math.floor(x / v);
    if (q > 0) {
      if (name === 'mille') parts.push(q === 1 ? 'mille' : below1000(q) + ' mille');
      else parts.push(below1000(q) + ' ' + name + (q > 1 ? 's' : ''));
      x %= v;
    }
  }
  if (x > 0) parts.push(below1000(x));
  return parts.join(' ') + ' dinars algériens';
}

/* ------------------------------ Semaine ouvrable -------------------------- */
/* En Algérie le week-end est vendredi-samedi (décret 09-234). Une application
   qui grise samedi-dimanche affiche une semaine fausse : le samedi est un jour
   de forte activité en clinique, le jeudi est un jour ouvré plein. */
export const WEEKEND_DAYS = [5, 6];          // ISO : 5 = vendredi, 6 = samedi
export const WORK_DAYS = [7, 1, 2, 3, 4];    // dimanche → jeudi

/** Jour ISO (1 = lundi … 7 = dimanche) à partir d'une Date. */
export const isoDay = (d) => ((new Date(d).getDay() + 6) % 7) + 1;
export const isWeekend = (d) => WEEKEND_DAYS.includes(isoDay(d));

/** Ordre d'affichage de l'agenda : la semaine commence le dimanche. */
export const WEEK_ORDER = [7, 1, 2, 3, 4, 5, 6];
export const DAY_NAMES = {
  1: 'Lundi', 2: 'Mardi', 3: 'Mercredi', 4: 'Jeudi',
  5: 'Vendredi', 6: 'Samedi', 7: 'Dimanche',
};

/** Début de semaine (dimanche) contenant la date donnée. */
export function startOfWeekDZ(d) {
  const x = new Date(d);
  x.setDate(x.getDate() - (x.getDay() % 7));   // getDay(): 0 = dimanche
  x.setHours(0, 0, 0, 0);
  return x;
}

/* --------------------------- Identifiants officiels ----------------------- */
/* NIN — numéro d'identification national unique, 18 chiffres
   (décret exécutif n° 23-320, qui a remplacé le décret 10-210). */
export const NIN_LENGTH = 18;

export function validateNIN(value) {
  const raw = String(value || '').replace(/\s/g, '');
  if (!raw) return { valid: true, empty: true };
  if (!/^\d+$/.test(raw)) return { valid: false, error: 'Le NIN ne contient que des chiffres.' };
  if (raw.length !== NIN_LENGTH) {
    return { valid: false, error: `Le NIN comporte ${NIN_LENGTH} chiffres (${raw.length} saisis).` };
  }
  return { valid: true, value: raw };
}

/** Affichage groupé, plus lisible à la relecture au comptoir. */
export const fmtNIN = (v) => {
  const raw = String(v || '').replace(/\s/g, '');
  return raw.length === NIN_LENGTH
    ? raw.replace(/(\d{2})(\d{3})(\d{4})(\d{5})(\d{2})(\d{2})/, '$1 $2 $3 $4 $5 $6')
    : raw;
};

/* Numéro de sécurité sociale porté par la carte Chifa (CNAS ou CASNOS). */
export function validateSecuriteSociale(value) {
  const raw = String(value || '').replace(/\s/g, '');
  if (!raw) return { valid: true, empty: true };
  if (!/^\d{8,12}$/.test(raw)) {
    return { valid: false, error: 'Numéro d\'assuré social : 8 à 12 chiffres.' };
  }
  return { valid: true, value: raw };
}

export const INSURANCE_SCHEMES = {
  CNAS:    'CNAS — salariés',
  CASNOS:  'CASNOS — non-salariés',
  MILITARY: 'Sécurité sociale militaire',
  MUTUELLE: 'Mutuelle d\'entreprise',
  PRIVATE: 'Assurance privée',
  NONE:    'Sans couverture (payant)',
};

/* Taux de remboursement de droit commun. 80 % en régime général,
   100 % pour les affections de longue durée et certains retraités. */
export const DEFAULT_COVERAGE_RATE = 80;
export const ALD_COVERAGE_RATE = 100;

/* --------------------------------- Téléphone ------------------------------ */
/* Mobiles : 05/06/07 + 8 chiffres. Fixes : indicatif de wilaya 0xx + 6 chiffres. */
export function validatePhone(value, { required = false } = {}) {
  const raw = String(value || '').replace(/[\s.\-]/g, '');
  if (!raw) return required
    ? { valid: false, error: 'Numéro de téléphone obligatoire.' }
    : { valid: true, empty: true };
  const national = raw.replace(/^(\+213|00213)/, '0');
  if (!/^0[5-7]\d{8}$/.test(national) && !/^0[2-4]\d{7}$/.test(national)) {
    return { valid: false, error: 'Numéro invalide (ex. 0555 12 34 56 ou 021 23 45 67).' };
  }
  return { valid: true, value: national, mobile: /^0[5-7]/.test(national) };
}

export function fmtPhone(v) {
  const raw = String(v || '').replace(/[\s.\-]/g, '').replace(/^(\+213|00213)/, '0');
  if (/^0[5-7]\d{8}$/.test(raw)) return raw.replace(/(\d{4})(\d{2})(\d{2})(\d{2})/, '$1 $2 $3 $4');
  if (/^0[2-4]\d{7}$/.test(raw)) return raw.replace(/(\d{3})(\d{2})(\d{2})(\d{2})/, '$1 $2 $3 $4');
  return v || '—';
}

/* ------------------------------- Droit de timbre -------------------------- */
/* Article 100 du code du timbre : les règlements en espèces supportent un
   droit de 1 DA par tranche de 100 DA, plancher 5 DA, plafond 2 500 DA.
   Les sommes n'excédant pas 20 DA en sont dispensées. Le droit ne s'applique
   ni aux virements ni aux versements bancaires (article 258 bis). */
export const STAMP_DUTY_METHODS = ['CASH'];
export const STAMP_DUTY_MIN = 5;
export const STAMP_DUTY_MAX = 2500;

export function stampDuty(amount, method) {
  if (!STAMP_DUTY_METHODS.includes(method)) return 0;
  const ttc = Number(amount) || 0;
  if (ttc <= 20) return 0;
  const tranches = Math.ceil(ttc / 100);
  return Math.min(STAMP_DUTY_MAX, Math.max(STAMP_DUTY_MIN, tranches));
}

/* ---------------------------- Découpage administratif --------------------- */
/* 58 wilayas depuis la réforme de 2019 (les 10 nouvelles wilayas du Sud). */
export const WILAYAS = [
  '01 Adrar', '02 Chlef', '03 Laghouat', '04 Oum El Bouaghi', '05 Batna',
  '06 Béjaïa', '07 Biskra', '08 Béchar', '09 Blida', '10 Bouira',
  '11 Tamanrasset', '12 Tébessa', '13 Tlemcen', '14 Tiaret', '15 Tizi Ouzou',
  '16 Alger', '17 Djelfa', '18 Jijel', '19 Sétif', '20 Saïda',
  '21 Skikda', '22 Sidi Bel Abbès', '23 Annaba', '24 Guelma', '25 Constantine',
  '26 Médéa', '27 Mostaganem', '28 M\'Sila', '29 Mascara', '30 Ouargla',
  '31 Oran', '32 El Bayadh', '33 Illizi', '34 Bordj Bou Arréridj', '35 Boumerdès',
  '36 El Tarf', '37 Tindouf', '38 Tissemsilt', '39 El Oued', '40 Khenchela',
  '41 Souk Ahras', '42 Tipaza', '43 Mila', '44 Aïn Defla', '45 Naâma',
  '46 Aïn Témouchent', '47 Ghardaïa', '48 Relizane', '49 Timimoun',
  '50 Bordj Badji Mokhtar', '51 Ouled Djellal', '52 Béni Abbès', '53 In Salah',
  '54 In Guezzam', '55 Touggourt', '56 Djanet', '57 El M\'Ghair', '58 El Meniaa',
];

/* --------------------------------- Dates ---------------------------------- */
export const fmtDateDZ = (d) => d ? new Date(d).toLocaleDateString('fr-DZ') : '—';

/** Date longue avec le jour de semaine, pour les en-têtes d'agenda. */
export const fmtLongDateDZ = (d) => d
  ? new Date(d).toLocaleDateString('fr-DZ',
      { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  : '—';

/* Fêtes légales à date fixe. Les fêtes religieuses suivent le calendrier
   hégirien : elles sont saisies chaque année par l'administrateur dans
   Paramètres → Jours fériés, car leur date dépend de l'observation lunaire
   et ne peut pas être calculée de façon fiable à l'avance. */
export const FIXED_HOLIDAYS = [
  { md: '01-01', label: 'Jour de l\'An' },
  { md: '01-12', label: 'Yennayer — Nouvel an amazigh' },
  { md: '05-01', label: 'Fête du Travail' },
  { md: '07-05', label: 'Fête de l\'Indépendance' },
  { md: '11-01', label: 'Anniversaire de la Révolution' },
];

export function fixedHolidayFor(date) {
  const d = new Date(date);
  const md = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return FIXED_HOLIDAYS.find((h) => h.md === md) || null;
}
