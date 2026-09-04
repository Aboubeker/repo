/** Module Patients : fiches, recherche, historique médical, assurances, consentements. */
import { many, one, query, tx } from '../core/db.mjs';
import { notFound, conflict, unprocessable } from '../core/errors.mjs';
import { writeAudit, diffOf } from '../core/audit.mjs';
import { validate, EMAIL_RE, PHONE_RE } from '../core/validate.mjs';

const patientSchema = {
  lastName:      { type: 'string', required: true, max: 100 },
  firstName:     { type: 'string', required: true, max: 100 },
  birthName:     { type: 'string', max: 100 },
  birthDate:     { type: 'date', required: true },
  sex:           { type: 'enum', values: ['M', 'F', 'U'], default: 'U' },
  birthPlace:    { type: 'string', max: 120 },
  nationalId:    { type: 'string', max: 30 },
  phoneMobile:   { type: 'string', pattern: PHONE_RE, message: 'Numéro invalide.' },
  phoneHome:     { type: 'string', pattern: PHONE_RE, message: 'Numéro invalide.' },
  email:         { type: 'string', pattern: EMAIL_RE, message: 'Adresse e-mail invalide.' },
  addressLine1:  { type: 'string', max: 200 },
  addressLine2:  { type: 'string', max: 200 },
  postalCode:    { type: 'string', max: 15 },
  city:          { type: 'string', max: 100 },
  bloodType:     { type: 'string', max: 5 },
  gpName:        { type: 'string', max: 120 },
  notes:         { type: 'string', max: 4000 },
};

const COLS = `id, mrn, last_name, first_name, birth_name, sex, birth_date, birth_place,
  national_id, phone_mobile, phone_home, email, address_line1, address_line2,
  postal_code, city, country, blood_type, gp_name, notes, status, created_at, updated_at`;

