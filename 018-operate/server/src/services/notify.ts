import type { Db } from '../db/pool.js';
import { sql } from '../lib/sql.js';
import type { OrgSettings } from '../lib/settings.js';

export interface NotificationInput {
  type: string;
  title: string;
  link: string;
  /** dedupe key WITHOUT user id — the user id is appended so each user gets it at most once */
  key: string;
}

/**
 * In-app notifications (+ optional email queue). Idempotent via (org_id, dedupe_key).
 * Titles/links only: document bodies are never copied into notifications or emails.
 */
export async function notify(db: Db, settings: OrgSettings, userIds: string[], n: NotificationInput): Promise<number> {
  if (!userIds.length) return 0;
  const email = settings.email.enabled ? 'pending' : 'none';
  return db.exec(sql`INSERT INTO notifications (org_id, user_id, type, title, link, dedupe_key, email_status)
    SELECT ${db.orgId}, u, ${n.type}, ${n.title}, ${n.link}, ${n.key} || ':' || u::text, ${email}
      FROM unnest(${userIds}::uuid[]) AS u
    ON CONFLICT (org_id, dedupe_key) DO NOTHING`);
}
