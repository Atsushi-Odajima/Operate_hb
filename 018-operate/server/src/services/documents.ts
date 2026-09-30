import type { Db } from '../db/pool.js';
import { canApproveForDept, docAccessible, docEditable, docReadable, has, type Actor } from '../lib/authz.js';
import { contentHash, normalizeContent, plainText, type Content } from '../lib/content.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { resolveSettings, type OrgSettings } from '../lib/settings.js';
import { createCampaign } from './attestations.js';
import { sql } from '../lib/sql.js';
import { audit } from './audit.js';
import { enqueue } from './jobs.js';
import { notify } from './notify.js';
import { reindexDocument } from './search.js';

export async function orgSettings(db: Db): Promise<OrgSettings> {
  const o = await db.one(sql`SELECT settings FROM organizations WHERE id = ${db.orgId}`);
  return resolveSettings(o?.settings);
}

export type DocMode = 'read' | 'access' | 'edit';

export async function getDoc(db: Db, a: Actor, id: string, mode: DocMode = 'access') {
  const cond = mode === 'read' ? docReadable(a) : mode === 'edit' ? docEditable(a) : docAccessible(a);
  const d = await db.one(sql`SELECT d.*, ${docEditable(a)} AS can_edit FROM documents d WHERE d.id = ${id} AND ${cond}`);
  if (!d) throw mode === 'edit' && (await db.one(sql`SELECT 1 FROM documents d WHERE d.id = ${id} AND ${docAccessible(a)}`)) ? forbidden() : notFound();
  return d;
}

export async function getVersion(db: Db, versionId: string) {
  const v = await db.one(sql`SELECT * FROM document_versions WHERE id = ${versionId}`);
  if (!v) throw notFound();
  return v;
}

export const versionLabel = (v: { major: number; minor: number }) => `${v.major}.${v.minor}`;

async function nextNumber(db: Db, documentId: string, changeType: string, base: { major: number; minor: number } | null) {
  if (!base) {
    const m = await db.one(sql`SELECT max(major * 100000 + minor) AS m FROM document_versions WHERE document_id = ${documentId}`);
    if (!m?.m) return { major: 1, minor: 0 };
    return { major: Math.floor(m.m / 100000), minor: (m.m % 100000) + 1 };
  }
  if (changeType === 'major') {
    const m = await db.one(sql`SELECT max(major) AS m FROM document_versions WHERE document_id = ${documentId}`);
    return { major: Math.max(base.major, m?.m ?? 0) + 1, minor: 0 };
  }
  const m = await db.one(sql`SELECT max(minor) AS m FROM document_versions WHERE document_id = ${documentId} AND major = ${base.major}`);
  return { major: base.major, minor: Math.max(base.minor, m?.m ?? 0) + 1 };
}

export interface DocInput {
  type: string;
  title: string;
  docNumber?: string | null;
  summary?: string;
  purpose?: string;
  scope?: string;
  category?: string;
  tags?: string[];
  classification?: string;
  departmentId?: string | null;
  ownerId?: string | null;
  audienceAll?: boolean;
  audiences?: Array<{ kind: string; target: string }>;
  reviewCycleDays?: number | null;
  requiresAttestation?: boolean;
  content?: unknown;
  templateId?: string | null;
  aiGenerated?: boolean;
}

export async function setAudiences(db: Db, documentId: string, audiences: Array<{ kind: string; target: string }>) {
  await db.exec(sql`DELETE FROM document_audiences WHERE document_id = ${documentId}`);
  for (const a of audiences) {
    await db.exec(sql`INSERT INTO document_audiences (org_id, document_id, kind, target) VALUES (${db.orgId}, ${documentId}, ${a.kind}, ${a.target}) ON CONFLICT DO NOTHING`);
  }
}

async function validateAudiences(db: Db, audiences: Array<{ kind: string; target: string }>) {
  for (const a of audiences) {
    const ok =
      a.kind === 'role'
        ? ['owner', 'knowledge_admin', 'approver', 'editor', 'trainer', 'member', 'auditor'].includes(a.target)
        : a.kind === 'department'
          ? await db.one(sql`SELECT 1 FROM departments WHERE id::text = ${a.target}`)
          : a.kind === 'team'
            ? await db.one(sql`SELECT 1 FROM teams WHERE id::text = ${a.target}`)
            : await db.one(sql`SELECT 1 FROM users WHERE id::text = ${a.target}`);
    if (!ok) throw badRequest(`配布先が見つかりません: ${a.kind}`);
  }
}

