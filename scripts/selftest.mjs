#!/usr/bin/env node
/**
 * Auto-test complet : démarre le serveur DANS ce processus (aucun sous-processus
 * qui pourrait masquer une erreur), interroge toutes les adresses possibles et
 * produit un rapport unique.
 *
 *   npm run selftest
 *
 * À lancer quand « l'application ne s'ouvre pas » : le rapport indique la
 * ou les adresses réellement joignables sur cette machine.
 */
import { createServer as netServer, connect } from 'node:net';
import { networkInterfaces, hostname } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const color = process.stdout.isTTY;
const c = (n, s) => (color ? `\x1b[${n}m${s}\x1b[0m` : s);
const bold = (s) => c(1, s);
const head = (m) => console.log(`\n${c(36, bold('▸ ' + m))}`);
const ok = (m, d) => console.log(`  ${c(32, '✓')} ${m}${d ? c(90, `  ${d}`) : ''}`);
const bad = (m, d) => console.log(`  ${c(31, '✗')} ${bold(m)}${d ? c(90, `  ${d}`) : ''}`);
const info = (m) => console.log(`    ${c(90, m)}`);

console.log(bold('\n  CliniRDV — auto-test de démarrage'));
console.log(c(90, `  ${process.platform}/${process.arch} · Node ${process.version} · ${hostname()}`));

/* ------------------------------------------------------------------ .env */
const envPath = resolve(ROOT, '.env');
if (!existsSync(envPath)) {
  bad('.env absent'); info('Lancez : npm run app'); process.exit(1);
}
const env = {};
for (const line of readFileSync(envPath, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
for (const [k, v] of Object.entries(env)) process.env[k] ??= v;
// Coupe le journal des requêtes : le rapport doit rester lisible.
process.env.NODE_ENV = 'test';
const PORT = Number(env.PORT || 3001);

head('Interfaces réseau de cette machine');
const ifaces = networkInterfaces();
let hasV6 = false;
for (const [name, addrs] of Object.entries(ifaces)) {
  for (const a of addrs || []) {
    if (a.internal) {
      info(`${name}: ${a.address} (${a.family}) — boucle locale`);
      if (a.family === 'IPv6') hasV6 = true;
    }
  }
}
if (!hasV6) info('Aucune adresse IPv6 de boucle locale détectée.');

/* -------------------------------------------- test brut des liaisons */
head('Test des liaisons possibles');
const tryBind = (host) => new Promise((res) => {
  const s = netServer();
  s.on('error', (e) => res({ host, ok: false, code: e.code }));
  s.listen(PORT, host, () => {
    const a = s.address();
    s.close(() => res({ host, ok: true, addr: `${a.address}:${a.port}` }));
  });
});
for (const h of ['127.0.0.1', '::1', '0.0.0.0', '::']) {
  const r = await tryBind(h);
  if (r.ok) ok(`liaison possible sur ${h}`, r.addr);
  else bad(`liaison impossible sur ${h}`, r.code);
}

/* -------------------------------- démarrage réel du serveur applicatif */
head('Démarrage du serveur applicatif');
let buildRouter, createServer;
try {
  ({ createServer } = await import('../apps/api/src/main.mjs'));
} catch (e) {
  bad('Le code du serveur ne se charge pas');
  info(e.stack?.split('\n').slice(0, 6).join('\n    ') || e.message);
  process.exit(1);
}
if (typeof createServer !== 'function') {
  bad('main.mjs n\'exporte pas createServer()'); process.exit(1);
}

const server = createServer();
const listenOn = (host) => new Promise((res) => {
  const onErr = (e) => { server.removeListener('error', onErr); res({ ok: false, code: e.code }); };
  server.once('error', onErr);
  server.listen(PORT, host, () => { server.removeListener('error', onErr); res({ ok: true }); });
});

// On privilégie la boucle locale : jamais bloquée par un pare-feu.
let bound = null;
for (const h of ['::', '0.0.0.0', '127.0.0.1']) {
  const r = await listenOn(h);
  if (r.ok) { bound = h; ok(`serveur démarré (HOST=${h})`); break; }
  info(`HOST=${h} refusé : ${r.code}`);
}
if (!bound) { bad('Le serveur n\'a pu écouter sur aucune interface.'); process.exit(1); }

const a = server.address();
info(`socket : ${a.address}:${a.port} (${a.family})`);

/* ------------------------------------------- interrogation réelle HTTP */
head('Interrogation HTTP');
const targets = [
  `http://127.0.0.1:${PORT}`,
  `http://[::1]:${PORT}`,
  `http://localhost:${PORT}`,
];
const reachable = [];
for (const base of targets) {
  try {
    const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(4000) });
    if (r.ok) { ok(`${base} répond`, `HTTP ${r.status}`); reachable.push(base); }
    else bad(`${base} renvoie HTTP ${r.status}`);
  } catch (e) {
    bad(`${base} injoignable`, e.cause?.code || e.message);
  }
}

/* ------------------------------------------------ contenu de la page */
if (reachable.length) {
  head('Contenu servi');
  const base = reachable[0];
  try {
    const html = await (await fetch(`${base}/`, { signal: AbortSignal.timeout(4000) })).text();
    if (html.includes('id="root"')) ok('page HTML valide', 'conteneur React présent');
    else bad('page HTML inattendue', html.slice(0, 80));
    const js = html.match(/\/assets\/[^"]+\.js/)?.[0];
    if (js) {
      const r = await fetch(`${base}${js}`, { signal: AbortSignal.timeout(8000) });
      const size = (await r.arrayBuffer()).byteLength;
      r.ok ? ok('script de l\'interface servi', `${Math.round(size / 1024)} ko`)
           : bad(`script injoignable`, `HTTP ${r.status}`);
    } else bad('aucun script référencé dans la page', 'npm run build:web');

    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'Clinique2026!' }),
      signal: AbortSignal.timeout(6000),
    });
    login.ok ? ok('connexion admin fonctionnelle', `HTTP ${login.status}`)
             : bad('échec de la connexion admin', `HTTP ${login.status}`);
  } catch (e) { bad('erreur pendant la lecture', e.message); }
}

/* -------------------------------------------------------------- verdict */
console.log('\n' + c(90, '  ' + '─'.repeat(64)));
if (reachable.length) {
  console.log(`\n  ${c(32, bold('Le serveur fonctionne.'))}`);
  console.log(`\n  ${bold('Ouvrez cette adresse dans votre navigateur :')}`);
  reachable.forEach((u) => console.log(`      ${bold(c(36, u))}`));
  if (!reachable.includes(`http://localhost:${PORT}`)) {
    console.log(`\n  ${c(33, `« localhost » ne fonctionne pas sur cette machine : utilisez 127.0.0.1.`)}`);
  }
  console.log(`\n  Identifiant ${bold('admin')} — mot de passe ${bold('Clinique2026!')}`);
  console.log(c(90, '\n  Le serveur reste actif. Ctrl+C pour l\'arrêter.\n'));
  // On laisse tourner : l'utilisateur peut tester dans son navigateur.
} else {
  console.log(`\n  ${c(31, bold('Le serveur écoute mais rien ne le joint.'))}`);
  console.log(`
  Cause la plus probable : un pare-feu ou un antivirus bloque les
  connexions locales vers Node.js.

  À essayer :
    1. Autorisez Node.js dans votre pare-feu / antivirus.
    2. Testez un autre port : changez PORT=8080 dans .env, puis relancez.
    3. Désactivez temporairement l'antivirus pour confirmer la cause.
`);
  server.close();
  process.exit(1);
}
