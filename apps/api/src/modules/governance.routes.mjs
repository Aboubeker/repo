/**
 * Gouvernance : rôles personnalisables, superutilisateur, thème.
 *
 * Séparé de `admin.routes.mjs`, qui gère l'exploitation courante (comptes,
 * référentiels, sauvegardes). Ce module traite ce qui modifie les règles du
 * système lui-même : qui a le droit de faire quoi, et à quoi ressemble
 * l'application. Ces opérations ont un pouvoir de nuisance supérieur — un
 * rôle mal édité verrouille tout le monde dehors — d'où des garde-fous
 * spécifiques et un audit systématique.
 */
import { many, one, query, tx } from '../core/db.mjs';
import { notFound, badRequest, unprocessable, forbidden } from '../core/errors.mjs';
import { writeAudit } from '../core/audit.mjs';
import { validate } from '../core/validate.mjs';

/* Rôles livrés avec le logiciel : modifiables dans leurs permissions, mais
   ni renommables ni supprimables. Une clinique ne doit pas pouvoir détruire
   le rôle qui lui donne accès à sa propre administration. */
const PROTECTED_PERMISSIONS = ['admin.users', 'admin.roles'];

/** Le superutilisateur est un attribut de compte, jamais un rôle. */
async function assertSuperuser(ctx) {
  const u = await one('SELECT is_superuser FROM user_account WHERE id = $1', [ctx.user.sub]);
  if (!u?.is_superuser) {
    throw forbidden('Cette opération est réservée au superutilisateur.');
  }
}

/**
 * Relit un rôle avec ses permissions.
 *
 * Les écritures renvoient ainsi exactement la forme que sert le catalogue :
 * l'interface peut rafraîchir sa ligne sans second aller-retour, et sans
 * reconstruire à la main un état qu'elle croirait connaître.
 */
async function readRole(id, client) {
  const run = client ? (sql, p) => client.query(sql, p).then((r) => r.rows[0]) : one;
  return run(
    `SELECT r.id, r.code, r.label, r.description, r.is_system,
            coalesce(array_remove(array_agg(rp.permission_code), NULL), '{}') AS permissions,
            (SELECT count(*)::int FROM user_role ur
              JOIN user_account u ON u.id = ur.user_id
             WHERE ur.role_id = r.id AND u.deleted_at IS NULL) AS user_count
       FROM role r
       LEFT JOIN role_permission rp ON rp.role_id = r.id
      WHERE r.id = $1 GROUP BY r.id`, [id]);
}

