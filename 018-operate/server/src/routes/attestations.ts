import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { api, idParams, zDate, zId } from '../http.js';
import { has, need } from '../lib/authz.js';
import { conflict, notFound } from '../lib/errors.js';
import { sql } from '../lib/sql.js';
import { acknowledge, createCampaign, markProgress, waive } from '../services/attestations.js';
import { getDoc } from '../services/documents.js';

export default async function attestationRoutes(app: FastifyInstance) {
  api(app, 'GET', '/api/attestations/mine', {}, async ({ db, actor }) => {
    return db.q(sql`SELECT ua.id, ua.status, ua.due_date, ua.assigned_at, ua.acknowledged_at, ua.document_id, ua.version_id, v.title, v.major, v.minor,
        v.change_type, v.change_summary, (ua.status = 'pending' AND ua.due_date < current_date) AS overdue
      FROM user_attestations ua JOIN document_versions v ON v.id = ua.version_id
      WHERE ua.user_id = ${actor.id} AND ua.status IN ('pending','acknowledged') ORDER BY (ua.status = 'pending') DESC, ua.due_date NULLS LAST, ua.assigned_at DESC LIMIT 200`);
  });

  api(app, 'POST', '/api/attestations/:id/progress', { params: idParams, body: z.object({ what: z.enum(['viewed', 'reached_end']) }) },
    async ({ db, actor, params, body }) => markProgress(db, actor, params.id, body.what));

  api(app, 'POST', '/api/attestations/:id/acknowledge', { params: idParams }, async ({ db, actor, params, ip }) => acknowledge(db, actor, params.id, ip));

  api(app, 'POST', '/api/attestations/:id/waive', { params: idParams, body: z.object({ reason: z.string().max(1000) }) },
    async ({ db, actor, params, body, ip }) => { await waive(db, actor, params.id, body.reason, ip); return { ok: true }; });

  api(app, 'POST', '/api/documents/:id/attestations', { params: idParams, body: z.object({ dueDate: zDate.nullable().optional(), reason: z.string().max(500).default('確認依頼'), userIds: z.array(zId).max(5000).optional() }) },
    async ({ db, actor, params, body }) => {
      need(actor, 'attestation.manage');
      const d = await getDoc(db, actor, params.id, 'read');
      if (d.status !== 'published' || !d.current_version_id) throw conflict('公開中の文書のみ確認依頼を配布できます');
      const existing = await db.one(sql`SELECT id FROM attestation_campaigns WHERE version_id = ${d.current_version_id}`);
      if (existing && body.userIds?.length) {
        // add more users to the existing campaign of this version
        return createCampaign(db, actor.settings, actor, { documentId: d.id, versionId: d.current_version_id, dueDate: body.dueDate ?? null, reason: body.reason, userIds: body.userIds });
      }
      return createCampaign(db, actor.settings, actor, { documentId: d.id, versionId: d.current_version_id, dueDate: body.dueDate ?? null, reason: body.reason, userIds: body.userIds });
    });

  api(app, 'GET', '/api/attestations/campaigns', { query: z.object({ documentId: zId.optional() }) }, async ({ db, actor, query }) => {
    need(actor, 'attestation.report');
    return db.q(sql`SELECT c.id, c.document_id, c.version_id, c.due_date, c.reason, c.created_at, d.title, v.major, v.minor, v.change_type,
        count(ua.*) FILTER (WHERE ua.status <> 'cancelled')::int AS total,
        count(ua.*) FILTER (WHERE ua.status = 'acknowledged')::int AS acknowledged,
        count(ua.*) FILTER (WHERE ua.status = 'waived')::int AS waived,
        count(ua.*) FILTER (WHERE ua.status = 'pending')::int AS pending,
        count(ua.*) FILTER (WHERE ua.status = 'pending' AND ua.due_date < current_date)::int AS overdue
      FROM attestation_campaigns c JOIN documents d ON d.id = c.document_id JOIN document_versions v ON v.id = c.version_id
      LEFT JOIN user_attestations ua ON ua.campaign_id = c.id
      WHERE (${query.documentId ?? null}::uuid IS NULL OR c.document_id = ${query.documentId ?? null}::uuid)
      GROUP BY c.id, d.title, v.major, v.minor, v.change_type ORDER BY c.created_at DESC LIMIT 300`);
  });

  api(app, 'GET', '/api/attestations/campaigns/:id', { params: idParams }, async ({ db, actor, params }) => {
    need(actor, 'attestation.report');
    const c = await db.one(sql`SELECT c.*, d.title, v.major, v.minor FROM attestation_campaigns c JOIN documents d ON d.id = c.document_id JOIN document_versions v ON v.id = c.version_id WHERE c.id = ${params.id}`);
    if (!c) throw notFound();
    const users = await db.q(sql`SELECT ua.id, ua.status, ua.assigned_at, ua.viewed_at, ua.reached_end_at, ua.acknowledged_at, ua.due_date, ua.waived_reason,
        u.name, u.id AS user_id, (ua.status = 'pending' AND ua.due_date < current_date) AS overdue,
        (SELECT string_agg(dp.name, ', ') FROM memberships m JOIN departments dp ON dp.id = m.department_id WHERE m.user_id = u.id) AS departments
      FROM user_attestations ua JOIN users u ON u.id = ua.user_id WHERE ua.campaign_id = ${params.id} ORDER BY ua.status, u.name`);
    return { campaign: c, users, canWaive: has(actor, 'attestation.manage') };
  });
}