export async function createDocument(db: Db, a: Actor, input: DocInput, ip?: string) {
  if (!has(a, 'doc.create')) throw forbidden();
  if (input.departmentId && !has(a, 'doc.admin') && !a.deptIds.includes(input.departmentId)) throw forbidden('自分の所属部署の文書のみ作成できます');
  const typeSettings = a.settings.docTypes[input.type as keyof OrgSettings['docTypes']];
  if (!typeSettings) throw badRequest('文書種別が不正です');
  let rawContent = input.content;
  if (!rawContent && input.templateId) {
    const t = await db.one(sql`SELECT content FROM templates WHERE id = ${input.templateId}`);
    if (!t) throw notFound('テンプレートが見つかりません');
    rawContent = structuredClone(t.content); // copy: later template edits never change this document
  }
  const content = normalizeContent(rawContent ?? {});
  await validateAudiences(db, input.audiences ?? []);
  const d = await db.one(sql`
    INSERT INTO documents (org_id, doc_number, type, title, summary, purpose, scope, owner_id, department_id, category, tags, classification,
      audience_all, requires_attestation, review_cycle_days, created_by)
    VALUES (${db.orgId}, ${input.docNumber || null}, ${input.type}, ${input.title}, ${input.summary ?? ''}, ${input.purpose ?? ''}, ${input.scope ?? ''},
      ${input.ownerId ?? a.id}, ${input.departmentId ?? a.deptIds[0] ?? null}, ${input.category ?? ''}, ${input.tags ?? []}, ${input.classification ?? 'internal'},
      ${input.audienceAll ?? false}, ${input.requiresAttestation ?? typeSettings.requireAttestation}, ${input.reviewCycleDays === undefined ? typeSettings.reviewCycleDays : input.reviewCycleDays}, ${a.id})
    RETURNING *`);
  await setAudiences(db, d.id, input.audiences ?? []);
  const v = await insertVersion(db, a, d.id, { major: 1, minor: 0 }, input.title, content, 'normal', '初版', null, input.aiGenerated ?? false);
  await audit(db, a, 'document.create', { type: 'document', id: d.id }, `文書「${input.title}」を作成`, { type: input.type, classification: d.classification, aiGenerated: !!input.aiGenerated }, ip);
  return { document: d, version: v };
}

async function insertVersion(db: Db, a: Actor, documentId: string, num: { major: number; minor: number }, title: string, content: Content,
  changeType: string, changeSummary: string, basedOn: string | null, aiGenerated: boolean) {
  const hash = contentHash({ title, content, changeSummary, changeType });
  return db.one(sql`
    INSERT INTO document_versions (org_id, document_id, major, minor, status, change_type, change_summary, title, content, body_text, content_hash, author_id, based_on_version_id, ai_generated)
    VALUES (${db.orgId}, ${documentId}, ${num.major}, ${num.minor}, 'draft', ${changeType}, ${changeSummary}, ${title}, ${JSON.stringify(content)}, ${plainText(content)}, ${hash}, ${a.id}, ${basedOn}, ${aiGenerated})
    RETURNING *`);
}

/** Start a new draft from the current published version. The published version itself is never modified. */
export async function createRevision(db: Db, a: Actor, documentId: string, changeType: 'minor' | 'normal' | 'major', ip?: string) {
  const d = await getDoc(db, a, documentId, 'edit');
  if (['retired', 'archived'].includes(d.status)) throw conflict('廃止/アーカイブ済みの文書は改訂できません');
  const working = await db.one(sql`SELECT id FROM document_versions WHERE document_id = ${documentId} AND status IN ('draft','in_review','changes_requested','pending_approval','approved','scheduled')`);
  if (working) throw conflict('作業中の版が既にあります', { versionId: working.id });
  if (!d.current_version_id) throw conflict('公開済みの版がありません');
  const base = await getVersion(db, d.current_version_id);
  const num = await nextNumber(db, documentId, changeType, base);
  const v = await insertVersion(db, a, documentId, num, base.title, normalizeContent(base.content), changeType, '', base.id, false);
  await audit(db, a, 'version.create', { type: 'version', id: v.id }, `v${versionLabel(v)} の下書きを作成（元: v${versionLabel(base)}）`, { documentId, changeType }, ip);
  return v;
}

export interface DraftInput {
  title?: string;
  content?: unknown;
  changeSummary?: string;
  changeType?: 'minor' | 'normal' | 'major';
  editSeq: number;
  requireReattestation?: boolean;
}

