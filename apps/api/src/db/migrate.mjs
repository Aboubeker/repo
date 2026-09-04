#!/usr/bin/env node
/** Applique les migrations SQL dans l'ordre, une seule fois chacune. */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pool } from '../core/db.mjs';
import { ROOT } from '../core/root.mjs';

const DIR = resolve(ROOT, 'infra/db');

/**
 * Applique les migrations en attente.
 *
 * Exposé sous forme de fonction plutôt qu'exécuté à l'import : l'exécutable
 * distribué doit pouvoir préparer la base (`CliniRDV.exe --migrate`) sans
 * disposer de npm ni des scripts du dépôt. Le pool n'est donc pas fermé ici,
 * sinon le serveur qui appelle cette fonction se retrouverait sans connexion.
 *
 * @returns {Promise<number>} nombre de migrations appliquées.
 */
export async function runMigrations() {
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migration (
      filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);

    const applied = new Set((await client.query('SELECT filename FROM schema_migration')).rows
      .map((r) => r.filename));
    const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();

    let count = 0;
    for (const f of files) {
      if (applied.has(f)) continue;
      process.stdout.write(`• ${f} … `);
      const sql = readFileSync(resolve(DIR, f), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migration (filename) VALUES ($1)', [f]);
        await client.query('COMMIT');
        console.log('appliquée');
        count++;
      } catch (err) {
        // Une migration à moitié appliquée laisserait un schéma incohérent :
        // on annule et on s'arrête plutôt que d'enchaîner les suivantes.
        await client.query('ROLLBACK');
        console.log('ÉCHEC');
        throw new Error(`${f} : ${err.message}`);
      }
    }
    console.log(count ? `✓ ${count} migration(s) appliquée(s).` : '✓ Base à jour.');
    return count;
  } finally {
    client.release();
  }
}

// Exécution directe (« npm run migrate ») : on ferme le pool pour que le
// processus se termine au lieu de rester suspendu sur une connexion ouverte.
if (process.argv[1] && /migrate\.mjs$/.test(process.argv[1])) {
  (async () => {
    try {
      await runMigrations();
    } catch (e) {
      console.error(e.message);
      await pool.end();
      process.exit(1);
    }
    await pool.end();
  })();
}
