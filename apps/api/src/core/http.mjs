/**
 * Micro-framework HTTP : routeur, parsing du corps, middlewares,
 * contexte de requête (utilisateur, IP, traceId) et gestion d'erreurs.
 * Construit sur le module http de Node — aucune dépendance externe.
 */
import crypto from 'node:crypto';
import { AppError, translateDbError, unauthorized, forbidden, notFound } from './errors.mjs';
import { verifyAccessToken } from './auth.mjs';
import { writeAudit } from './audit.mjs';

export class Router {
  constructor() { this.routes = []; }

  add(method, pattern, handler, opts = {}) {
    const keys = [];
    const regex = new RegExp('^' + pattern.replace(/:[a-zA-Z]+/g, (m) => {
      keys.push(m.slice(1)); return '([^/]+)';
    }) + '$');
    this.routes.push({ method, regex, keys, handler, ...opts });
    return this;
  }
  get(p, h, o)    { return this.add('GET', p, h, o); }
  post(p, h, o)   { return this.add('POST', p, h, o); }
  patch(p, h, o)  { return this.add('PATCH', p, h, o); }
  put(p, h, o)    { return this.add('PUT', p, h, o); }
  delete(p, h, o) { return this.add('DELETE', p, h, o); }

  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = pathname.match(r.regex);
      if (m) {
        const params = {};
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        return { route: r, params };
      }
    }
    return null;
  }
}

async function readBody(req) {
  if (req.method === 'GET' || req.method === 'DELETE') return {};
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 10 * 1024 * 1024) throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'Contenu trop volumineux.');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(raw); }
  catch { throw new AppError(400, 'INVALID_JSON', 'Corps de requête JSON invalide.'); }
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((c) => {
    const i = c.indexOf('=');
    return i < 0 ? [c.trim(), ''] : [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1).trim())];
  }).filter(([k]) => k));
}

export function createHandler(router, { onNotFound } = {}) {
  return async function handle(req, res) {
    const traceId = crypto.randomUUID();
    const started = Date.now();
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const ctx = {
      traceId,
      ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress,
      userAgent: req.headers['user-agent'] || '',
      cookies: parseCookies(req.headers.cookie || ''),
      query: Object.fromEntries(url.searchParams),
      user: null,
      res,
      setCookie: (name, value, opts = {}) => {
        const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
        if (opts.maxAge) parts.push(`Max-Age=${opts.maxAge}`);
        if (opts.expires) parts.push(`Expires=${opts.expires.toUTCString()}`);
        const prev = res.getHeader('Set-Cookie');
        res.setHeader('Set-Cookie', prev ? [].concat(prev, parts.join('; ')) : [parts.join('; ')]);
      },
    };

    res.setHeader('X-Trace-Id', traceId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'no-referrer');

    const send = (status, payload) => {
      if (res.writableEnded) return;
      const body = payload === undefined ? '' : JSON.stringify(payload);
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(body);
    };

    try {
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

      const match = router.match(req.method, url.pathname);
      if (!match) {
        if (onNotFound) return onNotFound(req, res, ctx);
        throw notFound(`Route inconnue : ${req.method} ${url.pathname}`);
      }
      const { route, params } = match;
      ctx.params = params;
      ctx.body = await readBody(req);

      // Authentification (sauf routes publiques)
      if (!route.public) {
        const header = req.headers.authorization || '';
        const token = header.startsWith('Bearer ') ? header.slice(7) : ctx.cookies.access_token;
        const payload = verifyAccessToken(token);
        if (!payload) throw unauthorized('Session expirée, veuillez vous reconnecter.');
        ctx.user = payload;
      }

      // Autorisation
      if (route.permission) {
        const perms = ctx.user?.permissions || [];
        if (!perms.includes(route.permission) && !perms.includes('*')) {
          await writeAudit(ctx, { action: 'DENIED', entity: route.permission,
            summary: `Accès refusé sur ${req.method} ${url.pathname}` });
          throw forbidden(`Permission requise : ${route.permission}`);
        }
      }

      const result = await route.handler(ctx);
      if (res.writableEnded) return;
      send(result?.__status || (req.method === 'POST' ? 201 : 200), result?.__body ?? result ?? {});
    } catch (rawErr) {
      const err = translateDbError(rawErr);
      if (err.status >= 500) {
        console.error(`[${traceId}] ${req.method} ${url.pathname}`, rawErr);
      }
      send(err.status, { error: { ...err.toJSON().error, traceId } });
    } finally {
      const ms = Date.now() - started;
      if (process.env.NODE_ENV !== 'test') {
        console.log(JSON.stringify({ t: new Date().toISOString(), traceId,
          method: req.method, path: url.pathname, status: res.statusCode, ms,
          user: ctx.user?.username || '-' }));
      }
    }
  };
}

export const created = (body) => ({ __status: 201, __body: body });
export const noContent = () => ({ __status: 204, __body: undefined });