export function registerGovernanceRoutes(router) {

  /* =====================================================================
     Rôles
     ===================================================================== */

  router.get('/api/admin/roles/catalog', async () => ({
    permissions: await many(
      'SELECT code, label, category FROM permission ORDER BY category, code'),
    roles: await many(
      `SELECT r.id, r.code, r.label, r.description, r.is_system,
              array_remove(array_agg(rp.permission_code), NULL) AS permissions,
              (SELECT count(*)::int FROM user_role ur
                JOIN user_account u ON u.id = ur.user_id
               WHERE ur.role_id = r.id AND u.deleted_at IS NULL) AS user_count
         FROM role r
         LEFT JOIN role_permission rp ON rp.role_id = r.id
        GROUP BY r.id ORDER BY r.is_system DESC, r.code`),
  }), { permission: 'admin.users' });

  router.post('/api/admin/roles', async (ctx) => {
    const d = validate(ctx.body, {
      code:        { type: 'string', required: true, max: 30,
                     pattern: /^[A-Z][A-Z0-9_]{1,29}$/,
                     message: 'Majuscules, chiffres et « _ » ; doit commencer par une lettre.' },
      label:       { type: 'string', required: true, max: 60 },
      description: { type: 'string', max: 200 },
      permissions: { type: 'array' },
    });

    const exists = await one('SELECT 1 FROM role WHERE code = $1', [d.code]);
    if (exists) throw unprocessable(`Le rôle « ${d.code} » existe déjà.`, 'ROLE_EXISTS');

    return tx(async (c) => {
      const { rows: [r] } = await c.query(
        `INSERT INTO role (code, label, description, is_system)
         VALUES ($1, $2, $3, false) RETURNING *`,
        [d.code, d.label, d.description ?? null]);

      for (const p of d.permissions ?? []) {
        await c.query(
          `INSERT INTO role_permission (role_id, permission_code)
           SELECT $1, code FROM permission WHERE code = $2`, [r.id, p]);
      }
      await writeAudit(ctx, { action: 'CREATE', entity: 'role', entityId: r.id,
        summary: `Création du rôle ${r.code} (${(d.permissions ?? []).length} permission(s))` });
      return readRole(r.id, c);
    });
  }, { permission: 'admin.users' });

  router.patch('/api/admin/roles/:id', async (ctx) => {
    const d = validate(ctx.body, {
      label:       { type: 'string', max: 60 },
      description: { type: 'string', max: 200 },
      permissions: { type: 'array' },
    });

    const role = await one('SELECT * FROM role WHERE id = $1', [ctx.params.id]);
    if (!role) throw notFound('Rôle introuvable.');

    /*
     * Un rôle système garde son intitulé : il est cité dans la documentation
     * et les procédures de la clinique. Ses permissions, elles, restent
     * ajustables — c'est tout l'intérêt d'un RBAC modifiable.
     *
     * Le test porte sur les valeurs brutes de la requête : `validate`
     * transforme les champs absents en `null`, si bien que `d.description`
     * vaut `null` même lorsque l'appelant n'a envoyé que « permissions ».
     */
    const renaming = ctx.body?.label !== undefined || ctx.body?.description !== undefined;
    if (role.is_system && renaming) {
      throw unprocessable(
        'L\'intitulé d\'un rôle livré avec le logiciel ne peut pas être modifié. ' +
        'Ses permissions, en revanche, restent ajustables.', 'SYSTEM_ROLE');
    }

    /*
     * Verrou anti-auto-exclusion.
     *
     * Retirer « admin.users » du dernier rôle qui la porte rendrait
     * l'administration définitivement inaccessible — sans accès au serveur,
     * la clinique serait bloquée. Le superutilisateur reste un recours, mais
     * mieux vaut refuser l'opération que compter dessus.
     */
    if (d.permissions) {
      for (const critical of PROTECTED_PERMISSIONS) {
        const hadIt = await one(
          'SELECT 1 FROM role_permission WHERE role_id = $1 AND permission_code = $2',
          [role.id, critical]);
        if (!hadIt || d.permissions.includes(critical)) continue;

        const others = await one(
          `SELECT count(*)::int AS n
             FROM role_permission rp
             JOIN user_role ur ON ur.role_id = rp.role_id
             JOIN user_account u ON u.id = ur.user_id
            WHERE rp.permission_code = $1 AND rp.role_id <> $2
              AND u.status = 'ACTIVE' AND u.deleted_at IS NULL`,
          [critical, role.id]);

        if ((others?.n ?? 0) === 0) {
          throw unprocessable(
            `Impossible de retirer « ${critical} » : aucun autre rôle actif ne la ` +
            'porte, plus personne ne pourrait administrer le système.',
            'LAST_ADMIN_PERMISSION');
        }
      }
    }

    // `coalesce` seul rendrait la description ineffaçable : une chaîne vide
    // devient `null` après validation et serait confondue avec « absent ».
    // Le drapeau distingue « champ non transmis » de « champ vidé ».
    const clearDescription = ctx.body?.description === '';

    return tx(async (c) => {
      const { rows: [r] } = await c.query(
        `UPDATE role SET label = coalesce($2, label),
                         description = CASE WHEN $4 THEN NULL
                                            ELSE coalesce($3, description) END
          WHERE id = $1 RETURNING *`,
        [role.id, d.label ?? null, d.description ?? null, clearDescription]);

      if (d.permissions) {
        await c.query('DELETE FROM role_permission WHERE role_id = $1', [role.id]);
        for (const p of d.permissions) {
          await c.query(
            `INSERT INTO role_permission (role_id, permission_code)
             SELECT $1, code FROM permission WHERE code = $2`, [role.id, p]);
        }
      }
      await writeAudit(ctx, { action: 'UPDATE', entity: 'role', entityId: role.id,
        summary: `Modification du rôle ${role.code}`,
        diff: d.permissions ? { permissions: d.permissions } : null });
      return readRole(r.id, c);
    });
  }, { permission: 'admin.users' });

  router.delete('/api/admin/roles/:id', async (ctx) => {
    const role = await one('SELECT * FROM role WHERE id = $1', [ctx.params.id]);
    if (!role) throw notFound('Rôle introuvable.');
    if (role.is_system) {
      throw unprocessable('Un rôle livré avec le logiciel ne peut pas être supprimé.',
        'SYSTEM_ROLE');
    }

    const used = await one(
      `SELECT count(*)::int AS n FROM user_role ur
         JOIN user_account u ON u.id = ur.user_id
        WHERE ur.role_id = $1 AND u.deleted_at IS NULL`, [role.id]);
    if ((used?.n ?? 0) > 0) {
      throw unprocessable(
        `${used.n} compte(s) portent encore ce rôle. Réattribuez-les avant de le supprimer.`,
        'ROLE_IN_USE', { userCount: used.n });
    }

    await query('DELETE FROM role WHERE id = $1', [role.id]);
    await writeAudit(ctx, { action: 'DELETE', entity: 'role', entityId: role.id,
      summary: `Suppression du rôle ${role.code}` });
    return { deleted: true };
  }, { permission: 'admin.users' });

  /* =====================================================================
     Superutilisateur
     ===================================================================== */

  /*
   * Promotion et rétrogradation.
   *
   * Réservé aux superutilisateurs eux-mêmes : la permission « admin.users »
   * ne suffit pas. Sans cela, tout administrateur pourrait se hisser au
   * niveau supérieur, et la distinction n'aurait plus de sens.
   *
   * Le cas du dernier superutilisateur est verrouillé par un déclencheur en
   * base (migration 003) : la garantie tient même si cette route est
   * contournée.
   */
  router.patch('/api/admin/users/:id/superuser', async (ctx) => {
    await assertSuperuser(ctx);
    const d = validate(ctx.body, {
      isSuperuser: { type: 'boolean', required: true },
    });

    const target = await one(
      'SELECT id, username, is_superuser FROM user_account WHERE id = $1 AND deleted_at IS NULL',
      [ctx.params.id]);
    if (!target) throw notFound('Utilisateur introuvable.');

    if (target.id === ctx.user.sub && !d.isSuperuser) {
      throw unprocessable(
        'Vous ne pouvez pas renoncer vous-même à vos droits de superutilisateur. ' +
        'Demandez à un autre superutilisateur de le faire.', 'SELF_DEMOTION');
    }

    try {
      await query('UPDATE user_account SET is_superuser = $2, updated_at = now() WHERE id = $1',
        [target.id, d.isSuperuser]);
    } catch (e) {
      if (String(e.message).includes('LAST_SUPERUSER')) {
        throw unprocessable(
          'Il doit rester au moins un superutilisateur actif.', 'LAST_SUPERUSER');
      }
      throw e;
    }

    await writeAudit(ctx, { action: 'UPDATE', entity: 'user_account', entityId: target.id,
      summary: d.isSuperuser
        ? `Promotion de ${target.username} au rang de superutilisateur`
        : `Retrait des droits de superutilisateur à ${target.username}` });
    return { id: target.id, is_superuser: d.isSuperuser };
  }, { permission: 'admin.users' });

  /*
   * Suppression d'un compte — logique, jamais physique.
   *
   * Un compte ayant signé des factures ou des consultations doit rester
   * référençable : la traçabilité prime sur le ménage. La ligne est marquée
   * supprimée, ses sessions révoquées, son identifiant libéré pour un futur
   * compte (index unique partiel, migration 003).
   */
  router.delete('/api/admin/users/:id', async (ctx) => {
    const target = await one(
      'SELECT id, username, is_superuser FROM user_account WHERE id = $1 AND deleted_at IS NULL',
      [ctx.params.id]);
    if (!target) throw notFound('Utilisateur introuvable.');

    if (target.id === ctx.user.sub) {
      throw unprocessable('Vous ne pouvez pas supprimer votre propre compte.', 'SELF_LOCKOUT');
    }
    if (target.is_superuser) await assertSuperuser(ctx);

    try {
      await tx(async (c) => {
        await c.query(
          `UPDATE user_account
              SET deleted_at = now(), deleted_by = $2, status = 'DISABLED'
            WHERE id = $1`, [target.id, ctx.user.sub]);
        await c.query('DELETE FROM session_token WHERE user_id = $1', [target.id]);
      });
    } catch (e) {
      if (String(e.message).includes('LAST_SUPERUSER')) {
        throw unprocessable(
          'Il doit rester au moins un superutilisateur actif.', 'LAST_SUPERUSER');
      }
      throw e;
    }

    await writeAudit(ctx, { action: 'DELETE', entity: 'user_account', entityId: target.id,
      summary: `Suppression du compte ${target.username}` });
    return { deleted: true };
  }, { permission: 'admin.users' });

  /* =====================================================================
     Thème
     ===================================================================== */

  /** Lecture publique : l'écran de connexion doit être aux couleurs de la clinique. */
  router.get('/api/theme', async () => {
    const t = await one('SELECT * FROM app_theme WHERE singleton');
    return t ?? {};
  }, { public: true });

  router.put('/api/theme', async (ctx) => {
    const d = validate(ctx.body, {
      preset:       { type: 'string', max: 30 },
      primaryColor: { type: 'string', pattern: /^#[0-9a-fA-F]{6}$/,
                      message: 'Couleur hexadécimale attendue, par exemple #0f766e.' },
      accentColor:  { type: 'string', pattern: /^#[0-9a-fA-F]{6}$/ },
      sidebarColor: { type: 'string', pattern: /^#[0-9a-fA-F]{6}$/ },
      density:      { type: 'enum', values: ['comfortable', 'compact'] },
      radius:       { type: 'enum', values: ['square', 'medium', 'round'] },
      fontScale:    { type: 'number', min: 0.85, max: 1.30 },
      logoDataUri:  { type: 'string', max: 262144 },
      loginMessage: { type: 'string', max: 300 },
    });

    /*
     * `validate` convertit la chaîne vide en `null`, ce qui rend les deux
     * intentions indistinguables : « ne touche pas à ce champ » et « efface
     * ce champ ». Pour le logo et le message d'accueil, l'effacement doit
     * rester possible : on relit donc la valeur brute de la requête.
     */
    const clearLogo = ctx.body?.logoDataUri === '';
    const clearMessage = ctx.body?.loginMessage === '';

    // Le logo est injecté dans un attribut src : n'accepter que des images
    // encodées en base64, jamais une URL distante (déploiement hors ligne)
    // ni un SVG, qui peut porter du script.
    if (d.logoDataUri && d.logoDataUri !== '' &&
        !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(d.logoDataUri)) {
      throw badRequest('Logo invalide.', {
        logo: 'Formats acceptés : PNG, JPEG, WEBP ou GIF, encodés en base64.',
      });
    }

    const t = await one(
      `UPDATE app_theme SET
         preset        = coalesce($1, preset),
         primary_color = coalesce($2, primary_color),
         accent_color  = coalesce($3, accent_color),
         sidebar_color = coalesce($4, sidebar_color),
         density       = coalesce($5, density),
         radius        = coalesce($6, radius),
         font_scale    = coalesce($7, font_scale),
         logo_data_uri = CASE WHEN $10 THEN NULL
                              ELSE coalesce($8, logo_data_uri) END,
         login_message = CASE WHEN $11 THEN NULL
                              ELSE coalesce($9, login_message) END,
         updated_at = now(), updated_by = $12
       WHERE singleton RETURNING *`,
      [d.preset ?? null, d.primaryColor ?? null, d.accentColor ?? null,
       d.sidebarColor ?? null, d.density ?? null, d.radius ?? null,
       d.fontScale ?? null, d.logoDataUri ?? null, d.loginMessage ?? null,
       clearLogo, clearMessage, ctx.user.sub]);

    await writeAudit(ctx, { action: 'UPDATE', entity: 'app_theme', entityId: null,
      summary: 'Modification de l\'apparence de l\'application' });
    return t;
  }, { permission: 'admin.settings' });

  /** Retour à l'apparence livrée — utile après une personnalisation ratée. */
  router.post('/api/theme/reset', async (ctx) => {
    const t = await one(
      `UPDATE app_theme SET
         preset = 'teal', primary_color = '#0f766e', accent_color = '#5eead4',
         sidebar_color = '#14201e', density = 'comfortable', radius = 'medium',
         font_scale = 1.00, logo_data_uri = NULL, login_message = NULL,
         updated_at = now(), updated_by = $1
       WHERE singleton RETURNING *`, [ctx.user.sub]);
    await writeAudit(ctx, { action: 'UPDATE', entity: 'app_theme', entityId: null,
      summary: 'Réinitialisation de l\'apparence' });
    return t;
  }, { permission: 'admin.settings' });
}
