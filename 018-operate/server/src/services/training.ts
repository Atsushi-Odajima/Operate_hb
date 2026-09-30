import { randomInt } from 'node:crypto';
import { z } from 'zod';
import type { Db } from '../db/pool.js';
import { has, type Actor } from '../lib/authz.js';
import { hmac, token } from '../lib/crypto.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import type { OrgSettings } from '../lib/settings.js';
import { sql } from '../lib/sql.js';
import { audit } from './audit.js';
import { notify } from './notify.js';

// ------------------------------------------------------------------------------------------ course modules
export const moduleSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  type: z.enum(['document', 'text', 'video', 'quiz', 'acknowledgement']),
  title: z.string().trim().min(1).max(200),
  required: z.boolean().default(true),
  documentId: z.string().uuid().nullable().optional(),
  quizId: z.string().uuid().nullable().optional(),
  text: z.string().max(20000).optional(),
  url: z.string().url().max(1000).regex(/^https:\/\//, '動画リンクは https のURLにしてください').nullable().optional(),
});
export type Module = z.infer<typeof moduleSchema>;

// ------------------------------------------------------------------------------------------ quiz questions
export const questionSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  type: z.enum(['single', 'multiple', 'truefalse', 'short']),
  prompt: z.string().trim().min(1).max(2000),
  choices: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,20}$/), text: z.string().trim().min(1).max(500) })).max(8).default([]),
  correct: z.array(z.string().max(500)).max(8).default([]),
  explanation: z.string().max(3000).default(''),
  sourceDocumentId: z.string().uuid().nullable().optional(),
  sourceVersionId: z.string().uuid().nullable().optional(),
  sourceSection: z.string().max(200).default(''),
  points: z.number().min(0).max(100).default(1),
  aiGenerated: z.boolean().default(false),
  reviewed: z.boolean().default(false),
  reviewedBy: z.string().nullable().optional(),
  reviewedAt: z.string().nullable().optional(),
});
export type Question = z.infer<typeof questionSchema>;

export const quizSettingsSchema = z.object({
  passScore: z.number().min(0).max(100).default(80),
  maxAttempts: z.number().int().min(0).max(100).default(3), // 0 = unlimited
  cooldownMinutes: z.number().int().min(0).max(10080).default(0),
  shuffleQuestions: z.boolean().default(true),
  shuffleChoices: z.boolean().default(true),
  showExplanation: z.enum(['after_submit', 'after_pass', 'never']).default('after_submit'),
});
export type QuizSettings = z.infer<typeof quizSettingsSchema>;

export function validateQuestion(q: Question): Question {
  const ids = new Set(q.choices.map((c) => c.id));
  if (ids.size !== q.choices.length) throw badRequest('選択肢の ID が重複しています');
  if (q.type === 'truefalse') {
    q.choices = [{ id: 'true', text: '正しい' }, { id: 'false', text: '誤り' }];
    if (q.correct.length !== 1 || !['true', 'false'].includes(q.correct[0])) throw badRequest(`「${q.prompt.slice(0, 20)}」: 正解（正しい/誤り）を選んでください`);
  } else if (q.type === 'single' || q.type === 'multiple') {
    if (q.choices.length < 2) throw badRequest(`「${q.prompt.slice(0, 20)}」: 選択肢を2つ以上入力してください`);
    if (!q.correct.length || q.correct.some((c) => !ids.has(c))) throw badRequest(`「${q.prompt.slice(0, 20)}」: 正解を選んでください`);
    if (q.type === 'single' && q.correct.length !== 1) throw badRequest(`「${q.prompt.slice(0, 20)}」: 単一選択の正解は1つです`);
  } else {
    q.choices = [];
  }
  return q;
}

