/** Journal d'audit : toute action sensible est tracée de façon durable. */
import { query } from './db.mjs';

export async function writeAudit(ctx, { action, entity, entityId = null,
  summary = null, diff = null, justification = null }) {
  try {
    await query(
      `INSERT INTO audit_log (user_id, username, ip, action, entity, entity_id, summary, diff, justification)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [ctx.user?.sub ?? null, ctx.user?.username ?? null, ctx.ip ?? null,
       action, entity, entityId, summary, diff ? JSON.stringify(diff) : null, justification]);
  } catch (err) {
    // Le journal ne doit jamais bloquer une opération métier, mais l'échec est signalé.
    console.error('[audit] échec d\'écriture', err.message);
  }
}

/** Calcule le différentiel entre deux objets, pour tracer les modifications. */
export function diffOf(before, after) {
  const diff = {};
  for (const key of new Set([...Object.keys(before || {}), ...Object.keys(after || {})])) {
    const a = before?.[key], b = after?.[key];
    if (JSON.stringify(a) !== JSON.stringify(b)) diff[key] = { old: a ?? null, new: b ?? null };
  }
  return Object.keys(diff).length ? diff : null;
}
