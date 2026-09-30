import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { api, idParams, zDate, zId, zPage } from '../http.js';
import { canDownload, canOffline, canSeeHistory, CLASSIFICATIONS, docAccessible, docEditable, docReadable, docWorkflowParticipant, has, need, type Actor } from '../lib/authz.js';
import { normalizeContent } from '../lib/content.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { and, raw, sql, type SQL } from '../lib/sql.js';
import type { Db } from '../db/pool.js';
import { audit } from '../services/audit.js';
import {
  approvalDecision, createDocument, createRevision, getDoc, impactOf, publishVersion, reassignApprover, relationWouldCycle,
  retireDocument, reviewConfirmNoChange, reviewDecision, saveDraft, setAudiences, submitVersion, versionLabel, withdrawVersion,
} from '../services/documents.js';
import { reindexDocument } from '../services/search.js';

const docTypes = z.enum(['sop', 'policy', 'guide', 'faq', 'checklist', 'template', 'reference']);
const audience = z.object({ kind: z.enum(['department', 'team', 'role', 'user']), target: z.string().min(1).max(64) });
const meta = {
  docNumber: z.string().trim().max(40).nullable().optional(),
  summary: z.string().max(1000).optional(),
  purpose: z.string().max(2000).optional(),
  scope: z.string().max(2000).optional(),
  category: z.string().max(100).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
  classification: z.enum(CLASSIFICATIONS).optional(),
  departmentId: zId.nullable().optional(),
  ownerId: zId.nullable().optional(),
  audienceAll: z.boolean().optional(),
  audiences: z.array(audience).max(200).optional(),
  reviewCycleDays: z.number().int().min(1).max(3650).nullable().optional(),
  requiresAttestation: z.boolean().optional(),
};

/** Access check for a specific version: current published version needs read; other versions need history rights. */
export async function versionForActor(db: Db, a: Actor, versionId: string) {
  const v = await db.one(sql`SELECT * FROM document_versions WHERE id = ${versionId}`);
  if (!v) throw notFound();
  const d = await db.one(sql`SELECT d.*, ${docEditable(a)} AS can_edit, ${docReadable(a)} AS can_read, ${docWorkflowParticipant(a)} AS participant
      FROM documents d WHERE d.id = ${v.document_id} AND ${docAccessible(a)}`);
  if (!d) throw notFound();
  const isCurrentPublished = d.current_version_id === v.id && d.status === 'published';
  const ok = (isCurrentPublished && d.can_read) || canSeeHistory(a, d.can_edit) || (d.participant && ['in_review', 'pending_approval', 'approved', 'scheduled'].includes(v.status));
  if (!ok) throw notFound();
  return { v, d };
}

function lineDiff(a: string, b: string) {
  const A = a.split('\n').slice(0, 3000);
  const B = b.split('\n').slice(0, 3000);
  const n = A.length, m = B.length;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: Array<{ op: ' ' | '+' | '-'; text: string }> = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ op: ' ', text: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ op: '-', text: A[i++] });
    else out.push({ op: '+', text: B[j++] });
  }
  while (i < n) out.push({ op: '-', text: A[i++] });
  while (j < m) out.push({ op: '+', text: B[j++] });
  return out;
}