function shuffle<T>(xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function publicQuestion(q: Question, choiceOrder?: string[]) {
  const choices = choiceOrder ? choiceOrder.map((id) => q.choices.find((c) => c.id === id)!).filter(Boolean) : q.choices;
  return { id: q.id, type: q.type, prompt: q.prompt, choices, points: q.points };
}

// ------------------------------------------------------------------------------------------ grading
export function grade(questions: Question[], answers: Record<string, unknown>) {
  let score = 0;
  let max = 0;
  let pendingManual = false;
  const detail: Record<string, { correct: boolean | null; points: number }> = {};
  for (const q of questions) {
    max += q.points;
    const a = answers[q.id];
    let ok: boolean | null;
    if (q.type === 'short') {
      const text = typeof a === 'string' ? a.normalize('NFKC').trim().toLowerCase() : '';
      if (q.correct.length) ok = q.correct.some((c) => c.normalize('NFKC').trim().toLowerCase() === text);
      else { ok = null; pendingManual = true; }
    } else {
      const given = (Array.isArray(a) ? a : a === undefined || a === null ? [] : [a]).map(String);
      const want = new Set(q.correct);
      ok = given.length === want.size && given.every((g) => want.has(g));
    }
    const pts = ok ? q.points : 0;
    score += pts;
    detail[q.id] = { correct: ok, points: pts };
  }
  return { score, max, pendingManual, detail };
}

// ------------------------------------------------------------------------------------------ completion
export async function evaluateAssignment(db: Db, settings: OrgSettings, assignmentId: string, actor: Pick<Actor, 'id' | 'name'> | null) {
  const a = await db.one(sql`SELECT ta.*, cv.modules, c.title, c.validity_days FROM training_assignments ta
      JOIN course_versions cv ON cv.id = ta.course_version_id JOIN courses c ON c.id = ta.course_id WHERE ta.id = ${assignmentId} FOR UPDATE OF ta`);
  if (!a || ['completed', 'waived', 'cancelled'].includes(a.status)) return a;
  const done = new Set((await db.q(sql`SELECT module_id FROM module_progress WHERE assignment_id = ${assignmentId}`)).map((r) => r.module_id));
  const required = (a.modules as Module[]).filter((m) => m.required);
  if (required.length && required.every((m) => done.has(m.id))) {
    await db.exec(sql`UPDATE training_assignments SET status = 'completed', completed_at = now(), started_at = coalesce(started_at, now()) WHERE id = ${assignmentId}`);
    const quizScores = await db.q(sql`SELECT qa.quiz_id, max(qa.score / nullif(qa.max_score, 0) * 100) AS pct FROM quiz_attempts qa
        WHERE qa.assignment_id = ${assignmentId} AND qa.result = 'pass' GROUP BY qa.quiz_id`);
    const code = token(8).replace(/[-_]/g, 'x').slice(0, 10).toUpperCase();
    const completedAt = new Date().toISOString();
    const certId = (await db.one(sql`SELECT gen_random_uuid() AS id`)).id;
    await db.exec(sql`INSERT INTO certificates (id, org_id, user_id, course_id, course_version_id, assignment_id, completed_at, score_summary, expires_at, verification_code, signature)
      VALUES (${certId}, ${db.orgId}, ${a.user_id}, ${a.course_id}, ${a.course_version_id}, ${assignmentId}, ${completedAt}, ${JSON.stringify(quizScores)},
        CASE WHEN ${a.validity_days}::int IS NULL THEN NULL ELSE ${completedAt}::timestamptz + make_interval(days => ${a.validity_days ?? 0}) END,
        ${code}, ${hmac(`${certId}|${a.user_id}|${a.course_version_id}|${completedAt}`)}) ON CONFLICT (assignment_id) DO NOTHING`);
    await notify(db, settings, [a.user_id], { type: 'course_completed', title: `研修「${a.title}」を修了しました`, link: `/training`, key: `completed:${assignmentId}` });
    await audit(db, actor, 'training.completed', { type: 'assignment', id: assignmentId }, `研修「${a.title}」修了`, { userId: a.user_id, courseVersionId: a.course_version_id });
  } else if (done.size && a.status === 'not_started') {
    await db.exec(sql`UPDATE training_assignments SET status = 'in_progress', started_at = coalesce(started_at, now()) WHERE id = ${assignmentId}`);
  }
  return db.one(sql`SELECT * FROM training_assignments WHERE id = ${assignmentId}`);
}

/** Sequential courses: a module is locked until every earlier REQUIRED module is complete. */
export function lockedModules(modules: Module[], done: Set<string>, sequential: boolean): Set<string> {
  const locked = new Set<string>();
  if (!sequential) return locked;
  let blocked = false;
  for (const m of modules) {
    if (blocked) locked.add(m.id);
    if (m.required && !done.has(m.id)) blocked = true;
  }
  return locked;
}

export async function resolveAssignees(db: Db, t: { userIds?: string[]; departmentIds?: string[]; teamIds?: string[]; roles?: string[] }) {
  const rows = await db.q(sql`SELECT DISTINCT u.id FROM users u WHERE u.status = 'active' AND (
      u.id = ANY(${t.userIds ?? []}::uuid[])
      OR (NOT u.is_external AND EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id AND (m.department_id = ANY(${t.departmentIds ?? []}::uuid[]) OR m.team_id = ANY(${t.teamIds ?? []}::uuid[]))))
      OR (NOT u.is_external AND EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.role = ANY(${t.roles ?? []}::text[]))))`);
  return rows.map((r) => r.id as string);
}

export async function assignCourse(db: Db, actor: Actor | null, settings: OrgSettings, courseId: string, userIds: string[],
  opts: { dueDate?: string | null; source: string; sourceRef?: string | null }) {
  const c = await db.one(sql`SELECT * FROM courses WHERE id = ${courseId}`);
  if (!c) throw notFound();
  if (c.status !== 'published' || !c.current_version_id) throw conflict('公開中のコースのみ割り当てできます');
  const due = opts.dueDate ?? (c.due_days ? new Date(Date.now() + c.due_days * 86400000).toISOString().slice(0, 10) : null);
  const inserted = await db.q(sql`INSERT INTO training_assignments (org_id, course_id, course_version_id, user_id, source, source_ref, assigned_by, due_date)
      SELECT ${db.orgId}, ${courseId}, ${c.current_version_id}, u, ${opts.source}, ${opts.sourceRef ?? null}, ${actor?.id ?? null}, ${due}::date FROM unnest(${userIds}::uuid[]) u
      ON CONFLICT (course_version_id, user_id) DO NOTHING RETURNING id, user_id`);
  if (inserted.length) {
    await notify(db, settings, inserted.map((r) => r.user_id), { type: 'course_assigned', title: `研修「${c.title}」が割り当てられました${due ? `（期限 ${due}）` : ''}`, link: '/training', key: `assign:${c.current_version_id}` });
    await audit(db, actor, 'training.assign', { type: 'course', id: courseId }, `研修「${c.title}」を ${inserted.length} 名に割り当て`, { source: opts.source, due, count: inserted.length });
  }
  return { assigned: inserted.length, skipped: userIds.length - inserted.length };
}

// ------------------------------------------------------------------------------------------ attempts
export async function startAttempt(db: Db, a: Actor, quizId: string, assignmentId: string | null, moduleId: string | null) {
  const qz = await db.one(sql`SELECT q.*, v.id AS vid, v.questions, v.settings FROM quizzes q JOIN quiz_versions v ON v.id = q.current_version_id WHERE q.id = ${quizId} AND q.status = 'published'`);
  if (!qz) throw notFound();
  if (assignmentId) {
    const asg = await db.one(sql`SELECT ta.*, cv.modules, cv.sequential FROM training_assignments ta JOIN course_versions cv ON cv.id = ta.course_version_id WHERE ta.id = ${assignmentId} AND ta.user_id = ${a.id}`);
    if (!asg) throw notFound();
    if (!['not_started', 'in_progress'].includes(asg.status)) throw conflict('この研修は受講中ではありません');
    const mod = (asg.modules as Module[]).find((m) => m.id === moduleId && m.type === 'quiz' && m.quizId === quizId);
    if (!mod) throw badRequest('コースのテストではありません');
    const done = new Set((await db.q(sql`SELECT module_id FROM module_progress WHERE assignment_id = ${assignmentId}`)).map((r) => r.module_id));
    if (lockedModules(asg.modules, done, asg.sequential).has(mod.id)) throw conflict('前の必須モジュールを先に完了してください');
  } else if (!has(a, 'training.manage')) {
    // stand-alone practice attempts are allowed only for trainers (preview); learners take quizzes through a course
    throw forbidden('このテストはコースから受験してください');
  }
  const open = await db.one(sql`SELECT * FROM quiz_attempts WHERE quiz_id = ${quizId} AND user_id = ${a.id} AND status = 'in_progress'
      AND assignment_id IS NOT DISTINCT FROM ${assignmentId}::uuid ORDER BY started_at DESC LIMIT 1`);
  if (open) return attemptView(db, open, qz.questions);
  const settings = quizSettingsSchema.parse(qz.settings);
  const prev = await db.one(sql`SELECT count(*)::int AS n, max(submitted_at) AS last, bool_or(result = 'pass') AS passed FROM quiz_attempts
      WHERE quiz_id = ${quizId} AND user_id = ${a.id} AND status <> 'in_progress' AND assignment_id IS NOT DISTINCT FROM ${assignmentId}::uuid`);
  if (prev.passed && assignmentId) throw conflict('既に合格しています');
  if (settings.maxAttempts && prev.n >= settings.maxAttempts) throw new AppError(409, 'attempts_exhausted', `受験回数の上限（${settings.maxAttempts}回）に達しました。研修担当者に相談してください`);
  if (settings.cooldownMinutes && prev.last && Date.now() - new Date(prev.last).getTime() < settings.cooldownMinutes * 60000) {
    const wait = Math.ceil((settings.cooldownMinutes * 60000 - (Date.now() - new Date(prev.last).getTime())) / 60000);
    throw new AppError(409, 'cooldown', `再受験まで あと約${wait}分 お待ちください`);
  }
  const qs = qz.questions as Question[];
  const order = (settings.shuffleQuestions ? shuffle(qs) : qs).map((q) => ({ id: q.id, choices: settings.shuffleChoices && q.type !== 'truefalse' ? shuffle(q.choices.map((c) => c.id)) : q.choices.map((c) => c.id) }));
  const at = await db.one(sql`INSERT INTO quiz_attempts (org_id, quiz_id, quiz_version_id, user_id, assignment_id, module_id, question_order)
      VALUES (${db.orgId}, ${quizId}, ${qz.vid}, ${a.id}, ${assignmentId}, ${moduleId}, ${JSON.stringify(order)}) RETURNING *`);
  return attemptView(db, at, qs);
}

export async function attemptView(db: Db, at: any, questions?: Question[]) {
  const v = questions ? { questions, settings: null } : await db.one(sql`SELECT questions, settings FROM quiz_versions WHERE id = ${at.quiz_version_id}`);
  const settings = quizSettingsSchema.parse(v.settings ?? (await db.one(sql`SELECT settings FROM quiz_versions WHERE id = ${at.quiz_version_id}`)).settings);
  const qs = v.questions as Question[];
  const order = at.question_order as { id: string; choices: string[] }[];
  const base = {
    id: at.id, quizId: at.quiz_id, quizVersionId: at.quiz_version_id, status: at.status, startedAt: at.started_at, submittedAt: at.submitted_at,
    assignmentId: at.assignment_id, moduleId: at.module_id, passScore: settings.passScore,
    questions: order.map((o) => publicQuestion(qs.find((q) => q.id === o.id)!, o.choices)),
  };
  if (at.status === 'in_progress') return base;
  const reveal = settings.showExplanation === 'after_submit' || (settings.showExplanation === 'after_pass' && at.result === 'pass');
  return {
    ...base, answers: at.answers, score: at.score, maxScore: at.max_score, result: at.result,
    percent: at.max_score ? Math.round((at.score / at.max_score) * 1000) / 10 : 0,
    review: reveal
      ? qs.map((q) => ({ id: q.id, correct: at.graded_detail?.[q.id]?.correct ?? null, correctAnswer: q.correct, explanation: q.explanation, sourceSection: q.sourceSection, sourceVersionId: q.sourceVersionId }))
      : qs.map((q) => ({ id: q.id, correct: at.graded_detail?.[q.id]?.correct ?? null })),
  };
}

/** Submit is atomic: only the first submit of an in-progress attempt is graded; re-sends return the stored result. */
export async function submitAttempt(db: Db, a: Actor, attemptId: string, answers: Record<string, unknown>, ip?: string) {
  const at0 = await db.one(sql`SELECT * FROM quiz_attempts WHERE id = ${attemptId} AND user_id = ${a.id}`);
  if (!at0) throw notFound();
  if (at0.status !== 'in_progress') return attemptView(db, at0);
  const v = await db.one(sql`SELECT questions, settings FROM quiz_versions WHERE id = ${at0.quiz_version_id}`);
  const settings = quizSettingsSchema.parse(v.settings);
  const g = grade(v.questions as Question[], answers);
  const pct = g.max ? (g.score / g.max) * 100 : 0;
  const result = g.pendingManual ? 'pending' : pct >= settings.passScore ? 'pass' : 'fail';
  const at = await db.one(sql`UPDATE quiz_attempts SET status = ${g.pendingManual ? 'pending_review' : 'submitted'}, answers = ${JSON.stringify(answers)},
      score = ${g.score}, max_score = ${g.max}, result = ${result}, graded_detail = ${JSON.stringify(g.detail)}, submitted_at = now()
    WHERE id = ${attemptId} AND status = 'in_progress' RETURNING *`);
  if (!at) return attemptView(db, await db.one(sql`SELECT * FROM quiz_attempts WHERE id = ${attemptId}`));
  await afterGraded(db, a.settings, at, a);
  await audit(db, a, 'quiz.submit', { type: 'quiz_attempt', id: attemptId }, `テスト提出（${result}）`, { quizVersionId: at.quiz_version_id, score: g.score, max: g.max }, ip);
  return attemptView(db, at, v.questions);
}

export async function afterGraded(db: Db, settings: OrgSettings, at: any, actor: Pick<Actor, 'id' | 'name'> | null) {
  if (at.result === 'pass' && at.assignment_id && at.module_id) {
    await db.exec(sql`INSERT INTO module_progress (org_id, assignment_id, module_id, detail) VALUES (${db.orgId}, ${at.assignment_id}, ${at.module_id}, ${JSON.stringify({ attemptId: at.id, score: at.score, max: at.max_score })})
      ON CONFLICT DO NOTHING`);
  }
  if (at.assignment_id) await evaluateAssignment(db, settings, at.assignment_id, actor);
}
