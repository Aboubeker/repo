/**
 * Catalogue des actes et des tarifs.
 *
 * Deux notions distinctes, volontairement séparées :
 *
 *   • le TARIF répond à « combien coûte cet acte » (code NGAP, montant) ;
 *   • le TYPE DE RENDEZ-VOUS répond à « combien de temps prend-il » (durée,
 *     temps de préparation, salle requise) et désigne son tarif par défaut.
 *
 * Les fusionner serait tentant, mais un même tarif sert plusieurs formats de
 * rendez-vous — une consultation de cardiologie facturée au même prix qu'elle
 * dure 30 minutes en cabinet ou 45 en première visite — et l'on change un prix
 * bien plus souvent qu'une durée. Les garder distincts évite de dupliquer les
 * montants, donc de les voir diverger.
 *
 * Ce module n'apporte que l'écriture : la lecture existait déjà
 * (`/api/appointment-types` dans admin.routes, `/api/tariffs` dans billing).
 * Sans ces routes, changer un prix imposait d'ouvrir psql.
 */
import { many, one, query, tx } from '../core/db.mjs';
import { notFound, unprocessable } from '../core/errors.mjs';
import { writeAudit } from '../core/audit.mjs';
import { validate } from '../core/validate.mjs';

const HEX = /^#[0-9a-fA-F]{6}$/;

const tariffSchema = {
  code:     { type: 'string', required: true, max: 20 },
  label:    { type: 'string', required: true, max: 100 },
  amount:   { type: 'number', required: true, min: 0, max: 10000000 },
  vatRate:  { type: 'number', min: 0, max: 100, default: 0 },
  specialtyId: { type: 'uuid' },
};

const typeSchema = {
  code:  { type: 'string', required: true, max: 20 },
  label: { type: 'string', required: true, max: 100 },
  specialtyId: { type: 'uuid' },
  defaultDurationMinutes: { type: 'number', required: true, min: 5, max: 480 },
  bufferBeforeMinutes: { type: 'number', min: 0, max: 120, default: 0 },
  bufferAfterMinutes:  { type: 'number', min: 0, max: 120, default: 0 },
  requiresRoom: { type: 'boolean', default: true },
  color: { type: 'string', max: 9, default: '#3b82f6' },
  defaultTariffId: { type: 'uuid' },
  /*
   * Montant saisi librement dans le formulaire.
   *
   * Le prix reste porté par la table `tariff` — c'est elle que les lignes
   * de facture référencent, et l'historique en dépend. Ce champ est une
   * commodité de saisie : l'API se charge de trouver ou de créer le tarif
   * correspondant. Voir resolveTariff().
   */
  defaultAmount: { type: 'number', min: 0, max: 10000000 },
  preparationInstructions: { type: 'string', max: 1000 },
};

/**
 * Traduit un montant saisi en identifiant de tarif.
 *
 * Règles, dans l'ordre :
 *   1. montant absent            → on garde le tarif choisi, s'il y en a un ;
 *   2. le tarif actuel du type porte déjà ce montant ET n'est utilisé par
 *      aucun autre type → on le met à jour sur place ;
 *   3. un tarif actif porte déjà ce montant → on le réutilise ;
 *   4. sinon → on crée un tarif propre à ce type.
 *
 * Le point 2 est la raison d'être de cette fonction : le tarif « C » est
 * partagé par « CS-GEN » et « URGENCE ». Écraser son montant parce qu'on
 * modifie l'un des deux changerait le prix de l'autre à son insu — et,
 * comme les lignes de facture copient le prix à l'émission, personne ne
 * s'en apercevrait avant la fin du mois.
 */
