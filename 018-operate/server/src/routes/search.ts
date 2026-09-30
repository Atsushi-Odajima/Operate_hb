import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { answer, draftSop } from '../ai/service.js';
import { api, zDate, zId } from '../http.js';
import { CLASSIFICATIONS, docReadable, has, need } from '../lib/authz.js';
import { badRequest } from '../lib/errors.js';
import { sql } from '../lib/sql.js';
import { audit } from '../services/audit.js';
import { createDocument } from '../services/documents.js';
import { searchDocuments } from '../services/search.js';

export default async function searchRoutes(app: FastifyInstance) {
  api(app, 'GET', '/api/search', {
    query: z.object({
      q: z.string().trim().max(200).default(''),
      type: z.string().max(20).optional(), departmentId: zId.optional(), classification: z.enum(CLASSIFICATIONS).optional(),
      updatedSince: zDate.optional(), category: z.string().max(100).optional(), tag: z.string().max(40).optional(),
      limit: z.coerce.number().int().min(1).max(50).default(20), offset: z.coerce.number().int().min(0).max(10000).default(0),
    }),
  }, async ({ db, actor, query }) => {
    const res = await searchDocuments(db, actor, query.q, query, query.limit, query.offset);
    let queryId: number | null = null;
    if (query.q && query.offset === 0 && actor.settings.searchAnalytics.enabled) {
      // Search analytics are stored WITHOUT the user id (privacy); only the query text and result count.
      const r = await db.one(sql`INSERT INTO search_queries (org_id, query, mode, result_count) VALUES (${db.orgId}, ${query.q.slice(0, 200)}, 'keyword', ${res.total}) RETURNING id`);
      queryId = r.id;
    }
    return { ...res, queryId };
  });

  api(app, 'POST', '/api/search/click', { body: z.object({ queryId: z.number().int(), documentId: zId }) }, async ({ db, actor, body }) => {
    // only record clicks on documents the actor can actually read
    const ok = await db.one(sql`SELECT 1 FROM documents d WHERE d.id = ${body.documentId} AND ${docReadable(actor)}`);
    if (ok) await db.exec(sql`UPDATE search_queries SET clicked_document_id = ${body.documentId}, clicked_at = now() WHERE id = ${body.queryId} AND clicked_document_id IS NULL`);
  });

  api(app, 'POST', '/api/search/dwell', { body: z.object({ queryId: z.number().int(), ms: z.number().int().min(0).max(86_400_000) }) }, async ({ db, body }) => {
    await db.exec(sql`UPDATE search_queries SET dwell_ms = ${body.ms} WHERE id = ${body.queryId} AND dwell_ms IS NULL`);
  });

  api(app, 'POST', '/api/ai/ask', { body: z.object({ question: z.string().trim().min(2).max(500), historical: z.boolean().default(false) }) }, async ({ db, actor, body }) => {
    if (body.historical) need(actor, 'ai.historical');
    const r = await answer(db, actor, body.question, { historical: body.historical });
    if (actor.settings.searchAnalytics.enabled) {
      await db.exec(sql`INSERT INTO search_queries (org_id, query, mode, result_count) VALUES (${db.orgId}, ${body.question.slice(0, 200)}, 'ai', ${r.citations.length})`);
    }
    return r;
  });

  /** AI SOP draft: always creates a Draft flagged ai_generated. It can never be published without human review + approval. */
  api(app, 'POST', '/api/ai/draft-sop', {
    body: z.object({ title: z.string().trim().min(1).max(200), source: z.string().trim().min(10).max(60000), type: z.enum(['sop', 'guide', 'faq', 'checklist']).default('sop'),
      departmentId: zId.nullable().optional(), classification: z.enum(CLASSIFICATIONS).default('internal') }),
  }, async ({ db, actor, body, ip }) => {
    need(actor, 'doc.create');
    if (actor.settings.ai.provider !== 'local' && !actor.settings.ai.allowedClassifications.includes(body.classification))
      throw badRequest('この機密区分の資料は外部AIへ送信できない設定です');
    const content = await draftSop(db, actor, body.source);
    const r = await createDocument(db, actor, { type: body.type, title: body.title, departmentId: body.departmentId ?? null, classification: body.classification, content, aiGenerated: true }, ip);
    await audit(db, actor, 'ai.draft', { type: 'document', id: r.document.id }, 'AIでSOP下書きを作成（Draft）', { provider: actor.settings.ai.provider, sourceChars: body.source.length }, ip);
    return { id: r.document.id, versionId: r.version.id };
  });

  api(app, 'GET', '/api/ai/usage', {}, async ({ db, actor }) => {
    if (!has(actor, 'ai.settings') && !has(actor, 'analytics.read')) need(actor, 'ai.settings');
    const month = await db.one(sql`SELECT count(*)::int AS requests, coalesce(sum(input_tokens),0)::int AS input_tokens, coalesce(sum(output_tokens),0)::int AS output_tokens,
        coalesce(sum(cost_usd),0) AS cost_usd, count(*) FILTER (WHERE status = 'no_source')::int AS no_source FROM ai_usage WHERE created_at >= date_trunc('month', now())`);
    const byKind = await db.q(sql`SELECT kind, provider, model, count(*)::int AS n, coalesce(sum(cost_usd),0) AS cost_usd FROM ai_usage WHERE created_at >= date_trunc('month', now()) GROUP BY 1,2,3 ORDER BY 4 DESC`);
    return { month, byKind, settings: actor.settings.ai };
  });
}