/** Autosave / save. Optimistic concurrency via edit_seq: a stale editor gets 409 instead of overwriting. */
export async function saveDraft(db: Db, a: Actor, versionId: string, input: DraftInput) {
  const v = await db.one(sql`SELECT * FROM document_versions WHERE id = ${versionId} FOR UPDATE`);
  if (!v) throw notFound();
  await getDoc(db, a, v.document_id, 'edit');
  if (!['draft', 'changes_requested'].includes(v.status)) throw conflict('この版はレビュー/承認中または確定済みのため編集できません。新しい版を作成してください');
  if (v.edit_seq !== input.editSeq) {
    const who = await db.one(sql`SELECT name FROM users WHERE id = (SELECT actor_id FROM audit_events WHERE target_id = ${versionId} AND action = 'version.save' ORDER BY id DESC LIMIT 1)`);
    throw conflict('他の人がこの下書きを更新しました。最新の内容を読み込んでから編集してください', { editSeq: v.edit_seq, by: who?.name ?? null });
  }
  const title = input.title ?? v.title;
  const content = input.content !== undefined ? normalizeContent(input.content) : normalizeContent(v.content);
  const changeType = input.changeType ?? v.change_type;
  const changeSummary = input.changeSummary ?? v.change_summary;
  let num = { major: v.major, minor: v.minor };
  if (changeType !== v.change_type && v.based_on_version_id) {
    const base = await getVersion(db, v.based_on_version_id);
    num = await nextNumber(db, v.document_id, changeType, base);
    if (num.major === v.major && num.minor === v.minor + 1 && changeType !== 'major') num = { major: v.major, minor: v.minor };
  }
  const hash = contentHash({ title, content, changeSummary, changeType });
  const row = await db.one(sql`
    UPDATE document_versions SET title = ${title}, content = ${JSON.stringify(content)}, body_text = ${plainText(content)}, content_hash = ${hash},
      change_type = ${changeType}, change_summary = ${changeSummary}, major = ${num.major}, minor = ${num.minor},
      require_reattestation = ${input.requireReattestation ?? (changeType === 'major' ? true : v.require_reattestation)},
      edit_seq = edit_seq + 1, updated_at = now()
    WHERE id = ${versionId} RETURNING *`);
  await db.exec(sql`UPDATE documents SET updated_at = now() WHERE id = ${v.document_id}`);
  await audit(db, a, 'version.save', { type: 'version', id: versionId }, `v${versionLabel(row)} の下書きを保存`, { editSeq: row.edit_seq });
  return row;
}

/** Document.status derived from its versions (kept denormalized for listing/filtering). */
export async function syncDocStatus(db: Db, documentId: string) {
  const d = await db.one(sql`SELECT status, current_version_id FROM documents WHERE id = ${documentId}`);
  if (!d || ['retired', 'archived', 'superseded'].includes(d.status)) return;
  let status = 'draft';
  if (d.current_version_id) status = 'published';
  else {
    const w = await db.one(sql`SELECT status FROM document_versions WHERE document_id = ${documentId} ORDER BY created_at DESC LIMIT 1`);
    const map: Record<string, string> = { draft: 'draft', in_review: 'in_review', pending_approval: 'in_review', changes_requested: 'changes_requested', approved: 'approved', scheduled: 'scheduled' };
    status = map[w?.status] ?? 'draft';
  }
  await db.exec(sql`UPDATE documents SET status = ${status}, updated_at = now() WHERE id = ${documentId}`);
}

// ---------------------------------------------------------------------------------------------- workflow

export interface SubmitInput {
  reviewers: string[];
  approvalSteps?: Array<{ mode: 'any' | 'all'; approvers: string[] }>;
  publishMode: 'immediate' | 'scheduled' | 'manual';
  publishAt?: string | null;
  effectiveDate?: string | null;
}

async function loadUsersWithRoles(db: Db, ids: string[]) {
  return db.q(sql`SELECT u.id, u.name, u.status, u.is_external,
      coalesce((SELECT array_agg(role) FROM user_roles r WHERE r.user_id = u.id), '{}') AS roles,
      coalesce((SELECT array_agg(a.department_id::text) FROM approver_scopes a WHERE a.user_id = u.id), '{}') AS scopes,
      EXISTS (SELECT 1 FROM approver_scopes a WHERE a.user_id = u.id AND a.department_id IS NULL) AS scope_all
    FROM users u WHERE u.id = ANY(${ids}::uuid[])`);
}

export function approvalRequired(settings: OrgSettings, docType: string, aiGenerated: boolean) {
  // AI generated drafts ALWAYS require human approval, whatever the document type setting says.
  return aiGenerated || settings.docTypes[docType as keyof OrgSettings['docTypes']].requireApproval;
}

