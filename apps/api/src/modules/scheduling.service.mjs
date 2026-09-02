/**
 * Moteur de planification.
 *
 * Calcul des créneaux disponibles :
 *   règles de disponibilité  −  absences  −  fermetures  −  RDV existants
 *   −  indisponibilités de ressources
 *
 * La garantie d'absence de double réservation ne repose PAS sur ce calcul :
 * elle est assurée par les contraintes EXCLUDE de PostgreSQL. Ce moteur sert
 * à proposer des créneaux pertinents à l'utilisateur ; la base tranche.
 */
import { many, one } from '../core/db.mjs';

const MIN = 60_000;

/**
 * @param {object} p
 * @param {string} p.practitionerId
 * @param {string} p.from  date ISO (AAAA-MM-JJ)
 * @param {string} p.to    date ISO
 * @param {number} p.durationMinutes
 * @param {number} p.bufferBefore
 * @param {number} p.bufferAfter
 * @param {string} [p.appointmentTypeId]
 * @returns {Promise<Array<{start:string,end:string,roomId:string|null}>>}
 */
export async function computeAvailableSlots({
  practitionerId, from, to, durationMinutes,
  bufferBefore = 0, bufferAfter = 0, appointmentTypeId = null,
}) {
  const [rules, absences, closures, appointments, defaults] = await Promise.all([
    many(`SELECT * FROM availability_rule
           WHERE practitioner_id = $1 AND valid_from <= $3::date
             AND (valid_to IS NULL OR valid_to >= $2::date)`, [practitionerId, from, to]),
    many(`SELECT lower(period) AS s, upper(period) AS e FROM absence
           WHERE practitioner_id = $1 AND period && tstzrange($2::timestamptz, $3::timestamptz)`,
         [practitionerId, from, `${to} 23:59:59`]),
    many(`SELECT lower(period) AS s, upper(period) AS e FROM clinic_closure
           WHERE period && tstzrange($1::timestamptz, $2::timestamptz)`, [from, `${to} 23:59:59`]),
    many(`SELECT lower(blocked_period) AS s, upper(blocked_period) AS e FROM appointment
           WHERE practitioner_id = $1
             AND status IN ('SCHEDULED','CONFIRMED','CHECKED_IN','IN_PROGRESS')
             AND blocked_period && tstzrange($2::timestamptz, $3::timestamptz)`,
         [practitionerId, from, `${to} 23:59:59`]),
    one(`SELECT default_slot_minutes, office_room_id FROM practitioner WHERE id = $1`, [practitionerId]),
  ]);

  if (!rules.length) return [];

  const busy = [...absences, ...closures, ...appointments]
    .map((b) => ({ s: new Date(b.s).getTime(), e: new Date(b.e).getTime() }));

  const slots = [];
  const startDay = new Date(`${from}T00:00:00`);
  const endDay = new Date(`${to}T00:00:00`);
  const now = Date.now();

  for (let d = new Date(startDay); d <= endDay; d.setDate(d.getDate() + 1)) {
    const isoDow = ((d.getDay() + 6) % 7) + 1;             // 1 = lundi … 7 = dimanche
    const dayStr = toLocalDate(d);
    for (const rule of rules) {
      if (rule.weekday !== isoDow) continue;
      if (rule.valid_from && dayStr < toLocalDate(new Date(rule.valid_from))) continue;
      if (rule.valid_to && dayStr > toLocalDate(new Date(rule.valid_to))) continue;
      // une plage dédiée à un type de RDV n'accepte que ce type
      if (rule.appointment_type_id && appointmentTypeId &&
          rule.appointment_type_id !== appointmentTypeId) continue;

      const step = rule.slot_minutes || defaults?.default_slot_minutes || durationMinutes;
      let cursor = new Date(`${dayStr}T${rule.start_time}`).getTime();
      const limit = new Date(`${dayStr}T${rule.end_time}`).getTime();

      while (cursor + durationMinutes * MIN <= limit) {
        const s = cursor;
        const e = cursor + durationMinutes * MIN;
        const bs = s - bufferBefore * MIN;
        const be = e + bufferAfter * MIN;
        const free = s >= now && !busy.some((b) => bs < b.e && be > b.s);
        if (free) {
          slots.push({
            start: new Date(s).toISOString(),
            end: new Date(e).toISOString(),
            roomId: rule.room_id || defaults?.office_room_id || null,
          });
        }
        cursor += step * MIN;
      }
    }
  }
  return slots.sort((a, b) => a.start.localeCompare(b.start));
}

/** Cherche la première salle libre compatible sur la période demandée. */
export async function findFreeRoom(client, startAt, endAt, preferredRoomId = null) {
  const { rows } = await client.query(
    `SELECT r.id FROM room r
      WHERE r.is_active AND r.kind IN ('CONSULTATION','PROCEDURE','IMAGING')
        AND NOT EXISTS (
          SELECT 1 FROM appointment_resource ar
           WHERE ar.room_id = r.id AND ar.period && tstzrange($1::timestamptz, $2::timestamptz))
        AND NOT EXISTS (
          SELECT 1 FROM resource_unavailability ru
           WHERE ru.room_id = r.id AND ru.period && tstzrange($1::timestamptz, $2::timestamptz))
      ORDER BY (r.id = $3) DESC, r.code
      LIMIT 1`, [startAt, endAt, preferredRoomId]);
  return rows[0]?.id ?? null;
}

/** Indicateurs d'occupation pour un praticien sur une période. */
export async function occupancyFor(practitionerId, from, to) {
  return one(
    `WITH capacity AS (
       SELECT coalesce(sum(EXTRACT(EPOCH FROM (end_time - start_time)) / 60), 0) AS minutes_per_week
         FROM availability_rule WHERE practitioner_id = $1
     ), booked AS (
       SELECT coalesce(sum(EXTRACT(EPOCH FROM (upper(period) - lower(period))) / 60), 0) AS minutes
         FROM appointment
        WHERE practitioner_id = $1
          AND status IN ('SCHEDULED','CONFIRMED','CHECKED_IN','IN_PROGRESS','COMPLETED')
          AND period && tstzrange($2::timestamptz, $3::timestamptz)
     )
     SELECT c.minutes_per_week, b.minutes AS booked_minutes,
            CASE WHEN c.minutes_per_week > 0
                 THEN round(100 * b.minutes / (c.minutes_per_week *
                      greatest(1, ($3::date - $2::date) / 7.0)))
                 ELSE 0 END AS occupancy_rate
       FROM capacity c, booked b`, [practitionerId, from, to]);
}

function toLocalDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
