/** Module Administration : utilisateurs, référentiels, paramètres, sauvegardes. */
import { many, one, query, tx } from '../core/db.mjs';
import { notFound, badRequest, unprocessable } from '../core/errors.mjs';
import { writeAudit } from '../core/audit.mjs';
import { validate } from '../core/validate.mjs';
import { hashPassword, validatePasswordStrength, revokeAllSessions } from '../core/auth.mjs';
import { runBackup, listBackups, restoreBackup } from './backup.service.mjs';
import { resolveTariff } from './catalogue.routes.mjs';
import { processNotificationQueue, callList } from './notifications.service.mjs';

export function registerAdminRoutes(router) {

  /* --------------------------- Utilisateurs --------------------------- */
  router.get('/api/admin/users', async () => ({
    items: await many(
      `SELECT u.id, u.username, u.full_name, u.email, u.status, u.last_login_at,
              u.must_change_password, u.practitioner_id, u.is_superuser,
              array_remove(array_agg(DISTINCT r.code), NULL) AS roles
         FROM user_account u
         LEFT JOIN user_role ur ON ur.user_id = u.id
         LEFT JOIN role r ON r.id = ur.role_id
        WHERE u.deleted_at IS NULL GROUP BY u.id ORDER BY u.username`),
  }), { permission: 'admin.users' });

  router.post('/api/admin/users', async (ctx) => {
    const d = validate(ctx.body, {
      username:       { type: 'string', required: true, max: 60, pattern: /^[a-z0-9._-]+$/,
                        message: 'Minuscules, chiffres, point, tiret ou souligné uniquement.' },
      fullName:       { type: 'string', required: true, max: 120 },
      email:          { type: 'string', max: 120 },
      password:       { type: 'string', required: true },
      roles:          { type: 'array', required: true },
      practitionerId: { type: 'uuid' },
    });
    const weak = validatePasswordStrength(d.password);
    if (weak.length) throw badRequest('Mot de passe trop faible.', { password: weak.join(', ') });

    return tx(async (c) => {
      const { rows: [u] } = await c.query(
        `INSERT INTO user_account (username, full_name, email, password_hash,
           must_change_password, practitioner_id)
         VALUES ($1,$2,$3,$4,true,$5)
         RETURNING id, username, full_name, email, status`,
        [d.username, d.fullName, d.email, hashPassword(d.password), d.practitionerId]);
      for (const code of d.roles) {
        const { rows: [r] } = await c.query('SELECT id FROM role WHERE code = $1', [code]);
        if (!r) throw badRequest(`Rôle inconnu : ${code}`);
        await c.query('INSERT INTO user_role (user_id, role_id) VALUES ($1,$2)', [u.id, r.id]);
      }
      await writeAudit(ctx, { action: 'CREATE', entity: 'user_account', entityId: u.id,
        summary: `Création de l'utilisateur ${u.username} (${d.roles.join(', ')})` });
      return u;
    });
  }, { permission: 'admin.users' });

  router.patch('/api/admin/users/:id', async (ctx) => {
    const d = validate(ctx.body, {
      fullName: { type: 'string', max: 120 },
      email:    { type: 'string', max: 120 },
      status:   { type: 'enum', values: ['ACTIVE','LOCKED','DISABLED'] },
      password: { type: 'string' },
      roles:    { type: 'array' },
    });
    if (ctx.params.id === ctx.user.sub && d.status && d.status !== 'ACTIVE')
      throw unprocessable('Vous ne pouvez pas désactiver votre propre compte.', 'SELF_LOCKOUT');

    return tx(async (c) => {
      if (d.password) {
        const weak = validatePasswordStrength(d.password);
        if (weak.length) throw badRequest('Mot de passe trop faible.', { password: weak.join(', ') });
        await c.query(
          `UPDATE user_account SET password_hash = $2, must_change_password = true,
                  password_changed_at = now() WHERE id = $1`,
          [ctx.params.id, hashPassword(d.password)]);
        await revokeAllSessions(ctx.params.id);
      }
      const { rows: [u] } = await c.query(
        `UPDATE user_account SET full_name = coalesce($2, full_name), email = coalesce($3, email),
                status = coalesce($4, status),
                failed_attempts = CASE WHEN $4 = 'ACTIVE' THEN 0 ELSE failed_attempts END,
                locked_until = CASE WHEN $4 = 'ACTIVE' THEN NULL ELSE locked_until END,
                updated_at = now()
          WHERE id = $1 RETURNING id, username, full_name, email, status`,
        [ctx.params.id, d.fullName, d.email, d.status]);
      if (!u) throw notFound('Utilisateur introuvable.');
      if (d.roles) {
        await c.query('DELETE FROM user_role WHERE user_id = $1', [u.id]);
        for (const code of d.roles) {
          const { rows: [r] } = await c.query('SELECT id FROM role WHERE code = $1', [code]);
          if (r) await c.query('INSERT INTO user_role (user_id, role_id) VALUES ($1,$2)', [u.id, r.id]);
        }
      }
      await writeAudit(ctx, { action: 'UPDATE', entity: 'user_account', entityId: u.id,
        summary: `Modification de l'utilisateur ${u.username}` });
      return u;
    });
  }, { permission: 'admin.users' });

  router.get('/api/admin/roles', async () => ({
    items: await many(
      `SELECT r.*, array_remove(array_agg(rp.permission_code), NULL) AS permissions
         FROM role r LEFT JOIN role_permission rp ON rp.role_id = r.id
        GROUP BY r.id ORDER BY r.code`),
  }), { permission: 'admin.users' });

  /* --------------------------- Référentiels --------------------------- */
  router.get('/api/specialties', async () => ({
    items: await many('SELECT * FROM specialty WHERE is_active ORDER BY label'),
  }), { permission: 'practitioner.read' });

  router.post('/api/specialties', async (ctx) => {
    const d = validate(ctx.body, {
      code:  { type: 'string', required: true, max: 20 },
      label: { type: 'string', required: true, max: 100 },
      color: { type: 'string', max: 9, default: '#64748b' },
    });
    return one('INSERT INTO specialty (code,label,color) VALUES ($1,$2,$3) RETURNING *',
      [d.code, d.label, d.color]);
  }, { permission: 'admin.settings' });

  router.get('/api/appointment-types', async () => ({
    items: await many(
      `SELECT at.*, s.label AS specialty_label, t.amount AS tariff_amount, t.code AS tariff_code
         FROM appointment_type at
         LEFT JOIN specialty s ON s.id = at.specialty_id
         LEFT JOIN tariff t ON t.id = at.default_tariff_id
        WHERE at.is_active ORDER BY at.label`),
  }), { permission: 'appointment.read' });

  router.post('/api/appointment-types', async (ctx) => {
    const d = validate(ctx.body, {
      code:  { type: 'string', required: true, max: 20 },
      label: { type: 'string', required: true, max: 100 },
      specialtyId: { type: 'uuid' },
      defaultDurationMinutes: { type: 'number', required: true, min: 5, max: 480 },
      bufferBeforeMinutes: { type: 'number', min: 0, max: 120, default: 0 },
      bufferAfterMinutes:  { type: 'number', min: 0, max: 120, default: 0 },
      requiresRoom: { type: 'boolean', default: true },
      color: { type: 'string', max: 9, default: '#3b82f6' },
      defaultTariffId: { type: 'uuid' },
      defaultAmount: { type: 'number', min: 0, max: 10000000 },
      preparationInstructions: { type: 'string', max: 1000 },
    });
    /*
     * Le formulaire propose une saisie libre du montant. Le prix reste
     * cependant porté par la table `tariff`, que les lignes de facture
     * référencent : on traduit donc le montant en tarif, en réutilisant un
     * tarif existant de même montant plutôt que d'en multiplier les doublons.
     */
    const t = await tx(async (c) => {
      const tariffId = await resolveTariff(c, {
        amount: d.defaultAmount, currentTariffId: d.defaultTariffId,
        typeCode: d.code, typeLabel: d.label, specialtyId: d.specialtyId });
      const { rows: [row] } = await c.query(
        `INSERT INTO appointment_type (code, label, specialty_id, default_duration_minutes,
           buffer_before_minutes, buffer_after_minutes, requires_room, color,
           default_tariff_id, preparation_instructions)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [d.code, d.label, d.specialtyId, d.defaultDurationMinutes, d.bufferBeforeMinutes,
         d.bufferAfterMinutes, d.requiresRoom, d.color, tariffId, d.preparationInstructions]);
      return row;
    });
    await writeAudit(ctx, { action: 'CREATE', entity: 'appointment_type', entityId: t.id,
      summary: `Type de RDV créé : ${t.label}` });
    return t;
  }, { permission: 'admin.settings' });

  /* ---------------------------- Paramètres ---------------------------- */
  router.get('/api/admin/settings', async () => ({
    items: await many('SELECT * FROM app_setting ORDER BY category, key'),
  }), { permission: 'admin.settings' });

  router.put('/api/admin/settings/:key', async (ctx) => {
    const s = await one(
      `INSERT INTO app_setting (key, value, updated_by, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value,
         updated_by = EXCLUDED.updated_by, updated_at = now() RETURNING *`,
      [ctx.params.key, JSON.stringify(ctx.body?.value ?? null), ctx.user.sub]);
    await writeAudit(ctx, { action: 'UPDATE', entity: 'app_setting', entityId: ctx.params.key,
      summary: `Paramètre ${ctx.params.key} modifié` });
    return s;
  }, { permission: 'admin.settings' });

  /* -------------------------- Jours fériés ---------------------------- */
  router.get('/api/closures', async () => ({
    items: await many(
      `SELECT id, lower(period) AS start_at, upper(period) AS end_at, label
         FROM clinic_closure ORDER BY lower(period)`),
  }), { permission: 'appointment.read' });

  router.post('/api/closures', async (ctx) => {
    const d = validate(ctx.body, {
      startAt: { type: 'datetime', required: true },
      endAt:   { type: 'datetime', required: true },
      label:   { type: 'string', required: true, max: 120 },
    });
    return one(`INSERT INTO clinic_closure (period, label)
                VALUES (tstzrange($1,$2,'[)'), $3) RETURNING *`, [d.startAt, d.endAt, d.label]);
  }, { permission: 'admin.settings' });

  /* --------------------------- Sauvegardes ---------------------------- */
  router.get('/api/admin/backups', async () => ({
    items: await listBackups(),
    diskInfo: await one(`SELECT pg_size_pretty(pg_database_size(current_database())) AS database_size`),
  }), { permission: 'admin.backup' });

  router.post('/api/admin/backups', async (ctx) => {
    const run = await runBackup({ kind: ctx.body?.kind || 'MANUAL' });
    await writeAudit(ctx, { action: 'BACKUP', entity: 'backup_run', entityId: run.id,
      summary: `Sauvegarde ${run.status} — ${run.target_path}` });
    return run;
  }, { permission: 'admin.backup' });

  router.post('/api/admin/backups/:id/restore', async (ctx) => {
    if (ctx.body?.confirm !== 'RESTAURER')
      throw badRequest('Confirmation requise : saisissez « RESTAURER ».');
    await writeAudit(ctx, { action: 'RESTORE', entity: 'backup_run', entityId: ctx.params.id,
      summary: 'Demande de restauration', justification: ctx.body?.reason });
    return restoreBackup(ctx.params.id);
  }, { permission: 'admin.backup' });

  /* -------------------------- Notifications --------------------------- */
  router.get('/api/notifications', async (ctx) => ({
    items: await many(
      `SELECT n.*, p.last_name, p.first_name FROM notification n
         LEFT JOIN patient p ON p.id = n.patient_id
        WHERE ($1::text IS NULL OR n.status = $1)
        ORDER BY n.scheduled_for DESC LIMIT 200`, [ctx.query.status || null]),
  }), { permission: 'appointment.read' });

  router.post('/api/notifications/process', async () =>
    processNotificationQueue(), { permission: 'admin.settings' });

  router.get('/api/notifications/call-list', async (ctx) => ({
    date: ctx.query.date || new Date(Date.now() + 864e5).toISOString().slice(0, 10),
    items: await callList(ctx.query.date || new Date(Date.now() + 864e5).toISOString().slice(0, 10)),
  }), { permission: 'appointment.read' });

  /* ------------------------------ Santé -------------------------------- */
  router.get('/api/admin/system', async () => {
    const [db, counts, lastBackup] = await Promise.all([
      one(`SELECT version() AS version, pg_size_pretty(pg_database_size(current_database())) AS size`),
      one(`SELECT (SELECT count(*) FROM patient WHERE status='ACTIVE')::int AS patients,
                  (SELECT count(*) FROM practitioner WHERE is_active)::int  AS practitioners,
                  (SELECT count(*) FROM appointment)::int                   AS appointments,
                  (SELECT count(*) FROM invoice)::int                       AS invoices,
                  (SELECT count(*) FROM audit_log)::int                     AS audit_entries`),
      one(`SELECT * FROM backup_run WHERE status='SUCCESS' ORDER BY started_at DESC LIMIT 1`),
    ]);
    return {
      database: db, counts, lastBackup,
      deployment: { mode: 'on-premise', cloudSync: false, externalCalls: false },
      uptimeSeconds: Math.round(process.uptime()),
      nodeVersion: process.version,
    };
  }, { permission: 'admin.settings' });
}
