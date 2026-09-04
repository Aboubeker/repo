/** Module Praticiens : profils, spécialités, disponibilités, absences. */
import { many, one, tx } from '../core/db.mjs';
import { notFound, unprocessable } from '../core/errors.mjs';
import { writeAudit } from '../core/audit.mjs';
import { validate } from '../core/validate.mjs';
import { computeAvailableSlots } from './scheduling.service.mjs';

export function registerPractitionerRoutes(router) {

  router.get('/api/practitioners', async (ctx) => ({
    items: await many(
      `SELECT p.*, array_remove(array_agg(DISTINCT s.label), NULL) AS specialties,
              r.code AS office_room_code
         FROM practitioner p
         LEFT JOIN practitioner_specialty ps ON ps.practitioner_id = p.id
         LEFT JOIN specialty s ON s.id = ps.specialty_id
         LEFT JOIN room r ON r.id = p.office_room_id
        WHERE p.deleted_at IS NULL ${ctx.query.all === 'true' ? '' : 'AND p.is_active'}
        GROUP BY p.id, r.code ORDER BY p.last_name, p.first_name`),
  }), { permission: 'practitioner.read' });

  router.get('/api/practitioners/:id', async (ctx) => {
    const p = await one('SELECT * FROM practitioner WHERE id = $1', [ctx.params.id]);
    if (!p) throw notFound('Praticien introuvable.');
    const [specialties, rules, absences, stats] = await Promise.all([
      many(`SELECT s.*, ps.is_primary FROM practitioner_specialty ps
              JOIN specialty s ON s.id = ps.specialty_id WHERE ps.practitioner_id = $1`, [p.id]),
      many(`SELECT ar.*, r.code AS room_code, at.label AS type_label
              FROM availability_rule ar
              LEFT JOIN room r ON r.id = ar.room_id
              LEFT JOIN appointment_type at ON at.id = ar.appointment_type_id
             WHERE ar.practitioner_id = $1 ORDER BY ar.weekday, ar.start_time`, [p.id]),
      many(`SELECT id, lower(period) AS start_at, upper(period) AS end_at, reason, comment
              FROM absence WHERE practitioner_id = $1 AND upper(period) > now()
             ORDER BY lower(period)`, [p.id]),
      one(`SELECT
             count(*) FILTER (WHERE status = 'COMPLETED')::int AS completed,
             count(*) FILTER (WHERE status = 'NO_SHOW')::int   AS no_show,
             count(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled,
             count(*) FILTER (WHERE status IN ('SCHEDULED','CONFIRMED'))::int AS upcoming
           FROM appointment WHERE practitioner_id = $1
             AND lower(period) > now() - interval '90 days'`, [p.id]),
    ]);
    return { practitioner: p, specialties, availabilityRules: rules, absences, stats };
  }, { permission: 'practitioner.read' });

  router.post('/api/practitioners', async (ctx) => {
    const d = validate(ctx.body, {
      code:               { type: 'string', required: true, max: 20 },
      lastName:           { type: 'string', required: true, max: 100 },
      firstName:          { type: 'string', required: true, max: 100 },
      title:              { type: 'string', max: 30, default: 'Dr' },
      registrationNumber: { type: 'string', max: 30 },
      phone:              { type: 'string', max: 20 },
      email:              { type: 'string', max: 120 },
      defaultSlotMinutes: { type: 'number', min: 5, max: 240, default: 20 },
      color:              { type: 'string', max: 9, default: '#2563eb' },
      employmentType:     { type: 'enum', values: ['SALARIED','LIBERAL','LOCUM'], default: 'SALARIED' },
      officeRoomId:       { type: 'uuid' },
      specialtyIds:       { type: 'array', default: [] },
    });
    return tx(async (c) => {
      const { rows: [p] } = await c.query(
        `INSERT INTO practitioner (code, last_name, first_name, title, registration_number,
           phone, email, default_slot_minutes, color, employment_type, office_room_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [d.code, d.lastName, d.firstName, d.title, d.registrationNumber, d.phone, d.email,
         d.defaultSlotMinutes, d.color, d.employmentType, d.officeRoomId]);
      for (const [i, sid] of (d.specialtyIds || []).entries()) {
        await c.query(`INSERT INTO practitioner_specialty (practitioner_id, specialty_id, is_primary)
                       VALUES ($1,$2,$3)`, [p.id, sid, i === 0]);
      }
      await writeAudit(ctx, { action: 'CREATE', entity: 'practitioner', entityId: p.id,
        summary: `Création du praticien ${p.code} — ${p.last_name}` });
      return p;
    });
  }, { permission: 'practitioner.write' });

  router.patch('/api/practitioners/:id', async (ctx) => {
    const before = await one('SELECT * FROM practitioner WHERE id = $1', [ctx.params.id]);
    if (!before) throw notFound('Praticien introuvable.');
    const d = validate({
      lastName: before.last_name, firstName: before.first_name, title: before.title,
      phone: before.phone, email: before.email,
      defaultSlotMinutes: before.default_slot_minutes, color: before.color,
      isActive: before.is_active, ...ctx.body,
    }, {
      lastName:  { type: 'string', required: true, max: 100 },
      firstName: { type: 'string', required: true, max: 100 },
      title:     { type: 'string', max: 30 },
      phone:     { type: 'string', max: 20 },
      email:     { type: 'string', max: 120 },
      defaultSlotMinutes: { type: 'number', min: 5, max: 240 },
      color:     { type: 'string', max: 9 },
      isActive:  { type: 'boolean' },
      officeRoomId: { type: 'uuid' },
    });
    const p = await one(
      `UPDATE practitioner SET last_name=$2, first_name=$3, title=$4, phone=$5, email=$6,
         default_slot_minutes=$7, color=$8, is_active=$9, office_room_id=coalesce($10, office_room_id),
         updated_at=now() WHERE id=$1 RETURNING *`,
      [ctx.params.id, d.lastName, d.firstName, d.title, d.phone, d.email,
       d.defaultSlotMinutes, d.color, d.isActive, d.officeRoomId]);
    await writeAudit(ctx, { action: 'UPDATE', entity: 'practitioner', entityId: p.id,
      summary: `Modification du praticien ${p.code}` });
    return p;
  }, { permission: 'practitioner.write' });

  /* --------------------------- Disponibilités -------------------------- */
  router.post('/api/practitioners/:id/availability', async (ctx) => {
    const d = validate(ctx.body, {
      weekday:     { type: 'number', required: true, min: 1, max: 7 },
      startTime:   { type: 'string', required: true, pattern: /^\d{2}:\d{2}$/, message: 'Format HH:MM.' },
      endTime:     { type: 'string', required: true, pattern: /^\d{2}:\d{2}$/, message: 'Format HH:MM.' },
      roomId:      { type: 'uuid' },
      slotMinutes: { type: 'number', min: 5, max: 240 },
      validFrom:   { type: 'date' },
      validTo:     { type: 'date' },
      appointmentTypeId: { type: 'uuid' },
    });
    if (d.endTime <= d.startTime)
      throw unprocessable("L'heure de fin doit être postérieure à l'heure de début.");
    const r = await one(
      `INSERT INTO availability_rule (practitioner_id, weekday, start_time, end_time, room_id,
         slot_minutes, valid_from, valid_to, appointment_type_id)
       VALUES ($1,$2,$3,$4,$5,$6, coalesce($7::date, CURRENT_DATE), $8, $9) RETURNING *`,
      [ctx.params.id, d.weekday, d.startTime, d.endTime, d.roomId, d.slotMinutes,
       d.validFrom, d.validTo, d.appointmentTypeId]);
    await writeAudit(ctx, { action: 'CREATE', entity: 'availability_rule', entityId: r.id,
      summary: `Plage ajoutée : jour ${d.weekday} ${d.startTime}–${d.endTime}` });
    return r;
  }, { permission: 'practitioner.write' });

  router.delete('/api/practitioners/:pid/availability/:id', async (ctx) => {
    const r = await one('DELETE FROM availability_rule WHERE id = $1 RETURNING *', [ctx.params.id]);
    if (!r) throw notFound('Plage introuvable.');
    await writeAudit(ctx, { action: 'DELETE', entity: 'availability_rule', entityId: ctx.params.id,
      summary: 'Plage de disponibilité supprimée' });
    return { ok: true };
  }, { permission: 'practitioner.write' });

  /** Aperçu des créneaux générés par les règles (validation visuelle avant enregistrement). */
  router.get('/api/practitioners/:id/preview-slots', async (ctx) => {
    const from = ctx.query.from || new Date().toISOString().slice(0, 10);
    const to = ctx.query.to || new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);
    const p = await one('SELECT default_slot_minutes FROM practitioner WHERE id = $1', [ctx.params.id]);
    if (!p) throw notFound('Praticien introuvable.');
    const slots = await computeAvailableSlots({
      practitionerId: ctx.params.id, from, to, durationMinutes: p.default_slot_minutes });
    return { slots, count: slots.length };
  }, { permission: 'practitioner.read' });

  /* ------------------------------- Absences ---------------------------- */
  router.post('/api/practitioners/:id/absences', async (ctx) => {
    const d = validate(ctx.body, {
      startAt: { type: 'datetime', required: true },
      endAt:   { type: 'datetime', required: true },
      reason:  { type: 'enum', required: true, values: ['LEAVE','SICK','TRAINING','SURGERY','OTHER'] },
      comment: { type: 'string', max: 500 },
    });
    if (new Date(d.endAt) <= new Date(d.startAt))
      throw unprocessable('La date de fin doit être postérieure à la date de début.');

    // Rendez-vous impactés : signalés pour replanification
    const impacted = await many(
      `SELECT id, reference, start_at, patient_last_name, patient_first_name, patient_phone
         FROM v_appointment_full
        WHERE practitioner_id = $1 AND period && tstzrange($2::timestamptz, $3::timestamptz)
          AND status IN ('SCHEDULED','CONFIRMED')
        ORDER BY start_at`, [ctx.params.id, d.startAt, d.endAt]);

    const a = await one(
      `INSERT INTO absence (practitioner_id, period, reason, comment, created_by)
       VALUES ($1, tstzrange($2,$3,'[)'), $4, $5, $6) RETURNING *`,
      [ctx.params.id, d.startAt, d.endAt, d.reason, d.comment, ctx.user.sub]);

    await writeAudit(ctx, { action: 'CREATE', entity: 'absence', entityId: a.id,
      summary: `Absence ${d.reason} du ${d.startAt} au ${d.endAt} — ${impacted.length} RDV impactés` });
    return { absence: a, impactedAppointments: impacted };
  }, { permission: 'practitioner.write' });

  router.delete('/api/practitioners/:pid/absences/:id', async (ctx) => {
    await one('DELETE FROM absence WHERE id = $1 RETURNING id', [ctx.params.id]);
    await writeAudit(ctx, { action: 'DELETE', entity: 'absence', entityId: ctx.params.id,
      summary: 'Absence supprimée' });
    return { ok: true };
  }, { permission: 'practitioner.write' });
}
