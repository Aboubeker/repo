/** Module Rendez-vous : agenda, création, déplacement, annulation, parcours patient. */
import { many, one, tx } from '../core/db.mjs';
import { notFound, conflict, unprocessable, badRequest } from '../core/errors.mjs';
import { writeAudit } from '../core/audit.mjs';
import { validate } from '../core/validate.mjs';
import { computeAvailableSlots, findFreeRoom, occupancyFor } from './scheduling.service.mjs';
import { scheduleAppointmentNotifications, cancelAppointmentNotifications } from './notifications.service.mjs';

export function registerAppointmentRoutes(router) {

  /* ------------------------- Vue agenda ---------------------------- */
  router.get('/api/appointments', async (ctx) => {
    const from = ctx.query.from || new Date().toISOString().slice(0, 10);
    const to = ctx.query.to || from;
    const practitionerIds = (ctx.query.practitionerIds || '').split(',').filter(Boolean);
    const statuses = (ctx.query.statuses || '').split(',').filter(Boolean);

    const params = [`${from} 00:00:00`, `${to} 23:59:59`];
    let where = `period && tstzrange($1::timestamptz, $2::timestamptz)`;
    if (practitionerIds.length) { params.push(practitionerIds); where += ` AND practitioner_id = ANY($${params.length})`; }
    if (statuses.length)        { params.push(statuses);        where += ` AND status = ANY($${params.length})`; }
    else where += ` AND status <> 'RESCHEDULED'`;

    return { items: await many(
      `SELECT * FROM v_appointment_full WHERE ${where} ORDER BY start_at`, params) };
  }, { permission: 'appointment.read' });

  /* --------------------- Créneaux disponibles ----------------------- */
  router.get('/api/appointments/slots', async (ctx) => {
    const practitionerId = ctx.query.practitionerId;
    const typeId = ctx.query.appointmentTypeId;
    if (!practitionerId || !typeId)
      throw badRequest('practitionerId et appointmentTypeId sont requis.');
    const type = await one('SELECT * FROM appointment_type WHERE id = $1', [typeId]);
    if (!type) throw notFound('Type de rendez-vous introuvable.');
    const from = ctx.query.from || new Date().toISOString().slice(0, 10);
    const to = ctx.query.to ||
      new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
    const slots = await computeAvailableSlots({
      practitionerId, from, to,
      durationMinutes: Number(ctx.query.duration || type.default_duration_minutes),
      bufferBefore: type.buffer_before_minutes,
      bufferAfter: type.buffer_after_minutes,
      appointmentTypeId: typeId,
    });
    return { slots, durationMinutes: type.default_duration_minutes };
  }, { permission: 'appointment.read' });

  /* ---------------------------- Détail ------------------------------ */
  router.get('/api/appointments/:id', async (ctx) => {
    const a = await one('SELECT * FROM v_appointment_full WHERE id = $1', [ctx.params.id]);
    if (!a) throw notFound('Rendez-vous introuvable.');
    const [resources, history, notifications, allergies] = await Promise.all([
      many(`SELECT ar.*, r.code AS room_code, r.label AS room_label,
                   e.code AS equipment_code, e.label AS equipment_label
              FROM appointment_resource ar
              LEFT JOIN room r ON r.id = ar.room_id
              LEFT JOIN equipment e ON e.id = ar.equipment_id
             WHERE ar.appointment_id = $1`, [a.id]),
      many('SELECT * FROM appointment_status_history WHERE appointment_id = $1 ORDER BY changed_at DESC', [a.id]),
      many('SELECT * FROM notification WHERE appointment_id = $1 ORDER BY scheduled_for', [a.id]),
      many(`SELECT label, severity FROM medical_history_entry
             WHERE patient_id = $1 AND category = 'ALLERGY' AND is_active`, [a.patient_id]),
    ]);
    return { appointment: a, resources, history, notifications, allergies };
  }, { permission: 'appointment.read' });

  /* ---------------------------- Création ---------------------------- */
  router.post('/api/appointments', async (ctx) => {
    const d = validate(ctx.body, {
      patientId:         { type: 'uuid', required: true },
      practitionerId:    { type: 'uuid', required: true },
      appointmentTypeId: { type: 'uuid', required: true },
      startAt:           { type: 'datetime', required: true },
      durationMinutes:   { type: 'number', min: 5, max: 480 },
      reason:            { type: 'string', max: 300 },
      notes:             { type: 'string', max: 2000 },
      priority:          { type: 'enum', values: ['NORMAL','URGENT','EMERGENCY'], default: 'NORMAL' },
      origin:            { type: 'enum', values: ['DESK','PHONE','KIOSK','WAITLIST'], default: 'DESK' },
      roomId:            { type: 'uuid' },
      force:             { type: 'boolean', default: false },
    });

    const appt = await tx(async (c) => {
      // Sérialise les tentatives concurrentes sur le même praticien : les requêtes
      // se mettent en file au lieu de s'interbloquer. La contrainte EXCLUDE reste
      // la garantie finale d'intégrité.
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',
        [`appt:${d.practitionerId}`]);
      const type = (await c.query('SELECT * FROM appointment_type WHERE id = $1',
        [d.appointmentTypeId])).rows[0];
      if (!type) throw notFound('Type de rendez-vous introuvable.');

      const duration = d.durationMinutes || type.default_duration_minutes;
      const startAt = new Date(d.startAt);
      const endAt = new Date(startAt.getTime() + duration * 60_000);

      // Vérification métier (hors disponibilité / absence / fermeture).
      // Dérogeable avec la permission appointment.override.
      const { rows: [chk] } = await c.query(
        'SELECT fn_slot_is_available($1, $2, $3) AS ok', [d.practitionerId, startAt, endAt]);
      if (!chk.ok && !d.force) {
        throw unprocessable(
          "Ce créneau est hors des disponibilités du praticien, ou déjà occupé.",
          'SLOT_NOT_AVAILABLE');
      }
      if (!chk.ok && d.force && !(ctx.user.permissions || []).includes('appointment.override'))
        throw unprocessable("Vous n'avez pas le droit de forcer un créneau indisponible.", 'OVERRIDE_FORBIDDEN');

      // L'insertion peut échouer sur la contrainte EXCLUDE : c'est la garantie ultime.
      const { rows: [a] } = await c.query(
        `INSERT INTO appointment
           (patient_id, practitioner_id, appointment_type_id, period, blocked_period,
            reason, notes, priority, origin, created_by, updated_by, reference)
         VALUES ($1,$2,$3, tstzrange($4,$5,'[)'), tstzrange($4,$5,'[)'),
                 $6,$7,$8,$9,$10,$10,'')
         RETURNING *`,
        [d.patientId, d.practitionerId, d.appointmentTypeId, startAt, endAt,
         d.reason, d.notes, d.priority, d.origin, ctx.user.sub]);

      // Attribution automatique d'une salle si le type l'exige
      if (type.requires_room) {
        const roomId = d.roomId || await findFreeRoom(c, startAt, endAt, null);
        if (roomId) {
          await c.query(
            `INSERT INTO appointment_resource (appointment_id, room_id, period)
             VALUES ($1, $2, tstzrange($3,$4,'[)'))`, [a.id, roomId, startAt, endAt]);
        }
      }
      await scheduleAppointmentNotifications(c, a.id);
      return a;
    });

    const full = await one('SELECT * FROM v_appointment_full WHERE id = $1', [appt.id]);
    await writeAudit(ctx, { action: 'CREATE', entity: 'appointment', entityId: appt.id,
      summary: `RDV ${full.reference} — ${full.patient_last_name} avec Dr ${full.practitioner_last_name} le ${full.start_at}` });
    return full;
  }, { permission: 'appointment.write' });

  /* --------------------------- Déplacement --------------------------- */
  router.patch('/api/appointments/:id/reschedule', async (ctx) => {
    const d = validate(ctx.body, {
      startAt:         { type: 'datetime', required: true },
      durationMinutes: { type: 'number', min: 5, max: 480 },
      practitionerId:  { type: 'uuid' },
      version:         { type: 'number' },
      force:           { type: 'boolean', default: false },
    });

    const result = await tx(async (c) => {
      const { rows: [old] } = await c.query(
        'SELECT * FROM appointment WHERE id = $1 FOR UPDATE', [ctx.params.id]);
      if (!old) throw notFound('Rendez-vous introuvable.');
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',
        [`appt:${d.practitionerId || old.practitioner_id}`]);
      if (!['SCHEDULED','CONFIRMED'].includes(old.status))
        throw unprocessable(`Un rendez-vous « ${old.status} » ne peut pas être déplacé.`, 'INVALID_STATE');
      // Verrou optimiste : refus si un autre poste a modifié le RDV entre-temps
      if (d.version && d.version !== old.version)
        throw conflict('Ce rendez-vous a été modifié par un autre utilisateur. Rechargez la page.',
          'STALE_VERSION', { currentVersion: old.version });

      const practitionerId = d.practitionerId || old.practitioner_id;
      const { rows: [span] } = await c.query(
        `SELECT EXTRACT(EPOCH FROM (upper(period) - lower(period))) / 60 AS minutes
           FROM appointment WHERE id = $1`, [old.id]);
      const duration = d.durationMinutes || Number(span.minutes);
      const startAt = new Date(d.startAt);
      const endAt = new Date(startAt.getTime() + duration * 60_000);

      const { rows: [chk] } = await c.query(
        'SELECT fn_slot_is_available($1,$2,$3) AS ok', [practitionerId, startAt, endAt]);
      if (!chk.ok && !d.force)
        throw unprocessable('Le nouveau créneau est indisponible.', 'SLOT_NOT_AVAILABLE');

      // L'ancien RDV est marqué RESCHEDULED, un nouveau est créé : traçabilité complète
      await c.query(
        `UPDATE appointment SET status = 'RESCHEDULED', updated_by = $2, updated_at = now()
          WHERE id = $1`, [old.id, ctx.user.sub]);
      const { rows: [a] } = await c.query(
        `INSERT INTO appointment
           (patient_id, practitioner_id, appointment_type_id, period, blocked_period,
            reason, notes, priority, origin, rescheduled_from_id, created_by, updated_by, reference)
         VALUES ($1,$2,$3, tstzrange($4,$5,'[)'), tstzrange($4,$5,'[)'),
                 $6,$7,$8,$9,$10,$11,$11,'')
         RETURNING *`,
        [old.patient_id, practitionerId, old.appointment_type_id, startAt, endAt,
         old.reason, old.notes, old.priority, old.origin, old.id, ctx.user.sub]);

      await c.query(`UPDATE appointment_resource SET appointment_id = $1,
                       period = tstzrange($2,$3,'[)') WHERE appointment_id = $4`,
        [a.id, startAt, endAt, old.id]);
      await cancelAppointmentNotifications(c, old.id);
      await scheduleAppointmentNotifications(c, a.id);
      return { old, a };
    });

    const full = await one('SELECT * FROM v_appointment_full WHERE id = $1', [result.a.id]);
    await writeAudit(ctx, { action: 'RESCHEDULE', entity: 'appointment', entityId: result.a.id,
      summary: `RDV déplacé (ancien ${result.old.reference} → ${full.reference}) au ${full.start_at}` });
    return full;
  }, { permission: 'appointment.write' });

  /* --------------------------- Changement d'état ---------------------- */
  router.patch('/api/appointments/:id/status', async (ctx) => {
    const d = validate(ctx.body, {
      status:  { type: 'enum', required: true,
                 values: ['CONFIRMED','CHECKED_IN','IN_PROGRESS','COMPLETED','CANCELLED','NO_SHOW'] },
      reason:  { type: 'string', max: 300 },
      version: { type: 'number' },
    });
    if (d.status === 'CANCELLED' && !d.reason)
      throw badRequest("Le motif d'annulation est obligatoire.", { reason: 'Champ obligatoire.' });

    const a = await tx(async (c) => {
      const { rows: [cur] } = await c.query(
        'SELECT * FROM appointment WHERE id = $1 FOR UPDATE', [ctx.params.id]);
      if (!cur) throw notFound('Rendez-vous introuvable.');
      if (d.version && d.version !== cur.version)
        throw conflict('Rendez-vous modifié entre-temps. Rechargez la page.', 'STALE_VERSION',
          { currentVersion: cur.version });

      const ts = {
        CHECKED_IN:  'checked_in_at = now()',
        IN_PROGRESS: 'started_at = now()',
        COMPLETED:   'ended_at = now()',
      }[d.status];

      const { rows: [upd] } = await c.query(
        `UPDATE appointment SET status = $2, updated_by = $3, updated_at = now()
           ${ts ? ', ' + ts : ''}
           ${d.status === 'CANCELLED' ? ", cancellation_reason = $4, cancelled_by = $3, cancelled_at = now()" : ''}
         WHERE id = $1 RETURNING *`,
        d.status === 'CANCELLED'
          ? [cur.id, d.status, ctx.user.sub, d.reason]
          : [cur.id, d.status, ctx.user.sub]);

      if (d.status === 'CANCELLED') {
        await c.query('DELETE FROM appointment_resource WHERE appointment_id = $1', [cur.id]);
        await cancelAppointmentNotifications(c, cur.id);
      }
      // L'ouverture d'une consultation crée automatiquement le dossier de rencontre
      if (d.status === 'IN_PROGRESS') {
        await c.query(
          `INSERT INTO encounter (appointment_id, patient_id, practitioner_id)
           VALUES ($1,$2,$3) ON CONFLICT (appointment_id) DO NOTHING`,
          [cur.id, cur.patient_id, cur.practitioner_id]);
      }
      return upd;
    });

    await writeAudit(ctx, { action: 'STATUS', entity: 'appointment', entityId: a.id,
      summary: `Statut → ${d.status}${d.reason ? ` (${d.reason})` : ''}` });
    return one('SELECT * FROM v_appointment_full WHERE id = $1', [a.id]);
  }, { permission: 'appointment.write' });

  /* --------------------------- File du jour --------------------------- */
  router.get('/api/appointments/today/queue', async (ctx) => {
    const day = ctx.query.date || new Date().toISOString().slice(0, 10);
    const rows = await many(
      `SELECT a.*, s.no_show_count, s.critical_allergy_count, s.outstanding_balance,
              (SELECT i.id FROM invoice i WHERE i.patient_id = a.patient_id
                 AND i.status IN ('ISSUED','PARTIALLY_PAID') LIMIT 1) AS open_invoice_id
         FROM v_appointment_full a
         JOIN v_patient_summary s ON s.id = a.patient_id
        WHERE a.period && tstzrange($1::timestamptz, $2::timestamptz)
        ORDER BY a.start_at`, [`${day} 00:00:00`, `${day} 23:59:59`]);
    const group = (st) => rows.filter((r) => st.includes(r.status));
    return {
      date: day,
      expected:   group(['SCHEDULED','CONFIRMED']),
      waiting:    group(['CHECKED_IN']),
      inProgress: group(['IN_PROGRESS']),
      done:       group(['COMPLETED']),
      absent:     group(['NO_SHOW']),
      cancelled:  group(['CANCELLED']),
    };
  }, { permission: 'appointment.read' });

  /* ---------------------- Série de rendez-vous ------------------------ */
  router.post('/api/appointments/series', async (ctx) => {
    const d = validate(ctx.body, {
      patientId:         { type: 'uuid', required: true },
      practitionerId:    { type: 'uuid', required: true },
      appointmentTypeId: { type: 'uuid', required: true },
      startAt:           { type: 'datetime', required: true },
      occurrences:       { type: 'number', required: true, min: 2, max: 52 },
      intervalDays:      { type: 'number', default: 7, min: 1, max: 90 },
      reason:            { type: 'string', max: 300 },
    });
    const type = await one('SELECT * FROM appointment_type WHERE id = $1', [d.appointmentTypeId]);
    if (!type) throw notFound('Type de rendez-vous introuvable.');

    const created = [], skipped = [];
    const groupId = crypto.randomUUID();
    for (let i = 0; i < d.occurrences; i++) {
      const start = new Date(new Date(d.startAt).getTime() + i * d.intervalDays * 864e5);
      const end = new Date(start.getTime() + type.default_duration_minutes * 60_000);
      try {
        const a = await tx(async (c) => {
          const { rows: [chk] } = await c.query('SELECT fn_slot_is_available($1,$2,$3) AS ok',
            [d.practitionerId, start, end]);
          if (!chk.ok) throw unprocessable('Créneau indisponible.', 'SLOT_NOT_AVAILABLE');
          const { rows: [r] } = await c.query(
            `INSERT INTO appointment (patient_id, practitioner_id, appointment_type_id,
               period, blocked_period, reason, recurrence_group_id, created_by, updated_by, reference)
             VALUES ($1,$2,$3, tstzrange($4,$5,'[)'), tstzrange($4,$5,'[)'), $6, $7, $8, $8, '')
             RETURNING *`,
            [d.patientId, d.practitionerId, d.appointmentTypeId, start, end, d.reason,
             groupId, ctx.user.sub]);
          await scheduleAppointmentNotifications(c, r.id);
          return r;
        });
        created.push({ reference: a.reference, startAt: start.toISOString() });
      } catch (err) {
        skipped.push({ startAt: start.toISOString(), reason: err.message });
      }
    }
    await writeAudit(ctx, { action: 'CREATE', entity: 'appointment_series', entityId: groupId,
      summary: `Série de ${created.length} rendez-vous créée (${skipped.length} ignorés)` });
    return { groupId, created, skipped };
  }, { permission: 'appointment.write' });

  /* --------------------------- Liste d'attente ------------------------ */
  router.get('/api/waiting-list', async () => ({
    items: await many(
      `SELECT w.*, p.mrn, p.last_name, p.first_name, p.phone_mobile,
              pr.last_name AS practitioner_last_name, s.label AS specialty_label
         FROM waiting_list_entry w
         JOIN patient p ON p.id = w.patient_id
         LEFT JOIN practitioner pr ON pr.id = w.practitioner_id
         LEFT JOIN specialty s ON s.id = w.specialty_id
        WHERE w.status = 'WAITING' ORDER BY
          CASE w.priority WHEN 'EMERGENCY' THEN 0 WHEN 'URGENT' THEN 1 ELSE 2 END,
          w.created_at`),
  }), { permission: 'appointment.read' });

  router.post('/api/waiting-list', async (ctx) => {
    const d = validate(ctx.body, {
      patientId:         { type: 'uuid', required: true },
      practitionerId:    { type: 'uuid' },
      specialtyId:       { type: 'uuid' },
      appointmentTypeId: { type: 'uuid' },
      earliestDate:      { type: 'date' },
      latestDate:        { type: 'date' },
      priority:          { type: 'enum', values: ['NORMAL','URGENT','EMERGENCY'], default: 'NORMAL' },
      note:              { type: 'string', max: 500 },
    });
    const w = await one(
      `INSERT INTO waiting_list_entry (patient_id, practitioner_id, specialty_id,
         appointment_type_id, earliest_date, latest_date, priority, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [d.patientId, d.practitionerId, d.specialtyId, d.appointmentTypeId,
       d.earliestDate, d.latestDate, d.priority, d.note]);
    await writeAudit(ctx, { action: 'CREATE', entity: 'waiting_list', entityId: w.id,
      summary: 'Inscription en liste d\'attente' });
    return w;
  }, { permission: 'appointment.write' });

  /* --------------------------- Consultation --------------------------- */
  router.put('/api/appointments/:id/encounter', async (ctx) => {
    const d = validate(ctx.body, {
      chiefComplaint: { type: 'string', max: 500 },
      diagnosisCode:  { type: 'string', max: 20 },
      diagnosisLabel: { type: 'string', max: 300 },
      observations:   { type: 'string', max: 20000 },
      plan:           { type: 'string', max: 10000 },
      lock:           { type: 'boolean', default: false },
    });
    const existing = await one('SELECT * FROM encounter WHERE appointment_id = $1', [ctx.params.id]);
    if (existing?.is_locked)
      throw unprocessable('Ce compte rendu est signé et ne peut plus être modifié.', 'ENCOUNTER_LOCKED');
    const a = await one('SELECT * FROM appointment WHERE id = $1', [ctx.params.id]);
    if (!a) throw notFound('Rendez-vous introuvable.');

    const e = await one(
      `INSERT INTO encounter (appointment_id, patient_id, practitioner_id, chief_complaint,
         diagnosis_code, diagnosis_label, observations, plan, is_locked, locked_at, locked_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, CASE WHEN $9 THEN now() END, CASE WHEN $9 THEN $10::uuid END)
       ON CONFLICT (appointment_id) DO UPDATE SET
         chief_complaint = EXCLUDED.chief_complaint, diagnosis_code = EXCLUDED.diagnosis_code,
         diagnosis_label = EXCLUDED.diagnosis_label, observations = EXCLUDED.observations,
         plan = EXCLUDED.plan, is_locked = EXCLUDED.is_locked,
         locked_at = EXCLUDED.locked_at, locked_by = EXCLUDED.locked_by
       RETURNING *`,
      [a.id, a.patient_id, a.practitioner_id, d.chiefComplaint, d.diagnosisCode,
       d.diagnosisLabel, d.observations, d.plan, d.lock, ctx.user.sub]);
    await writeAudit(ctx, { action: 'UPDATE', entity: 'encounter', entityId: e.id,
      summary: d.lock ? 'Compte rendu signé' : 'Compte rendu enregistré' });
    return e;
  }, { permission: 'encounter.write' });

  router.get('/api/appointments/:id/encounter', async (ctx) =>
    (await one('SELECT * FROM encounter WHERE appointment_id = $1', [ctx.params.id])) || {},
    { permission: 'encounter.read' });

  /* ---------------------------- Occupation ---------------------------- */
  router.get('/api/practitioners/:id/occupancy', async (ctx) => {
    const from = ctx.query.from || new Date().toISOString().slice(0, 10);
    const to = ctx.query.to || from;
    return occupancyFor(ctx.params.id, from, to);
  }, { permission: 'appointment.read' });
}
