/** Module Rapports : occupation, activité, indicateurs cliniques et financiers. */
import { many, one } from '../core/db.mjs';
import { writeAudit } from '../core/audit.mjs';

const range = (ctx) => {
  const from = ctx.query.from || new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const to = ctx.query.to || new Date().toISOString().slice(0, 10);
  return [`${from} 00:00:00`, `${to} 23:59:59`, from, to];
};

export function registerReportRoutes(router) {

  /** Tableau de bord synthétique de la période. */
  router.get('/api/reports/overview', async (ctx) => {
    const [s, e, from, to] = range(ctx);
    const [appts, finance, delay, duration] = await Promise.all([
      one(`SELECT
             count(*)::int AS total,
             count(*) FILTER (WHERE status='COMPLETED')::int AS completed,
             count(*) FILTER (WHERE status='CANCELLED')::int AS cancelled,
             count(*) FILTER (WHERE status='NO_SHOW')::int   AS no_show,
             count(*) FILTER (WHERE status IN ('SCHEDULED','CONFIRMED'))::int AS upcoming
           FROM appointment WHERE period && tstzrange($1::timestamptz,$2::timestamptz)
             AND status <> 'RESCHEDULED'`, [s, e]),
      one(`SELECT coalesce(sum(total_amount),0) AS revenue,
                  coalesce(sum(paid_amount),0)  AS collected,
                  coalesce(sum(balance) FILTER (WHERE status IN ('ISSUED','PARTIALLY_PAID','OVERDUE')),0)
                    AS outstanding
             FROM invoice WHERE issued_at BETWEEN $1::timestamptz AND $2::timestamptz`, [s, e]),
      one(`SELECT round(avg(EXTRACT(EPOCH FROM (lower(period) - created_at)) / 86400)::numeric, 1)
                    AS avg_lead_days
             FROM appointment WHERE created_at BETWEEN $1::timestamptz AND $2::timestamptz
               AND status IN ('COMPLETED','SCHEDULED','CONFIRMED')`, [s, e]),
      one(`SELECT round(avg(EXTRACT(EPOCH FROM (ended_at - started_at)) / 60)::numeric, 0)
                    AS avg_duration_minutes,
                  round(avg(EXTRACT(EPOCH FROM (started_at - checked_in_at)) / 60)::numeric, 0)
                    AS avg_wait_minutes
             FROM appointment WHERE status = 'COMPLETED'
               AND period && tstzrange($1::timestamptz,$2::timestamptz)`, [s, e]),
    ]);
    const denom = appts.completed + appts.no_show + appts.cancelled;
    return {
      period: { from, to },
      appointments: appts,
      noShowRate:    denom ? Math.round((appts.no_show / denom) * 1000) / 10 : 0,
      cancelledRate: denom ? Math.round((appts.cancelled / denom) * 1000) / 10 : 0,
      finance,
      avgLeadDays: delay?.avg_lead_days ?? null,
      avgDurationMinutes: duration?.avg_duration_minutes ?? null,
      avgWaitMinutes: duration?.avg_wait_minutes ?? null,
    };
  }, { permission: 'report.read' });

  /** Taux d'occupation par praticien : minutes réservées / capacité déclarée. */
  router.get('/api/reports/occupancy', async (ctx) => {
    const [s, e, from, to] = range(ctx);
    return { items: await many(
      `WITH weeks AS (SELECT greatest(1, ($4::date - $3::date + 1) / 7.0) AS n),
       capacity AS (
         SELECT ar.practitioner_id,
                sum(EXTRACT(EPOCH FROM (ar.end_time - ar.start_time)) / 60) * (SELECT n FROM weeks)
                  AS minutes
           FROM availability_rule ar GROUP BY ar.practitioner_id),
       booked AS (
         SELECT a.practitioner_id,
                sum(EXTRACT(EPOCH FROM (upper(a.period) - lower(a.period))) / 60) AS minutes,
                count(*)::int AS appointments
           FROM appointment a
          WHERE a.period && tstzrange($1::timestamptz,$2::timestamptz)
            AND a.status IN ('SCHEDULED','CONFIRMED','CHECKED_IN','IN_PROGRESS','COMPLETED')
          GROUP BY a.practitioner_id)
       SELECT p.id, p.code, p.last_name, p.first_name, p.color,
              coalesce(c.minutes, 0)::int AS capacity_minutes,
              coalesce(b.minutes, 0)::int AS booked_minutes,
              coalesce(b.appointments, 0) AS appointments,
              CASE WHEN coalesce(c.minutes,0) > 0
                   THEN round(100 * coalesce(b.minutes,0) / c.minutes)::int ELSE 0 END AS occupancy_rate
         FROM practitioner p
         LEFT JOIN capacity c ON c.practitioner_id = p.id
         LEFT JOIN booked b   ON b.practitioner_id = p.id
        WHERE p.is_active ORDER BY occupancy_rate DESC`, [s, e, from, to]) };
  }, { permission: 'report.read' });

  /** Répartition horaire : identifie les heures creuses. */
  router.get('/api/reports/hourly', async (ctx) => {
    const [s, e] = range(ctx);
    return { items: await many(
      `SELECT EXTRACT(HOUR FROM lower(period))::int AS hour, count(*)::int AS appointments
         FROM appointment
        WHERE period && tstzrange($1::timestamptz,$2::timestamptz)
          AND status NOT IN ('CANCELLED','RESCHEDULED')
        GROUP BY 1 ORDER BY 1`, [s, e]) };
  }, { permission: 'report.read' });

  /** Activité par spécialité. */
  router.get('/api/reports/by-specialty', async (ctx) => {
    const [s, e] = range(ctx);
    return { items: await many(
      `SELECT coalesce(sp.label, 'Non renseignée') AS specialty, sp.color,
              count(*)::int AS appointments,
              count(*) FILTER (WHERE a.status = 'COMPLETED')::int AS completed
         FROM appointment a
         JOIN appointment_type at ON at.id = a.appointment_type_id
         LEFT JOIN specialty sp ON sp.id = at.specialty_id
        WHERE a.period && tstzrange($1::timestamptz,$2::timestamptz)
          AND a.status <> 'RESCHEDULED'
        GROUP BY 1, sp.color ORDER BY appointments DESC`, [s, e]) };
  }, { permission: 'report.read' });

  /** Occupation des salles. */
  router.get('/api/reports/rooms', async (ctx) => {
    const [s, e] = range(ctx);
    return { items: await many(
      `SELECT r.code, r.label,
              count(ar.*)::int AS bookings,
              coalesce(sum(EXTRACT(EPOCH FROM (upper(ar.period) - lower(ar.period))) / 60), 0)::int
                AS booked_minutes
         FROM room r
         LEFT JOIN appointment_resource ar ON ar.room_id = r.id
              AND ar.period && tstzrange($1::timestamptz,$2::timestamptz)
        WHERE r.is_active GROUP BY r.id ORDER BY booked_minutes DESC`, [s, e]) };
  }, { permission: 'report.read' });

  /** Évolution quotidienne (courbe d'activité). */
  router.get('/api/reports/daily', async (ctx) => {
    const [s, e] = range(ctx);
    return { items: await many(
      `SELECT lower(period)::date AS day,
              count(*)::int AS total,
              count(*) FILTER (WHERE status = 'COMPLETED')::int AS completed,
              count(*) FILTER (WHERE status = 'NO_SHOW')::int  AS no_show
         FROM appointment
        WHERE period && tstzrange($1::timestamptz,$2::timestamptz) AND status <> 'RESCHEDULED'
        GROUP BY 1 ORDER BY 1`, [s, e]) };
  }, { permission: 'report.read' });

  /** Export CSV, écrit localement (aucun envoi réseau). */
  router.get('/api/reports/export', async (ctx) => {
    const [s, e] = range(ctx);
    const rows = await many(
      `SELECT reference, start_at, end_at, status, patient_last_name, patient_first_name,
              mrn, practitioner_last_name, type_label, specialty_label, room_code, reason
         FROM v_appointment_full
        WHERE period && tstzrange($1::timestamptz,$2::timestamptz)
        ORDER BY start_at`, [s, e]);
    await writeAudit(ctx, { action: 'EXPORT', entity: 'appointment',
      summary: `Export de ${rows.length} rendez-vous`, justification: ctx.query.reason || null });
    const header = Object.keys(rows[0] || { reference: '' }).join(';');
    const csv = [header, ...rows.map((r) => Object.values(r)
      .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(';'))].join('\n');
    ctx.res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="rendez-vous.csv"`,
    });
    ctx.res.end('\uFEFF' + csv);   // BOM pour Excel
  }, { permission: 'report.read' });

  /** Journal d'audit (réservé aux administrateurs). */
  router.get('/api/audit', async (ctx) => {
    const params = [Math.min(Number(ctx.query.limit || 100), 500)];
    const conds = [];
    if (ctx.query.entity)   { params.push(ctx.query.entity);   conds.push(`entity = $${params.length}`); }
    if (ctx.query.entityId) { params.push(ctx.query.entityId); conds.push(`entity_id = $${params.length}`); }
    if (ctx.query.username) { params.push(ctx.query.username); conds.push(`username = $${params.length}`); }
    if (ctx.query.action)   { params.push(ctx.query.action);   conds.push(`action = $${params.length}`); }
    return { items: await many(
      `SELECT * FROM audit_log ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''}
        ORDER BY occurred_at DESC LIMIT $1`, params) };
  }, { permission: 'audit.read' });
}
