import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { api, zId } from '../http.js';
import { docEditable, docReadable, has, need } from '../lib/authz.js';
import { sql } from '../lib/sql.js';

export default async function dashboardRoutes(app: FastifyInstance) {
  api(app, 'GET', '/api/dashboard', {}, async ({ db, actor }) => {
    const out: Record<string, unknown> = {};
    // ---- everyone
    out.attestations = await db.q(sql`SELECT ua.id, ua.document_id, ua.due_date, v.title, v.major, v.minor, v.change_type, (ua.due_date < current_date) AS overdue
        FROM user_attestations ua JOIN document_versions v ON v.id = ua.version_id WHERE ua.user_id = ${actor.id} AND ua.status = 'pending' ORDER BY ua.due_date NULLS LAST LIMIT 10`);
    out.training = await db.q(sql`SELECT ta.id, ta.status, ta.due_date, c.title, (ta.due_date < current_date) AS overdue,
        jsonb_array_length(cv.modules) AS module_count, (SELECT count(*)::int FROM module_progress mp WHERE mp.assignment_id = ta.id) AS done_count
        FROM training_assignments ta JOIN courses c ON c.id = ta.course_id JOIN course_versions cv ON cv.id = ta.course_version_id
       WHERE ta.user_id = ${actor.id} AND ta.status IN ('not_started','in_progress') ORDER BY ta.due_date NULLS LAST LIMIT 10`);
    out.recentUpdates = await db.q(sql`SELECT d.id, d.title, d.doc_number, d.type, v.major, v.minor, v.change_type, v.published_at FROM documents d JOIN document_versions v ON v.id = d.current_version_id
       WHERE ${docReadable(actor)} AND d.status = 'published' ORDER BY v.published_at DESC NULLS LAST LIMIT 8`);
    out.popular = await db.q(sql`SELECT d.id, d.title, d.doc_number, count(*)::int AS clicks FROM search_queries q JOIN documents d ON d.id = q.clicked_document_id
       WHERE q.created_at > now() - interval '30 days' AND ${docReadable(actor)} AND d.status = 'published' GROUP BY d.id ORDER BY clicks DESC LIMIT 6`);
    out.unreadNotifications = (await db.one(sql`SELECT count(*)::int AS n FROM notifications WHERE user_id = ${actor.id} AND read_at IS NULL`)).n;
    // ---- editor
    if (has(actor, 'doc.create')) {
      out.myWork = await db.q(sql`SELECT v.id AS version_id, v.document_id, v.title, v.major, v.minor, v.status, v.updated_at FROM document_versions v JOIN documents d ON d.id = v.document_id
         WHERE ${docEditable(actor)} AND v.status IN ('draft','changes_requested','in_review','pending_approval','approved','scheduled')
           AND (v.author_id = ${actor.id} OR d.owner_id = ${actor.id}) ORDER BY (v.status = 'changes_requested') DESC, v.updated_at DESC LIMIT 12`);
    }
    // ---- reviewer / approver
    out.reviewCount = (await db.one(sql`SELECT count(*)::int AS n FROM review_assignments ra JOIN review_requests rr ON rr.id = ra.review_id WHERE ra.reviewer_id = ${actor.id} AND ra.status = 'pending' AND rr.status = 'open'`)).n;
    if (has(actor, 'doc.approve')) {
      out.approvalCount = (await db.one(sql`SELECT count(*)::int AS n FROM approval_step_approvers sa JOIN approval_steps st ON st.id = sa.step_id JOIN document_versions v ON v.id = st.version_id
         WHERE sa.approver_id = ${actor.id} AND sa.active AND st.status = 'active' AND v.status = 'pending_approval' AND st.round = v.review_round
           AND NOT EXISTS (SELECT 1 FROM approvals ap WHERE ap.step_id = st.id AND ap.approver_id = ${actor.id})`)).n;
    }
    // ---- trainer
    if (has(actor, 'training.report')) {
      out.trainingStats = await db.one(sql`SELECT count(*) FILTER (WHERE status IN ('not_started','in_progress') AND due_date < current_date)::int AS overdue,
          count(*) FILTER (WHERE status IN ('not_started','in_progress'))::int AS open, count(*) FILTER (WHERE status = 'completed')::int AS completed,
          (SELECT count(*)::int FROM quiz_attempts WHERE submitted_at > now() - interval '30 days' AND result = 'fail') AS quiz_fail_30d,
          (SELECT count(*)::int FROM quiz_attempts WHERE submitted_at > now() - interval '30 days') AS quiz_attempts_30d,
          (SELECT count(*)::int FROM quiz_attempts WHERE status = 'pending_review') AS pending_grading
        FROM training_assignments WHERE status <> 'cancelled'`);
    }
    // ---- knowledge admin / owner
    if (has(actor, 'doc.admin')) {
      out.knowledge = await db.one(sql`SELECT
          count(*) FILTER (WHERE status = 'published' AND next_review_date < current_date)::int AS review_overdue,
          count(*) FILTER (WHERE status = 'published' AND next_review_date BETWEEN current_date AND current_date + ${actor.settings.reviewDueSoonDays}::int)::int AS review_soon,
          count(*) FILTER (WHERE status NOT IN ('retired','archived') AND (owner_id IS NULL OR owner_id IN (SELECT id FROM users WHERE status <> 'active')))::int AS no_owner,
          (SELECT count(*)::int FROM document_relations r JOIN documents t ON t.id = r.to_document_id JOIN documents f ON f.id = r.from_document_id
            WHERE t.status IN ('retired','superseded','archived') AND f.status NOT IN ('retired','archived') AND r.kind <> 'replaces') AS broken_relations,
          (SELECT count(*)::int FROM feedback WHERE status IN ('open','reviewing') AND kind <> 'helpful') AS open_feedback
        FROM documents`);
      out.overdueDocs = await db.q(sql`SELECT d.id, d.title, d.doc_number, d.next_review_date, u.name AS owner_name FROM documents d LEFT JOIN users u ON u.id = d.owner_id
         WHERE d.status = 'published' AND d.next_review_date < current_date + ${actor.settings.reviewDueSoonDays}::int ORDER BY d.next_review_date LIMIT 10`);
    }
    if (actor.roles.includes('owner')) {
      out.org = await db.one(sql`SELECT (SELECT count(*)::int FROM users WHERE status = 'active' AND NOT is_external) AS users,
          (SELECT count(*)::int FROM users WHERE status = 'active' AND is_external AND external_expires_at > now()) AS externals,
          (SELECT count(*)::int FROM documents WHERE status = 'published') AS published,
          (SELECT count(*)::int FROM courses WHERE status = 'published') AS courses,
          (SELECT coalesce(sum(cost_usd),0) FROM ai_usage WHERE created_at >= date_trunc('month', now())) AS ai_cost_month`);
    }
    if (has(actor, 'audit.read')) {
      out.audit = await db.one(sql`SELECT count(*)::int AS events_7d, count(*) FILTER (WHERE action = 'auth.login_failed')::int AS login_failed_7d,
          count(*) FILTER (WHERE action LIKE 'export.%')::int AS exports_7d FROM audit_events WHERE created_at > now() - interval '7 days'`);
    }
    return out;
  });

  /** Knowledge Health — factual operating indicators only (no AI "quality score"). */
  api(app, 'GET', '/api/health/knowledge', {}, async ({ db, actor }) => {
    need(actor, 'health.read');
    const docs = await db.one(sql`SELECT count(*) FILTER (WHERE status = 'published')::int AS published,
        count(*) FILTER (WHERE status = 'published' AND next_review_date < current_date)::int AS review_overdue,
        count(*) FILTER (WHERE status = 'published' AND (owner_id IS NULL OR owner_id IN (SELECT id FROM users WHERE status <> 'active')))::int AS no_owner,
        count(*) FILTER (WHERE status = 'published' AND coalesce(last_reviewed_at, updated_at) < now() - interval '365 days')::int AS stale,
        count(*) FILTER (WHERE status IN ('draft','in_review','changes_requested'))::int AS in_progress,
        count(*) FILTER (WHERE status = 'retired')::int AS retired
      FROM documents`);
    const broken = await db.q(sql`SELECT f.id, f.title, t.title AS target_title, t.status AS target_status, r.kind FROM document_relations r
        JOIN documents t ON t.id = r.to_document_id JOIN documents f ON f.id = r.from_document_id
       WHERE t.status IN ('retired','superseded','archived') AND f.status NOT IN ('retired','archived') AND r.kind <> 'replaces' LIMIT 100`);
    const major = await db.one(sql`SELECT count(*) FILTER (WHERE ua.status = 'pending')::int AS pending, count(*) FILTER (WHERE ua.status = 'pending' AND ua.due_date < current_date)::int AS overdue,
        count(*)::int AS total FROM user_attestations ua JOIN document_versions v ON v.id = ua.version_id WHERE v.change_type = 'major' AND ua.status <> 'cancelled'`);
    const training = await db.one(sql`SELECT count(*) FILTER (WHERE status = 'completed')::int AS completed, count(*) FILTER (WHERE status NOT IN ('cancelled','waived'))::int AS total,
        count(*) FILTER (WHERE status IN ('not_started','in_progress') AND due_date < current_date)::int AS overdue FROM training_assignments`);
    const search = await db.one(sql`SELECT count(*)::int AS queries, count(*) FILTER (WHERE result_count = 0)::int AS zero_result,
        count(*) FILTER (WHERE clicked_document_id IS NOT NULL AND dwell_ms IS NOT NULL AND dwell_ms < 10000)::int AS quick_exit,
        count(*) FILTER (WHERE clicked_document_id IS NOT NULL)::int AS clicked
      FROM search_queries WHERE created_at > now() - interval '30 days'`);
    const byDept = await db.q(sql`SELECT dp.name, count(d.*) FILTER (WHERE d.status = 'published')::int AS published,
        count(d.*) FILTER (WHERE d.status = 'published' AND d.next_review_date < current_date)::int AS overdue
      FROM departments dp LEFT JOIN documents d ON d.department_id = dp.id GROUP BY dp.id ORDER BY dp.code`);
    const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);
    return {
      documents: { ...docs, reviewOverdueRate: pct(docs.review_overdue, docs.published) },
      brokenRelations: broken,
      majorChanges: { ...major, unacknowledgedRate: pct(major.pending, major.total) },
      training: { ...training, completionRate: pct(training.completed, training.total) },
      search: { ...search, zeroResultRate: pct(search.zero_result, search.queries), quickExitRate: pct(search.quick_exit, search.clicked) },
      byDepartment: byDept,
      note: '指標はすべて記録された事実データの集計です。文書の品質をAIで評価・断定するものではありません。',
    };
  });

  api(app, 'GET', '/api/analytics/search', { query: z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }) }, async ({ db, actor, query }) => {
    need(actor, 'analytics.read');
    const top = await db.q(sql`SELECT lower(query) AS query, count(*)::int AS n, round(avg(result_count))::int AS avg_results, count(clicked_document_id)::int AS clicks
      FROM search_queries WHERE created_at > now() - make_interval(days => ${query.days}) GROUP BY 1 ORDER BY n DESC LIMIT 30`);
    const zero = await db.q(sql`SELECT lower(query) AS query, count(*)::int AS n, max(created_at) AS last_at, bool_or(mode = 'ai') AS via_ai
      FROM search_queries WHERE result_count = 0 AND created_at > now() - make_interval(days => ${query.days}) GROUP BY 1 ORDER BY n DESC LIMIT 50`);
    const noClick = await db.q(sql`SELECT lower(query) AS query, count(*)::int AS n FROM search_queries
      WHERE result_count > 0 AND clicked_document_id IS NULL AND mode = 'keyword' AND created_at > now() - make_interval(days => ${query.days}) GROUP BY 1 HAVING count(*) >= 2 ORDER BY n DESC LIMIT 30`);
    const clicked = await db.q(sql`SELECT d.id, d.title, count(*)::int AS clicks FROM search_queries q JOIN documents d ON d.id = q.clicked_document_id
      WHERE q.created_at > now() - make_interval(days => ${query.days}) GROUP BY d.id ORDER BY clicks DESC LIMIT 20`);
    return {
      top, zeroResult: zero, noClick, clicked,
      candidates: zero.filter((z0) => z0.n >= 2).map((z0) => ({ query: z0.query, count: z0.n, suggestion: 'FAQ / SOP の作成候補（自動公開はされません）' })),
      privacy: '検索語は利用者IDと紐づけずに保存しています。保存期間は組織設定の日数です。',
    };
  });

  api(app, 'GET', '/api/notifications', { query: z.object({ unread: z.enum(['true', 'false']).optional() }) }, async ({ db, actor, query }) => {
    return db.q(sql`SELECT id, type, title, link, created_at, read_at FROM notifications WHERE user_id = ${actor.id}
       AND (${query.unread !== 'true'} OR read_at IS NULL) ORDER BY created_at DESC LIMIT 100`);
  });

  api(app, 'POST', '/api/notifications/read', { body: z.object({ ids: z.array(zId).max(200).optional(), all: z.boolean().optional() }) }, async ({ db, actor, body }) => {
    if (body.all) await db.exec(sql`UPDATE notifications SET read_at = now() WHERE user_id = ${actor.id} AND read_at IS NULL`);
    else if (body.ids?.length) await db.exec(sql`UPDATE notifications SET read_at = now() WHERE user_id = ${actor.id} AND id = ANY(${body.ids}::uuid[]) AND read_at IS NULL`);
    return { ok: true };
  });

  api(app, 'GET', '/api/admin/notifications/delivery', {}, async ({ db, actor }) => {
    need(actor, 'org.settings');
    return db.q(sql`SELECT email_status, count(*)::int AS n, max(created_at) AS last_at FROM notifications GROUP BY 1`);
  });
}
