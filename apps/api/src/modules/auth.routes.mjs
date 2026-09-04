/** Module Authentification : connexion, rafraîchissement, déconnexion, profil. */
import {
  authenticate, signAccessToken, issueRefreshToken, consumeRefreshToken,
  revokeAllSessions, loadPermissions, publicUser, hashPassword,
  verifyPassword, validatePasswordStrength,
} from '../core/auth.mjs';
import { one, query } from '../core/db.mjs';
import { badRequest, unauthorized } from '../core/errors.mjs';
import { writeAudit } from '../core/audit.mjs';
import { validate } from '../core/validate.mjs';

const REFRESH_TTL = Number(process.env.REFRESH_TOKEN_TTL || 28800);

export function registerAuthRoutes(router) {
  router.post('/api/auth/login', async (ctx) => {
    const { username, password } = validate(ctx.body, {
      username: { type: 'string', required: true, max: 100 },
      password: { type: 'string', required: true, max: 200 },
    });
    const user = await authenticate(username, password);
    const accessToken = signAccessToken({
      sub: user.id, username: user.username, roles: user.roles,
      permissions: user.permissions, practitionerId: user.practitioner_id,
    });
    const refreshToken = await issueRefreshToken(user.id, ctx.ip, ctx.userAgent);
    ctx.setCookie('refresh_token', refreshToken, { maxAge: REFRESH_TTL });
    await writeAudit({ ...ctx, user: { sub: user.id, username: user.username } },
      { action: 'LOGIN', entity: 'user_account', entityId: user.id, summary: 'Connexion réussie' });
    return { accessToken, user: publicUser(user) };
  }, { public: true });

  router.post('/api/auth/refresh', async (ctx) => {
    const raw = ctx.cookies.refresh_token || ctx.body?.refreshToken;
    if (!raw) throw unauthorized('Aucune session active.');
    const userId = await consumeRefreshToken(raw);
    if (!userId) throw unauthorized('Session expirée, veuillez vous reconnecter.');
    const user = await one(
      `SELECT u.*, array_remove(array_agg(DISTINCT r.code), NULL) AS roles
         FROM user_account u
         LEFT JOIN user_role ur ON ur.user_id = u.id
         LEFT JOIN role r ON r.id = ur.role_id
        WHERE u.id = $1 AND u.deleted_at IS NULL AND u.status = 'ACTIVE'
        GROUP BY u.id`, [userId]);
    if (!user) throw unauthorized('Compte indisponible.');
    user.permissions = await loadPermissions(user.id);
    const accessToken = signAccessToken({
      sub: user.id, username: user.username, roles: user.roles,
      permissions: user.permissions, practitionerId: user.practitioner_id,
    });
    const refreshToken = await issueRefreshToken(user.id, ctx.ip, ctx.userAgent);
    ctx.setCookie('refresh_token', refreshToken, { maxAge: REFRESH_TTL });
    return { accessToken, user: publicUser(user) };
  }, { public: true });

  router.post('/api/auth/logout', async (ctx) => {
    const raw = ctx.cookies.refresh_token;
    if (raw) await consumeRefreshToken(raw);
    ctx.setCookie('refresh_token', '', { maxAge: 0 });
    await writeAudit(ctx, { action: 'LOGOUT', entity: 'user_account', entityId: ctx.user?.sub });
    return { ok: true };
  });

  router.get('/api/auth/me', async (ctx) => {
    const user = await one(
      `SELECT u.*, array_remove(array_agg(DISTINCT r.code), NULL) AS roles
         FROM user_account u
         LEFT JOIN user_role ur ON ur.user_id = u.id
         LEFT JOIN role r ON r.id = ur.role_id
        WHERE u.id = $1 GROUP BY u.id`, [ctx.user.sub]);
    if (!user) throw unauthorized();
    user.permissions = await loadPermissions(user.id);
    return { user: publicUser(user) };
  });

  router.post('/api/auth/change-password', async (ctx) => {
    const { currentPassword, newPassword } = validate(ctx.body, {
      currentPassword: { type: 'string', required: true },
      newPassword: { type: 'string', required: true },
    });
    const user = await one('SELECT * FROM user_account WHERE id = $1', [ctx.user.sub]);
    if (!verifyPassword(currentPassword, user.password_hash))
      throw badRequest('Mot de passe actuel incorrect.', { currentPassword: 'Incorrect.' });
    const weak = validatePasswordStrength(newPassword);
    if (weak.length) throw badRequest('Mot de passe trop faible.', { newPassword: weak.join(', ') });
    await query(
      `UPDATE user_account SET password_hash = $2, password_changed_at = now(),
              must_change_password = false WHERE id = $1`,
      [user.id, hashPassword(newPassword)]);
    await revokeAllSessions(user.id);
    await writeAudit(ctx, { action: 'UPDATE', entity: 'user_account', entityId: user.id,
      summary: 'Changement de mot de passe' });
    return { ok: true };
  });
}
