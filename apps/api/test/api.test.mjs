/**
 * Tests d'intégration de l'API.
 * Ils s'exécutent contre la base locale peuplée (npm run setup).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/main.mjs';
import { closePool, one, query } from '../src/core/db.mjs';

let server, base;
const tokens = {};

before(async () => {
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  // Isolation : supprime les données de test d'une exécution précédente
  const scope = `(SELECT id FROM appointment WHERE reason = 'Test automatisé'
                    OR patient_id IN (SELECT id FROM patient WHERE last_name = 'TESTPATIENT'))`;
  await query(`DELETE FROM notification            WHERE appointment_id IN ${scope}`);
  await query(`DELETE FROM encounter               WHERE appointment_id IN ${scope}`);
  await query(`DELETE FROM appointment_resource    WHERE appointment_id IN ${scope}`);
  await query(`DELETE FROM appointment_status_history WHERE appointment_id IN ${scope}`);
  // Les factures issues d'exécutions précédentes sont supprimées avant leurs lignes
  const invScope = `(SELECT DISTINCT invoice_id FROM invoice_line WHERE appointment_id IN ${scope})`;
  await query(`DELETE FROM payment      WHERE invoice_id IN ${invScope}`);
  // Les avoirs portent un montant négatif que la contrainte
  // « invoice_amount_sign_check » n'autorise qu'accompagné d'un
  // credited_invoice_id. On les supprime donc au lieu de les détacher.
  await query(`DELETE FROM payment WHERE invoice_id IN
                 (SELECT id FROM invoice WHERE credited_invoice_id IN ${invScope})`);
  // Un trigger interdit de modifier une facture émise : on repasse d'abord
  // l'avoir en brouillon, puis on le supprime.
  await query(`UPDATE invoice SET status = 'DRAFT'
                WHERE credited_invoice_id IN ${invScope}`);
  await query(`DELETE FROM invoice_line WHERE invoice_id IN
                 (SELECT id FROM invoice WHERE credited_invoice_id IN ${invScope})`);
  await query(`DELETE FROM invoice WHERE credited_invoice_id IN ${invScope}`);
  await query(`UPDATE invoice SET status = 'DRAFT' WHERE id IN ${invScope}`);
  await query(`DELETE FROM invoice_line WHERE appointment_id IN ${scope}`);
  await query(`DELETE FROM invoice WHERE NOT EXISTS
                 (SELECT 1 FROM invoice_line l WHERE l.invoice_id = invoice.id)
                 AND created_at > now() - interval '1 day'
                 AND NOT EXISTS (SELECT 1 FROM payment p WHERE p.invoice_id = invoice.id)`);
  await query(`UPDATE appointment SET rescheduled_from_id = NULL
                WHERE rescheduled_from_id IN ${scope}`);
  await query(`DELETE FROM appointment WHERE reason = 'Test automatisé'
                 OR patient_id IN (SELECT id FROM patient WHERE last_name = 'TESTPATIENT')`);
  await query(`DELETE FROM consent          WHERE patient_id IN
                 (SELECT id FROM patient WHERE last_name = 'TESTPATIENT')`);
  await query(`DELETE FROM patient_insurance WHERE patient_id IN
                 (SELECT id FROM patient WHERE last_name = 'TESTPATIENT')`);
  await query(`DELETE FROM patient WHERE last_name = 'TESTPATIENT'`);
  await query(`DELETE FROM absence WHERE reason IN ('TRAINING','SICK')
                 AND lower(period) > now() + interval '50 days'`);
  await query(`UPDATE user_account SET failed_attempts = 0, locked_until = NULL,
                 status = 'ACTIVE' WHERE status = 'LOCKED'`);

  for (const u of ['admin', 's.amrani', 'a.benali', 'c.compta']) {
    const r = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u, password: 'Clinique2026!' }),
    });
    const d = await r.json();
    tokens[u] = d.accessToken;
  }
});

after(async () => { server.close(); await closePool(); });

const api = (path, { as = 'admin', method = 'GET', body } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(as ? { Authorization: `Bearer ${tokens[as]}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

/* ====================================================================== */
describe('Santé et authentification', () => {

  test('le service répond et la base est joignable', async () => {
    const r = await fetch(`${base}/api/health`);
    const d = await r.json();
    assert.equal(r.status, 200);
    assert.equal(d.status, 'ok');
    assert.equal(d.database.ok, true);
  });

  test('connexion avec des identifiants valides', async () => {
    const r = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'Clinique2026!' }),
    });
    const d = await r.json();
    assert.equal(r.status, 201);
    assert.ok(d.accessToken);
    assert.ok(d.user.permissions.includes('admin.users'));
  });

  test('connexion refusée avec un mauvais mot de passe', async () => {
    const r = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'mauvais' }),
    });
    assert.equal(r.status, 401);
    assert.equal((await r.json()).error.code, 'UNAUTHENTICATED');
    await query(`UPDATE user_account SET failed_attempts = 0, locked_until = NULL,
                 status = 'ACTIVE' WHERE username = 'admin'`);
  });

  test('accès refusé sans jeton', async () => {
    const r = await api('/api/patients', { as: null });
    assert.equal(r.status, 401);
  });

  test('jeton falsifié rejeté', async () => {
    const r = await fetch(`${base}/api/patients`, {
      headers: { Authorization: 'Bearer aaa.bbb.ccc' } });
    assert.equal(r.status, 401);
  });
});

