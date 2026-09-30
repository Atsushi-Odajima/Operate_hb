import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { draftQuiz } from '../ai/service.js';
import { api, idParams, zDate, zId } from '../http.js';
import { docReadable, has, need } from '../lib/authz.js';
import { hmac, safeEqual } from '../lib/crypto.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { newPdf, pdfToBuffer } from '../lib/pdf.js';
import { sql } from '../lib/sql.js';
import { audit } from '../services/audit.js';
import {
  afterGraded, assignCourse, attemptView, evaluateAssignment, lockedModules, moduleSchema, questionSchema, quizSettingsSchema, resolveAssignees,
  startAttempt, submitAttempt, validateQuestion, type Module, type Question,
} from '../services/training.js';

const courseBody = z.object({
  title: z.string().trim().min(1).max(200), description: z.string().max(5000).default(''),
  dueDays: z.number().int().min(1).max(730).nullable().optional(), validityDays: z.number().int().min(1).max(3650).nullable().optional(),
});

export default async function trainingRoutes(app: FastifyInstance) {
  // ============================================================== courses
  api(app, 'GET', '/api/courses', {}, async ({ db, actor }) => {
    const manage = has(actor, 'training.manage') || has(actor, 'training.report');
    return db.q(sql`SELECT c.id, c.title, c.description, c.status, c.due_days, c.validity_days, c.updated_at, cv.version_no, u.name AS owner_name,
        jsonb_array_length(coalesce(cv.modules, '[]'::jsonb)) AS module_count,
        (SELECT count(*)::int FROM training_assignments ta WHERE ta.course_id = c.id AND ta.status <> 'cancelled') AS assigned,
        (SELECT count(*)::int FROM training_assignments ta WHERE ta.course_id = c.id AND ta.status = 'completed') AS completed,
        EXISTS (SELECT 1 FROM course_versions d WHERE d.course_id = c.id AND d.status = 'draft') AS has_draft
      FROM courses c LEFT JOIN course_versions cv ON cv.id = c.current_version_id LEFT JOIN users u ON u.id = c.owner_id
      WHERE ${manage} OR EXISTS (SELECT 1 FROM training_assignments ta WHERE ta.course_id = c.id AND ta.user_id = ${actor.id})
      ORDER BY c.updated_at DESC`);
  });

  api(app, 'POST', '/api/courses', { body: courseBody }, async ({ db, actor, body, ip }) => {
    need(actor, 'training.manage');
    const c = await db.one(sql`INSERT INTO courses (org_id, title, description, owner_id, due_days, validity_days) VALUES (${db.orgId}, ${body.title}, ${body.description}, ${actor.id}, ${body.dueDays ?? null}, ${body.validityDays ?? null}) RETURNING *`);
    await db.exec(sql`INSERT INTO course_versions (org_id, course_id, version_no, created_by) VALUES (${db.orgId}, ${c.id}, 1, ${actor.id})`);
    await audit(db, actor, 'course.create', { type: 'course', id: c.id }, `研修コース「${body.title}」を作成`, {}, ip);
    return c;
  });

  api(app, 'PATCH', '/api/courses/:id', { params: idParams, body: courseBody.partial() }, async ({ db, actor, params, body, ip }) => {
    need(actor, 'training.manage');
    const c = await db.one(sql`UPDATE courses SET title = coalesce(${body.title ?? null}, title), description = coalesce(${body.description ?? null}, description),
        due_days = CASE WHEN ${body.dueDays !== undefined} THEN ${body.dueDays ?? null}::int ELSE due_days END,
        validity_days = CASE WHEN ${body.validityDays !== undefined} THEN ${body.validityDays ?? null}::int ELSE validity_days END, updated_at = now() WHERE id = ${params.id} RETURNING *`);
    if (!c) throw notFound();
    await audit(db, actor, 'course.update', { type: 'course', id: c.id }, `研修コース「${c.title}」を更新`, body, ip);
    return c;
  });

  api(app, 'GET', '/api/courses/:id', { params: idParams }, async ({ db, actor, params }) => {
    const c = await db.one(sql`SELECT * FROM courses WHERE id = ${params.id}`);
    if (!c) throw notFound();
    const manage = has(actor, 'training.manage') || has(actor, 'training.report');
    if (!manage && !(await db.one(sql`SELECT 1 FROM training_assignments WHERE course_id = ${params.id} AND user_id = ${actor.id}`))) throw notFound();
    const versions = await db.q(sql`SELECT id, version_no, status, modules, sequential, completion_policy, change_note, published_at, created_at FROM course_versions WHERE course_id = ${params.id} ORDER BY version_no DESC`);
    return { course: c, versions: manage ? versions : versions.filter((v) => v.id === c.current_version_id) };
  });

  api(app, 'PUT', '/api/courses/:id/draft', {
    params: idParams,
    body: z.object({ modules: z.array(moduleSchema).max(100), sequential: z.boolean().default(true), completionPolicy: z.enum(['keep', 'reassign']).default('keep'), changeNote: z.string().max(2000).default('') }),
  }, async ({ db, actor, params, body }) => {
    need(actor, 'training.manage');
    const c = await db.one(sql`SELECT * FROM courses WHERE id = ${params.id}`);
    if (!c) throw notFound();
    if (new Set(body.modules.map((m) => m.id)).size !== body.modules.length) throw badRequest('モジュール ID が重複しています');
    let d = await db.one(sql`SELECT * FROM course_versions WHERE course_id = ${params.id} AND status = 'draft'`);
    if (!d) {
      const n = await db.one(sql`SELECT max(version_no) AS m FROM course_versions WHERE course_id = ${params.id}`);
      d = await db.one(sql`INSERT INTO course_versions (org_id, course_id, version_no, created_by) VALUES (${db.orgId}, ${params.id}, ${(n.m ?? 0) + 1}, ${actor.id}) RETURNING *`);
    }
    return db.one(sql`UPDATE course_versions SET modules = ${JSON.stringify(body.modules)}, sequential = ${body.sequential}, completion_policy = ${body.completionPolicy}, change_note = ${body.changeNote}
      WHERE id = ${d.id} RETURNING *`);
  });

  api(app, 'POST', '/api/courses/:id/publish', { params: idParams }, async ({ db, actor, params, ip }) => {
    need(actor, 'training.manage');
    const c = await db.one(sql`SELECT * FROM courses WHERE id = ${params.id} FOR UPDATE`);
    if (!c) throw notFound();
    const d = await db.one(sql`SELECT * FROM course_versions WHERE course_id = ${params.id} AND status = 'draft'`);
    if (!d) throw conflict('公開する下書きがありません');
    const modules = d.modules as Module[];
    if (!modules.some((m) => m.required)) throw badRequest('必須モジュールを1つ以上追加してください');
    for (const m of modules) {
      if (m.type === 'document') {
        if (!m.documentId || !(await db.one(sql`SELECT 1 FROM documents WHERE id = ${m.documentId} AND status = 'published'`))) throw badRequest(`「${m.title}」: 公開中の文書を指定してください`);
      } else if (m.type === 'quiz') {
        if (!m.quizId || !(await db.one(sql`SELECT 1 FROM quizzes WHERE id = ${m.quizId} AND status = 'published'`))) throw badRequest(`「${m.title}」: 公開済みのテストを指定してください`);
      } else if (m.type === 'video' && !m.url) throw badRequest(`「${m.title}」: 動画のURLを入力してください`);
    }
    const prevId = c.current_version_id;
    if (prevId) await db.exec(sql`UPDATE course_versions SET status = 'superseded' WHERE id = ${prevId}`);
    await db.exec(sql`UPDATE course_versions SET status = 'published', published_at = now() WHERE id = ${d.id}`);
    await db.exec(sql`UPDATE courses SET current_version_id = ${d.id}, status = 'published', updated_at = now() WHERE id = ${params.id}`);
    let reassigned = 0;
    if (prevId && d.completion_policy === 'reassign') {
      // v1 completions stay v1 completions. Everyone who had v1 gets a NEW v2 assignment to take.
      const users = await db.q(sql`SELECT DISTINCT user_id FROM training_assignments ta JOIN users u ON u.id = ta.user_id
          WHERE ta.course_version_id = ${prevId} AND ta.status <> 'cancelled' AND u.status = 'active'`);
      const r = await assignCourse(db, actor, actor.settings, params.id, users.map((u) => u.user_id), { source: 'reassign', sourceRef: prevId });
      reassigned = r.assigned;
    }
    await audit(db, actor, 'course.publish', { type: 'course', id: params.id }, `研修コース「${c.title}」v${d.version_no} を公開`, { previous: prevId, completionPolicy: d.completion_policy, reassigned }, ip);
    return { ok: true, version: d.version_no, reassigned };
  });

  api(app, 'POST', '/api/courses/:id/assign', {
    params: idParams,
    body: z.object({ userIds: z.array(zId).max(5000).default([]), departmentIds: z.array(zId).max(100).default([]), teamIds: z.array(zId).max(100).default([]),
      roles: z.array(z.string().max(30)).max(10).default([]), dueDate: zDate.nullable().optional() }),
  }, async ({ db, actor, params, body }) => {
    need(actor, 'training.manage');
    const users = await resolveAssignees(db, body);
    if (!users.length) throw badRequest('対象ユーザーがいません');
    const source = body.departmentIds.length ? 'department' : body.teamIds.length ? 'team' : body.roles.length ? 'role' : 'manual';
    return assignCourse(db, actor, actor.settings, params.id, users, { dueDate: body.dueDate ?? null, source });
  });

  // ============================================================== learner
  api(app, 'GET', '/api/training/mine', {}, async ({ db, actor }) => {
    return db.q(sql`SELECT ta.id, ta.status, ta.due_date, ta.assigned_at, ta.started_at, ta.completed_at, c.id AS course_id, c.title, c.description, cv.version_no,
        jsonb_array_length(cv.modules) AS module_count, (SELECT count(*)::int FROM module_progress mp WHERE mp.assignment_id = ta.id) AS done_count,
        (ta.status IN ('not_started','in_progress') AND ta.due_date < current_date) AS overdue,
        (SELECT id FROM certificates ce WHERE ce.assignment_id = ta.id) AS certificate_id
      FROM training_assignments ta JOIN courses c ON c.id = ta.course_id JOIN course_versions cv ON cv.id = ta.course_version_id
      WHERE ta.user_id = ${actor.id} AND ta.status <> 'cancelled'
      ORDER BY (ta.status IN ('not_started','in_progress')) DESC, ta.due_date NULLS LAST, ta.assigned_at DESC`);
  });

  async function assignmentFor(db: any, actor: any, id: string) {
    const a = await db.one(sql`SELECT ta.*, cv.modules, cv.sequential, cv.version_no, c.title, c.description, u.name AS user_name FROM training_assignments ta
        JOIN course_versions cv ON cv.id = ta.course_version_id JOIN courses c ON c.id = ta.course_id JOIN users u ON u.id = ta.user_id WHERE ta.id = ${id}`);
    if (!a || (a.user_id !== actor.id && !has(actor, 'training.report'))) throw notFound();
    return a;
  }

  api(app, 'GET', '/api/assignments/:id', { params: idParams }, async ({ db, actor, params }) => {
    const a = await assignmentFor(db, actor, params.id);
    const progress = await db.q(sql`SELECT module_id, completed_at, detail FROM module_progress WHERE assignment_id = ${params.id}`);
    const done = new Set(progress.map((p: any) => p.module_id));
    const locked = lockedModules(a.modules, done, a.sequential);
    const modules = [];
    for (const m of a.modules as Module[]) {
      let doc = null;
      if (m.type === 'document' && m.documentId) {
        doc = await db.one(sql`SELECT d.id, d.title, d.status, v.major, v.minor FROM documents d LEFT JOIN document_versions v ON v.id = d.current_version_id WHERE d.id = ${m.documentId} AND ${docReadable(actor)}`);
      }
      const attempts = m.type === 'quiz' ? await db.q(sql`SELECT id, status, result, score, max_score, submitted_at FROM quiz_attempts WHERE assignment_id = ${params.id} AND module_id = ${m.id} ORDER BY started_at DESC`) : [];
      modules.push({ ...m, done: done.has(m.id), locked: locked.has(m.id), document: doc, attempts, completedAt: progress.find((p: any) => p.module_id === m.id)?.completed_at ?? null });
    }
    const cert = await db.one(sql`SELECT id, verification_code, completed_at, expires_at FROM certificates WHERE assignment_id = ${params.id}`);
    return { id: a.id, status: a.status, dueDate: a.due_date, title: a.title, description: a.description, version: a.version_no, sequential: a.sequential,
      userName: a.user_name, mine: a.user_id === actor.id, modules, certificate: cert,
      overdue: ['not_started', 'in_progress'].includes(a.status) && a.due_date && a.due_date < new Date().toISOString().slice(0, 10) };
  });

  api(app, 'POST', '/api/assignments/:id/modules/:moduleId/complete', { params: z.object({ id: zId, moduleId: z.string().max(40) }) }, async ({ db, actor, params, ip }) => {
    const a = await assignmentFor(db, actor, params.id);
    if (a.user_id !== actor.id) throw forbidden();
    if (!['not_started', 'in_progress'].includes(a.status)) throw conflict('この研修は受講中ではありません');
    const m = (a.modules as Module[]).find((x) => x.id === params.moduleId);
    if (!m) throw notFound();
    if (m.type === 'quiz') throw badRequest('テストは合格すると完了になります');
    const done = new Set((await db.q(sql`SELECT module_id FROM module_progress WHERE assignment_id = ${params.id}`)).map((r: any) => r.module_id));
    if (lockedModules(a.modules, done, a.sequential).has(m.id)) throw conflict('前の必須モジュールを先に完了してください');
    if (m.type === 'document' && m.documentId && !(await db.one(sql`SELECT 1 FROM documents d WHERE d.id = ${m.documentId} AND ${docReadable(actor)}`))) throw forbidden('文書の閲覧権限がありません。研修担当者に連絡してください');
    const ver = m.type === 'document' && m.documentId ? await db.one(sql`SELECT current_version_id FROM documents WHERE id = ${m.documentId}`) : null;
    await db.exec(sql`INSERT INTO module_progress (org_id, assignment_id, module_id, detail) VALUES (${db.orgId}, ${params.id}, ${m.id}, ${JSON.stringify({ documentVersionId: ver?.current_version_id ?? null })}) ON CONFLICT DO NOTHING`);
    await audit(db, actor, 'training.module_complete', { type: 'assignment', id: params.id }, `モジュール「${m.title}」完了`, { moduleId: m.id, type: m.type }, ip);
    const r = await evaluateAssignment(db, actor.settings, params.id, actor);
    return { status: r.status };
  });

  api(app, 'POST', '/api/assignments/:id/waive', { params: idParams, body: z.object({ reason: z.string().max(1000) }) }, async ({ db, actor, params, body, ip }) => {
    need(actor, 'training.manage');
    if (!body.reason.trim()) throw badRequest('免除理由を入力してください');
    const a = await db.one(sql`SELECT * FROM training_assignments WHERE id = ${params.id}`);
    if (!a) throw notFound();
    if (!['not_started', 'in_progress'].includes(a.status)) throw conflict('受講中の割り当てのみ免除できます');
    await db.exec(sql`UPDATE training_assignments SET status = 'waived', waived_by = ${actor.id}, waived_reason = ${body.reason}, waived_at = now() WHERE id = ${params.id}`);
    await audit(db, actor, 'training.waive', { type: 'assignment', id: params.id }, '研修を免除', { userId: a.user_id, reason: body.reason }, ip);
    return { ok: true };
  });

  api(app, 'GET', '/api/training/report', { query: z.object({ courseId: zId.optional(), departmentId: zId.optional(), status: z.string().max(20).optional() }) }, async ({ db, actor, query }) => {
    need(actor, 'training.report');
    return db.q(sql`SELECT ta.id, ta.status, ta.due_date, ta.assigned_at, ta.completed_at, ta.waived_reason, ta.source, c.title, cv.version_no, u.name AS user_name, u.id AS user_id,
        (ta.status IN ('not_started','in_progress') AND ta.due_date < current_date) AS overdue,
        (SELECT string_agg(dp.name, ', ') FROM memberships m JOIN departments dp ON dp.id = m.department_id WHERE m.user_id = u.id) AS departments
      FROM training_assignments ta JOIN courses c ON c.id = ta.course_id JOIN course_versions cv ON cv.id = ta.course_version_id JOIN users u ON u.id = ta.user_id
      WHERE (${query.courseId ?? null}::uuid IS NULL OR ta.course_id = ${query.courseId ?? null}::uuid)
        AND (${query.departmentId ?? null}::uuid IS NULL OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id AND m.department_id = ${query.departmentId ?? null}::uuid))
        AND (${query.status ?? null}::text IS NULL OR (CASE WHEN ${query.status ?? ''} = 'overdue' THEN ta.status IN ('not_started','in_progress') AND ta.due_date < current_date ELSE ta.status = ${query.status ?? ''} END))
      ORDER BY c.title, u.name LIMIT 5000`);
  });

  /** Skill matrix: training / procedure-mastery visibility only (not an HR evaluation). */
  api(app, 'GET', '/api/training/skills', { query: z.object({ departmentId: zId.optional() }) }, async ({ db, actor, query }) => {
    need(actor, 'training.report');
    const courses = await db.q(sql`SELECT id, title FROM courses WHERE status = 'published' ORDER BY title`);
    const users = await db.q(sql`SELECT u.id, u.name FROM users u WHERE u.status = 'active' AND NOT u.is_external
        AND (${query.departmentId ?? null}::uuid IS NULL OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id AND m.department_id = ${query.departmentId ?? null}::uuid)) ORDER BY u.name LIMIT 1000`);
    const cells = await db.q(sql`SELECT DISTINCT ON (ta.user_id, ta.course_id) ta.user_id, ta.course_id, ta.status, ta.due_date, ce.expires_at
        FROM training_assignments ta LEFT JOIN certificates ce ON ce.assignment_id = ta.id
       WHERE ta.user_id = ANY(${users.map((u) => u.id)}::uuid[]) AND ta.status <> 'cancelled'
       ORDER BY ta.user_id, ta.course_id, (ta.status = 'completed') DESC, ta.assigned_at DESC`);
    const today = new Date().toISOString();
    const matrix: Record<string, Record<string, string>> = {};
    for (const c of cells) {
      const st = c.status === 'completed' ? (c.expires_at && c.expires_at.toISOString?.() < today ? 'expired' : 'completed')
        : c.status === 'waived' ? 'waived' : c.status === 'in_progress' || c.status === 'not_started' ? (c.due_date && c.due_date < today.slice(0, 10) ? 'overdue' : 'in_progress') : 'not_assigned';
      (matrix[c.user_id] ??= {})[c.course_id] = st;
    }
    return { courses, users, matrix };
  });

  // ============================================================== quizzes
  api(app, 'GET', '/api/quizzes', {}, async ({ db, actor }) => {
    need(actor, 'training.manage');
    return db.q(sql`SELECT q.id, q.title, q.status, q.updated_at, v.version_no, jsonb_array_length(coalesce(v.questions,'[]'::jsonb)) AS question_count,
        EXISTS (SELECT 1 FROM quiz_versions d WHERE d.quiz_id = q.id AND d.status = 'draft') AS has_draft
      FROM quizzes q LEFT JOIN quiz_versions v ON v.id = q.current_version_id ORDER BY q.updated_at DESC`);
  });

  api(app, 'POST', '/api/quizzes', { body: z.object({ title: z.string().trim().min(1).max(200) }) }, async ({ db, actor, body, ip }) => {
    need(actor, 'training.manage');
    const q = await db.one(sql`INSERT INTO quizzes (org_id, title, owner_id) VALUES (${db.orgId}, ${body.title}, ${actor.id}) RETURNING *`);
    await db.exec(sql`INSERT INTO quiz_versions (org_id, quiz_id, version_no, settings, created_by) VALUES (${db.orgId}, ${q.id}, 1, ${JSON.stringify(quizSettingsSchema.parse({}))}, ${actor.id})`);
    await audit(db, actor, 'quiz.create', { type: 'quiz', id: q.id }, `テスト「${body.title}」を作成`, {}, ip);
    return q;
  });

  api(app, 'GET', '/api/quizzes/:id', { params: idParams }, async ({ db, actor, params }) => {
    need(actor, 'training.manage');
    const q = await db.one(sql`SELECT * FROM quizzes WHERE id = ${params.id}`);
    if (!q) throw notFound();
    const versions = await db.q(sql`SELECT v.*, (SELECT count(*)::int FROM quiz_attempts a WHERE a.quiz_version_id = v.id) AS attempts FROM quiz_versions v WHERE v.quiz_id = ${params.id} ORDER BY v.version_no DESC`);
    return { quiz: q, versions };
  });

  api(app, 'PUT', '/api/quizzes/:id/draft', { params: idParams, body: z.object({ title: z.string().trim().min(1).max(200).optional(), questions: z.array(questionSchema).max(200), settings: quizSettingsSchema }) },
    async ({ db, actor, params, body }) => {
      need(actor, 'training.manage');
      const q = await db.one(sql`SELECT * FROM quizzes WHERE id = ${params.id}`);
      if (!q) throw notFound();
      let d = await db.one(sql`SELECT * FROM quiz_versions WHERE quiz_id = ${params.id} AND status = 'draft'`);
      if (!d) {
        const n = await db.one(sql`SELECT max(version_no) AS m FROM quiz_versions WHERE quiz_id = ${params.id}`);
        d = await db.one(sql`INSERT INTO quiz_versions (org_id, quiz_id, version_no, created_by) VALUES (${db.orgId}, ${params.id}, ${(n.m ?? 0) + 1}, ${actor.id}) RETURNING *`);
      }
      const prev = new Map((d.questions as Question[]).map((x) => [x.id, x]));
      if (new Set(body.questions.map((x) => x.id)).size !== body.questions.length) throw badRequest('問題 ID が重複しています');
      const questions = body.questions.map((x) => {
        const p = prev.get(x.id);
        // AI flag cannot be cleared by the client; the human review is recorded with who/when.
        const aiGenerated = x.aiGenerated || !!p?.aiGenerated;
        const reviewed = aiGenerated ? x.reviewed : true;
        return { ...x, aiGenerated, reviewed, reviewedBy: reviewed ? (p?.reviewed ? p.reviewedBy : actor.name) : null, reviewedAt: reviewed ? (p?.reviewed ? p.reviewedAt : new Date().toISOString()) : null };
      });
      if (body.title) await db.exec(sql`UPDATE quizzes SET title = ${body.title}, updated_at = now() WHERE id = ${params.id}`);
      return db.one(sql`UPDATE quiz_versions SET questions = ${JSON.stringify(questions)}, settings = ${JSON.stringify(body.settings)}, updated_at = now() WHERE id = ${d.id} RETURNING *`);
    });

  api(app, 'POST', '/api/quizzes/:id/ai-draft', { params: idParams, body: z.object({ versionId: zId, count: z.number().int().min(1).max(20).default(5) }) }, async ({ db, actor, params, body, ip }) => {
    need(actor, 'training.manage');
    if (!(await db.one(sql`SELECT 1 FROM quizzes WHERE id = ${params.id}`))) throw notFound();
    const qs = await draftQuiz(db, actor, body.versionId, body.count);
    await audit(db, actor, 'ai.quiz_draft', { type: 'quiz', id: params.id }, `AIでテスト問題の下書きを ${qs.length} 問作成（未確認）`, { sourceVersionId: body.versionId, provider: actor.settings.ai.provider }, ip);
    return { questions: qs };
  });

  api(app, 'POST', '/api/quizzes/:id/publish', { params: idParams }, async ({ db, actor, params, ip }) => {
    need(actor, 'training.manage');
    const q = await db.one(sql`SELECT * FROM quizzes WHERE id = ${params.id} FOR UPDATE`);
    if (!q) throw notFound();
    const d = await db.one(sql`SELECT * FROM quiz_versions WHERE quiz_id = ${params.id} AND status = 'draft'`);
    if (!d) throw conflict('公開する下書きがありません');
    const qs = d.questions as Question[];
    if (!qs.length) throw badRequest('問題を1問以上追加してください');
    const unreviewed = qs.filter((x) => x.aiGenerated && !x.reviewed);
    if (unreviewed.length) throw badRequest(`AIが作成した問題のうち ${unreviewed.length} 問が未確認です。内容・正解・根拠を確認してから公開してください`);
    qs.forEach((x) => validateQuestion(x));
    if (q.current_version_id) await db.exec(sql`UPDATE quiz_versions SET status = 'superseded' WHERE id = ${q.current_version_id}`);
    await db.exec(sql`UPDATE quiz_versions SET status = 'published', published_at = now(), published_by = ${actor.id} WHERE id = ${d.id}`);
    await db.exec(sql`UPDATE quizzes SET current_version_id = ${d.id}, status = 'published', updated_at = now() WHERE id = ${params.id}`);
    await audit(db, actor, 'quiz.publish', { type: 'quiz', id: params.id }, `テスト「${q.title}」v${d.version_no} を公開`, { questions: qs.length, aiQuestions: qs.filter((x) => x.aiGenerated).length }, ip);
    return { ok: true, version: d.version_no };
  });

  // ============================================================== attempts
  api(app, 'POST', '/api/quizzes/:id/attempts', { params: idParams, body: z.object({ assignmentId: zId.nullable().optional(), moduleId: z.string().max(40).nullable().optional() }) },
    async ({ db, actor, params, body }) => {
      const r = await startAttempt(db, actor, params.id, body.assignmentId ?? null, body.moduleId ?? null);
      if (body.assignmentId) await db.exec(sql`UPDATE training_assignments SET status = 'in_progress', started_at = coalesce(started_at, now()) WHERE id = ${body.assignmentId} AND status = 'not_started'`);
      return r;
    });

  api(app, 'GET', '/api/attempts/:id', { params: idParams }, async ({ db, actor, params }) => {
    const at = await db.one(sql`SELECT * FROM quiz_attempts WHERE id = ${params.id}`);
    if (!at || (at.user_id !== actor.id && !has(actor, 'training.report'))) throw notFound();
    return attemptView(db, at);
  });

  api(app, 'POST', '/api/attempts/:id/submit', { params: idParams, body: z.object({ answers: z.record(z.string().max(40), z.union([z.string().max(2000), z.array(z.string().max(40)).max(8), z.boolean()])) }) },
    async ({ db, actor, params, body, ip }) => submitAttempt(db, actor, params.id, body.answers, ip));

  api(app, 'GET', '/api/attempts', { query: z.object({ status: z.enum(['pending_review']).default('pending_review') }) }, async ({ db, actor }) => {
    need(actor, 'training.manage');
    return db.q(sql`SELECT a.id, a.submitted_at, u.name AS user_name, q.title FROM quiz_attempts a JOIN users u ON u.id = a.user_id JOIN quizzes q ON q.id = a.quiz_id WHERE a.status = 'pending_review' ORDER BY a.submitted_at`);
  });

  /** Manual grading of short-text answers. */
  api(app, 'POST', '/api/attempts/:id/grade', { params: idParams, body: z.object({ grades: z.record(z.string().max(40), z.boolean()) }) }, async ({ db, actor, params, body, ip }) => {
    need(actor, 'training.manage');
    const at = await db.one(sql`SELECT * FROM quiz_attempts WHERE id = ${params.id} FOR UPDATE`);
    if (!at || at.status !== 'pending_review') throw notFound();
    if (at.user_id === actor.id) throw forbidden('自分の回答は採点できません');
    const v = await db.one(sql`SELECT questions, settings FROM quiz_versions WHERE id = ${at.quiz_version_id}`);
    const settings = quizSettingsSchema.parse(v.settings);
    const detail = at.graded_detail as Record<string, { correct: boolean | null; points: number }>;
    let score = 0;
    for (const q of v.questions as Question[]) {
      if (detail[q.id]?.correct === null) {
        if (body.grades[q.id] === undefined) throw badRequest('すべての記述問題を採点してください');
        detail[q.id] = { correct: body.grades[q.id], points: body.grades[q.id] ? q.points : 0 };
      }
      score += detail[q.id].points;
    }
    const result = at.max_score && (score / at.max_score) * 100 >= settings.passScore ? 'pass' : 'fail';
    const done = await db.one(sql`UPDATE quiz_attempts SET status = 'submitted', score = ${score}, result = ${result}, graded_detail = ${JSON.stringify(detail)} WHERE id = ${params.id} RETURNING *`);
    await afterGraded(db, actor.settings, done, actor);
    await audit(db, actor, 'quiz.grade', { type: 'quiz_attempt', id: params.id }, `記述問題を採点（${result}）`, { userId: at.user_id }, ip);
    return { result, score };
  });

  // ============================================================== certificates (internal training completion records; not a qualification)
  api(app, 'GET', '/api/certificates', { query: z.object({ userId: zId.optional() }) }, async ({ db, actor, query }) => {
    const uid = query.userId && has(actor, 'training.report') ? query.userId : actor.id;
    return db.q(sql`SELECT ce.id, ce.completed_at, ce.expires_at, ce.verification_code, c.title, cv.version_no FROM certificates ce
      JOIN courses c ON c.id = ce.course_id JOIN course_versions cv ON cv.id = ce.course_version_id WHERE ce.user_id = ${uid} ORDER BY ce.completed_at DESC`);
  });

  api(app, 'GET', '/api/certificates/verify/:code', { params: z.object({ code: z.string().max(20) }) }, async ({ db, actor, params }) => {
    if (actor.isExternal) throw forbidden();
    const ce = await db.one(sql`SELECT ce.*, u.name, c.title, cv.version_no FROM certificates ce JOIN users u ON u.id = ce.user_id JOIN courses c ON c.id = ce.course_id
      JOIN course_versions cv ON cv.id = ce.course_version_id WHERE ce.verification_code = ${params.code.toUpperCase()}`);
    if (!ce) return { valid: false };
    const sigOk = safeEqual(ce.signature, hmac(`${ce.id}|${ce.user_id}|${ce.course_version_id}|${new Date(ce.completed_at).toISOString()}`));
    return { valid: sigOk, name: ce.name, course: ce.title, version: ce.version_no, completedAt: ce.completed_at, expiresAt: ce.expires_at, expired: !!ce.expires_at && new Date(ce.expires_at) < new Date() };
  });

  api(app, 'GET', '/api/certificates/:id/pdf', { params: idParams }, async ({ db, actor, params, reply, ip }) => {
    const ce = await db.one(sql`SELECT ce.*, u.name, c.title, cv.version_no, o.name AS org_name FROM certificates ce JOIN users u ON u.id = ce.user_id JOIN courses c ON c.id = ce.course_id
      JOIN course_versions cv ON cv.id = ce.course_version_id JOIN organizations o ON o.id = ce.org_id WHERE ce.id = ${params.id}`);
    if (!ce || (ce.user_id !== actor.id && !has(actor, 'training.report'))) throw notFound();
    const doc = newPdf({ title: '研修完了証', landscape: true });
    const W = doc.page.width;
    doc.rect(30, 30, W - 60, doc.page.height - 60).lineWidth(2).stroke('#1D4ED8');
    doc.font('jp-bold').fontSize(30).fillColor('#0B1A33').text('社内研修 完了証', 0, 100, { align: 'center', width: W });
    doc.font('jp').fontSize(12).fillColor('#475569').text('Operate — Training Completion Record', 0, 145, { align: 'center', width: W });
    doc.font('jp-bold').fontSize(24).fillColor('#0B1A33').text(`${ce.name} 殿`, 0, 200, { align: 'center', width: W });
    doc.font('jp').fontSize(15).text(`研修コース「${ce.title}」（v${ce.version_no}）を修了したことを記録します。`, 0, 255, { align: 'center', width: W });
    doc.fontSize(12).fillColor('#334155');
    doc.text(`修了日: ${new Date(ce.completed_at).toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' })}`, 0, 310, { align: 'center', width: W });
    if (ce.expires_at) doc.text(`有効期限: ${new Date(ce.expires_at).toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' })}`, { align: 'center', width: W });
    doc.text(`発行: ${ce.org_name}`, { align: 'center', width: W });
    doc.page.margins.bottom = 0;
    doc.fontSize(9).fillColor('#64748B').text(`照合コード: ${ce.verification_code}（Operate の「研修完了証の照合」で確認できます）`, 0, doc.page.height - 110, { align: 'center', width: W });
    doc.text('本書は社内研修の完了記録であり、公的な資格・認証を証明するものではありません。', { align: 'center', width: W });
    const buf = await pdfToBuffer(doc);
    await audit(db, actor, 'export.certificate', { type: 'certificate', id: ce.id }, '研修完了証PDFを出力', {}, ip);
    reply.header('Content-Type', 'application/pdf').header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`完了証_${ce.title}.pdf`)}`);
    return reply.send(buf);
  });

  // ============================================================== onboarding
  const onbItem = z.object({ courseId: zId, offsetDays: z.number().int().min(0).max(365), label: z.string().trim().min(1).max(40) });
  const onbBody = z.object({ name: z.string().trim().min(1).max(100), role: z.string().max(30).nullable().optional(), departmentId: zId.nullable().optional(), items: z.array(onbItem).max(50) });

  api(app, 'GET', '/api/onboarding/templates', {}, async ({ db, actor }) => {
    need(actor, 'training.manage');
    return db.q(sql`SELECT t.*, (SELECT count(*)::int FROM onboarding_runs r WHERE r.template_id = t.id) AS runs FROM onboarding_templates t ORDER BY t.name`);
  });
  api(app, 'POST', '/api/onboarding/templates', { body: onbBody }, async ({ db, actor, body, ip }) => {
    need(actor, 'training.manage');
    const t = await db.one(sql`INSERT INTO onboarding_templates (org_id, name, role, department_id, items, created_by) VALUES (${db.orgId}, ${body.name}, ${body.role ?? null}, ${body.departmentId ?? null}, ${JSON.stringify(body.items)}, ${actor.id}) RETURNING *`);
    await audit(db, actor, 'onboarding.template_create', { type: 'onboarding_template', id: t.id }, `オンボーディング「${body.name}」を作成`, {}, ip);
    return t;
  });
  api(app, 'PUT', '/api/onboarding/templates/:id', { params: idParams, body: onbBody }, async ({ db, actor, params, body, ip }) => {
    need(actor, 'training.manage');
    // Existing runs keep their snapshot; already-created assignments are not changed.
    const t = await db.one(sql`UPDATE onboarding_templates SET name = ${body.name}, role = ${body.role ?? null}, department_id = ${body.departmentId ?? null}, items = ${JSON.stringify(body.items)}, updated_at = now() WHERE id = ${params.id} RETURNING *`);
    if (!t) throw notFound();
    await audit(db, actor, 'onboarding.template_update', { type: 'onboarding_template', id: t.id }, `オンボーディング「${body.name}」を更新`, {}, ip);
    return t;
  });
  api(app, 'POST', '/api/onboarding/runs', { body: z.object({ templateId: zId, userId: zId, startDate: zDate }) }, async ({ db, actor, body, ip }) => {
    need(actor, 'training.manage');
    const t = await db.one(sql`SELECT * FROM onboarding_templates WHERE id = ${body.templateId}`);
    if (!t) throw notFound();
    const u = await db.one(sql`SELECT id, name FROM users WHERE id = ${body.userId} AND status = 'active' AND NOT is_external`);
    if (!u) throw badRequest('対象ユーザーが見つかりません');
    const run = await db.one(sql`INSERT INTO onboarding_runs (org_id, template_id, template_snapshot, user_id, start_date, created_by) VALUES (${db.orgId}, ${t.id}, ${JSON.stringify(t.items)}, ${u.id}, ${body.startDate}, ${actor.id})
      ON CONFLICT (template_id, user_id) DO NOTHING RETURNING *`);
    if (!run) throw conflict('このユーザーには既にこのオンボーディングを開始しています');
    const results = [];
    for (const it of t.items as z.infer<typeof onbItem>[]) {
      const due = new Date(new Date(body.startDate + 'T00:00:00Z').getTime() + it.offsetDays * 86400000).toISOString().slice(0, 10);
      const r = await assignCourse(db, actor, actor.settings, it.courseId, [u.id], { dueDate: due, source: 'onboarding', sourceRef: run.id }).catch((e) => ({ error: e.message }));
      results.push({ ...it, due, ...r });
    }
    await audit(db, actor, 'onboarding.start', { type: 'onboarding_run', id: run.id }, `${u.name} さんのオンボーディング「${t.name}」を開始`, { startDate: body.startDate }, ip);
    return { run, results };
  });
  api(app, 'GET', '/api/onboarding/runs', {}, async ({ db, actor }) => {
    need(actor, 'training.report');
    return db.q(sql`SELECT r.id, r.start_date, r.created_at, t.name AS template_name, u.name AS user_name, u.id AS user_id,
        (SELECT count(*)::int FROM training_assignments ta WHERE ta.source = 'onboarding' AND ta.source_ref = r.id::text) AS total,
        (SELECT count(*)::int FROM training_assignments ta WHERE ta.source = 'onboarding' AND ta.source_ref = r.id::text AND ta.status = 'completed') AS completed,
        (SELECT count(*)::int FROM training_assignments ta WHERE ta.source = 'onboarding' AND ta.source_ref = r.id::text AND ta.status IN ('not_started','in_progress') AND ta.due_date < current_date) AS overdue
      FROM onboarding_runs r JOIN onboarding_templates t ON t.id = r.template_id JOIN users u ON u.id = r.user_id ORDER BY r.created_at DESC LIMIT 300`);
  });
}