export async function submitVersion(db: Db, a: Actor, versionId: string, input: SubmitInput, ip?: string) {
  const v = await db.one(sql`SELECT * FROM document_versions WHERE id = ${versionId} FOR UPDATE`);
  if (!v) throw notFound();
  const d = await getDoc(db, a, v.document_id, 'edit');
  if (!['draft', 'changes_requested'].includes(v.status)) throw conflict('この版は提出済みです');
  if (a.settings.requireChangeSummary && v.based_on_version_id && !v.change_summary.trim()) throw badRequest('変更内容（changeSummary）を入力してください');
  if (input.publishMode === 'scheduled' && (!input.publishAt || new Date(input.publishAt) <= new Date())) throw badRequest('公開日時は未来の日時を指定してください');
  const required = approvalRequired(a.settings, d.type, v.ai_generated);
  const typeCfg = a.settings.docTypes[d.type as keyof OrgSettings['docTypes']];
  const steps = input.approvalSteps ?? [];
  if (required) {
    if (steps.length < 1 || steps.length > 3) throw badRequest('承認ステップを 1〜3 段で指定してください');
    if (steps.length < typeCfg.approvalSteps) throw badRequest(`この文書種別は ${typeCfg.approvalSteps} 段階の承認が必要です`);
    for (const s of steps) {
      if (!s.approvers.length) throw badRequest('各承認ステップに承認者を指定してください');
      const users = await loadUsersWithRoles(db, s.approvers);
      if (users.length !== new Set(s.approvers).size) throw badRequest('承認者が見つかりません');
      for (const u of users) {
        if (u.id === v.author_id) throw badRequest('作成者本人は承認者になれません');
        const ok = !u.is_external && u.status === 'active' &&
          canApproveForDept({ ...a, roles: u.roles, isExternal: false, approverScopes: [...u.scopes, ...(u.scope_all ? [null] : [])] }, d.department_id);
        if (!ok) throw badRequest(`${u.name} さんはこの文書の承認権限を持っていません`);
      }
    }
  }
  const reviewers = [...new Set(input.reviewers)];
  if (reviewers.length) {
    const users = await loadUsersWithRoles(db, reviewers);
    if (users.length !== reviewers.length || users.some((u) => u.is_external || u.status !== 'active' || !u.roles.some((r: string) => ['owner', 'knowledge_admin', 'approver', 'editor', 'trainer'].includes(r))))
      throw badRequest('レビュー担当者に指定できないユーザーが含まれています');
  }
  const round = v.review_round + 1;
  await db.exec(sql`UPDATE document_versions SET review_round = ${round}, submitted_at = now(), scheduled_publish_at = ${input.publishMode === 'scheduled' ? input.publishAt : null},
      effective_date = ${input.effectiveDate ?? null}, status = ${reviewers.length ? 'in_review' : 'pending_approval'}, updated_at = now() WHERE id = ${versionId}`);
  // Plan approval steps now (waiting), snapshot of the content hash being approved.
  for (let i = 0; i < (required ? steps.length : 0); i++) {
    const st = await db.one(sql`INSERT INTO approval_steps (org_id, version_id, round, step_no, mode, status, content_hash)
      VALUES (${db.orgId}, ${versionId}, ${round}, ${i + 1}, ${steps[i].mode}, 'waiting', ${v.content_hash}) RETURNING id`);
    for (const u of new Set(steps[i].approvers)) await db.exec(sql`INSERT INTO approval_step_approvers (org_id, step_id, approver_id) VALUES (${db.orgId}, ${st.id}, ${u})`);
  }
  await db.exec(sql`UPDATE document_versions SET publish_mode = ${input.publishMode} WHERE id = ${versionId}`);
  if (reviewers.length) {
    const rr = await db.one(sql`INSERT INTO review_requests (org_id, version_id, round, requested_by) VALUES (${db.orgId}, ${versionId}, ${round}, ${a.id}) RETURNING id`);
    for (const r of reviewers) await db.exec(sql`INSERT INTO review_assignments (org_id, review_id, reviewer_id) VALUES (${db.orgId}, ${rr.id}, ${r})`);
    await notify(db, a.settings, reviewers, { type: 'review_request', title: `レビュー依頼: ${v.title} v${versionLabel(v)}`, link: `/documents/${d.id}/review/${versionId}`, key: `review:${versionId}:${round}` });
  } else {
    await startApproval(db, a, versionId, round);
  }
  await syncDocStatus(db, d.id);
  await audit(db, a, 'version.submit', { type: 'version', id: versionId }, `v${versionLabel(v)} をレビュー/承認に提出`, { round, reviewers, steps: steps.length, publishMode: input.publishMode, contentHash: v.content_hash }, ip);
  return db.one(sql`SELECT * FROM document_versions WHERE id = ${versionId}`);
}

/** Activate step 1 (or finish if approval not required). */
async function startApproval(db: Db, a: Actor | null, versionId: string, round: number) {
  const v = await getVersion(db, versionId);
  const first = await db.one(sql`SELECT * FROM approval_steps WHERE version_id = ${versionId} AND round = ${round} ORDER BY step_no LIMIT 1`);
  if (!first) {
    await db.exec(sql`UPDATE document_versions SET status = 'approved', approved_at = now() WHERE id = ${versionId}`);
    await afterApproved(db, a, versionId);
    return;
  }
  await db.exec(sql`UPDATE document_versions SET status = 'pending_approval' WHERE id = ${versionId}`);
  await activateStep(db, first.id, v);
}

async function activateStep(db: Db, stepId: string, v: { id: string; title: string; major: number; minor: number; document_id: string; org_id: string }) {
  await db.exec(sql`UPDATE approval_steps SET status = 'active' WHERE id = ${stepId}`);
  const approvers = await db.q(sql`SELECT approver_id FROM approval_step_approvers WHERE step_id = ${stepId} AND active`);
  await notify(db, await orgSettings(db), approvers.map((x) => x.approver_id), {
    type: 'approval_request', title: `承認依頼: ${v.title} v${versionLabel(v)}`, link: `/documents/${v.document_id}/review/${v.id}`, key: `approval:${stepId}`,
  });
}

