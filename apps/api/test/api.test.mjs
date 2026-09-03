/**
 * Tests d'intégration de l'API.
 * Ils s'exécutent contre la base locale peuplée (npm run setup).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/main.mjs';
import { readFileSync } from 'node:fs';
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

  /* --- Export CSV -------------------------------------------------------
   * L'export doit couvrir TOUTES les fiches, pas seulement la page affichee
   * (l'ecran en montre 100, l'API en plafonne 200) : un export tronque en
   * silence produirait des decomptes faux sans que personne le remarque.
   */
  test('l\'export CSV renvoie un fichier telechargeable bien forme', async () => {
    const r = await api('/api/patients/export.csv');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/csv/);
    assert.match(r.headers.get('content-disposition'),
      /attachment; filename="clients-\d{4}-\d{2}-\d{2}\.csv"/);
    /* text() retire le BOM d'apres la spec fetch : on inspecte les octets. */
    const raw = Buffer.from(await r.clone().arrayBuffer());
    assert.deepEqual([...raw.subarray(0, 3)], [0xEF, 0xBB, 0xBF],
      'BOM UTF-8 requis pour les accents sous Excel');
    const body = await r.text();
    assert.ok(body.includes('\r\n'), 'fins de ligne CRLF');
    const lines = body.replace(/^\uFEFF/, '').trim().split('\r\n');
    assert.match(lines[0], /^Dossier;Nom;/, 'separateur point-virgule (locale FR)');
    const { total } = await (await api('/api/patients?limit=1')).json();
    assert.equal(lines.length - 1, total, 'export complet, jamais tronque a la page');
  });

  test('l\'export CSV neutralise les formules et echappe les separateurs', async () => {
    const r = await api('/api/patients', { method: 'POST', body: {
      lastName: 'EXPORT;"TEST"', firstName: '=1+1', birthDate: '1979-03-04', sex: 'M' } });
    const p = await r.json();
    const body = await (await api('/api/patients/export.csv?q=EXPORT')).text();
    const line = body.split('\r\n').find((l) => l.includes(p.mrn));
    assert.ok(line.includes('"EXPORT;""TEST"""'), 'guillemets doubles, champ entre guillemets');
    assert.ok(line.includes("'=1+1"), 'formule desamorcee par une apostrophe');
    /* Suppression physique : la route DELETE ne fait qu'archiver, la fiche
     * resterait exportable et polluerait les executions suivantes. */
    await query('DELETE FROM patient WHERE id = $1', [p.id]);
  });

  /* Le seed ne contient qu'une vingtaine de fiches : un LIMIT 100 glisse dans
   * la requete d'export resterait invisible. On depasse donc volontairement le
   * plafond de 200 de l'API de liste pour prouver que l'export n'en a aucun. */
  test('l\'export CSV depasse le plafond de pagination de l\'API', async () => {
    await query(`INSERT INTO patient (mrn, last_name, first_name, birth_date, sex, status)
                 SELECT 'P-TEST-' || lpad(g::text, 6, '0'), 'VOLUME', 'N' || g,
                        date '1990-01-01', 'F', 'ACTIVE'
                 FROM generate_series(1, 250) g`);
    try {
      const { total } = await (await api('/api/patients?limit=1')).json();
      assert.ok(total > 200, 'jeu de donnees suffisant pour depasser le plafond');
      const body = await (await api('/api/patients/export.csv')).text();
      const lines = body.replace(/^\uFEFF/, '').trim().split('\r\n');
      assert.equal(lines.length - 1, total, 'aucun LIMIT ne doit brider l\'export');
    } finally {
      await query(`DELETE FROM patient WHERE mrn LIKE 'P-TEST-%'`);
    }
  });

  test('l\'export CSV applique le filtre de statut', async () => {
    const r = await api('/api/patients/export.csv?status=ARCHIVED');
    const lines = (await r.text()).replace(/^\uFEFF/, '').trim().split('\r\n');
    const { total } = await (await api('/api/patients?status=ARCHIVED&limit=1')).json();
    assert.equal(lines.length - 1, total);
  });

  test('l\'export CSV est refuse sans jeton', async () => {
    assert.equal((await api('/api/patients/export.csv', { as: null })).status, 401);
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

  /* Ouvre une session de caisse si aucune ne l'est. Les encaissements en
     espèces l'exigent désormais, faute de quoi ils échapperaient au
     contrôle de caisse. */
  const ensureOpenCashSession = async () => {
    const open = await one(`SELECT id FROM cash_session WHERE status = 'OPEN' LIMIT 1`);
    if (!open) await api('/api/cash-sessions/open', { method: 'POST',
      body: { openingFloat: 0 } });
  };

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

  /* --- Modification des lignes (PATCH) ---------------------------------
   * Une facture brouillon dediee : ces tests modifient des lignes, ils ne
   * doivent pas perturber la sequence emission -> encaissement -> avoir qui
   * s'appuie sur `invoiceId`.
   */
  describe('Modification des lignes de facture', () => {
    let draftId, lineId;

    before(async () => {
      const a = await one(
        `SELECT a.id FROM appointment a
          WHERE a.status = 'COMPLETED'
            AND NOT EXISTS (SELECT 1 FROM invoice_line l WHERE l.appointment_id = a.id)
          LIMIT 1`);
      const inv = await (await api('/api/invoices', { method: 'POST',
        body: { appointmentId: a.id } })).json();
      draftId = inv.id;
      const line = await (await api(`/api/invoices/${draftId}/lines`, { method: 'POST',
        body: { label: 'Soin visage', quantity: 1, unitPrice: 2000 } })).json();
      lineId = line.id;
    });

    after(async () => {
      await query("UPDATE invoice SET status = 'DRAFT' WHERE id = $1", [draftId]);
      await query('DELETE FROM invoice_line WHERE invoice_id = $1', [draftId]);
      await query('DELETE FROM invoice WHERE id = $1', [draftId]);
    });

    test('la modification recalcule la ligne et le total de la facture', async () => {
      /* Le montant de la consultation pre-remplie depend du type de rendez-vous
       * tire : on compare a la somme des lignes, pas a un montant en dur. */
      const r = await api(`/api/invoices/${draftId}/lines/${lineId}`, {
        method: 'PATCH', body: { quantity: 3 } });
      assert.equal(r.status, 200);
      assert.equal(Number((await r.json()).line_total), 6000);
      const inv = await one('SELECT total_amount FROM invoice WHERE id = $1', [draftId]);
      const sum = await one(
        'SELECT coalesce(sum(line_total),0) AS s FROM invoice_line WHERE invoice_id = $1',
        [draftId]);
      assert.equal(Number(inv.total_amount), Number(sum.s),
        'le total de la facture suit la somme des lignes');
      assert.ok(Number(inv.total_amount) >= 6000, 'la ligne modifiee y est incluse');
    });

    test('la remise est appliquee au total de ligne', async () => {
      const r = await api(`/api/invoices/${draftId}/lines/${lineId}`, {
        method: 'PATCH', body: { quantity: 2, unitPrice: 1000, discountRate: 10 } });
      assert.equal(Number((await r.json()).line_total), 1800);
    });

    /* Le piege : `validate` ramene tout champ absent a null. Sans lecture des
     * cles reellement transmises, envoyer la seule quantite effacerait le
     * libelle. */
    test('une modification partielle preserve les champs non transmis', async () => {
      const before = await one('SELECT label FROM invoice_line WHERE id = $1', [lineId]);
      const r = await api(`/api/invoices/${draftId}/lines/${lineId}`, {
        method: 'PATCH', body: { quantity: 4 } });
      const after = await r.json();
      assert.equal(after.label, before.label, 'le libelle ne doit pas etre efface');
      assert.equal(Number(after.quantity), 4);
    });

    test('la ventilation reste coherente apres modification', async () => {
      await api(`/api/invoices/${draftId}/lines/${lineId}`, {
        method: 'PATCH', body: { quantity: 2, unitPrice: 1500, discountRate: 0 } });
      const inv = await one(
        `SELECT total_amount, insurance_part, patient_part FROM invoice WHERE id = $1`,
        [draftId]);
      assert.equal(Number(inv.insurance_part) + Number(inv.patient_part),
        Number(inv.total_amount), 'insurance_part + patient_part = total');
    });

    test('un corps vide est refuse', async () => {
      const r = await api(`/api/invoices/${draftId}/lines/${lineId}`, {
        method: 'PATCH', body: {} });
      assert.equal(r.status, 400);
    });

    test('une quantite nulle est refusee', async () => {
      const r = await api(`/api/invoices/${draftId}/lines/${lineId}`, {
        method: 'PATCH', body: { quantity: 0 } });
      assert.equal(r.status, 400);
    });

    test('une ligne inconnue renvoie 404', async () => {
      const r = await api(
        `/api/invoices/${draftId}/lines/00000000-0000-0000-0000-000000000000`,
        { method: 'PATCH', body: { quantity: 2 } });
      assert.equal(r.status, 404);
    });

    /* Regression M4 : le trigger de garde levait une exception remontant en
     * HTTP 500, message technique illisible au guichet. */
    test('modifier la ligne d\'une facture emise renvoie 422, pas 500', async () => {
      const a = await one(
        `SELECT a.id FROM appointment a
          WHERE a.status = 'COMPLETED'
            AND NOT EXISTS (SELECT 1 FROM invoice_line l WHERE l.appointment_id = a.id)
          LIMIT 1`);
      const inv = await (await api('/api/invoices', { method: 'POST',
        body: { appointmentId: a.id } })).json();
      const line = await one('SELECT id FROM invoice_line WHERE invoice_id = $1', [inv.id]);
      await api(`/api/invoices/${inv.id}/issue`, { method: 'POST' });

      const r = await api(`/api/invoices/${inv.id}/lines/${line.id}`, {
        method: 'PATCH', body: { quantity: 9 } });
      assert.equal(r.status, 422, 'ni 500, ni succes');
      assert.equal((await r.json()).error.code, 'INVOICE_NOT_DRAFT');

      const untouched = await one('SELECT quantity FROM invoice_line WHERE id = $1', [line.id]);
      assert.equal(Number(untouched.quantity), 1, 'la ligne doit rester intacte');

      await query("UPDATE invoice SET status = 'DRAFT' WHERE id = $1", [inv.id]);
      await query('DELETE FROM invoice_line WHERE invoice_id = $1', [inv.id]);
      await query('DELETE FROM invoice WHERE id = $1', [inv.id]);
    });

    /* La reception detient invoice.write : c'est elle qui encaisse au guichet.
     * Le praticien, lui, n'a aucun droit de facturation. */
    test('un praticien ne peut pas modifier une ligne de facture', async () => {
      const r = await api(`/api/invoices/${draftId}/lines/${lineId}`, {
        as: 'a.benali', method: 'PATCH', body: { quantity: 2 } });
      assert.equal(r.status, 403);
    });
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
    // Encaisser des espèces suppose une caisse ouverte (règle métier
    // introduite avec le contrôle NO_OPEN_CASH_SESSION).
    await ensureOpenCashSession();
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
    await ensureOpenCashSession();
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

  /* ---- Correctifs d'audit ------------------------------------------- */

  test('la ventilation assurance/patient suit chaque modification de ligne', async () => {
    /*
     * Défaut constaté : la part assurance n'était calculée qu'à la création.
     * Une facture à 4300 DA gardait « assurance 2000 + patient 500 », donc
     * 2500 — le patient assuré se voyait réclamer le montant plein.
     */
    const pat = await one(
      `SELECT p.id, pi.coverage_rate FROM patient p
         JOIN patient_insurance pi ON pi.patient_id = p.id AND pi.is_primary
        WHERE p.deleted_at IS NULL LIMIT 1`);
    const rate = Number(pat.coverage_rate);

    const inv = await (await api('/api/invoices', { method: 'POST',
      body: { patientId: pat.id } })).json();

    // Facture « libre » : le calcul se faisait sur un total encore nul.
    await api(`/api/invoices/${inv.id}/lines`, { method: 'POST',
      body: { label: 'Consultation', unitPrice: 1500, quantity: 1 } });
    let cur = (await (await api(`/api/invoices/${inv.id}`)).json()).invoice;
    assert.equal(Number(cur.insurance_part), 1500 * rate / 100,
      'part assurance erronée après la première ligne');

    // Deuxième ligne : c'est ici que la ventilation restait figée.
    await api(`/api/invoices/${inv.id}/lines`, { method: 'POST',
      body: { label: 'ECG', unitPrice: 1800, quantity: 1 } });
    cur = (await (await api(`/api/invoices/${inv.id}`)).json()).invoice;
    const tot = Number(cur.total_amount);
    assert.equal(tot, 3300);
    assert.equal(
      Math.round((Number(cur.insurance_part) + Number(cur.patient_part)) * 100) / 100,
      tot, 'assurance + patient doit toujours égaler le total');
  });

  test('le droit de timbre ne frappe que les espèces', async () => {
    // Art. 100 : 1 DA par tranche de 100 DA entamée, min 5, max 2500.
    // Art. 258 bis : les versements bancaires en sont exonérés.
    const cases = [[20, 'CASH', 0], [21, 'CASH', 5], [660, 'CASH', 7],
                   [1500, 'CASH', 15], [300000, 'CASH', 2500], [1500, 'CARD', 0]];
    for (const [amount, method, expected] of cases) {
      const r = await one('SELECT fn_stamp_duty($1,$2)::numeric AS d', [amount, method]);
      assert.equal(Number(r.d), expected, `timbre erroné pour ${amount} DA en ${method}`);
    }
  });

  test('un encaissement en espèces exige une caisse ouverte', async () => {
    /*
     * Sans ce contrôle, le paiement était accepté avec cash_session_id à
     * NULL : ces espèces n'apparaissaient dans aucun contrôle de caisse.
     */
    await query(`UPDATE cash_session SET status = 'CLOSED', closed_at = now()
                  WHERE status = 'OPEN'`);
    const pat = await one(`SELECT id FROM patient WHERE deleted_at IS NULL LIMIT 1`);
    const inv = await (await api('/api/invoices', { method: 'POST',
      body: { patientId: pat.id } })).json();
    await api(`/api/invoices/${inv.id}/lines`, { method: 'POST',
      body: { label: 'Consultation', unitPrice: 1500 } });
    await api(`/api/invoices/${inv.id}/issue`, { method: 'POST' });

    const r = await api(`/api/invoices/${inv.id}/payments`, { method: 'POST',
      body: { method: 'CASH', amount: 100 } });
    assert.equal(r.status, 422);
    assert.equal((await r.json()).error.code, 'NO_OPEN_CASH_SESSION');

    // La carte laisse une trace bancaire : elle reste acceptée.
    const ok = await api(`/api/invoices/${inv.id}/payments`, { method: 'POST',
      body: { method: 'CARD', amount: 100 } });
    assert.equal(ok.status, 201);
    assert.equal(Number((await ok.json()).payment.stamp_duty), 0);
  });

  test('factures et avoirs ont chacun leur suite de numéros', async () => {
    /*
     * La séquence était partagée : un avoir consommait un numéro de
     * facture et perçait un trou dans la suite — motif de rejet fiscal.
     */
    const pat = await one(`SELECT id FROM patient WHERE deleted_at IS NULL LIMIT 1`);
    const mk = async () => {
      const inv = await (await api('/api/invoices', { method: 'POST',
        body: { patientId: pat.id } })).json();
      await api(`/api/invoices/${inv.id}/lines`, { method: 'POST',
        body: { label: 'Consultation', unitPrice: 1500 } });
      return (await (await api(`/api/invoices/${inv.id}/issue`, { method: 'POST' })).json());
    };
    const first = await mk();
    const credit = await (await api(`/api/invoices/${first.id}/credit`, { method: 'POST',
      body: { reason: 'Test de numérotation' } })).json();
    const second = await mk();

    assert.match(first.number, /^F-\d{4}-\d{5}$/);
    assert.match(credit.number, /^AV-\d{4}-\d{5}$/);
    const n = (x) => Number(x.number.split('-')[2]);
    assert.equal(n(second), n(first) + 1,
      `suite de factures interrompue : ${first.number} puis ${second.number}`);
  });

  test('les factures sont datées de leur émission, pas de leur brouillon', async () => {
    /*
     * Le filtre portait sur created_at : une facture émise le 3 mais
     * ouverte en brouillon le 2 était imputée à la journée du 2, faussant
     * la recette du jour.
     */
    const pat = await one(`SELECT id FROM patient WHERE deleted_at IS NULL LIMIT 1`);
    const inv = await (await api('/api/invoices', { method: 'POST',
      body: { patientId: pat.id } })).json();
    await api(`/api/invoices/${inv.id}/lines`, { method: 'POST',
      body: { label: 'Consultation', unitPrice: 1500 } });
    const issued = await (await api(`/api/invoices/${inv.id}/issue`,
      { method: 'POST' })).json();

    // Le brouillon a été ouvert la veille de l'émission.
    await query(`UPDATE invoice SET created_at = created_at - interval '1 day'
                  WHERE id = $1`, [inv.id]);
    const day = String(issued.issued_at).slice(0, 10);
    const prev = new Date(new Date(day).getTime() - 86400000).toISOString().slice(0, 10);

    const onIssue = await (await api(`/api/invoices?from=${day}&to=${day}`)).json();
    assert.ok(onIssue.items.some((i) => i.id === inv.id),
      'la facture doit compter dans la journée de son émission');

    const onDraft = await (await api(`/api/invoices?from=${prev}&to=${prev}`)).json();
    assert.ok(!onDraft.items.some((i) => i.id === inv.id),
      'elle ne doit pas compter dans la journée du brouillon');
  });

  test('supprimer une ligne de facture émise renvoie une erreur explicite', async () => {
    // Le trigger de garde levait une exception convertie en HTTP 500 :
    // message technique illisible pour la caissière.
    const line = await one(
      `SELECT l.id, l.invoice_id FROM invoice_line l
         JOIN invoice i ON i.id = l.invoice_id
        WHERE i.status <> 'DRAFT' LIMIT 1`);
    const r = await api(`/api/invoices/${line.invoice_id}/lines/${line.id}`,
      { method: 'DELETE' });
    assert.equal(r.status, 422);
    assert.equal((await r.json()).error.code, 'INVOICE_NOT_DRAFT');
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

/* ======================================================================
   Gouvernance : rôles, superutilisateur, apparence
   ====================================================================== */
describe('Catalogue — montant saisi librement', () => {

  test('le montant crée ou réutilise un tarif, sans toucher aux autres types', async () => {
    /*
     * Le formulaire propose désormais un montant libre plutôt qu'une liste
     * de tarifs. Le piège : « C » est partagé par CS-GEN et URGENCE.
     * Écraser son montant parce qu'on modifie l'un changerait le prix de
     * l'autre — invisible jusqu'à la facturation.
     */
    const shared = await one(`SELECT id FROM tariff WHERE code = 'C'`);
    const gen = await one(`SELECT id FROM appointment_type WHERE code = 'CS-GEN'`);
    const urg = await one(
      `SELECT at.id, t.amount FROM appointment_type at
         JOIN tariff t ON t.id = at.default_tariff_id
        WHERE at.code = 'URGENCE'`);
    assert.equal(urg.amount, 1500, 'préalable : URGENCE facturé 1500 via le tarif C');

    const r = await api(`/api/appointment-types/${gen.id}`, { method: 'PATCH',
      body: { defaultAmount: 1700 } });
    assert.equal(r.status, 200);

    const after = await one(
      `SELECT t.id, t.amount FROM appointment_type at
         JOIN tariff t ON t.id = at.default_tariff_id WHERE at.id = $1`, [gen.id]);
    assert.equal(Number(after.amount), 1700, 'le nouveau montant doit être appliqué');
    assert.notEqual(after.id, shared.id,
      'un tarif partagé ne doit jamais être détourné : il fallait en créer un autre');

    const urgAfter = await one(
      `SELECT t.amount FROM appointment_type at
         JOIN tariff t ON t.id = at.default_tariff_id WHERE at.id = $1`, [urg.id]);
    assert.equal(Number(urgAfter.amount), 1500,
      'URGENCE a changé de prix alors que seul CS-GEN était modifié');

    // Remise en état pour ne pas polluer les autres tests.
    await query(`UPDATE appointment_type SET default_tariff_id = $2 WHERE id = $1`,
      [gen.id, shared.id]);
  });

  test('un même montant ne multiplie pas les tarifs', async () => {
    /* Le montant est lu dans le catalogue ACTIF plutot que code en dur :
     * resolveTariff ne reutilise que les tarifs actifs, et le catalogue a
     * change (migration 006, passage a l'esthetique). */
    // Un run interrompu peut laisser TESTDUP : la creation echouerait en 409.
    await query(`DELETE FROM appointment_type WHERE code = 'TESTDUP'`);
    await query(`DELETE FROM tariff WHERE code = 'TESTDUP'`);
    const ref = await one(
      `SELECT amount FROM tariff WHERE is_active
          AND (valid_to IS NULL OR valid_to >= CURRENT_DATE)
        ORDER BY code LIMIT 1`);
    const amount = Number(ref.amount);
    const before = await one(`SELECT count(*)::int AS n FROM tariff`);
    const t = await (await api('/api/appointment-types', { method: 'POST',
      body: { code: 'TESTDUP', label: 'Test doublon',
              defaultDurationMinutes: 20, defaultAmount: amount } })).json();
    const after = await one(`SELECT count(*)::int AS n FROM tariff`);
    assert.equal(after.n, before.n,
      `un tarif a ${amount} existe deja : il devait etre reutilise, pas duplique`);

    const linked = await one(
      `SELECT t.amount FROM appointment_type at
         JOIN tariff t ON t.id = at.default_tariff_id WHERE at.id = $1`, [t.id]);
    assert.equal(Number(linked.amount), amount);
    await query(`DELETE FROM appointment_type WHERE id = $1`, [t.id]);
  });

  test('sans montant, le type reste sans tarif', async () => {
    const t = await (await api('/api/appointment-types', { method: 'POST',
      body: { code: 'TESTNUL', label: 'Test sans tarif',
              defaultDurationMinutes: 15 } })).json();
    assert.equal(t.default_tariff_id, null,
      'aucun montant saisi : aucun tarif ne doit être inventé');
    await query(`DELETE FROM appointment_type WHERE id = $1`, [t.id]);
  });
});

/* ====================================================================== */
describe('Gouvernance', () => {
  const cleanup = async () => {
    await query(`DELETE FROM role_permission WHERE role_id IN
                   (SELECT id FROM role WHERE code LIKE 'TESTROLE%')`);
    await query(`DELETE FROM user_role WHERE role_id IN
                   (SELECT id FROM role WHERE code LIKE 'TESTROLE%')`);
    await query(`DELETE FROM role WHERE code LIKE 'TESTROLE%'`);
    await query(`DELETE FROM user_role WHERE user_id IN
                   (SELECT id FROM user_account WHERE username LIKE 'testuser.%')`);
    await query(`DELETE FROM user_account WHERE username LIKE 'testuser.%'`);
  };
  before(cleanup);
  after(cleanup);

  test('le catalogue expose les permissions et le décompte des comptes', async () => {
    const d = await (await api('/api/admin/roles/catalog')).json();
    assert.ok(d.permissions.length >= 20);
    const admin = d.roles.find((r) => r.code === 'ADMIN');
    assert.equal(admin.is_system, true);
    assert.ok(admin.permissions.includes('admin.users'));
    assert.ok(typeof admin.user_count === 'number');
  });

  test('un rôle métier se crée, se modifie et se supprime', async () => {
    const created = await (await api('/api/admin/roles', { method: 'POST', body: {
      code: 'TESTROLE_A', label: 'Rôle de test',
      permissions: ['patient.read', 'appointment.read'] } })).json();
    assert.equal(created.code, 'TESTROLE_A');
    assert.equal(created.is_system, false);

    const patched = await (await api(`/api/admin/roles/${created.id}`, { method: 'PATCH',
      body: { label: 'Rôle ajusté', permissions: ['patient.read'] } })).json();
    assert.equal(patched.label, 'Rôle ajusté');
    assert.deepEqual(patched.permissions, ['patient.read']);

    assert.equal((await api(`/api/admin/roles/${created.id}`, { method: 'DELETE' })).status, 200);
  });

  test('le code d\'un rôle est normalisé et unique', async () => {
    assert.equal((await api('/api/admin/roles', { method: 'POST',
      body: { code: 'minuscules', label: 'X' } })).status, 400);
    await api('/api/admin/roles', { method: 'POST',
      body: { code: 'TESTROLE_B', label: 'B' } });
    const dup = await api('/api/admin/roles', { method: 'POST',
      body: { code: 'TESTROLE_B', label: 'Autre' } });
    assert.equal(dup.status, 422);
    assert.equal((await dup.json()).error.code, 'ROLE_EXISTS');
  });

  test('un rôle système garde son intitulé mais accepte un ajustement de permissions', async () => {
    const cat = await (await api('/api/admin/roles/catalog')).json();
    const readonly = cat.roles.find((r) => r.code === 'READONLY');

    const renamed = await api(`/api/admin/roles/${readonly.id}`, { method: 'PATCH',
      body: { label: 'Renommé' } });
    assert.equal(renamed.status, 422);
    assert.equal((await renamed.json()).error.code, 'SYSTEM_ROLE');

    const perms = [...readonly.permissions];
    const ok = await api(`/api/admin/roles/${readonly.id}`, { method: 'PATCH',
      body: { permissions: perms } });
    assert.equal(ok.status, 200, 'les permissions d\'un rôle système restent modifiables');
  });

  test('la dernière permission d\'administration ne peut pas être retirée', async () => {
    const cat = await (await api('/api/admin/roles/catalog')).json();
    const admin = cat.roles.find((r) => r.code === 'ADMIN');
    const r = await api(`/api/admin/roles/${admin.id}`, { method: 'PATCH',
      body: { permissions: ['patient.read'] } });
    assert.equal(r.status, 422);
    assert.equal((await r.json()).error.code, 'LAST_ADMIN_PERMISSION');
  });

  test('un rôle attribué à un compte ne peut pas être supprimé', async () => {
    const role = await (await api('/api/admin/roles', { method: 'POST',
      body: { code: 'TESTROLE_C', label: 'C', permissions: ['patient.read'] } })).json();
    await api('/api/admin/users', { method: 'POST', body: {
      username: 'testuser.porteur', fullName: 'Porteur du rôle',
      password: 'Clinique2026!', roles: ['TESTROLE_C'] } });

    const r = await api(`/api/admin/roles/${role.id}`, { method: 'DELETE' });
    assert.equal(r.status, 422);
    assert.equal((await r.json()).error.code, 'ROLE_IN_USE');
  });

  test('un compte se supprime sans détruire sa trace, et libère son identifiant', async () => {
    const u = await (await api('/api/admin/users', { method: 'POST', body: {
      username: 'testuser.jetable', fullName: 'Compte jetable',
      password: 'Clinique2026!', roles: ['READONLY'] } })).json();

    assert.equal((await api(`/api/admin/users/${u.id}`, { method: 'DELETE' })).status, 200);
    const list = await (await api('/api/admin/users')).json();
    assert.ok(!list.items.some((x) => x.username === 'testuser.jetable'));

    // L'identifiant redevient disponible : l'unicité ne porte que sur les vivants.
    const again = await api('/api/admin/users', { method: 'POST', body: {
      username: 'testuser.jetable', fullName: 'Reprise',
      password: 'Clinique2026!', roles: ['READONLY'] } });
    assert.equal(again.status, 201);
  });

  test('un administrateur ne peut pas supprimer son propre compte', async () => {
    const list = await (await api('/api/admin/users')).json();
    const me = list.items.find((x) => x.username === 'admin');
    const r = await api(`/api/admin/users/${me.id}`, { method: 'DELETE' });
    assert.equal(r.status, 422);
    assert.equal((await r.json()).error.code, 'SELF_LOCKOUT');
  });

  test('le dernier superutilisateur ne peut être ni rétrogradé ni désactivé', async () => {
    const list = await (await api('/api/admin/users')).json();
    const su = list.items.find((x) => x.username === 'admin');
    assert.equal(su.is_superuser, true);

    const demote = await api(`/api/admin/users/${su.id}/superuser`, { method: 'PATCH',
      body: { isSuperuser: false } });
    assert.equal(demote.status, 422);
    // Se rétrograder soi-même est refusé avant même le contrôle du dernier superuser.
    assert.ok(['SELF_DEMOTION', 'LAST_SUPERUSER'].includes((await demote.json()).error.code));

    const disable = await api(`/api/admin/users/${su.id}`, { method: 'PATCH',
      body: { status: 'DISABLED' } });
    assert.equal(disable.status, 422);
  });

  test('le superutilisateur détient les permissions absentes de ses rôles', async () => {
    const me = await (await api('/api/auth/me')).json();
    const all = await query('SELECT count(*)::int AS n FROM permission');
    assert.equal(me.user.permissions.length, all.rows[0].n,
      'le superutilisateur reçoit le catalogue complet');
    assert.equal(me.user.isSuperuser, true);
  });

  test('le thème est lisible sans authentification et modifiable par un administrateur', async () => {
    const pub = await api('/api/theme', { as: null });
    assert.equal(pub.status, 200);
    assert.match((await pub.json()).primary_color, /^#[0-9a-f]{6}$/i);

    const saved = await (await api('/api/theme', { method: 'PUT',
      body: { primaryColor: '#4338ca', radius: 'round', fontScale: 1.1 } })).json();
    assert.equal(saved.primary_color, '#4338ca');
    assert.equal(saved.radius, 'round');

    // Une couleur non hexadécimale est rejetée : la valeur est réinjectée
    // telle quelle dans une variable CSS, elle ne doit rien pouvoir porter d'autre.
    assert.equal((await api('/api/theme', { method: 'PUT',
      body: { primaryColor: 'red; background:url(x)' } })).status, 400);

    const reset = await (await api('/api/theme/reset', { method: 'POST' })).json();
    assert.equal(reset.primary_color, '#0f766e');
  });

  test('les comptes proposés à la connexion existent réellement en base', async () => {
    // Régression : la liste était codée en dur dans l'interface et proposait
    // des identifiants absents d'une base peuplée par une version antérieure.
    const b = await (await api('/api/branding', { as: null })).json();
    assert.ok(Array.isArray(b.demo_accounts) && b.demo_accounts.length > 0);

    const { rows } = await query(
      `SELECT username FROM user_account WHERE status = 'ACTIVE' AND deleted_at IS NULL`);
    const real = new Set(rows.map((r) => r.username));
    for (const a of b.demo_accounts) {
      assert.ok(real.has(a.username), `${a.username} est proposé mais absent de la base`);
    }

    // Aucune donnée sensible ne doit transiter par cette route publique.
    for (const a of b.demo_accounts) {
      assert.ok(!('password_hash' in a) && !('locked_until' in a));
    }
  });

  test('chaque compte de démonstration peut réellement se connecter', async () => {
    const b = await (await api('/api/branding', { as: null })).json();
    for (const a of b.demo_accounts) {
      const r = await api('/api/auth/login', { as: null, method: 'POST',
        body: { username: a.username, password: 'Clinique2026!' } });
      assert.equal(r.status, 201, `connexion impossible pour ${a.username}`);
    }
  });

  test('la restauration vérifie l\'archive et ne cite que des commandes valides', async () => {
    const run = await (await api('/api/admin/backups', { method: 'POST',
      body: { kind: 'MANUAL' } })).json();

    assert.equal((await api(`/api/admin/backups/${run.id}/restore`, {
      method: 'POST', body: {} })).status, 400, 'la confirmation est obligatoire');

    const d = await (await api(`/api/admin/backups/${run.id}/restore`, { method: 'POST',
      body: { confirm: 'RESTAURER', reason: 'Test' } })).json();
    assert.equal(d.verified, true);

    // La procédure citait « npm run stop », un script inexistant.
    const scripts = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url)));
    for (const line of d.procedure) {
      const m = line.match(/npm run ([a-z:]+)/);
      if (m) assert.ok(scripts.scripts[m[1]], `« npm run ${m[1]} » n'existe pas`);
    }
  });

  test('le catalogue expose durée, battements et tarif de chaque acte', async () => {
    const d = await (await api('/api/catalogue')).json();
    assert.ok(d.types.length > 0 && d.tariffs.length > 0);
    const t = d.types.find((x) => x.code === 'CS-CARDIO');
    assert.equal(t.default_duration_minutes, 30);
    assert.ok(Number(t.tariff_amount) > 0, 'le montant doit accompagner l\'acte');
    assert.ok(typeof t.appointment_count === 'number');
  });

  test('durée et tarif se modifient depuis l\'interface', async () => {
    const cat = await (await api('/api/catalogue')).json();
    const type = cat.types.find((x) => x.code === 'CS-DERMA');
    const before = type.default_duration_minutes;

    const up = await (await api(`/api/appointment-types/${type.id}`, { method: 'PATCH',
      body: { defaultDurationMinutes: 45, bufferAfterMinutes: 15 } })).json();
    assert.equal(up.default_duration_minutes, 45);
    assert.equal(up.buffer_after_minutes, 15);

    await api(`/api/appointment-types/${type.id}`, { method: 'PATCH',
      body: { defaultDurationMinutes: before, bufferAfterMinutes: 5 } });
  });

  test('changer un prix ne réécrit pas les factures déjà établies', async () => {
    // Le point le plus sensible : invoice_line copie le prix unitaire au lieu
    // de pointer le tarif. Une hausse ne doit jamais toucher le passé.
    const cat = await (await api('/api/catalogue')).json();
    const tariff = cat.tariffs.find((t) => t.code === 'C');

    const { rows: b } = await query(
      `SELECT l.id, l.unit_price FROM invoice_line l
        WHERE l.tariff_id = $1 ORDER BY l.id LIMIT 5`, [tariff.id]);
    assert.ok(b.length > 0, 'il faut des lignes existantes pour que le test ait un sens');

    const r = await api(`/api/tariffs/${tariff.id}`, { method: 'PATCH', body: { amount: 9999 } });
    assert.equal(r.status, 200, 'la mise à jour du tarif doit aboutir');

    const { rows: a } = await query(
      `SELECT l.id, l.unit_price FROM invoice_line l
        WHERE l.id = ANY($1::uuid[]) ORDER BY l.id`, [b.map((r) => r.id)]);
    for (let i = 0; i < b.length; i++) {
      assert.equal(Number(a[i].unit_price), Number(b[i].unit_price),
        'le prix figurant sur une facture émise ne doit pas bouger');
    }

    await api(`/api/tariffs/${tariff.id}`, { method: 'PATCH',
      body: { amount: Number(tariff.amount) } });

    /*
     * Ceinture et bretelles : même une écriture directe en SQL est refusée
     * par le déclencheur `trg_invoice_line_guard` dès que la facture a
     * quitté l'état DRAFT. La protection ne dépend donc pas du code API.
     */
    const issued = await one(
      `SELECT l.id FROM invoice_line l JOIN invoice i ON i.id = l.invoice_id
        WHERE i.status <> 'DRAFT' LIMIT 1`);
    if (issued) {
      await assert.rejects(
        () => query('UPDATE invoice_line SET unit_price = 1 WHERE id = $1', [issued.id]),
        /non modifiable/,
        'la base doit refuser de modifier la ligne d\'une facture émise');
    }
  });

  test('un tarif ou un acte encore utilisé ne peut pas être retiré', async () => {
    const cat = await (await api('/api/catalogue')).json();

    const tariff = cat.tariffs.find((t) => t.used_by_types > 0);
    const r1 = await api(`/api/tariffs/${tariff.id}`, { method: 'DELETE' });
    assert.equal(r1.status, 422);
    assert.equal((await r1.json()).error.code, 'TARIFF_IN_USE');

    const type = cat.types.find((t) => t.appointment_count > 0);
    const r2 = await api(`/api/appointment-types/${type.id}`, { method: 'DELETE' });
    assert.equal(r2.status, 422);
    assert.equal((await r2.json()).error.code, 'TYPE_IN_USE');
  });

  test('le catalogue est en lecture seule pour un réceptionniste', async () => {
    const cat = await (await api('/api/catalogue')).json();
    assert.equal((await api('/api/catalogue', { as: 's.amrani' })).status, 200,
      'la lecture reste nécessaire pour prendre un rendez-vous');
    assert.equal((await api(`/api/tariffs/${cat.tariffs[0].id}`, { as: 's.amrani',
      method: 'PATCH', body: { amount: 1 } })).status, 403);
  });

  test('le jeu de données initial accorde la vue globale aux bons rôles', async () => {
    /*
     * Régression constatée sur une installation neuve : les migrations
     * s'exécutent AVANT le seed, donc le « INSERT ... SELECT FROM role » de
     * la migration 004 ne trouvait aucun rôle à qui accorder la permission,
     * et le seed recréait ensuite les rôles sans elle. L'accueil perdait
     * l'agenda global, sans que rien ne le signale.
     */
    const { rows } = await query(`SELECT r.code FROM role r
       JOIN role_permission rp ON rp.role_id = r.id
      WHERE rp.permission_code = 'appointment.read.all' ORDER BY 1`);
    const roles = rows.map((r) => r.code);
    assert.deepEqual(roles, ['ADMIN', 'BILLING', 'RECEPTION'],
      `vue globale mal distribuée : ${roles.join(', ') || 'aucun rôle'}`);
    assert.ok(!roles.includes('PRACTITIONER'),
      'le praticien ne doit jamais recevoir la vue globale');
  });

  test('un praticien ne voit que son propre agenda', async () => {
    /*
     * Le filtre par praticien n'existait que dans l'interface : appeler
     * l'API sans « practitionerIds » renvoyait le planning de toute la
     * clinique, secret médical compris.
     */
    const mine = await (await api('/api/appointments?from=2026-09-01&to=2026-09-07',
      { as: 'a.benali' })).json();
    assert.ok(mine.items.length > 0, 'le praticien doit voir ses propres rendez-vous');

    const names = new Set(mine.items.map((a) => a.practitioner_last_name));
    assert.equal(names.size, 1, `un seul praticien attendu, reçu : ${[...names]}`);
    assert.ok(names.has('BENALI'));

    // L'accueil, lui, a besoin de la vue complète pour placer les rendez-vous.
    const all = await (await api('/api/appointments?from=2026-09-01&to=2026-09-07',
      { as: 's.amrani' })).json();
    assert.ok(new Set(all.items.map((a) => a.practitioner_last_name)).size > 1);
  });

  test('demander explicitement l\'agenda d\'un confrère ne le divulgue pas', async () => {
    const other = await one(
      `SELECT id FROM practitioner WHERE last_name <> 'BENALI' AND is_active LIMIT 1`);
    const d = await (await api(
      `/api/appointments?from=2026-09-01&to=2026-09-07&practitionerIds=${other.id}`,
      { as: 'a.benali' })).json();
    assert.equal(d.items.length, 0,
      'le paramètre client ne doit pas élargir le périmètre autorisé');
  });

  test('la file du jour et l\'occupation suivent la même règle', async () => {
    const q = await (await api('/api/appointments/today/queue?date=2026-09-02',
      { as: 'a.benali' })).json();
    const all = [...q.expected, ...q.waiting, ...q.inProgress, ...q.done, ...q.absent];
    for (const a of all) assert.equal(a.practitioner_last_name, 'BENALI');

    const other = await one(
      `SELECT id FROM practitioner WHERE last_name <> 'BENALI' AND is_active LIMIT 1`);
    assert.equal((await api(`/api/practitioners/${other.id}/occupancy`,
      { as: 'a.benali' })).status, 403);
    assert.equal((await api(`/api/practitioners/${other.id}/occupancy`,
      { as: 's.amrani' })).status, 200);
  });

  test('un compte praticien sans fiche rattachée ne voit rien, plutôt que tout', async () => {
    /*
     * Cas limite le plus dangereux : si le cloisonnement se contentait de
     * « pas de fiche → pas de filtre », une configuration incomplète
     * ouvrirait l'agenda entier. On veut l'échec fermé.
     */
    await api('/api/admin/users', { method: 'POST', body: {
      username: 'testuser.sansfiche', fullName: 'Praticien sans fiche',
      password: 'Clinique2026!', roles: ['PRACTITIONER'] } });

    const r = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'testuser.sansfiche', password: 'Clinique2026!' }) });
    const token = (await r.json()).accessToken;

    const d = await (await fetch(`${base}/api/appointments?from=2026-09-01&to=2026-09-07`,
      { headers: { Authorization: `Bearer ${token}` } })).json();
    assert.equal(d.items.length, 0, 'aucun rendez-vous, et surtout pas ceux des autres');

    const q = await (await fetch(`${base}/api/appointments/today/queue?date=2026-09-02`,
      { headers: { Authorization: `Bearer ${token}` } })).json();
    assert.deepEqual(q.expected, []);
    assert.ok(Array.isArray(q.waiting), 'la forme de la réponse reste celle attendue');
  });

  test('la personnalisation est refusée à un compte non administrateur', async () => {
    assert.equal((await api('/api/theme', { as: 's.amrani', method: 'PUT',
      body: { primaryColor: '#000000' } })).status, 403);
    assert.equal((await api('/api/admin/roles/catalog', { as: 's.amrani' })).status, 403);
  });
});
