import { config } from '../config.js';
import { sys, tx, type Db } from '../db/pool.js';
import { resolveSettings, type OrgSettings } from '../lib/settings.js';
import { sql } from '../lib/sql.js';
import { audit } from './audit.js';
import { publishVersion } from './documents.js';
import { setWorkerWake } from './jobs.js';
import { notify } from './notify.js';

type Log = { info: (...a: any[]) => void; warn: (...a: any[]) => void; error: (...a: any[]) => void };

async function settingsOf(db: Db): Promise<OrgSettings> {
  return resolveSettings((await db.one(sql`SELECT settings FROM organizations WHERE id = ${db.orgId}`))?.settings);
}

/** Hourly maintenance per organization. Every notification is keyed so re-running a sweep never duplicates. */
export async function sweepOrg(db: Db, now = new Date()) {
  const s = await settingsOf(db);
  const today = now.toISOString().slice(0, 10);
  const week = `${now.getUTCFullYear()}-w${Math.floor((now.getTime() / 86400000 + 3) / 7)}`;
  // Review due soon / overdue -> owner. Documents are NOT auto-expired: they stay Published.
  const due = await db.q(sql`SELECT id, title, owner_id, next_review_date, (next_review_date < ${today}::date) AS overdue FROM documents
      WHERE status = 'published' AND owner_id IS NOT NULL AND next_review_date <= ${today}::date + ${s.reviewDueSoonDays}::int`);
  for (const d of due) {
    await notify(db, s, [d.owner_id], {
      type: d.overdue ? 'review_overdue' : 'review_due', title: `${d.overdue ? '【期限超過】' : ''}定期レビュー: ${d.title}（期限 ${d.next_review_date}）`,
      link: `/documents/${d.id}`, key: `reviewdue:${d.id}:${d.next_review_date}:${d.overdue ? 'over' : 'soon'}`,
    });
  }
  // Attestation reminders (weekly while overdue)
  const att = await db.q(sql`SELECT ua.user_id, ua.document_id, ua.id, v.title FROM user_attestations ua JOIN document_versions v ON v.id = ua.version_id
      WHERE ua.status = 'pending' AND ua.due_date < ${today}::date`);
  for (const a of att) await notify(db, s, [a.user_id], { type: 'attestation_overdue', title: `【期限超過】確認のお願い: ${a.title}`, link: `/documents/${a.document_id}`, key: `attover:${a.id}:${week}` });
  // Training reminders
  const tr = await db.q(sql`SELECT ta.id, ta.user_id, c.title FROM training_assignments ta JOIN courses c ON c.id = ta.course_id
      WHERE ta.status IN ('not_started','in_progress') AND ta.due_date < ${today}::date`);
  for (const t of tr) await notify(db, s, [t.user_id], { type: 'training_overdue', title: `【期限超過】研修: ${t.title}`, link: `/training/${t.id}`, key: `trover:${t.id}:${week}` });
  // External membership expiry: revoke sessions + one audit record per expiry
  const exp = await db.q(sql`SELECT u.id, u.name, u.external_expires_at FROM users u WHERE u.is_external AND u.external_expires_at <= now()
      AND NOT EXISTS (SELECT 1 FROM audit_events e WHERE e.action = 'external.expired' AND e.target_id = u.id::text AND e.detail->>'expiresAt' = to_json(u.external_expires_at)#>>'{}')`);
  for (const u of exp) {
    await db.exec(sql`UPDATE sessions SET revoked_at = now(), revoked_reason = 'external_expired' WHERE user_id = ${u.id} AND revoked_at IS NULL`);
    await db.exec(sql`INSERT INTO audit_events (org_id, actor_label, action, target_type, target_id, summary, detail)
      SELECT ${db.orgId}, 'system', 'external.expired', 'user', ${u.id}, ${`外部メンバー「${u.name}」の共有期間が終了`}, jsonb_build_object('expiresAt', to_json(external_expires_at)#>>'{}') FROM users WHERE id = ${u.id}`);
  }
  // Retention
  await db.exec(sql`DELETE FROM search_queries WHERE created_at < now() - make_interval(days => ${s.searchAnalytics.retentionDays})`);
  await db.exec(sql`DELETE FROM download_tokens WHERE expires_at < now() - interval '1 day'`);
  await db.exec(sql`DELETE FROM sessions WHERE expires_at < now() - interval '7 days'`);
  return { reviewDue: due.length, attestationOverdue: att.length, trainingOverdue: tr.length, externalExpired: exp.length };
}