export function registerPatientRoutes(router) {

  /* --------------------------- Recherche --------------------------- */
  router.get('/api/patients', async (ctx) => {
    const q = (ctx.query.q || '').trim();
    const limit = Math.min(Number(ctx.query.limit || 50), 200);
    const offset = Number(ctx.query.offset || 0);
    const status = ctx.query.status || 'ACTIVE';

    const params = [status, limit, offset];
    let where = `p.status = $1 AND p.deleted_at IS NULL`;
    if (q) {
      params.push(`%${q.toLowerCase()}%`);
      // recherche floue : nom, prénom, MRN, téléphone ; + date de naissance JJ/MM/AAAA
      where += ` AND (immutable_unaccent(lower(p.last_name || ' ' || p.first_name || ' ' ||
                     p.mrn || ' ' || coalesce(p.phone_mobile,''))) LIKE immutable_unaccent($4)
                 OR to_char(p.birth_date, 'DD/MM/YYYY') LIKE $4
                 OR to_char(p.birth_date, 'DDMMYYYY') LIKE $4)`;
    }
    const rows = await many(
      `SELECT p.id, p.mrn, p.last_name, p.first_name, p.birth_date, p.sex,
              p.phone_mobile, p.email, p.city, p.status,
              s.no_show_count, s.last_visit_at, s.next_visit_at, s.outstanding_balance,
              s.critical_allergy_count,
              count(*) OVER() AS total_count
         FROM patient p JOIN v_patient_summary s ON s.id = p.id
        WHERE ${where}
        ORDER BY p.last_name, p.first_name
        LIMIT $2 OFFSET $3`, params);
    return {
      items: rows.map(({ total_count, ...r }) => r),
      total: rows.length ? Number(rows[0].total_count) : 0,
    };
  }, { permission: 'patient.read' });

  /* ---------------------------- Export CSV -------------------------- */
  /**
   * Échappement CSV (RFC 4180).
   *
   * Deux pièges traités ici :
   *  - le séparateur retenu est le POINT-VIRGULE, car Excel en configuration
   *    française lit un fichier séparé par virgules comme une colonne unique ;
   *  - une valeur commençant par = + - @ est interprétée comme une FORMULE
   *    par Excel et LibreOffice. Un nom tel que « =cmd » deviendrait
   *    exécutable à l'ouverture : on la préfixe d'une apostrophe.
   */
  const csvCell = (value) => {
    if (value === null || value === undefined) return '';
    let out = String(value);
    if (/^[=+\-@\t\r]/.test(out)) out = `'${out}`;
    return /[";\n\r]/.test(out) ? `"${out.replace(/"/g, '""')}"` : out;
  };

  router.get('/api/patients/export.csv', async (ctx) => {
    const status = ctx.query.status || 'ACTIVE';
    const q = (ctx.query.q || '').trim();

    /*
     * L'export porte sur la sélection ENTIÈRE, pas sur la page affichée.
     * L'écran est plafonné à 100 lignes : exporter ce tableau aurait produit
     * un fichier silencieusement tronqué, que personne n'aurait remarqué
     * avant de s'en servir.
     */
    const params = [status];
    let where = `p.status = $1 AND p.deleted_at IS NULL`;
    if (q) {
      params.push(`%${q.toLowerCase()}%`);
      where += ` AND (immutable_unaccent(lower(p.last_name || ' ' || p.first_name || ' ' ||
                     p.mrn || ' ' || coalesce(p.phone_mobile,''))) LIKE immutable_unaccent($2)
                 OR to_char(p.birth_date, 'DD/MM/YYYY') LIKE $2
                 OR to_char(p.birth_date, 'DDMMYYYY') LIKE $2)`;
    }
    const rows = await many(
      `SELECT p.mrn, p.last_name, p.first_name, p.birth_date, p.sex,
              p.phone_mobile, p.email, p.city,
              s.last_visit_at, s.next_visit_at, s.outstanding_balance, s.no_show_count
         FROM patient p JOIN v_patient_summary s ON s.id = p.id
        WHERE ${where}
        ORDER BY p.last_name, p.first_name`, params);

    const d = (v) => (v ? new Date(v).toLocaleDateString('fr-FR') : '');
    const header = ['Dossier', 'Nom', 'Prénom', 'Naissance', 'Sexe', 'Téléphone',
                    'E-mail', 'Ville', 'Dernière visite', 'Prochain rendez-vous',
                    'Solde dû (DA)', 'Absences'];
    const lines = [header.join(';')];
    for (const r of rows) {
      lines.push([r.mrn, r.last_name, r.first_name, d(r.birth_date), r.sex,
                  r.phone_mobile, r.email, r.city, d(r.last_visit_at), d(r.next_visit_at),
                  Number(r.outstanding_balance || 0).toFixed(2).replace('.', ','),
                  r.no_show_count].map(csvCell).join(';'));
    }

    /*
     * Le BOM UTF-8 est indispensable : sans lui, Excel sous Windows lit le
     * fichier en ANSI et affiche « BENALI Zoubida » avec des accents cassés.
     * CRLF pour la même raison de compatibilité.
     */
    const csv = '\uFEFF' + lines.join('\r\n') + '\r\n';
    const stamp = new Date().toISOString().slice(0, 10);

    await writeAudit(ctx, { action: 'EXPORT', entity: 'patient',
      summary: `Export CSV de ${rows.length} fiche(s)` });

    ctx.res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="clients-${stamp}.csv"`,
      'Cache-Control': 'no-store',
    });
    ctx.res.end(csv);
    return undefined;
  }, { permission: 'patient.read' });

  /* --------------------------- Détail ------------------------------ */
  router.get('/api/patients/:id', async (ctx) => {
    const p = await one(`SELECT * FROM v_patient_summary WHERE id = $1`, [ctx.params.id]);
    if (!p) throw notFound('Patient introuvable.');
    const [contacts, insurances, history, consents, appointments, invoices] = await Promise.all([
      many('SELECT * FROM patient_contact WHERE patient_id = $1', [p.id]),
      many('SELECT * FROM patient_insurance WHERE patient_id = $1 ORDER BY is_primary DESC', [p.id]),
      many(`SELECT * FROM medical_history_entry WHERE patient_id = $1
            ORDER BY (severity = 'CRITICAL') DESC, recorded_at DESC`, [p.id]),
      many('SELECT * FROM consent WHERE patient_id = $1', [p.id]),
      many(`SELECT id, reference, start_at, end_at, status, type_label,
                   practitioner_last_name, practitioner_first_name, reason
              FROM v_appointment_full WHERE patient_id = $1
             ORDER BY start_at DESC LIMIT 50`, [p.id]),
      many(`SELECT id, number, issued_at, status, total_amount, paid_amount, balance
              FROM invoice WHERE patient_id = $1 ORDER BY created_at DESC LIMIT 50`, [p.id]),
    ]);
    // Toute consultation d'un dossier patient est journalisée (exigence RGPD)
    await writeAudit(ctx, { action: 'READ', entity: 'patient', entityId: p.id,
      summary: `Consultation du dossier ${p.mrn}` });
    return { patient: p, contacts, insurances, history, consents, appointments, invoices };
  }, { permission: 'patient.read' });

  /* --------------------------- Création ---------------------------- */
  router.post('/api/patients', async (ctx) => {
    const d = validate(ctx.body, patientSchema);
    const dup = await one(
      `SELECT id, mrn FROM patient
        WHERE lower(immutable_unaccent(last_name)) = lower(immutable_unaccent($1))
          AND lower(immutable_unaccent(first_name)) = lower(immutable_unaccent($2))
          AND birth_date = $3 AND status = 'ACTIVE' AND deleted_at IS NULL`,
      [d.lastName, d.firstName, d.birthDate]);
    if (dup) throw conflict(
      `Un patient identique existe déjà (${dup.mrn}).`, 'DUPLICATE_PATIENT', { existingId: dup.id, mrn: dup.mrn });

    const p = await one(
      `INSERT INTO patient (mrn, last_name, first_name, birth_name, birth_date, sex, birth_place,
         national_id, phone_mobile, phone_home, email, address_line1, address_line2,
         postal_code, city, blood_type, gp_name, notes, created_by, updated_by)
       VALUES ('P-' || to_char(now(),'YYYY') || '-' || lpad(nextval('patient_mrn_seq')::text, 6, '0'),
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18)
       RETURNING ${COLS}`,
      [d.lastName, d.firstName, d.birthName, d.birthDate, d.sex, d.birthPlace, d.nationalId,
       d.phoneMobile, d.phoneHome, d.email, d.addressLine1, d.addressLine2, d.postalCode,
       d.city, d.bloodType, d.gpName, d.notes, ctx.user.sub]);

    await writeAudit(ctx, { action: 'CREATE', entity: 'patient', entityId: p.id,
      summary: `Création du patient ${p.mrn} — ${p.last_name} ${p.first_name}` });
    return p;
  }, { permission: 'patient.write' });

  /* -------------------------- Modification -------------------------- */
  router.patch('/api/patients/:id', async (ctx) => {
    const before = await one(`SELECT ${COLS} FROM patient WHERE id = $1`, [ctx.params.id]);
    if (!before) throw notFound('Patient introuvable.');
    const d = validate({ ...toCamel(before), ...ctx.body }, patientSchema);
    const after = await one(
      `UPDATE patient SET last_name=$2, first_name=$3, birth_name=$4, birth_date=$5, sex=$6,
         birth_place=$7, national_id=$8, phone_mobile=$9, phone_home=$10, email=$11,
         address_line1=$12, address_line2=$13, postal_code=$14, city=$15, blood_type=$16,
         gp_name=$17, notes=$18, updated_at=now(), updated_by=$19
       WHERE id=$1 RETURNING ${COLS}`,
      [ctx.params.id, d.lastName, d.firstName, d.birthName, d.birthDate, d.sex, d.birthPlace,
       d.nationalId, d.phoneMobile, d.phoneHome, d.email, d.addressLine1, d.addressLine2,
       d.postalCode, d.city, d.bloodType, d.gpName, d.notes, ctx.user.sub]);
    await writeAudit(ctx, { action: 'UPDATE', entity: 'patient', entityId: after.id,
      summary: `Modification du patient ${after.mrn}`, diff: diffOf(before, after) });
    return after;
  }, { permission: 'patient.write' });

  /* --------------------------- Archivage ---------------------------- */
  router.delete('/api/patients/:id', async (ctx) => {
    const active = await one(
      `SELECT count(*)::int AS n FROM appointment
        WHERE patient_id = $1 AND status IN ('SCHEDULED','CONFIRMED','CHECKED_IN','IN_PROGRESS')`,
      [ctx.params.id]);
    if (active.n > 0)
      throw unprocessable(`Impossible d'archiver : ${active.n} rendez-vous à venir.`, 'PATIENT_HAS_APPOINTMENTS');
    const p = await one(
      `UPDATE patient SET status = 'ARCHIVED', updated_at = now(), updated_by = $2
        WHERE id = $1 RETURNING id, mrn`, [ctx.params.id, ctx.user.sub]);
    if (!p) throw notFound('Patient introuvable.');
    await writeAudit(ctx, { action: 'ARCHIVE', entity: 'patient', entityId: p.id,
      summary: `Archivage du patient ${p.mrn}` });
    return { ok: true };
  }, { permission: 'patient.write' });

  /* --------------------------- Réactivation -------------------------- */
  /*
   * L'archivage est une mesure de rangement, pas une sanction : un patient
   * revient parfois après des années. Sans ce point d'entrée, la seule issue
   * serait de recréer une fiche, ce qui casserait l'historique de soins et
   * produirait le doublon que la détection cherche justement à éviter.
   */
  router.post('/api/patients/:id/restore', async (ctx) => {
    const p = await one(
      `UPDATE patient SET status = 'ACTIVE', updated_at = now(), updated_by = $2
        WHERE id = $1 AND deleted_at IS NULL RETURNING id, mrn`, [ctx.params.id, ctx.user.sub]);
    if (!p) throw notFound('Patient introuvable.');
    await writeAudit(ctx, { action: 'RESTORE', entity: 'patient', entityId: p.id,
      summary: `Réactivation du patient ${p.mrn}` });
    return { ok: true };
  }, { permission: 'patient.write' });

  /* ---------------------- Historique médical ------------------------ */
  router.post('/api/patients/:id/history', async (ctx) => {
    const d = validate(ctx.body, {
      category: { type: 'enum', required: true,
        values: ['ALLERGY','CHRONIC_CONDITION','SURGERY','TREATMENT','VACCINATION','FAMILY','LIFESTYLE','NOTE'] },
      label:     { type: 'string', required: true, max: 200 },
      severity:  { type: 'enum', values: ['LOW','MODERATE','HIGH','CRITICAL'] },
      onsetDate: { type: 'date' },
      detail:    { type: 'string', max: 4000 },
      code:      { type: 'string', max: 20 },
    });
    const e = await one(
      `INSERT INTO medical_history_entry
         (patient_id, category, label, severity, onset_date, detail, code, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [ctx.params.id, d.category, d.label, d.severity, d.onsetDate, d.detail, d.code, ctx.user.sub]);
    await writeAudit(ctx, { action: 'CREATE', entity: 'medical_history', entityId: e.id,
      summary: `Antécédent ajouté : ${d.category} — ${d.label}` });
    return e;
  }, { permission: 'patient.write.medical' });

  router.delete('/api/patients/:pid/history/:id', async (ctx) => {
    await query(`UPDATE medical_history_entry SET is_active = false WHERE id = $1`, [ctx.params.id]);
    await writeAudit(ctx, { action: 'UPDATE', entity: 'medical_history', entityId: ctx.params.id,
      summary: 'Antécédent désactivé' });
    return { ok: true };
  }, { permission: 'patient.write.medical' });

  /* -------------------------- Assurances ---------------------------- */
  router.post('/api/patients/:id/insurances', async (ctx) => {
    const d = validate(ctx.body, {
      scheme:       { type: 'string', required: true, max: 60 },
      insurerName:  { type: 'string', max: 120 },
      policyNumber: { type: 'string', max: 60 },
      coverageRate: { type: 'number', min: 0, max: 100, default: 70 },
      validFrom:    { type: 'date' },
      validTo:      { type: 'date' },
      isPrimary:    { type: 'boolean', default: true },
    });
    return tx(async (c) => {
      if (d.isPrimary)
        await c.query('UPDATE patient_insurance SET is_primary = false WHERE patient_id = $1', [ctx.params.id]);
      const { rows } = await c.query(
        `INSERT INTO patient_insurance
           (patient_id, scheme, insurer_name, policy_number, coverage_rate, valid_from, valid_to, is_primary)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [ctx.params.id, d.scheme, d.insurerName, d.policyNumber, d.coverageRate,
         d.validFrom, d.validTo, d.isPrimary]);
      return rows[0];
    });
  }, { permission: 'patient.write' });

  /* ------------------------- Consentements -------------------------- */
  router.put('/api/patients/:id/consents/:kind', async (ctx) => {
    const granted = ctx.body?.granted === true;
    const c = await one(
      `INSERT INTO consent (patient_id, kind, granted, revoked_at)
       VALUES ($1,$2,$3, CASE WHEN $3 THEN NULL ELSE now() END)
       ON CONFLICT (patient_id, kind) DO UPDATE
         SET granted = EXCLUDED.granted, granted_at = now(),
             revoked_at = CASE WHEN EXCLUDED.granted THEN NULL ELSE now() END
       RETURNING *`, [ctx.params.id, ctx.params.kind, granted]);
    await writeAudit(ctx, { action: 'UPDATE', entity: 'consent', entityId: c.id,
      summary: `Consentement ${ctx.params.kind} : ${granted ? 'accordé' : 'révoqué'}` });
    return c;
  }, { permission: 'patient.write' });

  /* ---------------------- Fusion de doublons ------------------------ */
  router.post('/api/patients/:id/merge', async (ctx) => {
    const targetId = ctx.params.id;
    const { sourceId } = validate(ctx.body, { sourceId: { type: 'uuid', required: true } });
    if (sourceId === targetId) throw unprocessable('Impossible de fusionner un patient avec lui-même.');
    return tx(async (c) => {
      const src = (await c.query('SELECT * FROM patient WHERE id = $1', [sourceId])).rows[0];
      const tgt = (await c.query('SELECT * FROM patient WHERE id = $1', [targetId])).rows[0];
      if (!src || !tgt) throw notFound('Patient introuvable.');
      for (const t of ['appointment', 'invoice', 'medical_history_entry', 'patient_contact',
                       'patient_insurance', 'waiting_list_entry', 'encounter']) {
        await c.query(`UPDATE ${t} SET patient_id = $1 WHERE patient_id = $2`, [targetId, sourceId]);
      }
      await c.query(
        `UPDATE patient SET status = 'MERGED', merged_into_id = $2, updated_at = now(), updated_by = $3
          WHERE id = $1`, [sourceId, targetId, ctx.user.sub]);
      await writeAudit(ctx, { action: 'MERGE', entity: 'patient', entityId: targetId,
        summary: `Fusion de ${src.mrn} dans ${tgt.mrn}` });
      return { ok: true, targetId, sourceMrn: src.mrn, targetMrn: tgt.mrn };
    });
  }, { permission: 'patient.merge' });
}

function toCamel(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] =
      v instanceof Date ? v.toISOString().slice(0, 10) : v;
  }
  return out;
}
