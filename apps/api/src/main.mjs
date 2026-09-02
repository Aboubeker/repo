/**
 * CliniRDV — serveur applicatif.
 * Sert l'API REST et l'interface web depuis un unique processus local.
 */
import http from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Router, createHandler } from './core/http.mjs';
import { healthcheck, closePool } from './core/db.mjs';
import { registerAuthRoutes } from './modules/auth.routes.mjs';
import { registerPatientRoutes } from './modules/patients.routes.mjs';
import { registerPractitionerRoutes } from './modules/practitioners.routes.mjs';
import { registerAppointmentRoutes } from './modules/appointments.routes.mjs';
import { registerResourceRoutes } from './modules/resources.routes.mjs';
import { registerBillingRoutes } from './modules/billing.routes.mjs';
import { registerReportRoutes } from './modules/reports.routes.mjs';
import { registerAdminRoutes } from './modules/admin.routes.mjs';
import { processNotificationQueue } from './modules/notifications.service.mjs';
import { integrityCheck } from './modules/backup.service.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const WEB_DIR = resolve(ROOT, 'apps/web/dist');
const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || '0.0.0.0';

export function buildRouter() {
  const router = new Router();

  router.get('/api/health', async () => {
    const db = await healthcheck();
    return { status: 'ok', database: db, uptimeSeconds: Math.round(process.uptime()) };
  }, { public: true });

  router.get('/api/ready', async () => {
    const db = await healthcheck();
    return { ready: db.ok, database: db };
  }, { public: true });

  router.get('/api/admin/integrity', async () => integrityCheck(), { permission: 'admin.settings' });

  registerAuthRoutes(router);
  registerPatientRoutes(router);
  registerPractitionerRoutes(router);
  registerAppointmentRoutes(router);
  registerResourceRoutes(router);
  registerBillingRoutes(router);
  registerReportRoutes(router);
  registerAdminRoutes(router);
  return router;
}

/* ------------------- Service des fichiers statiques ------------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.map': 'application/json',
};

function serveStatic(req, res) {
  if (!existsSync(WEB_DIR)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end('<h1>CliniRDV</h1><p>Interface non compilée. Lancez <code>npm run build:web</code>.</p>');
  }
  const url = new URL(req.url, 'http://localhost');
  let file = join(WEB_DIR, normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(WEB_DIR)) { res.writeHead(403); return res.end(); }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(WEB_DIR, 'index.html');
  if (!existsSync(file)) { res.writeHead(404); return res.end('Not found'); }

  const ext = extname(file);
  const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
  // L'index n'est jamais mis en cache : les mises à jour sont immédiates
  headers['Cache-Control'] = ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable';
  res.writeHead(200, headers);
  res.end(readFileSync(file));
}

/* ------------------------------ Démarrage ----------------------------- */
export function createServer() {
  const handler = createHandler(buildRouter(), { onNotFound: (req, res) => serveStatic(req, res) });
  return http.createServer(handler);
}

const isMain = process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`;
if (isMain) {
  const server = createServer();
  server.listen(PORT, HOST, () => {
    console.log(`\n  CliniRDV — ${process.env.CLINIC_NAME || 'Clinique'}`);
    console.log(`  Serveur local : http://${HOST}:${PORT}`);
    console.log(`  Mode          : on-premise (aucune synchronisation externe)\n`);
  });

  // Traitement périodique de la file de notifications (worker intégré)
  const timer = setInterval(() => {
    processNotificationQueue().catch((e) => console.error('[notifications]', e.message));
  }, 60_000);
  timer.unref();

  const shutdown = async (sig) => {
    console.log(`\n${sig} reçu — arrêt propre…`);
    server.close();
    await closePool().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