async function sendEmails(db: Db, log: Log) {
  const rows = await db.q(sql`SELECT n.id, n.title, n.link, u.email FROM notifications n JOIN users u ON u.id = n.user_id
      WHERE n.email_status = 'pending' AND n.email_attempts < 5 ORDER BY n.created_at LIMIT 100 FOR UPDATE OF n SKIP LOCKED`);
  for (const r of rows) {
    try {
      // Only the title and an app link are sent — never document bodies.
      // Only 'log' delivery exists; a real mail transport is wired in here before sending to real users.
      log.info({ to: r.email.replace(/(.).*@/, '$1***@'), subject: `[Operate] ${r.title}` }, 'email (log mode)');
      await db.exec(sql`UPDATE notifications SET email_status = 'sent', email_attempts = email_attempts + 1 WHERE id = ${r.id}`);
    } catch (e: any) {
      await db.exec(sql`UPDATE notifications SET email_status = CASE WHEN email_attempts + 1 >= 5 THEN 'failed' ELSE 'pending' END, email_attempts = email_attempts + 1, email_last_error = ${String(e?.message ?? e).slice(0, 300)} WHERE id = ${r.id}`);
    }
  }
}

export async function runJob(job: { id: string; org_id: string; type: string; payload: any }) {
  await tx(job.org_id, async (db) => {
    if (job.type === 'publish') {
      const r = await publishVersion(db, null, job.payload.versionId);
      await audit(db, null, 'job.publish', { type: 'version', id: job.payload.versionId }, '指定日時の公開ジョブを実行', r);
    } else if (job.type === 'sweep') {
      await sweepOrg(db);
    }
  });
}

/** Claim + run due jobs (SKIP LOCKED: safe with several workers). Failed jobs retry with backoff up to 5 times. */
export async function runDueJobs(log: Log, max = 50) {
  let n = 0;
  for (; n < max; n++) {
    const [job] = await sys(sql`UPDATE jobs SET status = 'running', locked_at = now(), attempts = attempts + 1
        WHERE id = (SELECT id FROM jobs WHERE (status = 'queued' AND run_at <= now()) OR (status = 'running' AND locked_at < now() - interval '10 minutes')
                    ORDER BY run_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`);
    if (!job) break;
    try {
      await runJob(job);
      await sys(sql`UPDATE jobs SET status = 'done', finished_at = now(), last_error = NULL WHERE id = ${job.id}`);
    } catch (e: any) {
      log.error({ job: job.id, type: job.type, err: e?.message }, 'job failed');
      await sys(sql`UPDATE jobs SET status = CASE WHEN attempts >= 5 THEN 'failed' ELSE 'queued' END,
          run_at = now() + make_interval(secs => 30 * power(2, attempts)), last_error = ${String(e?.message ?? e).slice(0, 500)} WHERE id = ${job.id}`);
    }
  }
  return n;
}

export async function scheduleSweeps(now = new Date()) {
  const hour = now.toISOString().slice(0, 13);
  const orgs = await sys(sql`SELECT id FROM worker_org_ids()`);
  for (const o of orgs) {
    await sys(sql`INSERT INTO jobs (org_id, type, payload, idempotency_key) VALUES (${o.id}, 'sweep', '{}', ${`sweep:${o.id}:${hour}`}) ON CONFLICT DO NOTHING`);
  }
}

export function startWorker(log: Log) {
  let running = false;
  let timer: NodeJS.Timeout;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await scheduleSweeps();
      await runDueJobs(log);
      const orgs = await sys(sql`SELECT id FROM worker_org_ids()`);
      // EMAIL_MODE=off: leave notifications pending (nothing is delivered or marked sent).
      if (config.emailMode === 'log') for (const o of orgs) await tx(o.id, (db) => sendEmails(db, log));
    } catch (e: any) {
      log.error({ err: e?.message }, 'worker tick failed');
    } finally {
      running = false;
    }
  };
  setWorkerWake(() => setTimeout(tick, 50));
  timer = setInterval(tick, 15_000);
  setTimeout(tick, 1000);
  return () => clearInterval(timer);
}