export async function reviewDecision(db: Db, a: Actor, versionId: string, decision: 'approved' | 'changes_requested', comment: string, ip?: string) {
  const v = await db.one(sql`SELECT * FROM document_versions WHERE id = ${versionId} FOR UPDATE`);
  if (!v) throw notFound();
  const rr = await db.one(sql`SELECT * FROM review_requests WHERE version_id = ${versionId} AND round = ${v.review_round} AND status = 'open'`);
  const ra = rr && (await db.one(sql`SELECT * FROM review_assignments WHERE review_id = ${rr.id} AND reviewer_id = ${a.id}`));
  if (!ra) throw notFound('レビュー依頼が見つかりません');
  if (ra.status !== 'pending') return { alreadyDecided: true, status: ra.status };
  await db.exec(sql`UPDATE review_assignments SET status = ${decision}, comment = ${comment}, decided_at = now() WHERE id = ${ra.id}`);
  if (comment.trim()) {
    await db.exec(sql`INSERT INTO review_comments (org_id, version_id, content_hash, round, author_id, section, body) VALUES (${db.orgId}, ${versionId}, ${v.content_hash}, ${v.review_round}, ${a.id}, '', ${comment})`);
  }
  if (decision === 'changes_requested') {
    await db.exec(sql`UPDATE review_requests SET status = 'changes_requested', completed_at = now() WHERE id = ${rr.id}`);
    await db.exec(sql`UPDATE approval_steps SET status = 'cancelled' WHERE version_id = ${versionId} AND round = ${v.review_round}`);
    await db.exec(sql`UPDATE document_versions SET status = 'changes_requested' WHERE id = ${versionId}`);
    if (v.author_id) await notify(db, a.settings, [v.author_id], { type: 'changes_requested', title: `修正依頼: ${v.title}`, link: `/documents/${v.document_id}/edit`, key: `changes:${versionId}:${v.review_round}:review` });
  } else {
    const pending = await db.one(sql`SELECT count(*)::int AS n FROM review_assignments WHERE review_id = ${rr.id} AND status = 'pending'`);
    if (!pending.n) {
      await db.exec(sql`UPDATE review_requests SET status = 'completed', completed_at = now() WHERE id = ${rr.id}`);
      await startApproval(db, a, versionId, v.review_round);
    }
  }
  await syncDocStatus(db, v.document_id);
  await audit(db, a, 'review.decision', { type: 'version', id: versionId }, `レビュー: ${decision === 'approved' ? '確認完了' : '修正依頼'}`, { round: v.review_round, contentHash: v.content_hash }, ip);
  return { status: decision };
}

export async function approvalDecision(db: Db, a: Actor, versionId: string, decision: 'approved' | 'rejected' | 'changes_requested', comment: string, seenHash: string, ip?: string) {
  const v = await db.one(sql`SELECT * FROM document_versions WHERE id = ${versionId} FOR UPDATE`);
  if (!v) throw notFound();
  const step = await db.one(sql`SELECT st.* FROM approval_steps st JOIN approval_step_approvers sa ON sa.step_id = st.id
     WHERE st.version_id = ${versionId} AND st.round = ${v.review_round} AND sa.approver_id = ${a.id} AND sa.active ORDER BY st.step_no`);
  if (!step) throw notFound('承認依頼が見つかりません');
  const prior = await db.one(sql`SELECT * FROM approvals WHERE step_id = ${step.id} AND approver_id = ${a.id}`);
  if (prior) return { duplicate: true, approval: prior }; // idempotent re-send
  if (step.status !== 'active' || v.status !== 'pending_approval') throw conflict('現在この承認ステップは受付中ではありません');
  if (seenHash !== v.content_hash || step.content_hash !== v.content_hash) throw conflict('表示中の内容と現在の内容が一致しません。再読み込みしてから承認してください');
  if (v.author_id === a.id) throw forbidden('作成者本人は承認できません');
  const ap = await db.one(sql`INSERT INTO approvals (org_id, version_id, step_id, approver_id, decision, comment, content_hash)
     VALUES (${db.orgId}, ${versionId}, ${step.id}, ${a.id}, ${decision}, ${comment}, ${v.content_hash}) RETURNING *`);
  if (decision === 'approved') {
    const remaining = step.mode === 'all'
      ? (await db.one(sql`SELECT count(*)::int AS n FROM approval_step_approvers sa WHERE sa.step_id = ${step.id} AND sa.active
            AND NOT EXISTS (SELECT 1 FROM approvals x WHERE x.step_id = sa.step_id AND x.approver_id = sa.approver_id AND x.decision = 'approved')`)).n
      : 0;
    if (!remaining) {
      await db.exec(sql`UPDATE approval_steps SET status = 'approved', decided_at = now() WHERE id = ${step.id}`);
      const next = await db.one(sql`SELECT * FROM approval_steps WHERE version_id = ${versionId} AND round = ${v.review_round} AND step_no > ${step.step_no} ORDER BY step_no LIMIT 1`);
      if (next) await activateStep(db, next.id, v);
      else {
        await db.exec(sql`UPDATE document_versions SET status = 'approved', approved_at = now() WHERE id = ${versionId}`);
        await afterApproved(db, a, versionId);
      }
    }
  } else {
    await db.exec(sql`UPDATE approval_steps SET status = CASE WHEN id = ${step.id} THEN ${decision} ELSE 'cancelled' END, decided_at = now()
       WHERE version_id = ${versionId} AND round = ${v.review_round} AND status IN ('waiting','active')`);
    await db.exec(sql`UPDATE document_versions SET status = ${decision === 'rejected' ? 'rejected' : 'changes_requested'} WHERE id = ${versionId}`);
    if (v.author_id) await notify(db, a.settings, [v.author_id], { type: decision, title: `${decision === 'rejected' ? '却下' : '修正依頼'}: ${v.title}`, link: `/documents/${v.document_id}`, key: `${decision}:${versionId}:${v.review_round}` });
  }
  await syncDocStatus(db, v.document_id);
  await audit(db, a, 'approval.decision', { type: 'version', id: versionId }, `承認ステップ${step.step_no}: ${decision}`, { step: step.step_no, round: v.review_round, contentHash: v.content_hash, decision }, ip);
  return { approval: ap };
}