/* ====================================================================== */
describe('Contrôle d\'accès par rôle', () => {

  test('la réceptionniste ne peut pas gérer les utilisateurs', async () => {
    const r = await api('/api/admin/users', { as: 's.amrani' });
    assert.equal(r.status, 403);
    assert.equal((await r.json()).error.code, 'FORBIDDEN');
  });

  test('la comptable ne peut pas modifier un patient', async () => {
    const r = await api('/api/patients', { as: 'c.compta', method: 'POST',
      body: { lastName: 'TEST', firstName: 'Interdit', birthDate: '1990-01-01' } });
    assert.equal(r.status, 403);
  });

  test('la réceptionniste accède bien à l\'agenda', async () => {
    const r = await api('/api/appointments', { as: 's.amrani' });
    assert.equal(r.status, 200);
  });

  test('le praticien peut rédiger un compte rendu, pas la réceptionniste', async () => {
    const a = await one(`SELECT id FROM appointment WHERE status = 'COMPLETED' LIMIT 1`);
    const r1 = await api(`/api/appointments/${a.id}/encounter`, { as: 's.amrani',
      method: 'PUT', body: { observations: 'test' } });
    assert.equal(r1.status, 403);
    const r2 = await api(`/api/appointments/${a.id}/encounter`, { as: 'a.benali',
      method: 'PUT', body: { observations: 'Examen sans particularité.' } });
    assert.equal(r2.status, 200);
  });
});