export default async function documentRoutes(app: FastifyInstance) {
  api(app, 'GET', '/api/documents', {
    query: zPage.extend({
      view: z.enum(['published', 'work', 'all']).default('published'),
      type: docTypes.optional(), departmentId: zId.optional(), status: z.string().max(30).optional(), q: z.string().max(200).optional(),
      classification: z.enum(CLASSIFICATIONS).optional(), reviewDue: z.enum(['soon', 'overdue']).optional(),
    }),
  }, async ({ db, actor, query }) => {
    const conds: SQL[] = [];
    if (query.view === 'published') conds.push(docReadable(actor), raw(`d.status = 'published'`));
    else if (query.view === 'work') conds.push(docEditable(actor), raw(`d.status NOT IN ('archived')`));
    else { need(actor, 'doc.readAll'); }
    if (query.type) conds.push(sql`d.type = ${query.type}`);
    if (query.departmentId) conds.push(sql`d.department_id = ${query.departmentId}::uuid`);
    if (query.status) conds.push(sql`d.status = ${query.status}`);
    if (query.classification) conds.push(sql`d.classification = ${query.classification}`);
    if (query.q) conds.push(sql`(d.title ILIKE ${'%' + query.q.replace(/[\\%_]/g, '\\$&') + '%'} OR d.doc_number ILIKE ${'%' + query.q.replace(/[\\%_]/g, '\\$&') + '%'})`);
    if (query.reviewDue === 'overdue') conds.push(raw(`d.status = 'published' AND d.next_review_date < current_date`));
    if (query.reviewDue === 'soon') conds.push(sql`d.status = 'published' AND d.next_review_date BETWEEN current_date AND current_date + ${actor.settings.reviewDueSoonDays}::int`);
    const rows = await db.q(sql`
      SELECT d.id, d.doc_number, d.type, d.title, d.summary, d.status, d.classification, d.department_id, dep.name AS department_name,
             d.owner_id, u.name AS owner_name, d.category, d.tags, d.next_review_date, d.effective_date, d.updated_at,
             cv.major AS cur_major, cv.minor AS cur_minor,
             wv.id AS working_version_id, wv.status AS working_status, wv.major AS w_major, wv.minor AS w_minor,
             count(*) OVER() AS total
        FROM documents d
        LEFT JOIN departments dep ON dep.id = d.department_id
        LEFT JOIN users u ON u.id = d.owner_id
        LEFT JOIN document_versions cv ON cv.id = d.current_version_id
        LEFT JOIN LATERAL (SELECT id, status, major, minor FROM document_versions x WHERE x.document_id = d.id
             AND x.status IN ('draft','in_review','changes_requested','pending_approval','approved','scheduled') AND ${query.view !== 'published'} LIMIT 1) wv ON true
       WHERE ${and(conds)}
       ORDER BY d.updated_at DESC LIMIT ${query.limit} OFFSET ${query.offset}`);
    return {
      total: rows[0]?.total ?? 0,
      items: rows.map(({ total: _t, ...r }) => ({
        ...r,
        version: r.cur_major != null ? `${r.cur_major}.${r.cur_minor}` : null,
        workingVersion: r.working_version_id ? { id: r.working_version_id, status: r.working_status, version: `${r.w_major}.${r.w_minor}` } : null,
      })),
    };
  });

  api(app, 'POST', '/api/documents', {
    body: z.object({ type: docTypes, title: z.string().trim().min(1).max(200), templateId: zId.nullable().optional(), content: z.unknown().optional(), ...meta }),
  }, async ({ db, actor, body, ip }) => {
    const r = await createDocument(db, actor, body, ip);
    return { id: r.document.id, versionId: r.version.id };
  });

  api(app, 'GET', '/api/documents/:id', { params: idParams }, async ({ db, actor, params }) => {
    const d = await getDoc(db, actor, params.id, 'access');
    const readable = !!(await db.one(sql`SELECT 1 FROM documents d WHERE d.id = ${params.id} AND ${docReadable(actor)}`));
    const current = d.current_version_id && readable ? await db.one(sql`SELECT * FROM document_versions WHERE id = ${d.current_version_id}`) : null;
    const participant = !!(await db.one(sql`SELECT 1 FROM documents d WHERE d.id = ${params.id} AND ${docWorkflowParticipant(actor)}`));
    const working = d.can_edit || participant || has(actor, 'doc.readAll')
      ? await db.one(sql`SELECT id, status, major, minor, title, change_type, change_summary, edit_seq, content_hash, author_id, ai_generated, publish_mode, scheduled_publish_at, effective_date, updated_at, review_round, require_reattestation
          FROM document_versions WHERE document_id = ${params.id} AND status IN ('draft','in_review','changes_requested','pending_approval','approved','scheduled')`)
      : null;
    const audiences = actor.isExternal ? [] : await db.q(sql`SELECT a.kind, a.target,
        CASE a.kind WHEN 'department' THEN (SELECT name FROM departments WHERE id::text = a.target)
                    WHEN 'team' THEN (SELECT dp.name || '/' || t.name FROM teams t JOIN departments dp ON dp.id = t.department_id WHERE t.id::text = a.target)
                    WHEN 'user' THEN (SELECT name FROM users WHERE id::text = a.target) ELSE a.target END AS label
      FROM document_audiences a WHERE a.document_id = ${params.id} ORDER BY a.kind`);
    const relations = await db.q(sql`
      SELECT r.id, r.kind, 'out' AS dir, d2.id AS document_id, d2.title, d2.status, d2.doc_number FROM document_relations r JOIN documents d2 ON d2.id = r.to_document_id
       WHERE r.from_document_id = ${params.id} AND ${docAccessible(actor, 'd2')}
      UNION ALL
      SELECT r.id, r.kind, 'in', d2.id, d2.title, d2.status, d2.doc_number FROM document_relations r JOIN documents d2 ON d2.id = r.from_document_id
       WHERE r.to_document_id = ${params.id} AND ${docAccessible(actor, 'd2')}`);
    const myAttestation = current ? await db.one(sql`SELECT ua.id, ua.status, ua.due_date, ua.viewed_at, ua.reached_end_at, ua.acknowledged_at, c.require_scroll
        FROM user_attestations ua JOIN attestation_campaigns c ON c.id = ua.campaign_id
       WHERE ua.user_id = ${actor.id} AND ua.version_id = ${current.id} AND ua.status IN ('pending','acknowledged')`) : null;
    const owner = d.owner_id ? await db.one(sql`SELECT id, name FROM users WHERE id = ${d.owner_id}`) : null;
    const dept = d.department_id ? await db.one(sql`SELECT id, name, code FROM departments WHERE id = ${d.department_id}`) : null;
    const fb = await db.one(sql`SELECT count(*) FILTER (WHERE kind = 'helpful')::int AS helpful, count(*) FILTER (WHERE status IN ('open','reviewing') AND kind <> 'helpful')::int AS open FROM feedback WHERE document_id = ${params.id}`);
    const reviewOverdue = d.status === 'published' && d.next_review_date && d.next_review_date < new Date().toISOString().slice(0, 10);
    return {
      document: {
        id: d.id, docNumber: d.doc_number, type: d.type, title: d.title, summary: d.summary, purpose: d.purpose, scope: d.scope, status: d.status,
        classification: d.classification, category: d.category, tags: d.tags, audienceAll: d.audience_all, requiresAttestation: d.requires_attestation,
        reviewCycleDays: d.review_cycle_days, nextReviewDate: d.next_review_date, lastReviewedAt: d.last_reviewed_at, effectiveDate: d.effective_date,
        retiredAt: d.retired_at, updatedAt: d.updated_at, owner, department: dept, currentVersionId: readable ? d.current_version_id : null, reviewOverdue,
      },
      current: current && {
        id: current.id, version: versionLabel(current), title: current.title, content: current.content, changeType: current.change_type,
        changeSummary: current.change_summary, publishedAt: current.published_at, effectiveDate: current.effective_date ?? d.effective_date, contentHash: current.content_hash, aiGenerated: current.ai_generated,
      },
      working: working && { ...working, version: versionLabel(working) },
      audiences, relations, myAttestation, feedback: fb,
      can: {
        edit: d.can_edit, admin: has(actor, 'doc.admin'), history: canSeeHistory(actor, d.can_edit), download: canDownload(actor, d.classification),
        offline: canOffline(actor, d.classification), retire: d.can_edit && (has(actor, 'doc.admin') || d.owner_id === actor.id),
        reviewConfirm: d.status === 'published' && (d.can_edit || d.owner_id === actor.id),
      },
    };
  });

  api(app, 'PATCH', '/api/documents/:id', { params: idParams, body: z.object(meta) }, async ({ db, actor, params, body, ip }) => {
    const d = await getDoc(db, actor, params.id, 'edit');
    const aclChange = body.classification !== undefined || body.audiences !== undefined || body.audienceAll !== undefined;
    if (aclChange && d.status !== 'draft' && !has(actor, 'doc.admin')) throw forbidden('公開後の配布先・機密区分の変更はナレッジ管理者が行います');
    if (body.departmentId && !has(actor, 'doc.admin') && !actor.deptIds.includes(body.departmentId)) throw forbidden();
    await db.exec(sql`UPDATE documents SET
        doc_number = CASE WHEN ${body.docNumber !== undefined} THEN ${body.docNumber ?? null} ELSE doc_number END,
        summary = coalesce(${body.summary ?? null}, summary), purpose = coalesce(${body.purpose ?? null}, purpose), scope = coalesce(${body.scope ?? null}, scope),
        category = coalesce(${body.category ?? null}, category), tags = coalesce(${body.tags ?? null}::text[], tags),
        classification = coalesce(${body.classification ?? null}, classification),
        department_id = CASE WHEN ${body.departmentId !== undefined} THEN ${body.departmentId ?? null}::uuid ELSE department_id END,
        owner_id = CASE WHEN ${body.ownerId !== undefined} THEN ${body.ownerId ?? null}::uuid ELSE owner_id END,
        audience_all = coalesce(${body.audienceAll ?? null}::boolean, audience_all),
        review_cycle_days = CASE WHEN ${body.reviewCycleDays !== undefined} THEN ${body.reviewCycleDays ?? null}::int ELSE review_cycle_days END,
        next_review_date = CASE WHEN ${body.reviewCycleDays !== undefined} AND status = 'published'
             THEN (CASE WHEN ${body.reviewCycleDays ?? null}::int IS NULL THEN NULL ELSE coalesce(last_reviewed_at::date, current_date) + ${body.reviewCycleDays ?? 0}::int END)
             ELSE next_review_date END,
        requires_attestation = coalesce(${body.requiresAttestation ?? null}::boolean, requires_attestation), updated_at = now()
      WHERE id = ${params.id}`);
    if (body.audiences) {
      for (const a of body.audiences) if (a.kind === 'user' && !(await db.one(sql`SELECT 1 FROM users WHERE id::text = ${a.target}`))) throw badRequest('配布先ユーザーが見つかりません');
      await setAudiences(db, params.id, body.audiences);
    }
    await reindexDocument(db, params.id);
    const before = { classification: d.classification, audienceAll: d.audience_all, departmentId: d.department_id, ownerId: d.owner_id, reviewCycleDays: d.review_cycle_days };
    await audit(db, actor, aclChange ? 'document.acl_change' : 'document.update', { type: 'document', id: params.id }, `「${d.title}」の設定を変更`, { before, after: body }, ip);
    return { ok: true };
  });

  api(app, 'GET', '/api/documents/:id/versions', { params: idParams }, async ({ db, actor, params }) => {
    const d = await getDoc(db, actor, params.id, 'access');
    if (!canSeeHistory(actor, d.can_edit)) {
      const cur = await db.q(sql`SELECT v.id, v.major, v.minor, v.status, v.change_type, v.change_summary, v.published_at FROM document_versions v WHERE v.id = ${d.current_version_id}`);
      return cur.map((v) => ({ ...v, version: versionLabel(v) }));
    }
    const rows = await db.q(sql`SELECT v.id, v.major, v.minor, v.status, v.change_type, v.change_summary, v.title, v.ai_generated, v.content_hash,
        v.created_at, v.submitted_at, v.approved_at, v.published_at, v.superseded_at, v.effective_date, u.name AS author_name,
        (SELECT json_agg(json_build_object('step', st.step_no, 'approver', au.name, 'decision', ap.decision, 'at', ap.created_at) ORDER BY st.step_no)
           FROM approvals ap JOIN approval_steps st ON st.id = ap.step_id LEFT JOIN users au ON au.id = ap.approver_id WHERE ap.version_id = v.id AND st.round = v.review_round) AS approvals
      FROM document_versions v LEFT JOIN users u ON u.id = v.author_id WHERE v.document_id = ${params.id} ORDER BY v.major DESC, v.minor DESC`);
    return rows.map((v) => ({ ...v, version: versionLabel(v) }));
  });

  api(app, 'GET', '/api/versions/:id', { params: idParams }, async ({ db, actor, params }) => {
    const { v, d } = await versionForActor(db, actor, params.id);
    const author = v.author_id ? await db.one(sql`SELECT name FROM users WHERE id = ${v.author_id}`) : null;
    return { ...v, version: versionLabel(v), authorName: author?.name ?? null, document: { id: d.id, title: d.title, type: d.type, classification: d.classification, status: d.status, canEdit: d.can_edit } };
  });

  api(app, 'GET', '/api/versions/:id/diff', { params: idParams, query: z.object({ against: zId.optional() }) }, async ({ db, actor, params, query }) => {
    const { v } = await versionForActor(db, actor, params.id);
    const otherId = query.against ?? v.based_on_version_id;
    if (!otherId) return { base: null, lines: lineDiff('', v.body_text) };
    const { v: o } = await versionForActor(db, actor, otherId);
    if (o.document_id !== v.document_id) throw badRequest('同じ文書の版を指定してください');
    return { base: versionLabel(o), lines: lineDiff(o.body_text, v.body_text) };
  });

  api(app, 'POST', '/api/documents/:id/revisions', { params: idParams, body: z.object({ changeType: z.enum(['minor', 'normal', 'major']) }) }, async ({ db, actor, params, body, ip }) => {
    const v = await createRevision(db, actor, params.id, body.changeType, ip);
    return { id: v.id, version: versionLabel(v) };
  });

  api(app, 'PUT', '/api/versions/:id', {
    params: idParams,
    body: z.object({ title: z.string().trim().min(1).max(200).optional(), content: z.unknown().optional(), changeSummary: z.string().max(2000).optional(),
      changeType: z.enum(['minor', 'normal', 'major']).optional(), editSeq: z.number().int(), requireReattestation: z.boolean().optional() }),
  }, async ({ db, actor, params, body }) => {
    const v = await saveDraft(db, actor, params.id, body);
    return { id: v.id, editSeq: v.edit_seq, version: versionLabel(v), contentHash: v.content_hash, updatedAt: v.updated_at };
  });

  api(app, 'POST', '/api/versions/:id/submit', {
    params: idParams,
    body: z.object({
      reviewers: z.array(zId).max(20).default([]),
      approvalSteps: z.array(z.object({ mode: z.enum(['any', 'all']), approvers: z.array(zId).min(1).max(20) })).max(3).optional(),
      publishMode: z.enum(['immediate', 'scheduled', 'manual']).default('immediate'),
      publishAt: z.string().datetime({ offset: true }).nullable().optional(),
      effectiveDate: zDate.nullable().optional(),
    }),
  }, async ({ db, actor, params, body, ip }) => {
    const v = await submitVersion(db, actor, params.id, body, ip);
    return { id: v.id, status: v.status };
  });

  api(app, 'POST', '/api/versions/:id/review', { params: idParams, body: z.object({ decision: z.enum(['approved', 'changes_requested']), comment: z.string().max(5000).default('') }) },
    async ({ db, actor, params, body, ip }) => reviewDecision(db, actor, params.id, body.decision, body.comment, ip));

  api(app, 'POST', '/api/versions/:id/approve', {
    params: idParams, body: z.object({ decision: z.enum(['approved', 'rejected', 'changes_requested']), comment: z.string().max(5000).default(''), contentHash: z.string().length(64) }),
  }, async ({ db, actor, params, body, ip }) => {
    if (body.decision !== 'approved' && !body.comment.trim()) throw badRequest('却下・修正依頼の理由を入力してください');
    const r = await approvalDecision(db, actor, params.id, body.decision, body.comment, body.contentHash, ip);
    const v = await db.one(sql`SELECT status FROM document_versions WHERE id = ${params.id}`);
    return { ...r, versionStatus: v.status };
  });

  api(app, 'POST', '/api/versions/:id/reassign', { params: idParams, body: z.object({ from: zId, to: zId, reason: z.string().trim().min(1).max(500) }) },
    async ({ db, actor, params, body, ip }) => { await reassignApprover(db, actor, params.id, body.from, body.to, body.reason, ip); return { ok: true }; });

  api(app, 'POST', '/api/versions/:id/withdraw', { params: idParams }, async ({ db, actor, params, ip }) => { await withdrawVersion(db, actor, params.id, ip); return { ok: true }; });

  api(app, 'POST', '/api/versions/:id/publish', { params: idParams }, async ({ db, actor, params, ip }) => {
    need(actor, 'doc.admin');
    return publishVersion(db, actor, params.id, ip);
  });

  api(app, 'GET', '/api/versions/:id/workflow', { params: idParams }, async ({ db, actor, params }) => {
    const { v, d } = await versionForActor(db, actor, params.id);
    const reviews = await db.q(sql`SELECT rr.id, rr.round, rr.status, rr.created_at,
        (SELECT json_agg(json_build_object('reviewerId', ra.reviewer_id, 'name', u.name, 'status', ra.status, 'comment', ra.comment, 'decidedAt', ra.decided_at))
           FROM review_assignments ra JOIN users u ON u.id = ra.reviewer_id WHERE ra.review_id = rr.id) AS reviewers
      FROM review_requests rr WHERE rr.version_id = ${params.id} ORDER BY rr.round`);
    const steps = await db.q(sql`SELECT st.id, st.round, st.step_no, st.mode, st.status, st.content_hash, st.decided_at,
        (SELECT json_agg(json_build_object('approverId', sa.approver_id, 'name', u.name, 'active', sa.active, 'reassignedTo', sa.reassigned_to, 'reason', sa.reassign_reason, 'reassignedAt', sa.reassigned_at))
           FROM approval_step_approvers sa JOIN users u ON u.id = sa.approver_id WHERE sa.step_id = st.id) AS approvers,
        (SELECT json_agg(json_build_object('approverId', ap.approver_id, 'name', u.name, 'decision', ap.decision, 'comment', ap.comment, 'contentHash', ap.content_hash, 'at', ap.created_at))
           FROM approvals ap LEFT JOIN users u ON u.id = ap.approver_id WHERE ap.step_id = st.id) AS decisions
      FROM approval_steps st WHERE st.version_id = ${params.id} ORDER BY st.round, st.step_no`);
    const comments = await db.q(sql`SELECT c.id, c.round, c.section, c.body, c.content_hash, c.created_at, c.resolved_at, u.name AS author_name
      FROM review_comments c LEFT JOIN users u ON u.id = c.author_id WHERE c.version_id = ${params.id} ORDER BY c.created_at`);
    const myReview = await db.one(sql`SELECT ra.status FROM review_assignments ra JOIN review_requests rr ON rr.id = ra.review_id
       WHERE rr.version_id = ${params.id} AND rr.round = ${v.review_round} AND rr.status = 'open' AND ra.reviewer_id = ${actor.id}`);
    const myApproval = await db.one(sql`SELECT st.id, st.status, st.step_no, EXISTS (SELECT 1 FROM approvals ap WHERE ap.step_id = st.id AND ap.approver_id = ${actor.id}) AS decided
       FROM approval_steps st JOIN approval_step_approvers sa ON sa.step_id = st.id
      WHERE st.version_id = ${params.id} AND st.round = ${v.review_round} AND sa.approver_id = ${actor.id} AND sa.active ORDER BY st.step_no LIMIT 1`);
    return {
      status: v.status, round: v.review_round, contentHash: v.content_hash, publishMode: v.publish_mode, scheduledPublishAt: v.scheduled_publish_at,
      reviews, steps, comments, canEdit: d.can_edit,
      myReview: myReview?.status === 'pending',
      myApproval: !!myApproval && myApproval.status === 'active' && !myApproval.decided && v.status === 'pending_approval',
    };
  });

  api(app, 'POST', '/api/versions/:id/comments', { params: idParams, body: z.object({ section: z.string().max(200).default(''), body: z.string().trim().min(1).max(5000) }) },
    async ({ db, actor, params, body, ip }) => {
      const { v, d } = await versionForActor(db, actor, params.id);
      if (!(d.can_edit || d.participant || has(actor, 'doc.admin'))) throw forbidden();
      // Comments are pinned to the version AND the exact content hash they were written against.
      const c = await db.one(sql`INSERT INTO review_comments (org_id, version_id, content_hash, round, author_id, section, body)
        VALUES (${db.orgId}, ${v.id}, ${v.content_hash}, ${v.review_round}, ${actor.id}, ${body.section}, ${body.body}) RETURNING *`);
      await audit(db, actor, 'review.comment', { type: 'version', id: v.id }, 'レビューコメント', { commentId: c.id }, ip);
      return c;
    });

  api(app, 'POST', '/api/comments/:id/resolve', { params: idParams }, async ({ db, actor, params }) => {
    const c = await db.one(sql`SELECT * FROM review_comments WHERE id = ${params.id}`);
    if (!c) throw notFound();
    const { d } = await versionForActor(db, actor, c.version_id);
    if (!d.can_edit) throw forbidden();
    await db.exec(sql`UPDATE review_comments SET resolved_at = now(), resolved_by = ${actor.id} WHERE id = ${params.id}`);
    return { ok: true };
  });

  api(app, 'GET', '/api/inbox', {}, async ({ db, actor }) => {
    const reviews = await db.q(sql`SELECT v.id AS version_id, v.document_id, v.title, v.major, v.minor, rr.created_at, u.name AS requested_by
        FROM review_assignments ra JOIN review_requests rr ON rr.id = ra.review_id JOIN document_versions v ON v.id = rr.version_id
        LEFT JOIN users u ON u.id = rr.requested_by
       WHERE ra.reviewer_id = ${actor.id} AND ra.status = 'pending' AND rr.status = 'open' ORDER BY rr.created_at`);
    const approvals = await db.q(sql`SELECT v.id AS version_id, v.document_id, v.title, v.major, v.minor, st.step_no, st.mode, st.created_at, v.ai_generated
        FROM approval_step_approvers sa JOIN approval_steps st ON st.id = sa.step_id JOIN document_versions v ON v.id = st.version_id
       WHERE sa.approver_id = ${actor.id} AND sa.active AND st.status = 'active' AND v.status = 'pending_approval' AND st.round = v.review_round
         AND NOT EXISTS (SELECT 1 FROM approvals ap WHERE ap.step_id = st.id AND ap.approver_id = ${actor.id}) ORDER BY st.created_at`);
    const changes = await db.q(sql`SELECT v.id AS version_id, v.document_id, v.title, v.major, v.minor, v.status, v.updated_at FROM document_versions v
       WHERE v.author_id = ${actor.id} AND v.status IN ('draft','changes_requested') ORDER BY v.updated_at DESC LIMIT 50`);
    const lab = (r: any) => ({ ...r, version: versionLabel(r) });
    return { reviews: reviews.map(lab), approvals: approvals.map(lab), drafts: changes.map(lab) };
  });

  api(app, 'POST', '/api/documents/:id/retire', { params: idParams, body: z.object({ reason: z.string().trim().min(1).max(1000) }) },
    async ({ db, actor, params, body, ip }) => { await retireDocument(db, actor, params.id, body.reason, ip); return { ok: true }; });

  api(app, 'POST', '/api/documents/:id/archive', { params: idParams }, async ({ db, actor, params, ip }) => {
    const d = await getDoc(db, actor, params.id, 'edit');
    if (d.current_version_id) throw conflict('公開済みの文書は「廃止」を使ってください');
    await db.exec(sql`UPDATE document_versions SET status = 'withdrawn' WHERE document_id = ${params.id} AND status IN ('draft','changes_requested','in_review','pending_approval')`);
    await db.exec(sql`UPDATE documents SET status = 'archived', updated_at = now() WHERE id = ${params.id}`);
    await audit(db, actor, 'document.archive', { type: 'document', id: params.id }, `下書き「${d.title}」をアーカイブ`, {}, ip);
    return { ok: true };
  });

  api(app, 'POST', '/api/documents/:id/review-confirm', { params: idParams, body: z.object({ note: z.string().max(2000).default('') }) },
    async ({ db, actor, params, body, ip }) => reviewConfirmNoChange(db, actor, params.id, body.note, ip));

  // ------------------------------------------------------------------ relations
  api(app, 'POST', '/api/documents/:id/relations', { params: idParams, body: z.object({ toDocumentId: zId, kind: z.enum(['related', 'dependsOn', 'replaces', 'derivedFrom']) }) },
    async ({ db, actor, params, body, ip }) => {
      await getDoc(db, actor, params.id, 'edit');
      await getDoc(db, actor, body.toDocumentId, 'access');
      if (body.toDocumentId === params.id) throw badRequest('自分自身は参照できません');
      if (await relationWouldCycle(db, params.id, body.toDocumentId, body.kind)) throw conflict('循環する依存関係になるため追加できません');
      const r = await db.one(sql`INSERT INTO document_relations (org_id, from_document_id, to_document_id, kind, created_by) VALUES (${db.orgId}, ${params.id}, ${body.toDocumentId}, ${body.kind}, ${actor.id}) RETURNING *`);
      await reindexDocument(db, params.id);
      await audit(db, actor, 'relation.create', { type: 'document', id: params.id }, `関連文書を追加（${body.kind}）`, { to: body.toDocumentId }, ip);
      return r;
    });

  api(app, 'DELETE', '/api/relations/:id', { params: idParams }, async ({ db, actor, params, ip }) => {
    const r = await db.one(sql`SELECT * FROM document_relations WHERE id = ${params.id}`);
    if (!r) throw notFound();
    await getDoc(db, actor, r.from_document_id, 'edit');
    await db.exec(sql`DELETE FROM document_relations WHERE id = ${params.id}`);
    await reindexDocument(db, r.from_document_id);
    await audit(db, actor, 'relation.delete', { type: 'document', id: r.from_document_id }, '関連文書を削除', { to: r.to_document_id, kind: r.kind }, ip);
  });

  api(app, 'GET', '/api/documents/:id/impact', { params: idParams }, async ({ db, actor, params }) => {
    await getDoc(db, actor, params.id, 'access');
    return impactOf(db, actor, params.id);
  });

  // ------------------------------------------------------------------ templates (copy-on-create: editing a template never changes existing SOPs)
  api(app, 'GET', '/api/templates', {}, async ({ db, actor }) => {
    if (actor.isExternal) throw forbidden();
    return db.q(sql`SELECT id, name, doc_type, content, is_default, updated_at FROM templates ORDER BY is_default DESC, name`);
  });
  const tplBody = z.object({ name: z.string().trim().min(1).max(100), docType: docTypes, content: z.unknown() });
  api(app, 'POST', '/api/templates', { body: tplBody }, async ({ db, actor, body, ip }) => {
    need(actor, 'template.manage');
    const t = await db.one(sql`INSERT INTO templates (org_id, name, doc_type, content, created_by) VALUES (${db.orgId}, ${body.name}, ${body.docType}, ${JSON.stringify(normalizeContent(body.content))}, ${actor.id}) RETURNING *`);
    await audit(db, actor, 'template.create', { type: 'template', id: t.id }, `テンプレート「${body.name}」を作成`, {}, ip);
    return t;
  });
  api(app, 'PUT', '/api/templates/:id', { params: idParams, body: tplBody }, async ({ db, actor, params, body, ip }) => {
    need(actor, 'template.manage');
    const t = await db.one(sql`UPDATE templates SET name = ${body.name}, doc_type = ${body.docType}, content = ${JSON.stringify(normalizeContent(body.content))}, updated_at = now() WHERE id = ${params.id} RETURNING *`);
    if (!t) throw notFound();
    await audit(db, actor, 'template.update', { type: 'template', id: t.id }, `テンプレート「${body.name}」を更新`, {}, ip);
    return t;
  });

  // ------------------------------------------------------------------ offline (PWA)
  api(app, 'GET', '/api/documents/:id/offline', { params: idParams }, async ({ db, actor, params, ip }) => {
    const d = await getDoc(db, actor, params.id, 'read');
    if (!canOffline(actor, d.classification)) throw forbidden('この機密区分の文書はオフライン保存できません');
    const v = await db.one(sql`SELECT id, major, minor, title, content, published_at, effective_date FROM document_versions WHERE id = ${d.current_version_id}`);
    await audit(db, actor, 'document.offline_saved', { type: 'document', id: d.id }, 'オフライン保存', { versionId: v.id }, ip);
    return { documentId: d.id, versionId: v.id, version: versionLabel(v), title: v.title, content: v.content, classification: d.classification,
      effectiveDate: v.effective_date ?? d.effective_date, publishedAt: v.published_at, docNumber: d.doc_number, savedAt: new Date().toISOString() };
  });

  api(app, 'POST', '/api/offline/check', { body: z.object({ items: z.array(z.object({ documentId: zId, versionId: zId })).max(500) }) }, async ({ db, actor, body }) => {
    const out = [];
    for (const it of body.items) {
      const d = await db.one(sql`SELECT d.status, d.current_version_id, d.classification FROM documents d WHERE d.id = ${it.documentId} AND ${docReadable(actor)}`);
      const retired = !d && (await db.one(sql`SELECT 1 FROM documents WHERE id = ${it.documentId} AND status IN ('retired','superseded','archived')`));
      let state: string;
      if (retired) state = 'retired';
      else if (!d) state = 'forbidden';
      else if (!canOffline(actor, d.classification)) state = 'forbidden';
      else if (d.status === 'retired') state = 'retired';
      else if (d.current_version_id !== it.versionId) state = 'superseded';
      else state = 'current';
      out.push({ ...it, state, currentVersionId: d && state === 'superseded' ? d.current_version_id : undefined });
    }
    return out;
  });

  api(app, 'GET', '/api/document-types', {}, async ({ actor }) => actor.settings.docTypes);
}
