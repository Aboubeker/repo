#!/usr/bin/env node
/**
 * Jeu de données de démonstration : rôles, permissions, référentiels,
 * praticiens, patients et un planning réaliste sur plusieurs semaines.
 */
import { pool } from '../core/db.mjs';
import { hashPassword } from '../core/auth.mjs';

const c = await pool.connect();
const q = (sql, p) => c.query(sql, p);
const first = async (sql, p) => (await c.query(sql, p)).rows[0];

try {
  await q('BEGIN');
  console.log('• Initialisation des données de démonstration…');

  /* ------------------------- Permissions & rôles ------------------------ */
  const PERMISSIONS = [
    ['patient.read', 'Consulter les patients', 'Patients'],
    ['patient.write', 'Créer / modifier les patients', 'Patients'],
    ['patient.write.medical', 'Saisir les données médicales', 'Patients'],
    ['patient.merge', 'Fusionner des fiches patients', 'Patients'],
    ['practitioner.read', 'Consulter les praticiens', 'Praticiens'],
    ['practitioner.write', 'Gérer les praticiens et disponibilités', 'Praticiens'],
    ['appointment.read', 'Consulter l\'agenda', 'Rendez-vous'],
    ['appointment.write', 'Créer / modifier des rendez-vous', 'Rendez-vous'],
    ['appointment.override', 'Forcer un créneau indisponible', 'Rendez-vous'],
    ['encounter.read', 'Lire les comptes rendus', 'Consultations'],
    ['encounter.write', 'Rédiger les comptes rendus', 'Consultations'],
    ['resource.read', 'Consulter les ressources', 'Ressources'],
    ['resource.write', 'Gérer salles et équipements', 'Ressources'],
    ['billing.read', 'Consulter la facturation', 'Facturation'],
    ['invoice.write', 'Créer et émettre des factures', 'Facturation'],
    ['invoice.void', 'Émettre des avoirs', 'Facturation'],
    ['payment.write', 'Encaisser des paiements', 'Facturation'],
    ['report.read', 'Consulter les rapports', 'Rapports'],
    ['audit.read', 'Consulter le journal d\'audit', 'Administration'],
    ['admin.users', 'Gérer les utilisateurs', 'Administration'],
    ['admin.settings', 'Modifier le paramétrage', 'Administration'],
    ['admin.backup', 'Gérer les sauvegardes', 'Administration'],
  ];
  for (const [code, label, category] of PERMISSIONS) {
    await q(`INSERT INTO permission (code,label,category) VALUES ($1,$2,$3)
             ON CONFLICT (code) DO NOTHING`, [code, label, category]);
  }

  const ROLES = {
    ADMIN: { label: 'Administrateur', perms: PERMISSIONS.map((p) => p[0]) },
    RECEPTION: { label: 'Réceptionniste', perms: [
      'patient.read','patient.write','practitioner.read','appointment.read','appointment.write',
      'resource.read','billing.read','invoice.write','payment.write'] },
    PRACTITIONER: { label: 'Praticien', perms: [
      'patient.read','patient.write','patient.write.medical','practitioner.read','practitioner.write',
      'appointment.read','appointment.write','appointment.override',
      'encounter.read','encounter.write','resource.read','report.read'] },
    BILLING: { label: 'Facturation', perms: [
      'patient.read','appointment.read','billing.read','invoice.write','invoice.void',
      'payment.write','report.read'] },
    READONLY: { label: 'Consultation seule', perms: ['report.read'] },
  };
  const roleIds = {};
  for (const [code, { label, perms }] of Object.entries(ROLES)) {
    const r = await first(`INSERT INTO role (code,label) VALUES ($1,$2)
      ON CONFLICT (code) DO UPDATE SET label = EXCLUDED.label RETURNING id`, [code, label]);
    roleIds[code] = r.id;
    for (const p of perms) {
      await q(`INSERT INTO role_permission (role_id, permission_code) VALUES ($1,$2)
               ON CONFLICT DO NOTHING`, [r.id, p]);
    }
  }

  /* ---------------------------- Référentiels ---------------------------- */
  const specialties = {};
  for (const [code, label, color] of [
    ['CARDIO', 'Cardiologie', '#dc2626'], ['GENE', 'Médecine générale', '#2563eb'],
    ['DERMA', 'Dermatologie', '#7c3aed'], ['KINE', 'Kinésithérapie', '#059669'],
    ['PEDIA', 'Pédiatrie', '#ea580c'],
  ]) {
    specialties[code] = (await first(
      `INSERT INTO specialty (code,label,color) VALUES ($1,$2,$3) RETURNING id`,
      [code, label, color])).id;
  }

  const rooms = {};
  for (const [code, label, kind, floor] of [
    ['S01', 'Salle de consultation 1', 'CONSULTATION', 'RDC'],
    ['S02', 'Salle de consultation 2', 'CONSULTATION', 'RDC'],
    ['S03', 'Salle de consultation 3', 'CONSULTATION', '1er'],
    ['S12', 'Cardiologie — ECG', 'PROCEDURE', '1er'],
    ['S07', 'Kinésithérapie', 'PROCEDURE', 'RDC'],
    ['IMG1', 'Imagerie / échographie', 'IMAGING', 'RDC'],
  ]) {
    rooms[code] = (await first(
      `INSERT INTO room (code,label,kind,floor,building) VALUES ($1,$2,$3,$4,'Bâtiment A') RETURNING id`,
      [code, label, kind, floor])).id;
  }

  for (const [code, label, kind, roomCode] of [
    ['ECG-01', 'Électrocardiographe 1', 'ECG', 'S12'],
    ['ECHO-01', 'Échographe portable', 'ECHOGRAPHE', 'IMG1'],
    ['TENS-01', 'Électrostimulateur', 'KINE', 'S07'],
  ]) {
    await q(`INSERT INTO equipment (code,label,kind,room_id) VALUES ($1,$2,$3,$4)`,
      [code, label, kind, rooms[roomCode]]);
  }

  const tariffs = {};
  for (const [code, label, amount, spec] of [
    ['CS', 'Consultation simple', 25.00, 'GENE'],
    ['CSC', 'Consultation cardiologie', 50.00, 'CARDIO'],
    ['ECG', 'Électrocardiogramme', 35.00, 'CARDIO'],
    ['CSD', 'Consultation dermatologie', 45.00, 'DERMA'],
    ['SKINE', 'Séance de kinésithérapie', 22.00, 'KINE'],
    ['CSP', 'Consultation pédiatrique', 30.00, 'PEDIA'],
  ]) {
    tariffs[code] = (await first(
      `INSERT INTO tariff (code,label,amount,specialty_id) VALUES ($1,$2,$3,$4) RETURNING id`,
      [code, label, amount, specialties[spec]])).id;
  }

  const types = {};
  for (const [code, label, spec, dur, before, after, tariff, color] of [
    ['CS-GEN', 'Consultation générale', 'GENE', 20, 0, 5, 'CS', '#2563eb'],
    ['CS-CARDIO', 'Consultation cardiologie', 'CARDIO', 30, 0, 10, 'CSC', '#dc2626'],
    ['ECG', 'Électrocardiogramme', 'CARDIO', 20, 5, 10, 'ECG', '#f97316'],
    ['CS-DERMA', 'Consultation dermatologie', 'DERMA', 20, 0, 5, 'CSD', '#7c3aed'],
    ['KINE', 'Séance de kinésithérapie', 'KINE', 30, 0, 0, 'SKINE', '#059669'],
    ['CS-PEDIA', 'Consultation pédiatrique', 'PEDIA', 25, 0, 5, 'CSP', '#ea580c'],
    ['URGENCE', 'Consultation urgente', 'GENE', 15, 0, 0, 'CS', '#b91c1c'],
  ]) {
    types[code] = (await first(
      `INSERT INTO appointment_type (code,label,specialty_id,default_duration_minutes,
         buffer_before_minutes,buffer_after_minutes,default_tariff_id,color)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [code, label, specialties[spec], dur, before, after, tariffs[tariff], color])).id;
  }

  /* ------------------------------ Praticiens ---------------------------- */
  const practitioners = [];
  for (const [code, last, first_, spec, room, slot, color] of [
    ['DR-001', 'BERNARD', 'Alice', 'CARDIO', 'S12', 30, '#dc2626'],
    ['DR-002', 'LEROY', 'Marc', 'GENE', 'S01', 20, '#2563eb'],
    ['DR-003', 'AZIZ', 'Nadia', 'DERMA', 'S02', 20, '#7c3aed'],
    ['DR-004', 'MOREAU', 'Julien', 'KINE', 'S07', 30, '#059669'],
    ['DR-005', 'PETIT', 'Sophie', 'PEDIA', 'S03', 25, '#ea580c'],
  ]) {
    const p = await first(
      `INSERT INTO practitioner (code,last_name,first_name,title,office_room_id,
         default_slot_minutes,color,employment_type,registration_number,phone)
       VALUES ($1,$2,$3,'Dr',$4,$5,$6,'SALARIED',$7,$8) RETURNING *`,
      [code, last, first_, rooms[room], slot, color,
       '10' + code.slice(-3) + '00000', '01 23 45 67 ' + code.slice(-2)]);
    await q(`INSERT INTO practitioner_specialty (practitioner_id,specialty_id,is_primary)
             VALUES ($1,$2,true)`, [p.id, specialties[spec]]);
    // Disponibilités : lundi–vendredi, matin et après-midi
    for (const wd of [1, 2, 3, 4, 5]) {
      await q(`INSERT INTO availability_rule (practitioner_id,weekday,start_time,end_time,room_id,slot_minutes)
               VALUES ($1,$2,'08:00','12:00',$3,$4)`, [p.id, wd, rooms[room], slot]);
      if (wd !== 3) {  // mercredi après-midi non travaillé
        await q(`INSERT INTO availability_rule (practitioner_id,weekday,start_time,end_time,room_id,slot_minutes)
                 VALUES ($1,$2,'14:00','18:00',$3,$4)`, [p.id, wd, rooms[room], slot]);
      }
    }
    practitioners.push({ ...p, specCode: spec });
  }

  /* ----------------------------- Utilisateurs --------------------------- */
  const users = [
    ['admin', 'Administrateur Système', ['ADMIN'], null],
    ['s.martin', 'Sophie MARTIN', ['RECEPTION'], null],
    ['l.dubois', 'Laura DUBOIS', ['RECEPTION'], null],
    ['a.bernard', 'Dr Alice BERNARD', ['PRACTITIONER'], practitioners[0].id],
    ['m.leroy', 'Dr Marc LEROY', ['PRACTITIONER'], practitioners[1].id],
    ['n.aziz', 'Dr Nadia AZIZ', ['PRACTITIONER'], practitioners[2].id],
    ['c.compta', 'Claire COMPTABLE', ['BILLING'], null],
  ];
  const pwHash = hashPassword('Clinique2026!');
  for (const [username, fullName, roles, practId] of users) {
    const u = await first(
      `INSERT INTO user_account (username, full_name, password_hash, practitioner_id, email)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [username, fullName, pwHash, practId, `${username}@clinique.local`]);
    for (const r of roles) {
      await q('INSERT INTO user_role (user_id, role_id) VALUES ($1,$2)', [u.id, roleIds[r]]);
    }
  }

  /* ------------------------------- Patients ----------------------------- */
  const NAMES = [
    ['DUPONT','Marie','F','1979-03-12'], ['NKOSI','Jean','M','1985-07-22'],
    ['SOW','Fatou','F','1992-11-03'], ['MARTIN','Luc','M','1968-01-30'],
    ['BEN ALI','Samir','M','1974-05-18'], ['KONE','Awa','F','1990-09-09'],
    ['DIALLO','Mamadou','M','1955-12-25'], ['TRAORE','Kadi','F','2001-04-14'],
    ['BERGER','Thomas','M','1988-08-08'], ['LEROUX','Camille','F','1995-02-27'],
    ['GARCIA','Elena','F','1962-06-15'], ['NGUYEN','Minh','M','1998-10-05'],
    ['ROUSSEAU','Pierre','M','1971-03-21'], ['HADDAD','Leila','F','1983-12-11'],
    ['SCHMIDT','Anna','F','1959-07-07'], ['OKONKWO','David','M','1993-05-30'],
    ['FERRARI','Marco','M','1977-09-19'], ['DUBOIS','Julie','F','2005-01-08'],
    ['MERCIER','Paul','M','1948-11-23'], ['LAMBERT','Chloé','F','2012-06-02'],
  ];
  const patients = [];
  for (const [i, [last, first_, sex, birth]] of NAMES.entries()) {
    const p = await first(
      `INSERT INTO patient (mrn, last_name, first_name, sex, birth_date, phone_mobile, email,
         address_line1, postal_code, city, blood_type)
       VALUES ('P-2026-' || lpad(nextval('patient_mrn_seq')::text,6,'0'),
               $1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [last, first_, sex, birth,
       `06 ${10 + i} ${20 + i} ${30 + i} ${40 + i}`.slice(0, 14),
       `${first_.toLowerCase()}.${last.toLowerCase().replace(/\s/g,'')}@exemple.local`,
       `${i + 1} rue des Lilas`, `690${String(i % 10).padStart(2, '0')}`, 'LYON',
       ['A+','O+','B+','AB+','O-'][i % 5]]);
    patients.push(p);
    await q(`INSERT INTO patient_insurance (patient_id, scheme, insurer_name, coverage_rate, is_primary)
             VALUES ($1,'Régime obligatoire','CPAM',70,true)`, [p.id]);
    for (const kind of ['DATA_PROCESSING','SMS_REMINDER','EMAIL_REMINDER']) {
      await q(`INSERT INTO consent (patient_id, kind, granted) VALUES ($1,$2,$3)`,
        [p.id, kind, i % 7 !== 0]);   // quelques patients sans consentement
    }
  }
  // Antécédents notables
  await q(`INSERT INTO medical_history_entry (patient_id,category,label,severity,is_active)
           VALUES ($1,'ALLERGY','Pénicilline','CRITICAL',true)`, [patients[0].id]);
  await q(`INSERT INTO medical_history_entry (patient_id,category,label,severity,is_active)
           VALUES ($1,'CHRONIC_CONDITION','Hypertension artérielle','MODERATE',true)`, [patients[0].id]);
  await q(`INSERT INTO medical_history_entry (patient_id,category,label,severity,is_active)
           VALUES ($1,'ALLERGY','Arachides','CRITICAL',true)`, [patients[7].id]);
  await q(`INSERT INTO medical_history_entry (patient_id,category,label,severity,is_active)
           VALUES ($1,'CHRONIC_CONDITION','Diabète de type 2','HIGH',true)`, [patients[6].id]);

  /* ------------------------------ Agenda -------------------------------- */
  // Planning réaliste : 3 semaines passées + 3 semaines à venir
  const TYPE_BY_SPEC = { CARDIO: 'CS-CARDIO', GENE: 'CS-GEN', DERMA: 'CS-DERMA',
                         KINE: 'KINE', PEDIA: 'CS-PEDIA' };
  const REASONS = ['Suivi de traitement', 'Bilan annuel', 'Douleurs persistantes',
    'Contrôle post-opératoire', 'Renouvellement d\'ordonnance', 'Première consultation',
    'Résultats d\'analyses', 'Vaccination'];

  let created = 0, conflicts = 0;
  const today = new Date(); today.setHours(0, 0, 0, 0);

  for (let dayOffset = -21; dayOffset <= 21; dayOffset++) {
    const day = new Date(today.getTime() + dayOffset * 864e5);
    const dow = ((day.getDay() + 6) % 7) + 1;
    if (dow > 5) continue;                                  // week-end

    for (const pr of practitioners) {
      const typeId = types[TYPE_BY_SPEC[pr.specCode]];
      const dur = pr.default_slot_minutes;
      const slotsPerHalfDay = Math.floor(240 / dur);
      // taux de remplissage variable pour des statistiques réalistes
      const fill = 0.45 + ((dayOffset + pr.code.charCodeAt(4)) % 5) * 0.11;
      // matin 08:00–12:00 et après-midi 14:00–18:00 (sauf mercredi après-midi)
      const halfDays = dow === 3 ? [8] : [8, 14];

      for (const baseHour of halfDays)
      for (let s = 0; s < slotsPerHalfDay; s++) {
        if (Math.random() > fill) continue;
        const start = new Date(day); start.setHours(baseHour, s * dur, 0, 0);
        const end = new Date(start.getTime() + dur * 60_000);
        const patient = patients[Math.floor(Math.random() * patients.length)];

        let status;
        if (dayOffset < 0) {
          const r = Math.random();
          status = r < 0.86 ? 'COMPLETED' : r < 0.93 ? 'NO_SHOW' : 'CANCELLED';
        } else if (dayOffset === 0) {
          const now = new Date();
          if (start < new Date(now.getTime() - 45 * 60_000)) {
            status = Math.random() < 0.92 ? 'COMPLETED' : 'NO_SHOW';
          } else if (start < now) {
            // consultations en cours ou patients en salle d'attente
            status = Math.random() < 0.5 ? 'IN_PROGRESS' : 'CHECKED_IN';
          } else if (start < new Date(now.getTime() + 60 * 60_000)) {
            status = Math.random() < 0.4 ? 'CHECKED_IN' : 'CONFIRMED';
          } else {
            status = Math.random() < 0.7 ? 'CONFIRMED' : 'SCHEDULED';
          }
        } else {
          status = Math.random() < 0.6 ? 'CONFIRMED' : 'SCHEDULED';
        }

        try {
          await q('SAVEPOINT sp');
          const a = await first(
            `INSERT INTO appointment (patient_id, practitioner_id, appointment_type_id,
               period, blocked_period, reason, status, reference,
               checked_in_at, started_at, ended_at)
             VALUES ($1,$2,$3, tstzrange($4,$5,'[)'), tstzrange($4,$5,'[)'), $6, 'SCHEDULED', '',
               $7, $8, $9)
             RETURNING id`,
            [patient.id, pr.id, typeId, start, end,
             REASONS[Math.floor(Math.random() * REASONS.length)],
             ['COMPLETED','IN_PROGRESS','CHECKED_IN'].includes(status)
               ? new Date(start.getTime() - 6 * 60_000) : null,
             ['COMPLETED','IN_PROGRESS'].includes(status) ? start : null,
             status === 'COMPLETED' ? end : null]);

          // statut cible via la machine à états
          const path = { COMPLETED: ['CONFIRMED','CHECKED_IN','IN_PROGRESS','COMPLETED'],
                         NO_SHOW: ['CONFIRMED','NO_SHOW'], CANCELLED: ['CANCELLED'],
                         IN_PROGRESS: ['CONFIRMED','CHECKED_IN','IN_PROGRESS'],
                         CHECKED_IN: ['CONFIRMED','CHECKED_IN'],
                         CONFIRMED: ['CONFIRMED'], SCHEDULED: [] }[status];
          for (const st of path) {
            await q(`UPDATE appointment SET status = $2,
                       cancellation_reason = CASE WHEN $2='CANCELLED' THEN 'Annulé par le patient' END
                     WHERE id = $1`, [a.id, st]);
          }
          if (!['CANCELLED','NO_SHOW'].includes(status)) {
            await q(`INSERT INTO appointment_resource (appointment_id, room_id, period)
                     VALUES ($1,$2, tstzrange($3,$4,'[)'))`,
              [a.id, pr.office_room_id, start, end]).catch(() => {});
          }
          await q('RELEASE SAVEPOINT sp');
          created++;
        } catch {
          await q('ROLLBACK TO SAVEPOINT sp');
          conflicts++;
        }
      }
    }
  }

  /* ----------------------------- Facturation ---------------------------- */
  const completed = (await q(
    `SELECT a.id, a.patient_id, a.practitioner_id, at.default_tariff_id, t.amount, t.label
       FROM appointment a
       JOIN appointment_type at ON at.id = a.appointment_type_id
       JOIN tariff t ON t.id = at.default_tariff_id
      WHERE a.status = 'COMPLETED' LIMIT 120`)).rows;

  let invoiced = 0, paid = 0;
  for (const [i, a] of completed.entries()) {
    const inv = await first(
      `INSERT INTO invoice (patient_id, practitioner_id) VALUES ($1,$2) RETURNING id`,
      [a.patient_id, a.practitioner_id]);
    await q(`INSERT INTO invoice_line (invoice_id, appointment_id, tariff_id, label,
               quantity, unit_price, line_total) VALUES ($1,$2,$3,$4,1,$5,$5)`,
      [inv.id, a.id, a.default_tariff_id, a.label, a.amount]);
    await q(`UPDATE invoice SET status='ISSUED', issued_at=now(),
               due_date=(now() + interval '30 days')::date,
               number = 'F-2026-' || lpad(nextval('invoice_number_seq')::text,5,'0')
             WHERE id=$1`, [inv.id]);
    invoiced++;
    if (i % 10 !== 0) {   // 90 % encaissées
      const partial = i % 13 === 0;
      await q(`INSERT INTO payment (invoice_id, method, amount, received_by)
               VALUES ($1,$2,$3,(SELECT id FROM user_account WHERE username='s.martin'))`,
        [inv.id, ['CASH','CARD','CHECK'][i % 3], partial ? a.amount / 2 : a.amount]);
      paid++;
    }
  }

  /* ---------------------- Absences et paramètres ------------------------ */
  const nextFriday = new Date(today);
  nextFriday.setDate(nextFriday.getDate() + ((5 - ((today.getDay() + 6) % 7 + 1) + 7) % 7 || 7));
  await q(`INSERT INTO absence (practitioner_id, period, reason, comment)
           VALUES ($1, tstzrange($2,$3,'[)'), 'TRAINING', 'Formation continue')`,
    [practitioners[0].id, new Date(nextFriday.setHours(8, 0, 0, 0)),
     new Date(new Date(nextFriday).setHours(18, 0, 0, 0))]).catch(() => {});

  for (const [key, value, category, desc] of [
    ['clinic.name', `"${process.env.CLINIC_NAME || 'Clinique Saint-Michel'}"`, 'Général', 'Nom de l\'établissement'],
    ['clinic.timezone', '"Europe/Paris"', 'Général', 'Fuseau horaire'],
    ['scheduling.min_notice_hours', '0', 'Agenda', 'Délai minimal de prise de rendez-vous'],
    ['scheduling.max_horizon_days', '365', 'Agenda', 'Horizon maximal de réservation'],
    ['scheduling.no_show_threshold', '3', 'Agenda', 'Nombre d\'absences déclenchant une alerte'],
    ['notifications.reminder_offsets_hours', '[48,2]', 'Notifications', 'Décalages des rappels'],
    ['billing.invoice_prefix', '"F"', 'Facturation', 'Préfixe des numéros de facture'],
    ['billing.payment_terms_days', '30', 'Facturation', 'Délai de paiement'],
    ['security.session_timeout_minutes', '15', 'Sécurité', 'Verrouillage après inactivité'],
    ['security.password_min_length', '12', 'Sécurité', 'Longueur minimale des mots de passe'],
    ['retention.patient_years', '20', 'Conformité', 'Durée de conservation des dossiers'],
    ['deployment.mode', '"on-premise"', 'Système', 'Aucune synchronisation externe'],
  ]) {
    await q(`INSERT INTO app_setting (key,value,category,description) VALUES ($1,$2::jsonb,$3,$4)
             ON CONFLICT (key) DO NOTHING`, [key, value, category, desc]);
  }

  for (const [code, channel, subject, body] of [
    ['APPT_CONFIRMATION', 'EMAIL', 'Confirmation de votre rendez-vous',
     'Bonjour {{patient.firstName}}, votre rendez-vous du {{appointment.date}} est confirmé.'],
    ['APPT_REMINDER_48H', 'SMS', null,
     'Rappel : RDV le {{appointment.date}} avec {{practitioner.name}}.'],
    ['APPT_REMINDER_2H', 'SMS', null,
     'Votre RDV est dans 2 heures ({{appointment.time}}).'],
    ['APPT_CANCELLED', 'EMAIL', 'Annulation de votre rendez-vous',
     'Votre rendez-vous du {{appointment.date}} a été annulé.'],
  ]) {
    await q(`INSERT INTO notification_template (code,channel,subject,body) VALUES ($1,$2,$3,$4)
             ON CONFLICT (code) DO NOTHING`, [code, channel, subject, body]);
  }

  await q('COMMIT');

  console.log(`
✓ Données de démonstration créées

  Praticiens ......... ${practitioners.length}
  Patients ........... ${patients.length}
  Rendez-vous ........ ${created} (${conflicts} conflits évités par la base)
  Factures ........... ${invoiced} dont ${paid} encaissées
  Utilisateurs ....... ${users.length}

  Comptes de démonstration — mot de passe : Clinique2026!
  ┌──────────────┬─────────────────────────────────┐
  │ admin        │ Administrateur (tous droits)    │
  │ s.martin     │ Réceptionniste                  │
  │ a.bernard    │ Praticien (Dr Bernard, cardio)  │
  │ c.compta     │ Facturation                     │
  └──────────────┴─────────────────────────────────┘
`);
} catch (err) {
  await q('ROLLBACK').catch(() => {});
  console.error('✗ Échec du peuplement :', err.message);
  console.error(err.stack);
  process.exitCode = 1;
} finally {
  c.release();
  await pool.end();
}