/* ====================================================================== */
describe('Patients', () => {
  let created;

  test('création d\'un patient avec attribution d\'un identifiant unique', async () => {
    const r = await api('/api/patients', { method: 'POST', body: {
      lastName: 'TESTPATIENT', firstName: 'Alpha', birthDate: '1980-05-15',
      sex: 'F', phoneMobile: '06 11 22 33 44', city: 'LYON' } });
    created = await r.json();
    assert.equal(r.status, 201);
    assert.match(created.mrn, /^P-\d{4}-\d{6}$/);
  });

  test('le doublon exact est refusé avec un message exploitable', async () => {
    const r = await api('/api/patients', { method: 'POST', body: {
      lastName: 'TESTPATIENT', firstName: 'Alpha', birthDate: '1980-05-15' } });
    const d = await r.json();
    assert.equal(r.status, 409);
    assert.equal(d.error.code, 'DUPLICATE_PATIENT');
    assert.ok(d.error.details.existingId, 'le doublon existant doit être identifié');
  });

  test('validation : date de naissance obligatoire', async () => {
    const r = await api('/api/patients', { method: 'POST',
      body: { lastName: 'X', firstName: 'Y' } });
    const d = await r.json();
    assert.equal(r.status, 400);
    assert.ok(d.error.details.birthDate);
  });

  test('recherche floue par nom, insensible aux accents', async () => {
    const r = await api('/api/patients?q=testpat');
    const d = await r.json();
    assert.ok(d.items.some((p) => p.mrn === created.mrn));
  });

  test('recherche par date de naissance', async () => {
    const r = await api('/api/patients?q=15/05/1980');
    assert.ok((await r.json()).items.length >= 1);
  });

  test('la fiche remonte les allergies critiques', async () => {
    const p = await one(`SELECT patient_id FROM medical_history_entry
                         WHERE severity = 'CRITICAL' LIMIT 1`);
    const d = await (await api(`/api/patients/${p.patient_id}`)).json();
    assert.ok(d.patient.critical_allergy_count >= 1);
    assert.ok(d.history.some((h) => h.severity === 'CRITICAL'));
  });

  test('la consultation d\'un dossier est journalisée', async () => {
    await api(`/api/patients/${created.id}`);
    const log = await one(
      `SELECT * FROM audit_log WHERE entity = 'patient' AND entity_id = $1
         AND action = 'READ' ORDER BY occurred_at DESC LIMIT 1`, [created.id]);
    assert.ok(log, 'une entrée d\'audit de lecture doit exister');
    assert.equal(log.username, 'admin');
  });
});

