import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { api, idParams, zId } from '../http.js';
import { docEditable, has } from '../lib/authz.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { sql } from '../lib/sql.js';
import { audit } from '../services/audit.js';
import { getDoc } from '../services/documents.js';
import { notify } from '../services/notify.js';

export default async function feedbackRoutes(app: FastifyInstance) {
  /** Feedback is pinned to the version the reader saw. It never edits the document body. */
  api(app, 'POST', '/api/documents/:id/feedback', {
    params: idParams, body: z.object({ kind: z.enum(['helpful', 'outdated', 'unclear', 'suggestion']), body: z.string().max(3000).default('') }),
  }, async ({ db, actor, params, body }) => {
    const d = await getDoc(db, actor, params.id, 'read');
    if (body.kind !== 'helpful' && !body.body.trim()) throw badRequest('内容を入力してください');
    const f = await db.one(sql`INSERT INTO feedback (org_id, document_id, version_id, user_id, kind, body) VALUES (${db.orgId}, ${d.id}, ${d.current_version_id}, ${actor.id}, ${body.kind}, ${body.body}) RETURNING id`);
    if (body.kind !== 'helpful' && d.owner_id && d.owner_id !== actor.id) {
      await notify(db, actor.settings, [d.owner_id], { type: 'feedback', title: `フィードバック: ${d.title}`, link: `/feedback?documentId=${d.id}`, key: `feedback:${f.id}` });
    }
    return { id: f.id };
  });

  api(app, 'GET', '/api/feedback', { query: z.object({ status: z.string().max(20).optional(), documentId: zId.optional() }) }, async ({ db, actor, query }) => {
    const manage = has(actor, 'feedback.manage');
    if (!manage && actor.isExternal) throw forbidden();
    return db.q(sql`SELECT f.id, f.kind, f.body, f.status, f.resolution, f.created_at, f.updated_at, d.id AS document_id, d.title, v.major, v.minor,
        u.name AS user_name, h.name AS handled_by_name
      FROM feedback f JOIN documents d ON d.id = f.document_id JOIN document_versions v ON v.id = f.version_id
      LEFT JOIN users u ON u.id = f.user_id LEFT JOIN users h ON h.id = f.handled_by
      WHERE (${manage} OR d.owner_id = ${actor.id}::uuid OR ${docEditable(actor)})
        AND (${query.status ?? null}::text IS NULL OR f.status = ${query.status ?? null})
        AND (${query.documentId ?? null}::uuid IS NULL OR f.document_id = ${query.documentId ?? null}::uuid)
      ORDER BY f.created_at DESC LIMIT 500`);
  });

  api(app, 'PATCH', '/api/feedback/:id', { params: idParams, body: z.object({ status: z.enum(['open', 'reviewing', 'resolved', 'dismissed']), resolution: z.string().max(2000).default('') }) },
    async ({ db, actor, params, body, ip }) => {
      const f = await db.one(sql`SELECT f.*, d.owner_id FROM feedback f JOIN documents d ON d.id = f.document_id WHERE f.id = ${params.id}`);
      if (!f) throw notFound();
      if (!has(actor, 'feedback.manage') && f.owner_id !== actor.id) throw forbidden();
      if (body.status === 'dismissed' && !body.resolution.trim()) throw badRequest('却下する理由を入力してください');
      await db.exec(sql`UPDATE feedback SET status = ${body.status}, resolution = ${body.resolution}, handled_by = ${actor.id}, updated_at = now() WHERE id = ${params.id}`);
      await audit(db, actor, 'feedback.update', { type: 'feedback', id: params.id }, `フィードバックを「${body.status}」に更新`, { resolution: body.resolution }, ip);
      return { ok: true };
    });

  // Knowledge Improvement tickets (lightweight; intentionally not an ITSM)
  api(app, 'GET', '/api/improvements', {}, async ({ db, actor }) => {
    if (actor.isExternal) throw forbidden();
    return db.q(sql`SELECT t.*, d.title AS document_title, o.name AS owner_name FROM improvement_tickets t
      LEFT JOIN documents d ON d.id = t.document_id LEFT JOIN users o ON o.id = t.owner_id ORDER BY t.status, t.priority DESC, t.created_at DESC LIMIT 500`);
  });
  const ticket = z.object({ documentId: zId.nullable().optional(), title: z.string().trim().min(1).max(200), summary: z.string().max(5000).default(''),
    priority: z.enum(['low', 'normal', 'high']).default('normal'), ownerId: zId.nullable().optional() });
  api(app, 'POST', '/api/improvements', { body: ticket }, async ({ db, actor, body, ip }) => {
    if (actor.isExternal || !actor.roles.some((r) => r !== 'member' && r !== 'auditor')) throw forbidden();
    if (body.documentId) await getDoc(db, actor, body.documentId, 'access');
    const t = await db.one(sql`INSERT INTO improvement_tickets (org_id, document_id, title, summary, priority, owner_id, created_by)
      VALUES (${db.orgId}, ${body.documentId ?? null}, ${body.title}, ${body.summary}, ${body.priority}, ${body.ownerId ?? null}, ${actor.id}) RETURNING *`);
    if (body.ownerId) await notify(db, actor.settings, [body.ownerId], { type: 'improvement', title: `改善チケット: ${body.title}`, link: `/improvements`, key: `improvement:${t.id}` });
    await audit(db, actor, 'improvement.create', { type: 'improvement', id: t.id }, `改善チケット「${body.title}」を作成`, {}, ip);
    return t;
  });
  api(app, 'PATCH', '/api/improvements/:id', { params: idParams, body: z.object({ status: z.enum(['open', 'in_progress', 'done', 'dismissed']).optional(), ownerId: zId.nullable().optional(), priority: z.enum(['low', 'normal', 'high']).optional() }) },
    async ({ db, actor, params, body, ip }) => {
      if (actor.isExternal || !actor.roles.some((r) => r !== 'member' && r !== 'auditor')) throw forbidden();
      const t = await db.one(sql`UPDATE improvement_tickets SET status = coalesce(${body.status ?? null}, status), priority = coalesce(${body.priority ?? null}, priority),
          owner_id = CASE WHEN ${body.ownerId !== undefined} THEN ${body.ownerId ?? null}::uuid ELSE owner_id END, updated_at = now() WHERE id = ${params.id} RETURNING *`);
      if (!t) throw notFound();
      await audit(db, actor, 'improvement.update', { type: 'improvement', id: t.id }, '改善チケットを更新', body, ip);
      return t;
    });
}
