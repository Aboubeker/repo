/** Module Facturation : factures, paiements, caisse, impayés. */
import { many, one, tx } from '../core/db.mjs';
import { notFound, unprocessable, badRequest } from '../core/errors.mjs';
import { writeAudit } from '../core/audit.mjs';
import { validate } from '../core/validate.mjs';

export function registerBillingRoutes(router) {

  /* ------------------------------ Tarifs ------------------------------ */
  router.get('/api/tariffs', async () => ({
    items: await many(
      `SELECT t.*, s.label AS specialty_label FROM tariff t
         LEFT JOIN specialty s ON s.id = t.specialty_id
        WHERE t.is_active AND (t.valid_to IS NULL OR t.valid_to >= CURRENT_DATE)
        ORDER BY t.code`),
  }), { permission: 'billing.read' });

  /* ----------------------------- Factures ----------------------------- */
  router.get('/api/invoices', async (ctx) => {
    const params = [];
    const conds = [];
    if (ctx.query.status)    { params.push(ctx.query.status);    conds.push(`i.status = $${params.length}`); }
    if (ctx.query.patientId) { params.push(ctx.query.patientId); conds.push(`i.patient_id = $${params.length}`); }
    if (ctx.query.from)      { params.push(ctx.query.from);      conds.push(`i.created_at >= $${params.length}::date`); }
    if (ctx.query.to)        { params.push(ctx.query.to);        conds.push(`i.created_at < $${params.length}::date + 1`); }
    if (ctx.query.unpaid === 'true') conds.push(`i.status IN ('ISSUED','PARTIALLY_PAID','OVERDUE')`);
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const items = await many(
      `SELECT i.*, p.mrn, p.last_name AS patient_last_name, p.first_name AS patient_first_name,
              pr.last_name AS practitioner_last_name
         FROM invoice i
         JOIN patient p ON p.id = i.patient_id
         LEFT JOIN practitioner pr ON pr.id = i.practitioner_id
         ${where} ORDER BY i.created_at DESC LIMIT 200`, params);
    const totals = await one(
      `SELECT coalesce(sum(i.total_amount),0) AS total,
              coalesce(sum(i.paid_amount),0)  AS paid,
              coalesce(sum(i.balance) FILTER (WHERE i.status IN ('ISSUED','PARTIALLY_PAID','OVERDUE')),0) AS outstanding
         FROM invoice i ${where}`, params);
    return { items, totals };
  }, { permission: 'billing.read' });

  router.get('/api/invoices/:id', async (ctx) => {
    const inv = await one(
      `SELECT i.*, p.mrn, p.last_name AS patient_last_name, p.first_name AS patient_first_name,
              p.address_line1, p.postal_code, p.city,
              pr.last_name AS practitioner_last_name, pr.first_name AS practitioner_first_name
         FROM invoice i JOIN patient p ON p.id = i.patient_id
         LEFT JOIN practitioner pr ON pr.id = i.practitioner_id
        WHERE i.id = $1`, [ctx.params.id]);
    if (!inv) throw notFound('Facture introuvable.');
    const [lines, payments] = await Promise.all([
      many('SELECT * FROM invoice_line WHERE invoice_id = $1', [inv.id]),
      many(`SELECT pay.*, u.full_name AS received_by_name FROM payment pay
              LEFT JOIN user_account u ON u.id = pay.received_by
             WHERE pay.invoice_id = $1 ORDER BY pay.received_at`, [inv.id]),
    ]);
    return { invoice: inv, lines, payments };
  }, { permission: 'billing.read' });

  /** Crée une facture brouillon, éventuellement pré-remplie depuis un rendez-vous. */
  router.post('/api/invoices', async (ctx) => {
    const d = validate(ctx.body, {
      patientId:     { type: 'uuid' },
      appointmentId: { type: 'uuid' },
      notes:         { type: 'string', max: 1000 },
    });
    if (!d.patientId && !d.appointmentId)
      throw badRequest('patientId ou appointmentId est requis.');

    return tx(async (c) => {
      let patientId = d.patientId, practitionerId = null, seedLine = null;

      if (d.appointmentId) {
        const { rows: [a] } = await c.query(
          `SELECT a.*, at.label, at.default_tariff_id, t.amount, t.vat_rate, t.label AS tariff_label
             FROM appointment a
             JOIN appointment_type at ON at.id = a.appointment_type_id
             LEFT JOIN tariff t ON t.id = at.default_tariff_id
            WHERE a.id = $1`, [d.appointmentId]);
        if (!a) throw notFound('Rendez-vous introuvable.');
        if (a.status !== 'COMPLETED')
          throw unprocessable('Seul un rendez-vous terminé peut être facturé.', 'APPOINTMENT_NOT_COMPLETED');
        const { rows: [dup] } = await c.query(
          `SELECT i.id FROM invoice i JOIN invoice_line l ON l.invoice_id = i.id
            WHERE l.appointment_id = $1 AND i.status <> 'CANCELLED' LIMIT 1`, [d.appointmentId]);
        if (dup) throw unprocessable('Ce rendez-vous est déjà facturé.', 'ALREADY_INVOICED',
          { invoiceId: dup.id });
        patientId = a.patient_id;
        practitionerId = a.practitioner_id;
        if (a.default_tariff_id) {
          seedLine = { appointmentId: a.id, tariffId: a.default_tariff_id,
            label: a.tariff_label || a.label, unitPrice: a.amount ?? 0, vatRate: a.vat_rate ?? 0 };
        }
      }

      // Part assurance calculée depuis la couverture principale du patient
      const { rows: [ins] } = await c.query(
        `SELECT coverage_rate FROM patient_insurance
          WHERE patient_id = $1 AND is_primary
            AND (valid_to IS NULL OR valid_to >= CURRENT_DATE) LIMIT 1`, [patientId]);

      const { rows: [inv] } = await c.query(
        `INSERT INTO invoice (patient_id, practitioner_id, notes, created_by)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [patientId, practitionerId, d.notes, ctx.user.sub]);

      if (seedLine) {
        await c.query(
          `INSERT INTO invoice_line (invoice_id, appointment_id, tariff_id, label,
             quantity, unit_price, vat_rate, line_total)
           VALUES ($1,$2,$3,$4,1,$5,$6,$5)`,
          [inv.id, seedLine.appointmentId, seedLine.tariffId, seedLine.label,
           seedLine.unitPrice, seedLine.vatRate]);
      }
      if (ins?.coverage_rate) {
        const { rows: [t] } = await c.query('SELECT total_amount FROM invoice WHERE id = $1', [inv.id]);
        const insurance = Math.round(t.total_amount * ins.coverage_rate) / 100;
        await c.query(
          `UPDATE invoice SET insurance_part = $2, patient_part = total_amount - $2 WHERE id = $1`,
          [inv.id, insurance]);
      }
      await writeAudit(ctx, { action: 'CREATE', entity: 'invoice', entityId: inv.id,
        summary: 'Facture brouillon créée' });
      return (await c.query('SELECT * FROM invoice WHERE id = $1', [inv.id])).rows[0];
    });
  }, { permission: 'invoice.write' });

  router.post('/api/invoices/:id/lines', async (ctx) => {
    const d = validate(ctx.body, {
      label:        { type: 'string', required: true, max: 200 },
      quantity:     { type: 'number', min: 0.01, default: 1 },
      unitPrice:    { type: 'number', min: 0, required: true },
      vatRate:      { type: 'number', min: 0, max: 100, default: 0 },
      discountRate: { type: 'number', min: 0, max: 100, default: 0 },
      tariffId:     { type: 'uuid' },
      appointmentId:{ type: 'uuid' },
    });
    const total = Math.round(d.quantity * d.unitPrice * (1 - d.discountRate / 100) * 100) / 100;
    const l = await one(
      `INSERT INTO invoice_line (invoice_id, appointment_id, tariff_id, label,
         quantity, unit_price, discount_rate, vat_rate, line_total)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [ctx.params.id, d.appointmentId, d.tariffId, d.label, d.quantity,
       d.unitPrice, d.discountRate, d.vatRate, total]);
    return l;
  }, { permission: 'invoice.write' });

  router.delete('/api/invoices/:iid/lines/:id', async (ctx) => {
    await one('DELETE FROM invoice_line WHERE id = $1 RETURNING id', [ctx.params.id]);
    return { ok: true };
  }, { permission: 'invoice.write' });

  /** Émission : attribue un numéro légal et rend la facture immuable. */
  router.post('/api/invoices/:id/issue', async (ctx) => {
    const inv = await tx(async (c) => {
      const { rows: [cur] } = await c.query(
        'SELECT * FROM invoice WHERE id = $1 FOR UPDATE', [ctx.params.id]);
      if (!cur) throw notFound('Facture introuvable.');
      if (cur.status !== 'DRAFT')
        throw unprocessable('Cette facture est déjà émise.', 'ALREADY_ISSUED');
      const { rows: [n] } = await c.query('SELECT count(*)::int AS n FROM invoice_line WHERE invoice_id = $1',
        [cur.id]);
      if (n.n === 0) throw unprocessable('Une facture doit contenir au moins une ligne.', 'EMPTY_INVOICE');
      const { rows: [r] } = await c.query(
        `UPDATE invoice SET status = 'ISSUED', issued_at = now(),
                due_date = (now() + interval '30 days')::date,
                number = 'F-' || to_char(now(),'YYYY') || '-' ||
                         lpad(nextval('invoice_number_seq')::text, 5, '0')
           WHERE id = $1 RETURNING *`, [cur.id]);
      return r;
    });
    await writeAudit(ctx, { action: 'ISSUE', entity: 'invoice', entityId: inv.id,
      summary: `Facture ${inv.number} émise — ${inv.total_amount} €` });
    return inv;
  }, { permission: 'invoice.write' });

  /** Avoir : seule façon de corriger une facture émise. */
  router.post('/api/invoices/:id/credit', async (ctx) => {
    const { reason } = validate(ctx.body, { reason: { type: 'string', required: true, max: 300 } });
    const credit = await tx(async (c) => {
      const { rows: [orig] } = await c.query('SELECT * FROM invoice WHERE id = $1', [ctx.params.id]);
      if (!orig) throw notFound('Facture introuvable.');
      if (!['ISSUED','PARTIALLY_PAID','PAID','OVERDUE'].includes(orig.status))
        throw unprocessable('Seule une facture émise peut faire l\'objet d\'un avoir.', 'NOT_ISSUED');

      const { rows: [cr] } = await c.query(
        `INSERT INTO invoice (patient_id, practitioner_id, credited_invoice_id, notes, created_by)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [orig.patient_id, orig.practitioner_id, orig.id, `Avoir sur ${orig.number} : ${reason}`,
         ctx.user.sub]);
      const { rows: lines } = await c.query('SELECT * FROM invoice_line WHERE invoice_id = $1', [orig.id]);
      for (const l of lines) {
        await c.query(
          `INSERT INTO invoice_line (invoice_id, label, quantity, unit_price, vat_rate, line_total)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [cr.id, `Avoir — ${l.label}`, l.quantity, -l.unit_price, l.vat_rate, -l.line_total]);
      }
      await c.query(
        `UPDATE invoice SET status = 'ISSUED', issued_at = now(),
                number = 'AV-' || to_char(now(),'YYYY') || '-' ||
                         lpad(nextval('invoice_number_seq')::text, 5, '0')
           WHERE id = $1`, [cr.id]);
      await c.query(`UPDATE invoice SET status = 'CREDITED' WHERE id = $1`, [orig.id]);
      return (await c.query('SELECT * FROM invoice WHERE id = $1', [cr.id])).rows[0];
    });
    await writeAudit(ctx, { action: 'CREDIT', entity: 'invoice', entityId: credit.id,
      summary: `Avoir ${credit.number} émis — ${reason}` });
    return credit;
  }, { permission: 'invoice.void' });

  /* ----------------------------- Paiements ---------------------------- */
  router.post('/api/invoices/:id/payments', async (ctx) => {
    const d = validate(ctx.body, {
      method:    { type: 'enum', required: true,
                   values: ['CASH','CARD','CHECK','TRANSFER','INSURANCE','VOUCHER'] },
      amount:    { type: 'number', required: true, min: 0.01 },
      reference: { type: 'string', max: 60 },
      notes:     { type: 'string', max: 300 },
    });
    const pay = await tx(async (c) => {
      const { rows: [inv] } = await c.query(
        'SELECT * FROM invoice WHERE id = $1 FOR UPDATE', [ctx.params.id]);
      if (!inv) throw notFound('Facture introuvable.');
      if (inv.status === 'DRAFT')
        throw unprocessable('La facture doit être émise avant tout encaissement.', 'INVOICE_NOT_ISSUED');
      if (d.amount > inv.balance + 0.001)
        throw unprocessable(`Le montant dépasse le solde dû (${inv.balance} €).`, 'AMOUNT_EXCEEDS_BALANCE',
          { balance: inv.balance });

      const { rows: [session] } = await c.query(
        `SELECT id FROM cash_session WHERE status = 'OPEN' ORDER BY opened_at DESC LIMIT 1`);
      const { rows: [p] } = await c.query(
        `INSERT INTO payment (invoice_id, cash_session_id, method, amount, reference, notes, received_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [inv.id, session?.id ?? null, d.method, d.amount, d.reference, d.notes, ctx.user.sub]);
      return p;
    });
    await writeAudit(ctx, { action: 'PAYMENT', entity: 'invoice', entityId: ctx.params.id,
      summary: `Paiement ${d.amount} € (${d.method})` });
    return { payment: pay, invoice: await one('SELECT * FROM invoice WHERE id = $1', [ctx.params.id]) };
  }, { permission: 'payment.write' });

  /* ------------------------------- Caisse ------------------------------ */
  router.get('/api/cash-sessions/current', async () => {
    const s = await one(`SELECT * FROM cash_session WHERE status = 'OPEN' ORDER BY opened_at DESC LIMIT 1`);
    if (!s) return { session: null };
    const totals = await many(
      `SELECT method, count(*)::int AS count, sum(amount) AS total
         FROM payment WHERE cash_session_id = $1 AND NOT is_refund
        GROUP BY method ORDER BY method`, [s.id]);
    const expected = totals.filter((t) => t.method === 'CASH')
      .reduce((a, t) => a + Number(t.total), Number(s.opening_float));
    return { session: s, totals, expectedCash: expected };
  }, { permission: 'billing.read' });

  router.post('/api/cash-sessions/open', async (ctx) => {
    const d = validate(ctx.body, {
      openingFloat: { type: 'number', min: 0, default: 0 },
      workstation:  { type: 'string', max: 50 },
    });
    const existing = await one(`SELECT id FROM cash_session WHERE status = 'OPEN'`);
    if (existing) throw unprocessable('Une session de caisse est déjà ouverte.', 'SESSION_ALREADY_OPEN');
    const s = await one(
      `INSERT INTO cash_session (opened_by, opening_float, workstation) VALUES ($1,$2,$3) RETURNING *`,
      [ctx.user.sub, d.openingFloat, d.workstation]);
    await writeAudit(ctx, { action: 'CASH_OPEN', entity: 'cash_session', entityId: s.id,
      summary: `Ouverture de caisse — fond ${d.openingFloat} €` });
    return s;
  }, { permission: 'payment.write' });

  router.post('/api/cash-sessions/:id/close', async (ctx) => {
    const d = validate(ctx.body, {
      countedCash: { type: 'number', required: true, min: 0 },
      comment:     { type: 'string', max: 500 },
    });
    const s = await tx(async (c) => {
      const { rows: [cur] } = await c.query(
        `SELECT * FROM cash_session WHERE id = $1 AND status = 'OPEN' FOR UPDATE`, [ctx.params.id]);
      if (!cur) throw notFound('Session de caisse ouverte introuvable.');
      const { rows: [cash] } = await c.query(
        `SELECT coalesce(sum(CASE WHEN is_refund THEN -amount ELSE amount END),0) AS total
           FROM payment WHERE cash_session_id = $1 AND method = 'CASH'`, [cur.id]);
      const expected = Number(cur.opening_float) + Number(cash.total);
      const { rows: [r] } = await c.query(
        `UPDATE cash_session SET status='CLOSED', closed_by=$2, closed_at=now(),
           counted_cash=$3::numeric, expected_cash=$4::numeric,
           discrepancy=$3::numeric - $4::numeric, comment=$5
         WHERE id=$1 RETURNING *`,
        [cur.id, ctx.user.sub, d.countedCash, expected, d.comment]);
      return r;
    });
    await writeAudit(ctx, { action: 'CASH_CLOSE', entity: 'cash_session', entityId: s.id,
      summary: `Clôture de caisse — écart ${s.discrepancy} €` });
    return s;
  }, { permission: 'payment.write' });

  /* ------------------------------ Impayés ------------------------------ */
  router.get('/api/invoices/reports/outstanding', async () => ({
    items: await many(
      `SELECT i.id, i.number, i.issued_at, i.due_date, i.total_amount, i.paid_amount, i.balance,
              (CURRENT_DATE - i.due_date) AS days_overdue,
              p.mrn, p.last_name, p.first_name, p.phone_mobile
         FROM invoice i JOIN patient p ON p.id = i.patient_id
        WHERE i.status IN ('ISSUED','PARTIALLY_PAID','OVERDUE') AND i.balance > 0
        ORDER BY i.due_date`),
  }), { permission: 'billing.read' });
}
