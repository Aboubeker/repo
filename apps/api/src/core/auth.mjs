/**
 * Authentification locale : hachage scrypt, JWT signés HMAC-SHA256,
 * jetons de rafraîchissement en base, anti-force-brute.
 * Aucune dépendance externe : uniquement le module crypto de Node.
 */
import crypto from 'node:crypto';
import { one, query } from './db.mjs';
import { forbidden, tooMany, unauthorized } from './errors.mjs';

const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const ACCESS_TTL = Number(process.env.ACCESS_TOKEN_TTL || 900);        // 15 min
const REFRESH_TTL = Number(process.env.REFRESH_TOKEN_TTL || 28800);    // 8 h
const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

/* --------------------------- Mots de passe --------------------------- */

export function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(plain, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(plain, stored) {
  try {
    const [alg, N, r, p, saltB64, hashB64] = stored.split('$');
    if (alg !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(plain, salt, expected.length,
      { N: Number(N), r: Number(r), p: Number(p) });
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

/** Politique de mot de passe : 12 caractères, 3 classes sur 4. */
export function validatePasswordStrength(pw) {
  const errors = [];
  if (!pw || pw.length < 12) errors.push('12 caractères minimum');
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) => re.test(pw || '')).length;
  if (classes < 3) errors.push('au moins 3 types de caractères (minuscule, majuscule, chiffre, symbole)');
  return errors;
}

/* ------------------------------- JWT --------------------------------- */

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(s, 'base64url').toString('utf8');

export function signAccessToken(payload, ttl = ACCESS_TTL) {
  const header = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const body = b64u(JSON.stringify({ ...payload, iat: now, exp: now + ttl }));
  const sig = crypto.createHmac('sha256', SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

export function verifyAccessToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = crypto.createHmac('sha256', SECRET).update(`${header}.${body}`).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(unb64u(body));
    if (payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch { return null; }
}

/* ------------------------ Jetons de rafraîchissement ----------------- */

const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');

export async function issueRefreshToken(userId, ip, userAgent) {
  const raw = crypto.randomBytes(32).toString('base64url');
  await query(
    `INSERT INTO session_token (user_id, token_hash, ip, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, now() + ($5 || ' seconds')::interval)`,
    [userId, sha256(raw), ip, userAgent, REFRESH_TTL]);
  return raw;
}

export async function consumeRefreshToken(raw) {
  const row = await one(
    `UPDATE session_token SET revoked_at = now()
       WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
       RETURNING user_id`, [sha256(raw)]);
  return row?.user_id ?? null;
}

export async function revokeAllSessions(userId) {
  await query(`UPDATE session_token SET revoked_at = now()
               WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
}

/* --------------------------- Connexion ------------------------------- */

export async function authenticate(username, password) {
  const user = await one(
    `SELECT u.*, array_remove(array_agg(DISTINCT r.code), NULL) AS roles
       FROM user_account u
       LEFT JOIN user_role ur ON ur.user_id = u.id
       LEFT JOIN role r ON r.id = ur.role_id
      WHERE u.username = $1 AND u.deleted_at IS NULL
      GROUP BY u.id`, [username]);

  if (!user) { await new Promise((r) => setTimeout(r, 150)); throw unauthorized('Identifiants invalides.'); }
  if (user.status === 'DISABLED') throw forbidden('Ce compte est désactivé.');
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    const mins = Math.ceil((new Date(user.locked_until) - Date.now()) / 60000);
    throw tooMany(`Compte verrouillé. Réessayez dans ${mins} minute(s).`);
  }

  if (!verifyPassword(password, user.password_hash)) {
    const attempts = user.failed_attempts + 1;
    const lock = attempts >= MAX_ATTEMPTS;
    await query(
      `UPDATE user_account SET failed_attempts = $2,
              locked_until = CASE WHEN $3 THEN now() + ($4||' minutes')::interval ELSE locked_until END,
              status = CASE WHEN $3 THEN 'LOCKED' ELSE status END
         WHERE id = $1`, [user.id, lock ? 0 : attempts, lock, LOCK_MINUTES]);
    if (lock) throw tooMany(`Trop de tentatives. Compte verrouillé ${LOCK_MINUTES} minutes.`);
    throw unauthorized(`Identifiants invalides. ${MAX_ATTEMPTS - attempts} tentative(s) restante(s).`);
  }

  await query(
    `UPDATE user_account SET failed_attempts = 0, locked_until = NULL,
            status = CASE WHEN status = 'LOCKED' THEN 'ACTIVE' ELSE status END,
            last_login_at = now() WHERE id = $1`, [user.id]);

  const permissions = await loadPermissions(user.id);
  return { ...user, permissions };
}

export async function loadPermissions(userId) {
  const { rows } = await query(
    `SELECT DISTINCT rp.permission_code AS code
       FROM user_role ur
       JOIN role_permission rp ON rp.role_id = ur.role_id
      WHERE ur.user_id = $1`, [userId]);
  return rows.map((r) => r.code);
}

export function publicUser(u) {
  return {
    id: u.id, username: u.username, fullName: u.full_name, email: u.email,
    roles: u.roles || [], permissions: u.permissions || [],
    practitionerId: u.practitioner_id, mustChangePassword: u.must_change_password,
  };
}