export async function resolveTariff(c, { amount, currentTariffId, typeCode, typeLabel, specialtyId }) {
  if (amount === undefined || amount === null) return currentTariffId ?? null;

  if (currentTariffId) {
    const { rows: [cur] } = await c.query(
      `SELECT t.id, t.amount,
              (SELECT count(*) FROM appointment_type at
                WHERE at.default_tariff_id = t.id) AS used_by_types
         FROM tariff t WHERE t.id = $1`, [currentTariffId]);
    if (cur) {
      if (Number(cur.amount) === Number(amount)) return cur.id;   // rien à faire
      if (Number(cur.used_by_types) <= 1) {
        await c.query('UPDATE tariff SET amount = $2 WHERE id = $1', [cur.id, amount]);
        return cur.id;
      }
    }
  }

  const { rows: [same] } = await c.query(
    `SELECT id FROM tariff WHERE amount = $1 AND is_active
        AND (valid_to IS NULL OR valid_to >= CURRENT_DATE)
      ORDER BY code LIMIT 1`, [amount]);
  if (same) return same.id;

  // Code dérivé du type, suffixé si besoin : `tariff.code` est unique.
  const base = String(typeCode || 'ACTE').slice(0, 16).toUpperCase();
  let code = base, n = 1;
  /* eslint-disable no-await-in-loop */
  while (true) {
    const { rows: [clash] } = await c.query('SELECT 1 FROM tariff WHERE code = $1', [code]);
    if (!clash) break;
    code = `${base}-${++n}`;
  }
  const { rows: [created] } = await c.query(
    `INSERT INTO tariff (code, label, amount, vat_rate, specialty_id)
     VALUES ($1,$2,$3,0,$4) RETURNING id`,
    [code, typeLabel || code, amount, specialtyId ?? null]);
  return created.id;
}

