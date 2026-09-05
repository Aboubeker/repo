#!/usr/bin/env node
/**
 * Contrôleur du serveur PostgreSQL local embarqué.
 *
 *   node scripts/db.mjs start | stop | status | reset
 *
 * Aucune installation système requise : le binaire PostgreSQL est fourni
 * avec l'application, ce qui garantit un déploiement on-premise totalement
 * autonome. La mécanique (initdb, pg_ctl, base applicative) vit dans
 * apps/api/src/core/pgserver.mjs, partagé avec l'exécutable distribué
 * (--db-start, --db-stop, --db-status, --setup) : une seule implémentation,
 * deux mondes.
 */
import { loadEnvFile } from '../apps/api/src/core/env.mjs';
import { pgStart, pgStop, pgReset, pgStatus } from '../apps/api/src/core/pgserver.mjs';

// Le .env avant toute lecture : même règle que pour l'exécutable.
loadEnvFile();

const cmd = process.argv[2] || 'start';

try {
  if (cmd === 'start') {
    const before = pgStatus();
    if (before === 'stopped') console.log('• Démarrage de PostgreSQL…');
    await pgStart();
    console.log('✓ PostgreSQL prêt.');
  } else if (cmd === 'stop') {
    pgStop() ? console.log('✓ PostgreSQL arrêté.')
             : console.log('• PostgreSQL est déjà arrêté.');
  } else if (cmd === 'reset') {
    console.log('• Suppression du cluster…');
    await pgReset();
    console.log('✓ Cluster recréé.');
  } else if (cmd === 'status') {
    console.log(pgStatus() === 'running' ? 'running' : 'stopped');
  } else {
    console.error('Usage: db.mjs start|stop|status|reset');
    process.exit(1);
  }
} catch (e) {
  console.error(`Échec : ${e.message}`);
  process.exit(1);
}
