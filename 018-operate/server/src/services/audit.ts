import type { Db } from '../db/pool.js';
import type { Actor } from '../lib/authz.js';
import { sql } from '../lib/sql.js';

/**
 * Append-only audit trail. Never pass full document bodies, passwords or tokens in `detail`:
 * only identifiers and the minimal before/after of changed metadata.
 */
export async function audit(
  db: Db,
  actor: Pick<Actor, 'id' | 'name'> | null,
  action: string,
  target: { type: string; id: string },
  summary: string,
  detail: Record<string, unknown> = {},
  ip?: string,
) {
  await db.exec(sql`INSERT INTO audit_events (org_id, actor_id, actor_label, action, target_type, target_id, summary, detail, ip)
    VALUES (${db.orgId}, ${actor?.id ?? null}, ${actor?.name ?? 'system'}, ${action}, ${target.type}, ${target.id}, ${summary}, ${JSON.stringify(detail)}, ${ip ?? null})`);
}