export async function reassignApprover(db: Db, a: Actor, versionId: string, fromUser: string, toUser: string, reason: string, ip?: string) {
  if (!has(a, 'doc.admin')) throw forbidden();
  const v = await getVersion(db, versionId);
  const d = await db.one(sql`SELECT * FROM documents WHERE id = ${v.document_id}`);
  const sa = await db.one(sql`SELECT sa.* FROM approval_step_approvers sa JOIN approval_steps st ON st.id = sa.step_id
     WHERE st.version_id = ${versionId} AND st.round = ${v.review_round} AND sa.approver_id = ${fromUser} AND sa.active AND st.status IN ('waiting','active')`);
  if (!sa) throw notFound('再割当できる承認者が見つかりません');
  const [u] = await loadUsersWithRoles(db, [toUser]);
  if (!u || u.id === v.author_id || !canApproveForDept({ ...a, roles: u.roles, isExternal: u.is_external, approverScopes: [...u.scopes, ...(u.scope_all ? [null] : [])] }, d.department_id))
    throw badRequest('指定したユーザーは承認者にできません');
  await db.exec(sql`UPDATE approval_step_approvers SET active = false, reassigned_to = ${toUser}, reassigned_by = ${a.id}, reassigned_at = now(), reassign_reason = ${reason} WHERE id = ${sa.id}`);
  await db.exec(sql`INSERT INTO approval_step_approvers (org_id, step_id, approver_id) VALUES (${db.orgId}, ${sa.step_id}, ${toUser}) ON CONFLICT DO NOTHING`);
  const st = await db.one(sql`SELECT status FROM approval_steps WHERE id = ${sa.step_id}`);
  if (st.status === 'active') await notify(db, a.settings, [toUser], { type: 'approval_request', title: `承認依頼: ${v.title} v${versionLabel(v)}`, link: `/documents/${v.document_id}/review/${versionId}`, key: `approval:${sa.step_id}` });
  await audit(db, a, 'approval.reassign', { type: 'version', id: versionId }, '承認者を再割当', { from: fromUser, to: toUser, reason }, ip);
}

export async function withdrawVersion(db: Db, a: Actor, versionId: string, ip?: string) {
  const v = await db.one(sql`SELECT * FROM document_versions WHERE id = ${versionId} FOR UPDATE`);
  if (!v) throw notFound();
  await getDoc(db, a, v.document_id, 'edit');
  if (!['in_review', 'pending_approval', 'approved', 'scheduled'].includes(v.status)) throw conflict('取り下げできる状態ではありません');
  await db.exec(sql`UPDATE review_requests SET status = 'cancelled' WHERE version_id = ${versionId} AND status = 'open'`);
  await db.exec(sql`UPDATE approval_steps SET status = 'cancelled' WHERE version_id = ${versionId} AND status IN ('waiting','active')`);
  // Back to editable draft; any later content change produces a new hash so earlier approvals can never be reused.
  await db.exec(sql`UPDATE document_versions SET status = 'changes_requested', scheduled_publish_at = NULL WHERE id = ${versionId}`);
  await syncDocStatus(db, v.document_id);
  await audit(db, a, 'version.withdraw', { type: 'version', id: versionId }, `v${versionLabel(v)} を取り下げ`, {}, ip);
}

async function afterApproved(db: Db, a: Actor | null, versionId: string) {
  const v = await getVersion(db, versionId);
  if (v.publish_mode === 'manual') return;
  if (v.scheduled_publish_at && new Date(v.scheduled_publish_at) > new Date()) {
    await db.exec(sql`UPDATE document_versions SET status = 'scheduled' WHERE id = ${versionId}`);
    await enqueue(db, 'publish', { versionId }, `publish:${versionId}`, v.scheduled_publish_at);
    return;
  }
  await publishVersion(db, a, versionId);
}

