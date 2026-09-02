/**
 * CliniRDV — serveur applicatif.
 * Sert l'API REST et l'interface web depuis un unique processus local.
 */
import http from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Router, createHandler } from './core/http.mjs';
import { healthcheck, closePool, query } from './core/db.mjs';
import { registerAuthRoutes } from './modules/auth.routes.mjs';
import { registerPatientRoutes } from './modules/patients.routes.mjs';
import { registerPractitionerRoutes } from './modules/practitioners.routes.mjs';
import { registerAppointmentRoutes } from './modules/appointments.routes.mjs';
import { registerResourceRoutes } from './modules/resources.routes.mjs';
import { registerBillingRoutes } from './modules/billing.routes.mjs';
import { registerReportRoutes } from './modules/reports.routes.mjs';
import { registerAdminRoutes } from './modules/admin.routes.mjs';
import { registerGovernanceRoutes } from './modules/governance.routes.mjs';
import { processNotificationQueue } from './modules/notifications.service.mjs';
import { integrityCheck } from './modules/backup.service.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const WEB_DIR = resolve(ROOT, 'apps/web/dist');
const PORT = Number(process.env.PORT || 3001);
/**
 * Par défaut on écoute sur « :: » et non « 0.0.0.0 ».
 *
 * Sous Windows, le navigateur résout « localhost » en IPv6 (::1) avant IPv4.
 * Un serveur lié à 0.0.0.0 n'écoute qu'en IPv4 : Chrome tente ::1, échoue, et
 * affiche ERR_CONNECTION_REFUSED alors que le serveur tourne. Node accepte les
 * deux familles lorsqu'il est lié à « :: » (dual-stack), ce qui rend
 * http://localhost:PORT joignable dans tous les cas.
 */
const HOST = (() => {
  const h = process.env.HOST;
  // « 0.0.0.0 » (valeur historique des .env déjà déployés) est promu en « :: »
  // pour couvrir IPv4 *et* IPv6 : même portée d'écoute, mais localhost marche.
  if (!h || h === '0.0.0.0') return '::';
  return h;
})();

export function buildRouter() {
  const router = new Router();

  router.get('/api/health', async () => {
    const db = await healthcheck();
    return { status: 'ok', database: db, uptimeSeconds: Math.round(process.uptime()) };
  }, { public: true });

  /*
   * Identité de l'établissement, accessible sans authentification : l'écran de
   * connexion et la barre latérale doivent afficher le nom réel de la clinique
   * avant toute ouverture de session. Ne renvoie que des informations
   * publiques — jamais de données patient ni de paramètres de sécurité.
   */
  router.get('/api/branding', async () => {
    const rows = await query(
      `SELECT key, value FROM app_setting
        WHERE key IN ('clinic.name','clinic.city','clinic.wilaya','clinic.phone',
                      'clinic.agrement','clinic.timezone')`);
    const s = Object.fromEntries(rows.rows.map((r) => [r.key, r.value]));
    return {
      clinic_name: s['clinic.name'] || process.env.CLINIC_NAME || 'Clinique',
      city:        s['clinic.city'] || null,
      wilaya:      s['clinic.wilaya'] || null,
      phone:       s['clinic.phone'] || null,
      agrement:    s['clinic.agrement'] || null,
      timezone:    s['clinic.timezone'] || process.env.CLINIC_TZ || 'Africa/Algiers',
    };
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
  registerGovernanceRoutes(router);
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

/**
 * Détection « ce fichier est-il le point d'entrée ? ».
 *
 * La concaténation « file:// + chemin » est incorrecte sous Windows : argv[1]
 * vaut « C:\...\main.mjs » alors que import.meta.url vaut
 * « file:///C:/.../main.mjs ». La comparaison échouait donc toujours, le
 * serveur ne se lançait jamais et le processus se terminait en silence.
 * pathToFileURL() produit la forme canonique sur toutes les plateformes.
 */
const isMain = process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

// Filet de sécurité : si la détection échouait malgré tout (chemin exotique,
// lien symbolique, lecteur réseau), le processus se terminerait sans rien dire.
// Mieux vaut un message explicite qu'un « connexion refusée » inexpliqué.
if (!isMain && process.argv[1] && /main\.mjs$/.test(process.argv[1])) {
  console.error('\n  ✗ Le serveur n\'a pas pu s\'initialiser (point d\'entrée non reconnu).');
  console.error(`    argv[1]        : ${process.argv[1]}`);
  console.error(`    import.meta.url: ${import.meta.url}`);
  console.error('    Signalez ces deux lignes : il s\'agit d\'un problème de portabilité.\n');
  process.exit(1);
}
if (isMain) {
  const server = createServer();

  // Un échec d'écoute doit être explicite : sans cela le processus s'arrête en
  // silence et le navigateur affiche seulement « connexion refusée ».
  server.on('error', (e) => {
    console.error(`\n  ✗ Impossible de démarrer le serveur sur ${HOST}:${PORT}`);
    if (e.code === 'EADDRINUSE') {
      console.error('    Ce port est déjà utilisé par une autre application.');
      console.error('    Modifiez PORT dans le fichier .env, puis relancez « npm start ».');
    } else if (e.code === 'EACCES') {
      console.error('    Port réservé ou accès refusé. Utilisez un port supérieur à 1024.');
    } else {
      console.error(`    ${e.code} — ${e.message}`);
    }
    console.error('');
    process.exit(1);
  });

  server.listen(PORT, HOST, () => {
    const shown = HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST;
    console.log(`\n  CliniRDV — ${process.env.CLINIC_NAME || 'Clinique'}`);
    console.log(`  Interface     : http://${shown}:${PORT}`);
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
