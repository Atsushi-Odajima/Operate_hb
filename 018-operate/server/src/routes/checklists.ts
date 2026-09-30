import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { api, idParams, zId } from '../http.js';
import { has } from '../lib/authz.js';
import type { Content } from '../lib/content.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { sql } from '../lib/sql.js';
import { audit } from '../services/audit.js';
import { getDoc } from '../services/documents.js';

interface RunItem { id: string; text: string; required: boolean; stepId: string | null; checked: boolean; checkedAt: string | null; checkedBy: string | null; note: string }

export function itemsFromContent(c: Content): RunItem[] {
  const base = { checked: false, checkedAt: null, checkedBy: null, note: '' };
  if (c.checklistItems.length) return c.checklistItems.map((x) => ({ id: x.id, text: x.text, required: x.required, stepId: null, ...base }));
  return c.steps.flatMap((s, i) => [
    { id: `${s.id}`, text: `手順${i + 1}: ${s.title}`, required: true, stepId: s.id, ...base },
    ...s.checklist.map((t, j) => ({ id: `${s.id}-c${j + 1}`, text: t, required: true, stepId: s.id, ...base })),
  ]);
}

export default async function checklistRoutes(app: FastifyInstance) {
  api(app, 'POST', '/api/documents/:id/checklist-runs', { params: idParams, body: z.object({ clientKey: z.string().max(80).optional(), assigneeId: zId.optional(), notes: z.string().max(2000).default('') }) },
    async ({ db, actor, params, body, ip }) => {
      const d = await getDoc(db, actor, params.id, 'read');
      if (body.clientKey) {
        const ex = await db.one(sql`SELECT * FROM checklist_runs WHERE client_key = ${body.clientKey}`);
        if (ex) return ex; // idempotent (offline replay)
      }
      const v = await db.one(sql`SELECT id, content FROM document_versions WHERE id = ${d.current_version_id}`);
      const items = itemsFromContent(v.content as Content);
      if (!items.length) throw badRequest('この文書にはチェック項目・手順がありません');
      const assignee = body.assigneeId && body.assigneeId !== actor.id ? (has(actor, 'doc.admin') || has(actor, 'training.manage') ? body.assigneeId : null) : actor.id;
      if (!assignee) throw forbidden('他の人への割り当ては管理者のみ可能です');
      const r = await db.one(sql`INSERT INTO checklist_runs (org_id, document_id, version_id, assignee_id, started_by, client_key, items, notes)
        VALUES (${db.orgId}, ${d.id}, ${v.id}, ${assignee}, ${actor.id}, ${body.clientKey ?? null}, ${JSON.stringify(items)}, ${body.notes}) RETURNING *`);
      await audit(db, actor, 'checklist.start', { type: 'checklist_run', id: r.id }, `チェックリスト「${d.title}」を開始`, { versionId: v.id }, ip);
      return r;
    });

  api(app, 'GET', '/api/checklist-runs', { query: z.object({ documentId: zId.optional(), scope: z.enum(['mine', 'all']).default('mine') }) }, async ({ db, actor, query }) => {
    const all = query.scope === 'all' && (has(actor, 'doc.admin') || has(actor, 'audit.read') || has(actor, 'training.report'));
    return db.q(sql`SELECT r.id, r.document_id, r.version_id, r.status, r.started_at, r.completed_at, r.notes, d.title, v.major, v.minor, u.name AS assignee_name,
        jsonb_array_length(r.items) AS item_count, (SELECT count(*) FROM jsonb_array_elements(r.items) e WHERE (e->>'checked')::boolean)::int AS checked_count
      FROM checklist_runs r JOIN documents d ON d.id = r.document_id JOIN document_versions v ON v.id = r.version_id LEFT JOIN users u ON u.id = r.assignee_id
      WHERE (${all} OR r.assignee_id = ${actor.id} OR r.started_by = ${actor.id})
        AND (${query.documentId ?? null}::uuid IS NULL OR r.document_id = ${query.documentId ?? null}::uuid)
      ORDER BY r.started_at DESC LIMIT 300`);
  });

  async function ownRun(db: any, actor: any, id: string) {
    const r = await db.one(sql`SELECT r.*, d.title FROM checklist_runs r JOIN documents d ON d.id = r.document_id WHERE r.id = ${id}`);
    if (!r) throw notFound();
    if (r.assignee_id !== actor.id && r.started_by !== actor.id && !has(actor, 'doc.admin') && !has(actor, 'audit.read')) throw notFound();
    return r;
  }

  api(app, 'GET', '/api/checklist-runs/:id', { params: idParams }, async ({ db, actor, params }) => {
    const r = await ownRun(db, actor, params.id);
    const v = await db.one(sql`SELECT content, major, minor FROM document_versions WHERE id = ${r.version_id}`);
    return { ...r, steps: (v.content as Content).steps, version: `${v.major}.${v.minor}` };
  });

  api(app, 'PATCH', '/api/checklist-runs/:id', {
    params: idParams, body: z.object({ items: z.array(z.object({ id: z.string().max(80), checked: z.boolean(), note: z.string().max(1000).default(''), at: z.string().datetime({ offset: true }).optional() })).max(500), notes: z.string().max(2000).optional() }),
  }, async ({ db, actor, params, body }) => {
    const r = await ownRun(db, actor, params.id);
    if (r.assignee_id !== actor.id && r.started_by !== actor.id) throw forbidden();
    if (r.status !== 'in_progress') throw conflict('完了済みのチェックリストは変更できません');
    const items: RunItem[] = r.items;
    for (const u of body.items) {
      const it = items.find((x) => x.id === u.id);
      if (!it) throw badRequest('不明なチェック項目です');
      if (it.checked !== u.checked) { it.checked = u.checked; it.checkedAt = u.checked ? (u.at ?? new Date().toISOString()) : null; it.checkedBy = u.checked ? actor.name : null; }
      it.note = u.note;
    }
    return db.one(sql`UPDATE checklist_runs SET items = ${JSON.stringify(items)}, notes = coalesce(${body.notes ?? null}, notes) WHERE id = ${params.id} RETURNING *`);
  });

  api(app, 'POST', '/api/checklist-runs/:id/complete', { params: idParams }, async ({ db, actor, params, ip }) => {
    const r = await ownRun(db, actor, params.id);
    if (r.status === 'completed') return r;
    const missing = (r.items as RunItem[]).filter((x) => x.required && !x.checked);
    if (missing.length) throw badRequest(`未チェックの必須項目が ${missing.length} 件あります`);
    const done = await db.one(sql`UPDATE checklist_runs SET status = 'completed', completed_at = now() WHERE id = ${params.id} AND status = 'in_progress' RETURNING *`);
    await audit(db, actor, 'checklist.complete', { type: 'checklist_run', id: params.id }, `チェックリスト「${r.title}」を完了`, { versionId: r.version_id }, ip);
    return done ?? r;
  });
}