/* ====================================================================== */
describe('Rendez-vous — règles de planification', () => {
  let patient, practitioner, type, slot;

  before(async () => {
    patient = await one(`SELECT * FROM patient WHERE status='ACTIVE' ORDER BY created_at DESC LIMIT 1`);
    practitioner = await one(`SELECT * FROM practitioner WHERE code = 'DR-002'`);
    type = await one(`SELECT * FROM appointment_type WHERE code = 'CS-GEN'`);
    const from = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 25 * 864e5).toISOString().slice(0, 10);
    const d = await (await api(
      `/api/appointments/slots?practitionerId=${practitioner.id}` +
      `&appointmentTypeId=${type.id}&from=${from}&to=${to}`)).json();
    slot = d.slots[0];
    assert.ok(slot, 'des créneaux libres doivent être proposés');
  });

  test('le moteur ne propose que des créneaux dans les plages déclarées', async () => {
    const from = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 10 * 864e5).toISOString().slice(0, 10);
    const d = await (await api(
      `/api/appointments/slots?practitionerId=${practitioner.id}` +
      `&appointmentTypeId=${type.id}&from=${from}&to=${to}`)).json();
    for (const s of d.slots.slice(0, 40)) {
      const start = new Date(s.start);
      const dow = ((start.getDay() + 6) % 7) + 1;   // 1 = lundi … 7 = dimanche
      // Week-end algérien : vendredi (5) et samedi (6) sont chômés,
      // le dimanche (7) est au contraire le premier jour ouvré.
      assert.ok(dow !== 5 && dow !== 6,
        `créneau proposé un jour de week-end (jour ISO ${dow})`);
      const h = start.getHours();
      assert.ok((h >= 8 && h < 12) || (h >= 13 && h < 17),
        `créneau hors plage : ${start.toISOString()}`);
    }
  });

  test('création d\'un rendez-vous sur un créneau libre', async () => {
    const r = await api('/api/appointments', { method: 'POST', body: {
      patientId: patient.id, practitionerId: practitioner.id,
      appointmentTypeId: type.id, startAt: slot.start, reason: 'Test automatisé' } });
    const d = await r.json();
    assert.equal(r.status, 201, JSON.stringify(d));
    assert.match(d.reference, /^RDV-\d{4}-\d{6}$/);
    assert.equal(d.status, 'SCHEDULED');
  });

  test('le même créneau est ensuite refusé (anti-double-booking)', async () => {
    const other = await one(
      `SELECT * FROM patient WHERE id <> $1 AND status='ACTIVE' LIMIT 1`, [patient.id]);
    const r = await api('/api/appointments', { method: 'POST', body: {
      patientId: other.id, practitionerId: practitioner.id,
      appointmentTypeId: type.id, startAt: slot.start } });
    const d = await r.json();
    assert.ok([409, 422].includes(r.status), `attendu 409/422, reçu ${r.status}`);
    assert.ok(['SLOT_CONFLICT_PRACTITIONER', 'SLOT_NOT_AVAILABLE'].includes(d.error.code));
  });

  test('un créneau hors disponibilité est refusé', async () => {
    const sunday = new Date(Date.now() + 7 * 864e5);
    sunday.setDate(sunday.getDate() + (7 - sunday.getDay()) % 7);
    sunday.setHours(3, 0, 0, 0);
    const r = await api('/api/appointments', { method: 'POST', body: {
      patientId: patient.id, practitionerId: practitioner.id,
      appointmentTypeId: type.id, startAt: sunday.toISOString() } });
    assert.equal(r.status, 422);
    assert.equal((await r.json()).error.code, 'SLOT_NOT_AVAILABLE');
  });

  test('les notifications de rappel sont planifiées automatiquement', async () => {
    const a = await one(
      `SELECT id FROM appointment WHERE reason = 'Test automatisé' ORDER BY created_at DESC LIMIT 1`);
    const n = await one('SELECT count(*)::int AS n FROM notification WHERE appointment_id = $1', [a.id]);
    assert.ok(n.n > 0, 'au moins une notification doit être planifiée');
  });

  test('les transitions de statut interdites sont bloquées', async () => {
    const a = await one(
      `SELECT id FROM appointment WHERE reason = 'Test automatisé' ORDER BY created_at DESC LIMIT 1`);
    // SCHEDULED -> COMPLETED est interdit (il faut passer par les états intermédiaires)
    const r = await api(`/api/appointments/${a.id}/status`, { method: 'PATCH',
      body: { status: 'COMPLETED' } });
    assert.equal(r.status, 422);
  });

  test('parcours patient complet : confirmé → arrivé → en cours → terminé', async () => {
    const a = await one(
      `SELECT id FROM appointment WHERE reason = 'Test automatisé' ORDER BY created_at DESC LIMIT 1`);
    for (const status of ['CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS', 'COMPLETED']) {
      const r = await api(`/api/appointments/${a.id}/status`, { method: 'PATCH', body: { status } });
      assert.equal(r.status, 200, `échec de la transition vers ${status}`);
      assert.equal((await r.json()).status, status);
    }
    const hist = await one(
      'SELECT count(*)::int AS n FROM appointment_status_history WHERE appointment_id = $1', [a.id]);
    assert.ok(hist.n >= 5, 'chaque changement de statut doit être historisé');
  });

  test('le motif est obligatoire pour annuler', async () => {
    const from = new Date(Date.now() + 6 * 864e5).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 20 * 864e5).toISOString().slice(0, 10);
    const slots = (await (await api(
      `/api/appointments/slots?practitionerId=${practitioner.id}` +
      `&appointmentTypeId=${type.id}&from=${from}&to=${to}`)).json()).slots;
    const a = await (await api('/api/appointments', { method: 'POST', body: {
      patientId: patient.id, practitionerId: practitioner.id,
      appointmentTypeId: type.id, startAt: slots[0].start } })).json();

    const r1 = await api(`/api/appointments/${a.id}/status`, { method: 'PATCH',
      body: { status: 'CANCELLED' } });
    assert.equal(r1.status, 400);

    const r2 = await api(`/api/appointments/${a.id}/status`, { method: 'PATCH',
      body: { status: 'CANCELLED', reason: 'Patient indisponible' } });
    assert.equal(r2.status, 200);
    // le créneau libéré redevient réservable
    const again = await api('/api/appointments', { method: 'POST', body: {
      patientId: patient.id, practitionerId: practitioner.id,
      appointmentTypeId: type.id, startAt: slots[0].start } });
    assert.equal(again.status, 201, 'le créneau annulé doit être réattribuable');
  });

  test('le déplacement conserve la traçabilité', async () => {
    const from = new Date(Date.now() + 9 * 864e5).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 26 * 864e5).toISOString().slice(0, 10);
    const slots = (await (await api(
      `/api/appointments/slots?practitionerId=${practitioner.id}` +
      `&appointmentTypeId=${type.id}&from=${from}&to=${to}`)).json()).slots;
    const a = await (await api('/api/appointments', { method: 'POST', body: {
      patientId: patient.id, practitionerId: practitioner.id,
      appointmentTypeId: type.id, startAt: slots[0].start } })).json();

    const r = await api(`/api/appointments/${a.id}/reschedule`, { method: 'PATCH',
      body: { startAt: slots[5].start } });
    const moved = await r.json();
    assert.equal(r.status, 200, JSON.stringify(moved));
    assert.equal(moved.rescheduled_from_id, a.id);
    const old = await one('SELECT status FROM appointment WHERE id = $1', [a.id]);
    assert.equal(old.status, 'RESCHEDULED');
  });

  test('le verrou optimiste empêche les modifications concurrentes', async () => {
    const from = new Date(Date.now() + 12 * 864e5).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 27 * 864e5).toISOString().slice(0, 10);
    const slots = (await (await api(
      `/api/appointments/slots?practitionerId=${practitioner.id}` +
      `&appointmentTypeId=${type.id}&from=${from}&to=${to}`)).json()).slots;
    const a = await (await api('/api/appointments', { method: 'POST', body: {
      patientId: patient.id, practitionerId: practitioner.id,
      appointmentTypeId: type.id, startAt: slots[0].start } })).json();

    const r = await api(`/api/appointments/${a.id}/status`, { method: 'PATCH',
      body: { status: 'CONFIRMED', version: 99 } });
    assert.equal(r.status, 409);
    assert.equal((await r.json()).error.code, 'STALE_VERSION');
  });
});