/** Verify that every approval step of the latest round approved exactly this content hash. */
export async function verifyApprovals(db: Db, v: { id: string; review_round: number; content_hash: string; document_id: string; ai_generated: boolean }, settings: OrgSettings) {
  const d = await db.one(sql`SELECT type FROM documents WHERE id = ${v.document_id}`);
  const steps = await db.q(sql`SELECT * FROM approval_steps WHERE version_id = ${v.id} AND round = ${v.review_round} ORDER BY step_no`);
  if (!steps.length) return !approvalRequired(settings, d.type, v.ai_generated);
  for (const st of steps) {
    if (st.status !== 'approved' || st.content_hash !== v.content_hash) return false;
    const aps = await db.q(sql`SELECT content_hash FROM approvals WHERE step_id = ${st.id} AND decision = 'approved'`);
    if (!aps.length || aps.some((x) => x.content_hash !== v.content_hash)) return false;
  }
  return true;
}

/**
 * Publish (idempotent). Called on final approval, by the scheduled publish job, or manually by a Knowledge Admin.
 * Re-running for an already-published version is a no-op (no duplicate notifications / attestations).
 */
export async function publishVersion(db: Db, a: Actor | null, versionId: string, ip?: string) {
  const v = await db.one(sql`SELECT * FROM document_versions WHERE id = ${versionId} FOR UPDATE`);
  if (!v) throw notFound();
  if (v.status === 'published' || v.status === 'superseded') return { alreadyPublished: true };
  if (!['approved', 'scheduled'].includes(v.status)) throw conflict('承認済みの版のみ公開できます');
  const d = await db.one(sql`SELECT * FROM documents WHERE id = ${v.document_id} FOR UPDATE`);
  const settings = await orgSettings(db);
  if (!(await verifyApprovals(db, v, settings))) throw conflict('承認時の内容と一致しないため公開できません（承認が無効です）');
  if (['retired', 'archived'].includes(d.status)) throw conflict('廃止/アーカイブ済みの文書です');
  const prev = d.current_version_id;
  if (prev) await db.exec(sql`UPDATE document_versions SET status = 'superseded', superseded_at = now() WHERE id = ${prev} AND status = 'published'`);
  await db.exec(sql`UPDATE document_versions SET status = 'published', published_at = now() WHERE id = ${versionId}`);
  const cycle = d.review_cycle_days;
  await db.exec(sql`UPDATE documents SET current_version_id = ${versionId}, status = 'published', title = ${v.title},
      effective_date = coalesce(${v.effective_date}::date, current_date), last_reviewed_at = now(),
      next_review_date = CASE WHEN ${cycle}::int IS NULL THEN NULL ELSE current_date + ${cycle}::int END, updated_at = now()
    WHERE id = ${d.id}`);
  await reindexDocument(db, d.id);
  // "replaces" relation: the replaced documents become Superseded and leave search / AI retrieval.
  const replaced = await db.q(sql`SELECT to_document_id FROM document_relations WHERE from_document_id = ${d.id} AND kind = 'replaces'`);
  for (const r of replaced) {
    await db.exec(sql`UPDATE documents SET status = 'superseded', updated_at = now() WHERE id = ${r.to_document_id} AND status = 'published'`);
    await reindexDocument(db, r.to_document_id);
    await warnDependents(db, settings, r.to_document_id, '置き換えられました');
  }
  const audienceIds = await audienceUserIds(db, d.id, settings);
  const label = versionLabel(v);
  await notify(db, settings, audienceIds, {
    type: v.change_type === 'major' ? 'major_change' : 'published',
    title: `${v.change_type === 'major' ? '【重要変更】' : ''}${v.title} v${label} が公開されました`,
    link: `/documents/${d.id}`,
    key: `publish:${versionId}`,
  });
  // First publication of an attestation-required document, or any version flagged for re-attestation (default for Major).
  // Earlier acknowledgements are version-bound and are never carried over.
  if ((prev === null && d.requires_attestation) || v.require_reattestation) {
    await createCampaign(db, settings, a, { documentId: d.id, versionId, dueDays: settings.attestation.defaultDueDays, reason: v.change_type === 'major' ? '重要変更の再確認' : '確認依頼' });
  }
  await audit(db, a, 'version.publish', { type: 'version', id: versionId }, `「${v.title}」v${label} を公開`, { documentId: d.id, previous: prev, contentHash: v.content_hash, changeType: v.change_type }, ip);
  return { published: true };
}

