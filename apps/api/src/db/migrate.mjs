#!/usr/bin/env node
/** Applique les migrations SQL dans l'ordre, une seule fois chacune. */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../core/db.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const DIR = resolve(ROOT, 'infra/db');

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
      await client.query('ROLLBACK');
      console.log('ÉCHEC');
      console.error(err.message);
      process.exit(1);
    }
  }
  console.log(count ? `✓ ${count} migration(s) appliquée(s).` : '✓ Base à jour.');
} finally {
  client.release();
  await pool.end();
}
