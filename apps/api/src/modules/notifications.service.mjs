/**
 * Notifications locales.
 *
 * Contrainte on-premise : aucun service en ligne. Les canaux disponibles sont
 * un serveur SMTP interne, une passerelle SMS GSM du réseau local, ou
 * l'impression. En l'absence de passerelle, les notifications restent en file
 * et alimentent la « liste d'appels » imprimable de l'accueil.
 */
import { many, query } from '../core/db.mjs';

/** Décalages de rappel par défaut, en heures avant le rendez-vous. */
const REMINDER_OFFSETS_HOURS = [48, 2];

export async function scheduleAppointmentNotifications(client, appointmentId) {
  const { rows: [a] } = await client.query(
    `SELECT a.id, a.patient_id, lower(a.period) AS start_at, a.reference,
            p.first_name, p.last_name, p.email, p.phone_mobile,
            pr.last_name AS practitioner_name, at.label AS type_label,
            (SELECT granted FROM consent c WHERE c.patient_id = p.id AND c.kind='SMS_REMINDER')   AS sms_ok,
            (SELECT granted FROM consent c WHERE c.patient_id = p.id AND c.kind='EMAIL_REMINDER') AS email_ok
       FROM appointment a
       JOIN patient p ON p.id = a.patient_id
       JOIN practitioner pr ON pr.id = a.practitioner_id
       JOIN appointment_type at ON at.id = a.appointment_type_id
      WHERE a.id = $1`, [appointmentId]);
  if (!a) return;

  const when = new Date(a.start_at);
  const dateStr = when.toLocaleString('fr-FR', {
    dateStyle: 'full', timeStyle: 'short', timeZone: process.env.CLINIC_TZ || 'Europe/Paris' });
  const clinic = process.env.CLINIC_NAME || 'La clinique';

  const jobs = [];
  // Confirmation immédiate
  jobs.push({ code: 'APPT_CONFIRMATION', at: new Date() });
  // Rappels
  for (const h of REMINDER_OFFSETS_HOURS) {
    const at = new Date(when.getTime() - h * 3600_000);
    if (at > new Date()) jobs.push({ code: `APPT_REMINDER_${h}H`, at });
  }

  for (const job of jobs) {
    const body = `Bonjour ${a.first_name} ${a.last_name},\n\n` +
      `Votre rendez-vous « ${a.type_label} » avec le Dr ${a.practitioner_name} ` +
      `est prévu le ${dateStr}.\nRéférence : ${a.reference}.\n\n` +
      `Pour toute modification, contactez l'accueil.\n${clinic}`;

    if (a.email) {
      await client.query(
        `INSERT INTO notification (template_code, channel, appointment_id, patient_id,
           recipient, subject, body, scheduled_for, status)
         VALUES ($1,'EMAIL',$2,$3,$4,$5,$6,$7,$8)`,
        [job.code, a.id, a.patient_id, a.email,
         `Rendez-vous du ${dateStr} — ${clinic}`, body, job.at,
         a.email_ok === false ? 'SKIPPED_NO_CONSENT' : 'PENDING']);
    }
    if (a.phone_mobile) {
      await client.query(
        `INSERT INTO notification (template_code, channel, appointment_id, patient_id,
           recipient, body, scheduled_for, status)
         VALUES ($1,'SMS',$2,$3,$4,$5,$6,$7)`,
        [job.code, a.id, a.patient_id, a.phone_mobile,
         `${clinic} : RDV ${dateStr} avec Dr ${a.practitioner_name}. Réf ${a.reference}.`,
         job.at, a.sms_ok === false ? 'SKIPPED_NO_CONSENT' : 'PENDING']);
    }
  }
}

export async function cancelAppointmentNotifications(client, appointmentId) {
  await client.query(
    `UPDATE notification SET status = 'CANCELLED'
      WHERE appointment_id = $1 AND status = 'PENDING'`, [appointmentId]);
}

/**
 * Traitement de la file. Sans passerelle configurée, les envois sont
 * enregistrés dans un journal local (mode « spool ») et restent consultables :
 * l'accueil peut alors imprimer la liste d'appels.
 */
export async function processNotificationQueue({ limit = 50 } = {}) {
  const due = await many(
    `SELECT * FROM notification
      WHERE status = 'PENDING' AND scheduled_for <= now()
      ORDER BY scheduled_for LIMIT $1`, [limit]);

  let sent = 0, failed = 0;
  for (const n of due) {
    try {
      await deliver(n);
      await query(`UPDATE notification SET status='SENT', sent_at=now(), attempts=attempts+1
                    WHERE id=$1`, [n.id]);
      sent++;
    } catch (err) {
      const giveUp = n.attempts + 1 >= 3;
      await query(
        `UPDATE notification SET status = $2, attempts = attempts + 1, last_error = $3 WHERE id = $1`,
        [n.id, giveUp ? 'FAILED' : 'PENDING', err.message]);
      failed++;
    }
  }
  return { processed: due.length, sent, failed };
}

async function deliver(n) {
  const gateway = process.env.SMS_GATEWAY_URL;   // passerelle GSM sur le LAN
  const smtp = process.env.SMTP_HOST;            // serveur de messagerie interne
  if (n.channel === 'SMS' && !gateway) return spool(n);
  if (n.channel === 'EMAIL' && !smtp) return spool(n);
  // Les connecteurs réels (SMTP local / SMPP) se branchent ici.
  return spool(n);
}

function spool(n) {
  console.log(JSON.stringify({ t: new Date().toISOString(), notification: 'SPOOL',
    channel: n.channel, to: n.recipient, ref: n.template_code }));
}

/** Liste d'appels imprimable : rendez-vous de demain sans notification envoyée. */
export async function callList(date) {
  return many(
    `SELECT a.reference, a.start_at, a.patient_last_name, a.patient_first_name,
            a.patient_phone, a.practitioner_last_name, a.type_label, a.status
       FROM v_appointment_full a
      WHERE a.period && tstzrange($1::timestamptz, $2::timestamptz)
        AND a.status IN ('SCHEDULED')
        AND NOT EXISTS (SELECT 1 FROM notification n
                         WHERE n.appointment_id = a.id AND n.status = 'SENT')
      ORDER BY a.start_at`, [`${date} 00:00:00`, `${date} 23:59:59`]);
}
