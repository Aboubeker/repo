/**
 * Accès à la base de données locale.
 * Pool de connexions PostgreSQL + aide aux transactions avec réessai
 * automatique en cas d'échec de sérialisation (erreur 40001).
 */
import pg from 'pg';

// Les numeric reviennent en float pour le JSON (montants < 2^53, sans risque ici)
pg.types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));

export const pool = new pg.Pool({
  host: process.env.PGHOST || '127.0.0.1',
  port: Number(process.env.PGPORT || 55432),
  user: process.env.PGUSER || 'clinirdv',
  password: process.env.PGPASSWORD || 'clinirdv',
  database: process.env.PGDATABASE || 'clinirdv',
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => console.error('[db] erreur de pool inattendue', err));

export async function query(text, params) {
  return pool.query(text, params);
}

export async function one(text, params) {
  const { rows } = await pool.query(text, params);
  return rows[0] ?? null;
}

export async function many(text, params) {
  const { rows } = await pool.query(text, params);
  return rows;
}

/**
 * Exécute fn dans une transaction. Réessaie jusqu'à 3 fois si PostgreSQL
 * signale un conflit de sérialisation ou un interblocage.
 */
export async function tx(fn, { retries = 3 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      const retryable = err.code === '40001' || err.code === '40P01';
      if (retryable && attempt < retries) {
        await new Promise((r) => setTimeout(r, 25 * 2 ** attempt));
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }
}

export async function healthcheck() {
  const started = Date.now();
  await pool.query('SELECT 1');
  return { ok: true, latencyMs: Date.now() - started };
}

export async function closePool() {
  await pool.end();
}
