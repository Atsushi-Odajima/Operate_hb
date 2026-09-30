import type { Db } from '../db/pool.js';
import { docReadable, has, type Actor } from '../lib/authz.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import type { OrgSettings } from '../lib/settings.js';
import { sql } from '../lib/sql.js';
import { audit } from './audit.js';
import { audienceUserIds } from './documents.js';
import { notify } from './notify.js';

/**
 * Attestation = "読んで確認しました" bound to ONE document version.
 * - Acknowledging v1 never counts for v2 (records are keyed by version).
 * - Opening the page is not acknowledgement: the user must reach the end (if required) and press the button.
 * - This records that the user declared they read it; it does not prove understanding (UI says so).
 */
export async function createCampaign(db: Db, settings: OrgSettings, a: Pick<Actor, 'id' | 'name'> | null,
  input: { documentId: string; versionId: string; dueDays?: number; dueDate?: string | null; reason: string; userIds?: string[] }) {
  const due = input.dueDate ?? new Date(Date.now() + (input.dueDays ?? settings.attestation.defaultDueDays) * 86400000).toISOString().slice(0, 10);
  const c = await db.one(sql`INSERT INTO attestation_campaigns (org_id, document_id, version_id, due_date, reason, require_scroll, created_by)
      VALUES (${db.orgId}, ${input.documentId}, ${input.versionId}, ${due}, ${input.reason}, ${settings.attestation.requireScroll}, ${a?.id ?? null})
      ON CONFLICT (version_id) DO NOTHING RETURNING *`);
  const campaign = c ?? (await db.one(sql`SELECT * FROM attestation_campaigns WHERE version_id = ${input.versionId}`));
  // Older pending acknowledgements for this document are no longer meaningful: the new version must be confirmed.
  await db.exec(sql`UPDATE user_attestations SET status = 'cancelled' WHERE document_id = ${input.documentId} AND version_id <> ${input.versionId} AND status = 'pending'`);
  const audience = await audienceUserIds(db, input.documentId, settings);
  const targets = input.userIds ? input.userIds.filter((u) => audience.includes(u)) : audience;
  if (targets.length) {
    await db.exec(sql`INSERT INTO user_attestations (org_id, campaign_id, document_id, version_id, user_id, due_date)
      SELECT ${db.orgId}, ${campaign.id}, ${input.documentId}, ${input.versionId}, u, ${due}::date FROM unnest(${targets}::uuid[]) u
      ON CONFLICT (campaign_id, user_id) DO NOTHING`);
    const v = await db.one(sql`SELECT title, major, minor FROM document_versions WHERE id = ${input.versionId}`);
    await notify(db, settings, targets, { type: 'attestation', title: `確認のお願い: ${v.title} v${v.major}.${v.minor}（期限 ${due}）`, link: `/documents/${input.documentId}`, key: `attest:${input.versionId}` });
  }
  if (c) await audit(db, a, 'attestation.campaign', { type: 'version', id: input.versionId }, `確認依頼を配布（${targets.length}名）`, { documentId: input.documentId, due, reason: input.reason });
  return { campaign, assigned: targets.length };
}

async function mine(db: Db, a: Actor, id: string) {
  const r = await db.one(sql`SELECT ua.*, c.require_scroll FROM user_attestations ua JOIN attestation_campaigns c ON c.id = ua.campaign_id
      WHERE ua.id = ${id} AND ua.user_id = ${a.id}`);
  if (!r) throw notFound();
  return r;
}

export async function markProgress(db: Db, a: Actor, id: string, what: 'viewed' | 'reached_end') {
  const r = await mine(db, a, id);
  if (r.status !== 'pending') return r;
  if (what === 'viewed') await db.exec(sql`UPDATE user_attestations SET viewed_at = coalesce(viewed_at, now()) WHERE id = ${id}`);
  else await db.exec(sql`UPDATE user_attestations SET viewed_at = coalesce(viewed_at, now()), reached_end_at = coalesce(reached_end_at, now()) WHERE id = ${id}`);
  return mine(db, a, id);
}

export async function acknowledge(db: Db, a: Actor, id: string, ip?: string) {
  const r = await mine(db, a, id);
  if (r.status === 'acknowledged') return r; // idempotent
  if (r.status !== 'pending') throw conflict('この確認依頼は終了しています');
  // Must still be allowed to read the document and the version must still be the current one.
  const d = await db.one(sql`SELECT d.current_version_id FROM documents d WHERE d.id = ${r.document_id} AND ${docReadable(a)}`);
  if (!d) throw notFound();
  if (d.current_version_id !== r.version_id) throw conflict('新しい版が公開されています。最新版を確認してください');
  if (!r.viewed_at) throw badRequest('本文を開いてから確認してください');
  if (r.require_scroll && !r.reached_end_at) throw badRequest('最後まで読んでから確認してください');
  await db.exec(sql`UPDATE user_attestations SET status = 'acknowledged', acknowledged_at = now() WHERE id = ${id} AND status = 'pending'`);
  await audit(db, a, 'attestation.acknowledge', { type: 'version', id: r.version_id }, '内容を確認しました', { attestationId: id }, ip);
  return mine(db, a, id);
}

export async function waive(db: Db, a: Actor, id: string, reason: string, ip?: string) {
  if (!has(a, 'attestation.manage')) throw forbidden();
  if (!reason.trim()) throw badRequest('免除理由を入力してください');
  const r = await db.one(sql`SELECT * FROM user_attestations WHERE id = ${id}`);
  if (!r) throw notFound();
  if (r.status !== 'pending') throw conflict('未確認の依頼のみ免除できます');
  await db.exec(sql`UPDATE user_attestations SET status = 'waived', waived_by = ${a.id}, waived_reason = ${reason} WHERE id = ${id}`);
  await audit(db, a, 'attestation.waive', { type: 'user_attestation', id }, '確認依頼を免除', { userId: r.user_id, versionId: r.version_id, reason }, ip);
}