/* ====================================================================== */
describe('Concurrence — garantie anti-double-booking', () => {

  test('200 réservations simultanées sur le même créneau : une seule réussit', async () => {
    const practitioner = await one(`SELECT * FROM practitioner WHERE code = 'DR-005'`);
    const type = await one(`SELECT * FROM appointment_type WHERE code = 'CS-PEDIA'`);
    const from = new Date(Date.now() + 15 * 864e5).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
    const slots = (await (await api(
      `/api/appointments/slots?practitionerId=${practitioner.id}` +
      `&appointmentTypeId=${type.id}&from=${from}&to=${to}`)).json()).slots;
    const target = slots[0];
    assert.ok(target);

    const patients = (await (await api('/api/patients?limit=20')).json()).items;

    // 200 requêtes lancées en parallèle sur le même créneau
    const results = await Promise.all(
      Array.from({ length: 200 }, (_, i) =>
        api('/api/appointments', { method: 'POST', body: {
          patientId: patients[i % patients.length].id,
          practitionerId: practitioner.id,
          appointmentTypeId: type.id,
          startAt: target.start,
        } }).then((r) => r.status)));

    const ok = results.filter((s) => s === 201).length;
    const rejected = results.filter((s) => s === 409 || s === 422).length;

    assert.equal(ok, 1, `exactement une réservation doit aboutir (obtenu : ${ok})`);
    assert.equal(rejected, 199, `les 199 autres doivent être refusées proprement (obtenu : ${rejected})`);

    // Vérification en base : aucun chevauchement n'a pu être écrit
    const overlaps = await one(
      `SELECT count(*)::int AS n FROM appointment a1 JOIN appointment a2
          ON a1.practitioner_id = a2.practitioner_id AND a1.id < a2.id
         AND a1.blocked_period && a2.blocked_period
        WHERE a1.status IN ('SCHEDULED','CONFIRMED','CHECKED_IN','IN_PROGRESS')
          AND a2.status IN ('SCHEDULED','CONFIRMED','CHECKED_IN','IN_PROGRESS')`);
    assert.equal(overlaps.n, 0, 'aucun chevauchement ne doit exister en base');
  });
});