export function registerCatalogueRoutes(router) {

  /* =====================================================================
     Vue d'ensemble
     ===================================================================== */

  /**
   * Actes et tarifs en une seule réponse.
   *
   * L'écran présente les deux côte à côte : les servir séparément
   * obligerait l'interface à un double appel puis à recoudre les liens,
   * pour une information qui n'a de sens que rapprochée.
   */
  router.get('/api/catalogue', async () => ({
    specialties: await many('SELECT id, code, label FROM specialty ORDER BY label'),

    tariffs: await many(
      `SELECT t.*, s.label AS specialty_label,
              (SELECT count(*)::int FROM appointment_type at
                WHERE at.default_tariff_id = t.id AND at.is_active) AS used_by_types,
              (SELECT count(*)::int FROM invoice_line l
                WHERE l.tariff_id = t.id) AS used_by_lines
         FROM tariff t
         LEFT JOIN specialty s ON s.id = t.specialty_id
        ORDER BY t.is_active DESC, t.code`),

    types: await many(
      `SELECT at.*, s.label AS specialty_label,
              t.code AS tariff_code, t.amount AS tariff_amount, t.label AS tariff_label,
              (SELECT count(*)::int FROM appointment a
                WHERE a.appointment_type_id = at.id) AS appointment_count
         FROM appointment_type at
         LEFT JOIN specialty s ON s.id = at.specialty_id
         LEFT JOIN tariff t ON t.id = at.default_tariff_id
        ORDER BY at.is_active DESC, at.label`),
  }), { permission: 'appointment.read' });

  /* =====================================================================
     Tarifs
     ===================================================================== */

  router.post('/api/tariffs', async (ctx) => {
    const d = validate(ctx.body, tariffSchema);
    if (await one('SELECT 1 FROM tariff WHERE lower(code) = lower($1)', [d.code]))
      throw unprocessable(`Le tarif « ${d.code} » existe déjà.`, 'TARIFF_EXISTS');

    const t = await one(
      `INSERT INTO tariff (code, label, amount, vat_rate, specialty_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [d.code, d.label, d.amount, d.vatRate ?? 0, d.specialtyId]);

    await writeAudit(ctx, { action: 'CREATE', entity: 'tariff', entityId: t.id,
      summary: `Tarif créé : ${t.code} — ${t.label} à ${t.amount}` });
    return t;
  }, { permission: 'admin.settings' });

  router.patch('/api/tariffs/:id', async (ctx) => {
    const before = await one('SELECT * FROM tariff WHERE id = $1', [ctx.params.id]);
    if (!before) throw notFound('Tarif introuvable.');

    const d = validate({
      code: before.code, label: before.label,
      amount: Number(before.amount), vatRate: Number(before.vat_rate),
      specialtyId: before.specialty_id, ...ctx.body,
    }, tariffSchema);

    if (d.code.toLowerCase() !== before.code.toLowerCase() &&
        await one('SELECT 1 FROM tariff WHERE lower(code) = lower($1)', [d.code]))
      throw unprocessable(`Le tarif « ${d.code} » existe déjà.`, 'TARIFF_EXISTS');

    /*
     * Le montant est modifié sur place, sans versionner l'historique.
     *
     * C'est sans conséquence sur les factures déjà émises : `invoice_line`
     * copie le prix unitaire au moment de la facturation plutôt que de
     * pointer vers le tarif. Une hausse de prix ne réécrit donc jamais une
     * facture passée — ce que la loi exige, et qu'un simple JOIN aurait
     * silencieusement violé.
     */
    const after = await one(
      `UPDATE tariff SET code=$2, label=$3, amount=$4, vat_rate=$5, specialty_id=$6
        WHERE id=$1 RETURNING *`,
      [ctx.params.id, d.code, d.label, d.amount, d.vatRate ?? 0, d.specialtyId]);

    const priceChanged = Number(before.amount) !== Number(after.amount);
    await writeAudit(ctx, { action: 'UPDATE', entity: 'tariff', entityId: after.id,
      summary: priceChanged
        ? `Tarif ${after.code} : ${before.amount} → ${after.amount}`
        : `Tarif ${after.code} modifié`,
      diff: { before, after } });
    return after;
  }, { permission: 'admin.settings' });

  /**
   * Désactivation d'un tarif.
   *
   * Jamais de suppression : les lignes de facture y font référence, et
   * l'effacer romprait la piste d'audit comptable. Un tarif désactivé
   * disparaît des listes de saisie mais reste lisible sur l'historique.
   */
  router.delete('/api/tariffs/:id', async (ctx) => {
    const t = await one('SELECT * FROM tariff WHERE id = $1', [ctx.params.id]);
    if (!t) throw notFound('Tarif introuvable.');

    const used = await one(
      `SELECT count(*)::int AS n FROM appointment_type
        WHERE default_tariff_id = $1 AND is_active`, [ctx.params.id]);
    if (used.n > 0) {
      throw unprocessable(
        `${used.n} type(s) de rendez-vous utilisent ce tarif. ` +
        'Rattachez-les à un autre tarif avant de le retirer.',
        'TARIFF_IN_USE', { typeCount: used.n });
    }

    await query('UPDATE tariff SET is_active = false WHERE id = $1', [ctx.params.id]);
    await writeAudit(ctx, { action: 'ARCHIVE', entity: 'tariff', entityId: t.id,
      summary: `Tarif retiré du catalogue : ${t.code}` });
    return { ok: true };
  }, { permission: 'admin.settings' });

  router.post('/api/tariffs/:id/restore', async (ctx) => {
    const t = await one(
      'UPDATE tariff SET is_active = true WHERE id = $1 RETURNING *', [ctx.params.id]);
    if (!t) throw notFound('Tarif introuvable.');
    await writeAudit(ctx, { action: 'RESTORE', entity: 'tariff', entityId: t.id,
      summary: `Tarif réactivé : ${t.code}` });
    return t;
  }, { permission: 'admin.settings' });

  /* =====================================================================
     Types de rendez-vous
     ===================================================================== */

  router.patch('/api/appointment-types/:id', async (ctx) => {
    const before = await one('SELECT * FROM appointment_type WHERE id = $1', [ctx.params.id]);
    if (!before) throw notFound('Type de rendez-vous introuvable.');

    const d = validate({
      code: before.code, label: before.label, specialtyId: before.specialty_id,
      defaultDurationMinutes: before.default_duration_minutes,
      bufferBeforeMinutes: before.buffer_before_minutes,
      bufferAfterMinutes: before.buffer_after_minutes,
      requiresRoom: before.requires_room, color: before.color,
      defaultTariffId: before.default_tariff_id,
      preparationInstructions: before.preparation_instructions,
      ...ctx.body,
    }, typeSchema);

    if (!HEX.test(d.color)) {
      throw unprocessable('Couleur hexadécimale attendue, par exemple #3b82f6.',
        'BUSINESS_RULE', { color: 'Format #rrggbb attendu.' });
    }

    /*
     * La durée n'est appliquée qu'aux rendez-vous À VENIR.
     *
     * Le déclencheur `fn_appointment_defaults` recalcule `blocked_period` à
     * partir des temps tampons du type. Réécrire les rendez-vous passés
     * déplacerait des créneaux déjà honorés et pourrait heurter la contrainte
     * anti-chevauchement sur des données historiques parfaitement valides.
     * Les rendez-vous déjà planifiés conservent la durée retenue au moment de
     * leur prise : la modifier dans leur dos surprendrait patients et
     * praticiens.
     */
    const after = await tx(async (c) => {
      // Montant saisi librement : traduit en tarif, sans jamais écraser le
      // prix d'un tarif partagé par un autre type de rendez-vous.
      const tariffId = await resolveTariff(c, {
        amount: ctx.body.defaultAmount, currentTariffId: d.defaultTariffId,
        typeCode: d.code, typeLabel: d.label, specialtyId: d.specialtyId });
      const { rows: [row] } = await c.query(
        `UPDATE appointment_type SET code=$2, label=$3, specialty_id=$4,
                default_duration_minutes=$5, buffer_before_minutes=$6,
                buffer_after_minutes=$7, requires_room=$8, color=$9,
                default_tariff_id=$10, preparation_instructions=$11
          WHERE id=$1 RETURNING *`,
        [ctx.params.id, d.code, d.label, d.specialtyId, d.defaultDurationMinutes,
         d.bufferBeforeMinutes ?? 0, d.bufferAfterMinutes ?? 0,
         d.requiresRoom ?? true, d.color, tariffId, d.preparationInstructions]);
      return row;
    });

    await writeAudit(ctx, { action: 'UPDATE', entity: 'appointment_type', entityId: after.id,
      summary: `Type de RDV modifié : ${after.label} (${after.default_duration_minutes} min)`,
      diff: { before, after } });
    return after;
  }, { permission: 'admin.settings' });

  router.delete('/api/appointment-types/:id', async (ctx) => {
    const t = await one('SELECT * FROM appointment_type WHERE id = $1', [ctx.params.id]);
    if (!t) throw notFound('Type de rendez-vous introuvable.');

    // Les rendez-vous à venir référencent ce type : le retirer viderait leur
    // libellé et leur durée dans l'agenda.
    const upcoming = await one(
      `SELECT count(*)::int AS n FROM appointment
        WHERE appointment_type_id = $1 AND upper(period) > now()
          AND status IN ('SCHEDULED','CONFIRMED','CHECKED_IN','IN_PROGRESS')`,
      [ctx.params.id]);
    if (upcoming.n > 0) {
      throw unprocessable(
        `${upcoming.n} rendez-vous à venir utilisent ce type. ` +
        'Attendez qu\'ils soient passés ou reprogrammez-les.',
        'TYPE_IN_USE', { appointmentCount: upcoming.n });
    }

    await query('UPDATE appointment_type SET is_active = false WHERE id = $1', [ctx.params.id]);
    await writeAudit(ctx, { action: 'ARCHIVE', entity: 'appointment_type', entityId: t.id,
      summary: `Type de RDV retiré du catalogue : ${t.label}` });
    return { ok: true };
  }, { permission: 'admin.settings' });

  router.post('/api/appointment-types/:id/restore', async (ctx) => {
    const t = await one(
      'UPDATE appointment_type SET is_active = true WHERE id = $1 RETURNING *',
      [ctx.params.id]);
    if (!t) throw notFound('Type de rendez-vous introuvable.');
    await writeAudit(ctx, { action: 'RESTORE', entity: 'appointment_type', entityId: t.id,
      summary: `Type de RDV réactivé : ${t.label}` });
    return t;
  }, { permission: 'admin.settings' });
}
