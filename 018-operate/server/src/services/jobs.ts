import type { Db } from '../db/pool.js';
import { sql } from '../lib/sql.js';

let wake: (() => void) | null = null;
export function setWorkerWake(fn: () => void) {
  wake = fn;
}

/** Idempotent enqueue: the same idempotency key is only ever queued once. */
export async function enqueue(db: Db, type: string, payload: Record<string, unknown>, key: string, runAt?: Date | string | null) {
  const n = await db.exec(sql`INSERT INTO jobs (org_id, type, payload, idempotency_key, run_at)
    VALUES (${db.orgId}, ${type}, ${JSON.stringify(payload)}, ${key}, ${runAt ?? new Date()}) ON CONFLICT (idempotency_key) DO NOTHING`);
  if (n) db.afterCommit(() => wake?.());
  return n > 0;
}