/* ====================================================================== */
describe('Ressources', () => {

  test('une salle ne peut pas être réservée deux fois sur le même créneau', async () => {
    const room = await one(`SELECT id FROM room WHERE code = 'IMG1'`);
    const a = await one(`SELECT id FROM appointment
                         WHERE status IN ('SCHEDULED','CONFIRMED') LIMIT 1`);
    const start = new Date(Date.now() + 40 * 864e5);
    const end = new Date(start.getTime() + 30 * 60_000);
    await query(`INSERT INTO appointment_resource (appointment_id, room_id, period)
                 VALUES ($1,$2, tstzrange($3,$4,'[)'))`, [a.id, room.id, start, end]);
    await assert.rejects(
      () => query(`INSERT INTO appointment_resource (appointment_id, room_id, period)
                   VALUES ($1,$2, tstzrange($3,$4,'[)'))`, [a.id, room.id, start, end]),
      (err) => err.code === '23P01');
    await query(`DELETE FROM appointment_resource WHERE room_id = $1 AND lower(period) = $2`,
      [room.id, start]);
  });

  test('le planning d\'une salle est consultable', async () => {
    const room = await one(`SELECT id FROM room WHERE code = 'S01'`);
    const r = await api(`/api/rooms/${room.id}/schedule`);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray((await r.json()).items));
  });
});

/* ====================================================================== */
describe('Praticiens et absences', () => {

  test('déclarer une absence signale les rendez-vous impactés', async () => {
    const p = await one(`SELECT id FROM practitioner WHERE code = 'DR-003'`);
    const start = new Date(Date.now() + 60 * 864e5); start.setHours(8, 0, 0, 0);
    const end = new Date(start); end.setHours(18, 0, 0, 0);
    const r = await api(`/api/practitioners/${p.id}/absences`, { method: 'POST',
      body: { startAt: start.toISOString(), endAt: end.toISOString(), reason: 'TRAINING' } });
    const d = await r.json();
    assert.equal(r.status, 201);
    assert.ok(Array.isArray(d.impactedAppointments));
  });

  test('deux absences ne peuvent pas se chevaucher', async () => {
    const p = await one(`SELECT id FROM practitioner WHERE code = 'DR-003'`);
    const start = new Date(Date.now() + 60 * 864e5); start.setHours(10, 0, 0, 0);
    const end = new Date(start); end.setHours(16, 0, 0, 0);
    const r = await api(`/api/practitioners/${p.id}/absences`, { method: 'POST',
      body: { startAt: start.toISOString(), endAt: end.toISOString(), reason: 'SICK' } });
    assert.equal(r.status, 409);
  });

  test('aucun créneau n\'est proposé pendant une absence', async () => {
    const p = await one(`SELECT id FROM practitioner WHERE code = 'DR-003'`);
    const type = await one(`SELECT id FROM appointment_type WHERE code = 'CS-DERMA'`);
    const day = new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10);
    const d = await (await api(
      `/api/appointments/slots?practitionerId=${p.id}&appointmentTypeId=${type.id}` +
      `&from=${day}&to=${day}`)).json();
    assert.equal(d.slots.length, 0, 'le praticien est absent ce jour-là');
  });
});

