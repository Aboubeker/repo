/** Module Ressources : salles de consultation et équipements. */
import { many, one } from '../core/db.mjs';
import { notFound } from '../core/errors.mjs';
import { writeAudit } from '../core/audit.mjs';
import { validate } from '../core/validate.mjs';

export function registerResourceRoutes(router) {

  /* ------------------------------ Salles ------------------------------ */
  router.get('/api/rooms', async () => ({
    items: await many(
      `SELECT r.*,
              (SELECT count(*)::int FROM appointment_resource ar
                WHERE ar.room_id = r.id AND ar.period && tstzrange(now(), now() + interval '1 day')
              ) AS bookings_today
         FROM room r WHERE r.is_active ORDER BY r.code`),
  }), { permission: 'resource.read' });

  router.post('/api/rooms', async (ctx) => {
    const d = validate(ctx.body, {
      code:     { type: 'string', required: true, max: 20 },
      label:    { type: 'string', required: true, max: 100 },
      building: { type: 'string', max: 50 },
      floor:    { type: 'string', max: 20 },
      capacity: { type: 'number', min: 1, max: 100, default: 1 },
      kind:     { type: 'enum', default: 'CONSULTATION',
                  values: ['CONSULTATION','PROCEDURE','IMAGING','LAB','SURGERY','WAITING'] },
    });
    const r = await one(
      `INSERT INTO room (code, label, building, floor, capacity, kind)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [d.code, d.label, d.building, d.floor, d.capacity, d.kind]);
    await writeAudit(ctx, { action: 'CREATE', entity: 'room', entityId: r.id,
      summary: `Salle créée : ${r.code}` });
    return r;
  }, { permission: 'resource.write' });

  router.patch('/api/rooms/:id', async (ctx) => {
    const before = await one('SELECT * FROM room WHERE id = $1', [ctx.params.id]);
    if (!before) throw notFound('Salle introuvable.');
    const d = validate({ label: before.label, capacity: before.capacity,
      kind: before.kind, isActive: before.is_active, ...ctx.body }, {
      label:    { type: 'string', required: true, max: 100 },
      capacity: { type: 'number', min: 1, max: 100 },
      kind:     { type: 'enum', values: ['CONSULTATION','PROCEDURE','IMAGING','LAB','SURGERY','WAITING'] },
      isActive: { type: 'boolean' },
    });
    const r = await one(
      `UPDATE room SET label=$2, capacity=$3, kind=$4, is_active=$5 WHERE id=$1 RETURNING *`,
      [ctx.params.id, d.label, d.capacity, d.kind, d.isActive]);
    await writeAudit(ctx, { action: 'UPDATE', entity: 'room', entityId: r.id,
      summary: `Salle modifiée : ${r.code}` });
    return r;
  }, { permission: 'resource.write' });

  /** Plan d'occupation d'une salle : utile pour repérer les conflits matériels. */
  router.get('/api/rooms/:id/schedule', async (ctx) => {
    const day = ctx.query.date || new Date().toISOString().slice(0, 10);
    return { items: await many(
      `SELECT ar.period, lower(ar.period) AS start_at, upper(ar.period) AS end_at,
              a.reference, a.status, p.last_name AS patient_last_name,
              pr.last_name AS practitioner_last_name, at.label AS type_label
         FROM appointment_resource ar
         JOIN appointment a ON a.id = ar.appointment_id
         JOIN patient p ON p.id = a.patient_id
         JOIN practitioner pr ON pr.id = a.practitioner_id
         JOIN appointment_type at ON at.id = a.appointment_type_id
        WHERE ar.room_id = $1 AND ar.period && tstzrange($2::timestamptz, $3::timestamptz)
        ORDER BY lower(ar.period)`, [ctx.params.id, `${day} 00:00:00`, `${day} 23:59:59`]) };
  }, { permission: 'resource.read' });

  /* --------------------------- Équipements ---------------------------- */
  router.get('/api/equipment', async () => ({
    items: await many(
      `SELECT e.*, r.code AS room_code FROM equipment e
         LEFT JOIN room r ON r.id = e.room_id
        WHERE e.is_active ORDER BY e.code`),
  }), { permission: 'resource.read' });

  router.post('/api/equipment', async (ctx) => {
    const d = validate(ctx.body, {
      code:         { type: 'string', required: true, max: 20 },
      label:        { type: 'string', required: true, max: 100 },
      kind:         { type: 'string', max: 50 },
      serialNumber: { type: 'string', max: 60 },
      roomId:       { type: 'uuid' },
      isMobile:     { type: 'boolean', default: false },
      nextMaintenanceOn: { type: 'date' },
    });
    const e = await one(
      `INSERT INTO equipment (code, label, kind, serial_number, room_id, is_mobile, next_maintenance_on)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [d.code, d.label, d.kind, d.serialNumber, d.roomId, d.isMobile, d.nextMaintenanceOn]);
    await writeAudit(ctx, { action: 'CREATE', entity: 'equipment', entityId: e.id,
      summary: `Équipement créé : ${e.code}` });
    return e;
  }, { permission: 'resource.write' });

  router.patch('/api/equipment/:id', async (ctx) => {
    const d = validate(ctx.body, {
      status: { type: 'enum', values: ['AVAILABLE','IN_MAINTENANCE','OUT_OF_ORDER','RETIRED'] },
      nextMaintenanceOn: { type: 'date' },
      roomId: { type: 'uuid' },
    });
    const e = await one(
      `UPDATE equipment SET status = coalesce($2, status),
              next_maintenance_on = coalesce($3::date, next_maintenance_on),
              room_id = coalesce($4, room_id)
        WHERE id = $1 RETURNING *`,
      [ctx.params.id, d.status, d.nextMaintenanceOn, d.roomId]);
    if (!e) throw notFound('Équipement introuvable.');
    await writeAudit(ctx, { action: 'UPDATE', entity: 'equipment', entityId: e.id,
      summary: `Équipement ${e.code} → ${e.status}` });
    return e;
  }, { permission: 'resource.write' });

  /** Blocage d'une ressource (maintenance, nettoyage, réunion). */
  router.post('/api/resources/unavailability', async (ctx) => {
    const d = validate(ctx.body, {
      roomId:      { type: 'uuid' },
      equipmentId: { type: 'uuid' },
      startAt:     { type: 'datetime', required: true },
      endAt:       { type: 'datetime', required: true },
      reason:      { type: 'string', required: true, max: 200 },
    });
    const u = await one(
      `INSERT INTO resource_unavailability (room_id, equipment_id, period, reason)
       VALUES ($1,$2, tstzrange($3,$4,'[)'), $5) RETURNING *`,
      [d.roomId, d.equipmentId, d.startAt, d.endAt, d.reason]);
    await writeAudit(ctx, { action: 'CREATE', entity: 'resource_unavailability', entityId: u.id,
      summary: `Indisponibilité déclarée : ${d.reason}` });
    return u;
  }, { permission: 'resource.write' });
}