/** Users who can read the document's published version (used for notifications and attestation assignment). */
export async function audienceUserIds(db: Db, documentId: string, settings: OrgSettings): Promise<string[]> {
  const rows = await db.q(sql`
    SELECT u.id FROM users u, documents d
     WHERE d.id = ${documentId} AND u.status = 'active' AND (
       (NOT u.is_external AND (
          (d.audience_all AND d.classification <> 'restricted') OR d.owner_id = u.id
          OR EXISTS (SELECT 1 FROM document_audiences da WHERE da.document_id = d.id AND (
               (da.kind = 'user' AND da.target = u.id::text)
            OR (da.kind = 'role' AND EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.role = da.target))
            OR (da.kind = 'department' AND EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id AND m.department_id::text = da.target))
            OR (da.kind = 'team' AND EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id AND m.team_id::text = da.target))))))
       OR (u.is_external AND u.external_expires_at > now() AND d.classification = ANY(${settings.classification.externalAllowed}::text[])
          AND EXISTS (SELECT 1 FROM document_audiences da WHERE da.document_id = d.id AND (
               (da.kind = 'user' AND da.target = u.id::text)
            OR (da.kind = 'department' AND EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id AND m.department_id::text = da.target))))))`);
  return rows.map((r) => r.id);
}

/** Warn owners of documents that reference a document that was retired / superseded. */
export async function warnDependents(db: Db, settings: OrgSettings, documentId: string, what: string) {
  const deps = await db.q(sql`SELECT DISTINCT d.id, d.title, d.owner_id, t.title AS target_title FROM document_relations r
      JOIN documents d ON d.id = r.from_document_id JOIN documents t ON t.id = r.to_document_id
     WHERE r.to_document_id = ${documentId} AND r.kind IN ('related','dependsOn','derivedFrom') AND d.owner_id IS NOT NULL AND d.status NOT IN ('retired','archived')`);
  for (const x of deps) {
    await notify(db, settings, [x.owner_id], { type: 'relation_warning', title: `参照先「${x.target_title}」が${what}: ${x.title} を確認してください`, link: `/documents/${x.id}`, key: `relwarn:${documentId}:${x.id}:${what}` });
  }
  return deps.length;
}

export async function retireDocument(db: Db, a: Actor, documentId: string, reason: string, ip?: string) {
  const d = await getDoc(db, a, documentId, 'edit');
  if (!has(a, 'doc.admin') && d.owner_id !== a.id) throw forbidden('廃止は文書オーナーまたはナレッジ管理者が行えます');
  if (d.status === 'retired') return;
  await db.exec(sql`UPDATE documents SET status = 'retired', retired_at = now(), retire_date = current_date, updated_at = now() WHERE id = ${documentId}`);
  await db.exec(sql`UPDATE user_attestations SET status = 'cancelled' WHERE document_id = ${documentId} AND status = 'pending'`);
  await reindexDocument(db, documentId);
  await warnDependents(db, a.settings, documentId, '廃止されました');
  await audit(db, a, 'document.retire', { type: 'document', id: documentId }, `「${d.title}」を廃止`, { reason }, ip);
}

/** Relation graph helpers */
export async function relationWouldCycle(db: Db, from: string, to: string, kind: string): Promise<boolean> {
  if (kind !== 'dependsOn' && kind !== 'replaces' && kind !== 'derivedFrom') return false;
  const r = await db.one(sql`
    WITH RECURSIVE walk(id, depth) AS (
      SELECT ${to}::uuid, 0
      UNION
      SELECT r.to_document_id, w.depth + 1 FROM document_relations r JOIN walk w ON r.from_document_id = w.id
       WHERE r.kind = ${kind} AND w.depth < 50)
    SELECT 1 AS hit FROM walk WHERE id = ${from}::uuid LIMIT 1`);
  return !!r;
}

/** Documents affected if this document changes (reverse dependsOn / related / derivedFrom, transitive for dependsOn). */
export async function impactOf(db: Db, a: Actor, documentId: string) {
  return db.q(sql`
    WITH RECURSIVE up(id, kind, depth) AS (
      SELECT r.from_document_id, r.kind, 1 FROM document_relations r WHERE r.to_document_id = ${documentId}
      UNION
      SELECT r.from_document_id, r.kind, u.depth + 1 FROM document_relations r JOIN up u ON r.to_document_id = u.id
       WHERE r.kind = 'dependsOn' AND u.depth < 5)
    SELECT DISTINCT d.id, d.title, d.doc_number, d.status, up.kind, up.depth
      FROM up JOIN documents d ON d.id = up.id WHERE ${docAccessible(a)} ORDER BY up.depth, d.title`);
}

export async function reviewConfirmNoChange(db: Db, a: Actor, documentId: string, note: string, ip?: string) {
  const d = await getDoc(db, a, documentId, 'access');
  if (!(d.can_edit || has(a, 'doc.admin') || d.owner_id === a.id)) throw forbidden();
  if (d.status !== 'published') throw conflict('公開中の文書のみ定期レビューを記録できます');
  await db.exec(sql`UPDATE documents SET last_reviewed_at = now(),
      next_review_date = CASE WHEN review_cycle_days IS NULL THEN NULL ELSE current_date + review_cycle_days END, updated_at = now() WHERE id = ${documentId}`);
  await audit(db, a, 'document.review_confirmed', { type: 'document', id: documentId }, `定期レビュー: 変更なしで再確認`, { note, previousDue: d.next_review_date }, ip);
  return db.one(sql`SELECT id, next_review_date, last_reviewed_at FROM documents WHERE id = ${documentId}`);
}