/* ====================================================================== */
describe('Facturation', () => {
  let invoiceId;

  test('facturation d\'un rendez-vous terminé', async () => {
    const a = await one(
      `SELECT a.id FROM appointment a
        WHERE a.status = 'COMPLETED'
          AND NOT EXISTS (SELECT 1 FROM invoice_line l WHERE l.appointment_id = a.id)
        LIMIT 1`);
    const r = await api('/api/invoices', { method: 'POST', body: { appointmentId: a.id } });
    const inv = await r.json();
    assert.equal(r.status, 201, JSON.stringify(inv));
    assert.equal(inv.status, 'DRAFT');
    assert.ok(inv.total_amount > 0, 'la ligne de tarif doit être pré-remplie');
    invoiceId = inv.id;
  });

  test('un rendez-vous non terminé ne peut pas être facturé', async () => {
    const a = await one(`SELECT id FROM appointment WHERE status = 'SCHEDULED' LIMIT 1`);
    const r = await api('/api/invoices', { method: 'POST', body: { appointmentId: a.id } });
    assert.equal(r.status, 422);
    assert.equal((await r.json()).error.code, 'APPOINTMENT_NOT_COMPLETED');
  });

  test('l\'émission attribue un numéro légal', async () => {
    const r = await api(`/api/invoices/${invoiceId}/issue`, { method: 'POST' });
    const inv = await r.json();
    assert.equal(r.status, 201);
    assert.match(inv.number, /^F-\d{4}-\d{5}$/);
    assert.equal(inv.status, 'ISSUED');
  });

  test('une facture émise est immuable', async () => {
    await assert.rejects(
      () => query(`UPDATE invoice SET total_amount = 1 WHERE id = $1`, [invoiceId]),
      (err) => err.code === 'P0001' || err.code === '23514');
  });

  test('encaissement partiel puis solde', async () => {
    const inv = await one('SELECT total_amount FROM invoice WHERE id = $1', [invoiceId]);
    const half = Math.round(inv.total_amount / 2 * 100) / 100;

    const r1 = await api(`/api/invoices/${invoiceId}/payments`, { method: 'POST',
      body: { method: 'CASH', amount: half } });
    assert.equal(r1.status, 201);
    assert.equal((await r1.json()).invoice.status, 'PARTIALLY_PAID');

    const r2 = await api(`/api/invoices/${invoiceId}/payments`, { method: 'POST',
      body: { method: 'CARD', amount: inv.total_amount - half } });
    const d2 = await r2.json();
    assert.equal(d2.invoice.status, 'PAID');
    assert.equal(d2.invoice.balance, 0);
  });

  test('un paiement supérieur au solde est refusé', async () => {
    const r = await api(`/api/invoices/${invoiceId}/payments`, { method: 'POST',
      body: { method: 'CASH', amount: 500 } });
    assert.equal(r.status, 422);
    assert.equal((await r.json()).error.code, 'AMOUNT_EXCEEDS_BALANCE');
  });

  test('correction par avoir', async () => {
    const r = await api(`/api/invoices/${invoiceId}/credit`, { method: 'POST',
      body: { reason: 'Erreur de tarification' } });
    const credit = await r.json();
    assert.equal(r.status, 201);
    assert.match(credit.number, /^AV-/);
    assert.ok(credit.total_amount <= 0, 'un avoir porte un montant négatif');
    const orig = await one('SELECT status FROM invoice WHERE id = $1', [invoiceId]);
    assert.equal(orig.status, 'CREDITED');
  });

  test('cycle de caisse avec calcul de l\'écart', async () => {
    await query(`UPDATE cash_session SET status='CLOSED', closed_at=now() WHERE status='OPEN'`);
    const open = await api('/api/cash-sessions/open', { method: 'POST',
      body: { openingFloat: 100, workstation: 'ACCUEIL-1' } });
    const session = await open.json();
    assert.equal(open.status, 201);

    const cur = await (await api('/api/cash-sessions/current')).json();
    assert.equal(cur.expectedCash, 100);

    const close = await api(`/api/cash-sessions/${session.id}/close`, { method: 'POST',
      body: { countedCash: 95, comment: 'Écart constaté' } });
    const closed = await close.json();
    assert.equal(closed.discrepancy, -5);
    assert.equal(closed.status, 'CLOSED');
  });
});

/* ====================================================================== */
describe('Rapports', () => {

  test('la synthèse expose les indicateurs clés', async () => {
    const d = await (await api('/api/reports/overview')).json();
    assert.ok(d.appointments.total > 0);
    assert.ok(typeof d.noShowRate === 'number');
    assert.ok(d.finance.revenue >= 0);
  });

  test('le taux d\'occupation est calculé par praticien', async () => {
    const d = await (await api('/api/reports/occupancy')).json();
    assert.ok(d.items.length >= 5);
    for (const p of d.items) {
      assert.ok(p.occupancy_rate >= 0 && p.occupancy_rate <= 200);
    }
  });

  test('export CSV avec BOM pour Excel', async () => {
    const from = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
    const r = await api(`/api/reports/export?from=${from}`);
    assert.equal(r.headers.get('content-type'), 'text/csv; charset=utf-8');
    // fetch().text() retire le BOM : on contrôle donc les octets bruts
    const bytes = new Uint8Array(await r.arrayBuffer());
    assert.deepEqual([bytes[0], bytes[1], bytes[2]], [0xEF, 0xBB, 0xBF],
      'le BOM UTF-8 doit être présent pour Excel');
    assert.ok(new TextDecoder().decode(bytes).includes('reference'));
  });

  test('l\'export est tracé dans le journal d\'audit', async () => {
    const log = await one(
      `SELECT * FROM audit_log WHERE action = 'EXPORT' ORDER BY occurred_at DESC LIMIT 1`);
    assert.ok(log);
  });

  test('le journal d\'audit est réservé aux administrateurs', async () => {
    assert.equal((await api('/api/audit', { as: 's.amrani' })).status, 403);
    assert.equal((await api('/api/audit', { as: 'admin' })).status, 200);
  });
});

/* ====================================================================== */
describe('Intégrité et exploitation', () => {

  test('les contrôles d\'intégrité passent', async () => {
    const d = await (await api('/api/admin/integrity')).json();
    for (const c of d.checks) {
      assert.equal(c.ok, true, `contrôle en échec : ${c.name} (${c.detail})`);
    }
    assert.equal(d.ok, true);
  });

  test('l\'état système confirme le mode on-premise', async () => {
    const d = await (await api('/api/admin/system')).json();
    assert.equal(d.deployment.mode, 'on-premise');
    assert.equal(d.deployment.cloudSync, false);
    assert.ok(d.counts.patients > 0);
  });

  test('une sauvegarde locale est produite et vérifiable', async () => {
    const r = await api('/api/admin/backups', { method: 'POST', body: { kind: 'MANUAL' } });
    const run = await r.json();
    assert.equal(run.status, 'SUCCESS', run.error || '');
    assert.ok(run.size_bytes > 1000);
    assert.match(run.checksum, /^[0-9a-f]{64}$/);

    const restore = await (await api(`/api/admin/backups/${run.id}/restore`, {
      method: 'POST', body: { confirm: 'RESTAURER', reason: 'Test' } })).json();
    assert.equal(restore.verified, true, 'la somme de contrôle doit être validée');
  });

  test('la restauration exige une confirmation explicite', async () => {
    const run = await one(`SELECT id FROM backup_run WHERE status='SUCCESS' LIMIT 1`);
    const r = await api(`/api/admin/backups/${run.id}/restore`, { method: 'POST', body: {} });
    assert.equal(r.status, 400);
  });
});
