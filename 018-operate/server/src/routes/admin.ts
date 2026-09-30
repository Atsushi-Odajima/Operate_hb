import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { api, idParams, zId } from '../http.js';
import { has, need, ROLES } from '../lib/authz.js';
import { hashPassword, token } from '../lib/crypto.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { resolveSettings, settingsSchema } from '../lib/settings.js';
import { sql } from '../lib/sql.js';
import { audit } from '../services/audit.js';

const internalRoles = z.enum(ROLES.filter((r) => r !== 'external') as [string, ...string[]]);
const membership = z.object({ departmentId: zId, teamId: zId.nullable().optional() });

const userBody = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().toLowerCase().email().max(200),
  roles: z.array(internalRoles).min(1).max(7),
  memberships: z.array(membership).max(20).default([]),
  approverScopes: z.array(zId.nullable()).max(50).default([]),
  hireDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

async function setMemberships(db: any, userId: string, ms: Array<{ departmentId: string; teamId?: string | null }>) {
  await db.exec(sql`DELETE FROM memberships WHERE user_id = ${userId}`);
  for (const m of ms) {
    if (m.teamId) {
      const t = await db.one(sql`SELECT department_id FROM teams WHERE id = ${m.teamId}`);
      if (!t || t.department_id !== m.departmentId) throw badRequest('チームと部署の組み合わせが不正です');
    }
    await db.exec(sql`INSERT INTO memberships (org_id, user_id, department_id, team_id) VALUES (${db.orgId}, ${userId}, ${m.departmentId}, ${m.teamId ?? null}) ON CONFLICT DO NOTHING`);
  }
}

async function setRoles(db: any, userId: string, roles: string[]) {
  await db.exec(sql`DELETE FROM user_roles WHERE user_id = ${userId}`);
  for (const r of new Set(roles)) await db.exec(sql`INSERT INTO user_roles (org_id, user_id, role) VALUES (${db.orgId}, ${userId}, ${r})`);
}

async function setScopes(db: any, userId: string, scopes: Array<string | null>) {
  await db.exec(sql`DELETE FROM approver_scopes WHERE user_id = ${userId}`);
  for (const s of new Set(scopes)) await db.exec(sql`INSERT INTO approver_scopes (org_id, user_id, department_id) VALUES (${db.orgId}, ${userId}, ${s})`);
}

export default async function adminRoutes(app: FastifyInstance) {
  // ------------------------------------------------------------------ directory (pickers). External members cannot list the directory.
  api(app, 'GET', '/api/directory', { query: z.object({ role: z.string().optional(), q: z.string().max(100).optional() }) }, async ({ db, actor, query }) => {
    need(actor, 'directory.read');
    return db.q(sql`SELECT u.id, u.name, u.is_external,
        coalesce((SELECT array_agg(role) FROM user_roles r WHERE r.user_id = u.id), '{}') AS roles,
        coalesce((SELECT array_agg(DISTINCT m.department_id) FROM memberships m WHERE m.user_id = u.id), '{}') AS department_ids
      FROM users u WHERE u.status = 'active' AND u.anonymized_at IS NULL
        AND (NOT u.is_external OR ${has(actor, 'external.manage')})
        AND (${query.role ?? null}::text IS NULL OR EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.role = ${query.role ?? null}))
        AND (${query.q ?? null}::text IS NULL OR u.name ILIKE '%' || ${query.q ?? ''} || '%')
      ORDER BY u.name LIMIT 500`);
  });

  api(app, 'GET', '/api/departments', {}, async ({ db, actor }) => {
    if (actor.isExternal) return db.q(sql`SELECT id, name, code, '[]'::json AS teams FROM departments WHERE id = ANY(${actor.deptIds}::uuid[])`);
    return db.q(sql`SELECT d.id, d.name, d.code,
        coalesce((SELECT json_agg(json_build_object('id', t.id, 'name', t.name) ORDER BY t.name) FROM teams t WHERE t.department_id = d.id), '[]') AS teams,
        (SELECT count(DISTINCT m.user_id)::int FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.department_id = d.id AND u.status = 'active') AS member_count
      FROM departments d ORDER BY d.code`);
  });

  api(app, 'POST', '/api/departments', { body: z.object({ name: z.string().trim().min(1).max(100), code: z.string().trim().regex(/^[A-Za-z0-9_-]{1,20}$/) }) }, async ({ db, actor, body, ip }) => {
    need(actor, 'dept.manage');
    const d = await db.one(sql`INSERT INTO departments (org_id, name, code) VALUES (${db.orgId}, ${body.name}, ${body.code.toUpperCase()}) RETURNING *`);
    await audit(db, actor, 'department.create', { type: 'department', id: d.id }, `部署「${body.name}」を作成`, {}, ip);
    return d;
  });

  api(app, 'PATCH', '/api/departments/:id', { params: idParams, body: z.object({ name: z.string().trim().min(1).max(100) }) }, async ({ db, actor, body, params, ip }) => {
    need(actor, 'dept.manage');
    const d = await db.one(sql`UPDATE departments SET name = ${body.name} WHERE id = ${params.id} RETURNING *`);
    if (!d) throw notFound();
    await audit(db, actor, 'department.update', { type: 'department', id: d.id }, `部署名を「${body.name}」に変更`, {}, ip);
    return d;
  });

  api(app, 'POST', '/api/teams', { body: z.object({ departmentId: zId, name: z.string().trim().min(1).max(100) }) }, async ({ db, actor, body, ip }) => {
    need(actor, 'dept.manage');
    const t = await db.one(sql`INSERT INTO teams (org_id, department_id, name) VALUES (${db.orgId}, ${body.departmentId}, ${body.name}) RETURNING *`);
    await audit(db, actor, 'team.create', { type: 'team', id: t.id }, `チーム「${body.name}」を作成`, {}, ip);
    return t;
  });

  // ------------------------------------------------------------------ users
  api(app, 'GET', '/api/admin/users', { query: z.object({ external: z.enum(['true', 'false']).optional() }) }, async ({ db, actor, query }) => {
    if (!(has(actor, 'user.manage') || (query.external === 'true' && has(actor, 'external.manage')))) throw forbidden();
    return db.q(sql`SELECT u.id, u.name, u.email, u.status, u.is_external, u.external_expires_at, u.external_allow_download, u.external_allow_ai,
        u.hire_date, u.anonymized_at, u.created_at, u.locked_until,
        coalesce((SELECT array_agg(role) FROM user_roles r WHERE r.user_id = u.id), '{}') AS roles,
        coalesce((SELECT json_agg(json_build_object('departmentId', m.department_id, 'teamId', m.team_id)) FROM memberships m WHERE m.user_id = u.id), '[]') AS memberships,
        coalesce((SELECT json_agg(a.department_id) FROM approver_scopes a WHERE a.user_id = u.id), '[]') AS approver_scopes,
        (SELECT json_agg(json_build_object('documentId', d.id, 'title', d.title)) FROM document_audiences da JOIN documents d ON d.id = da.document_id WHERE da.kind = 'user' AND da.target = u.id::text AND u.is_external) AS shared_documents
      FROM users u WHERE (${query.external ?? null}::text IS NULL OR u.is_external = (${query.external ?? 'false'} = 'true'))
      ORDER BY u.is_external, u.name LIMIT 5000`);
  });

  api(app, 'POST', '/api/admin/users', { body: userBody }, async ({ db, actor, body, ip }) => {
    need(actor, 'user.manage');
    const temp = token(9);
    const u = await db.one(sql`INSERT INTO users (org_id, email, name, password_hash, hire_date) VALUES (${db.orgId}, ${body.email}, ${body.name}, ${await hashPassword(temp)}, ${body.hireDate ?? null}) RETURNING id, name, email`);
    await setRoles(db, u.id, body.roles);
    await setMemberships(db, u.id, body.memberships);
    await setScopes(db, u.id, body.roles.includes('approver') ? body.approverScopes : []);
    await audit(db, actor, 'user.create', { type: 'user', id: u.id }, `ユーザー「${body.name}」を作成`, { roles: body.roles, memberships: body.memberships }, ip);
    return { ...u, temporaryPassword: temp };
  });

  api(app, 'PATCH', '/api/admin/users/:id', { params: idParams, body: userBody.partial() }, async ({ db, actor, body, params, ip }) => {
    need(actor, 'user.manage');
    const before = await db.one(sql`SELECT u.id, u.name, u.email, u.is_external, coalesce((SELECT array_agg(role) FROM user_roles r WHERE r.user_id = u.id), '{}') AS roles FROM users u WHERE u.id = ${params.id}`);
    if (!before || before.is_external) throw notFound();
    if (body.roles && params.id === actor.id && !body.roles.includes('owner')) throw badRequest('自分自身の Owner 権限は外せません');
    if (body.roles && before.roles.includes('owner') && !body.roles.includes('owner')) {
      const owners = await db.one(sql`SELECT count(*)::int AS n FROM user_roles r JOIN users u ON u.id = r.user_id WHERE r.role = 'owner' AND u.status = 'active'`);
      if (owners.n <= 1) throw badRequest('Owner が 0 人になるため変更できません');
    }
    await db.exec(sql`UPDATE users SET name = coalesce(${body.name ?? null}, name), email = coalesce(${body.email ?? null}, email),
        hire_date = CASE WHEN ${body.hireDate !== undefined} THEN ${body.hireDate ?? null}::date ELSE hire_date END, updated_at = now() WHERE id = ${params.id}`);
    if (body.roles) await setRoles(db, params.id, body.roles);
    if (body.memberships) await setMemberships(db, params.id, body.memberships);
    if (body.approverScopes || body.roles) {
      const roles = body.roles ?? before.roles;
      await setScopes(db, params.id, roles.includes('approver') ? (body.approverScopes ?? []) : []);
    }
    // Permission changes take effect on the next request: actors are re-loaded from the DB on every request,
    // and search / AI retrieval evaluate ACL at query time (no permission cache to invalidate).
    await audit(db, actor, 'user.update', { type: 'user', id: params.id }, `ユーザー「${before.name}」を更新`, { before: { roles: before.roles }, after: { roles: body.roles, memberships: body.memberships } }, ip);
    return { ok: true };
  });

  api(app, 'POST', '/api/admin/users/:id/status', { params: idParams, body: z.object({ status: z.enum(['active', 'disabled']) }) }, async ({ db, actor, body, params, ip }) => {
    need(actor, 'user.manage');
    if (params.id === actor.id) throw badRequest('自分自身は無効化できません');
    const u = await db.one(sql`UPDATE users SET status = ${body.status}, updated_at = now() WHERE id = ${params.id} RETURNING name`);
    if (!u) throw notFound();
    if (body.status === 'disabled') {
      await db.exec(sql`UPDATE sessions SET revoked_at = now() WHERE user_id = ${params.id} AND revoked_at IS NULL`);
      // Open training assignments of disabled users are cancelled (history kept); completed records remain.
      await db.exec(sql`UPDATE training_assignments SET status = 'cancelled' WHERE user_id = ${params.id} AND status IN ('not_started','in_progress')`);
      await db.exec(sql`UPDATE user_attestations SET status = 'cancelled' WHERE user_id = ${params.id} AND status = 'pending'`);
    }
    await audit(db, actor, body.status === 'disabled' ? 'user.disable' : 'user.enable', { type: 'user', id: params.id }, `ユーザー「${u.name}」を${body.status === 'disabled' ? '無効化' : '有効化'}`, {}, ip);
    return { ok: true };
  });

  api(app, 'POST', '/api/admin/users/:id/reset-password', { params: idParams }, async ({ db, actor, params, ip }) => {
    need(actor, 'user.manage');
    const temp = token(9);
    const u = await db.one(sql`UPDATE users SET password_hash = ${await hashPassword(temp)}, failed_logins = 0, locked_until = NULL WHERE id = ${params.id} RETURNING name`);
    if (!u) throw notFound();
    await db.exec(sql`UPDATE sessions SET revoked_at = now() WHERE user_id = ${params.id} AND revoked_at IS NULL`);
    await audit(db, actor, 'user.reset_password', { type: 'user', id: params.id }, `「${u.name}」のパスワードを再発行`, {}, ip);
    return { temporaryPassword: temp };
  });

  /** Privacy: keep training/approval/audit history consistent but remove personal identifiers. */
  api(app, 'POST', '/api/admin/users/:id/anonymize', { params: idParams }, async ({ db, actor, params, ip }) => {
    need(actor, 'user.manage');
    const u = await db.one(sql`SELECT status, name FROM users WHERE id = ${params.id}`);
    if (!u) throw notFound();
    if (u.status !== 'disabled') throw conflict('先にユーザーを無効化してください');
    const label = `退職者-${params.id.slice(0, 8)}`;
    await db.exec(sql`UPDATE users SET name = ${label}, email = ${`${params.id}@anonymized.invalid`}, password_hash = NULL, anonymized_at = now(), hire_date = NULL WHERE id = ${params.id}`);
    await audit(db, actor, 'user.anonymize', { type: 'user', id: params.id }, `ユーザー表示名を匿名化`, {}, ip);
    return { ok: true, label };
  });

  // ------------------------------------------------------------------ external members
  const externalBody = z.object({
    name: z.string().trim().min(1).max(100),
    email: z.string().trim().toLowerCase().email().max(200),
    expiresAt: z.string().datetime({ offset: true }),
    departmentIds: z.array(zId).max(10).default([]),
    documentIds: z.array(zId).max(200).default([]),
    allowDownload: z.boolean().default(false),
    allowAi: z.boolean().default(false),
  });

  async function shareDocs(db: any, userId: string, docIds: string[], allowedCls: string[]) {
    await db.exec(sql`DELETE FROM document_audiences WHERE kind = 'user' AND target = ${userId}`);
    for (const id of docIds) {
      const d = await db.one(sql`SELECT classification FROM documents WHERE id = ${id}`);
      if (!d) throw notFound('文書が見つかりません');
      if (!allowedCls.includes(d.classification)) throw badRequest('この機密区分の文書は外部メンバーに共有できません');
      await db.exec(sql`INSERT INTO document_audiences (org_id, document_id, kind, target) VALUES (${db.orgId}, ${id}, 'user', ${userId}) ON CONFLICT DO NOTHING`);
    }
  }

  api(app, 'POST', '/api/admin/externals', { body: externalBody }, async ({ db, actor, body, ip }) => {
    need(actor, 'external.manage');
    if (new Date(body.expiresAt) <= new Date()) throw badRequest('共有期限は未来の日時にしてください');
    const temp = token(9);
    const u = await db.one(sql`INSERT INTO users (org_id, email, name, password_hash, is_external, external_expires_at, external_allow_download, external_allow_ai)
      VALUES (${db.orgId}, ${body.email}, ${body.name}, ${await hashPassword(temp)}, true, ${body.expiresAt}, ${body.allowDownload}, ${body.allowAi}) RETURNING id, name, email`);
    await setRoles(db, u.id, ['external']);
    await setMemberships(db, u.id, body.departmentIds.map((departmentId) => ({ departmentId })));
    await shareDocs(db, u.id, body.documentIds, actor.settings.classification.externalAllowed);
    await audit(db, actor, 'external.create', { type: 'user', id: u.id }, `外部メンバー「${body.name}」を招待（期限 ${body.expiresAt}）`, { departments: body.departmentIds, documents: body.documentIds, allowDownload: body.allowDownload, allowAi: body.allowAi }, ip);
    return { ...u, temporaryPassword: temp };
  });

  api(app, 'PATCH', '/api/admin/externals/:id', { params: idParams, body: externalBody.omit({ email: true, name: true }).partial() }, async ({ db, actor, body, params, ip }) => {
    need(actor, 'external.manage');
    const u = await db.one(sql`SELECT * FROM users WHERE id = ${params.id} AND is_external`);
    if (!u) throw notFound();
    await db.exec(sql`UPDATE users SET external_expires_at = coalesce(${body.expiresAt ?? null}::timestamptz, external_expires_at),
        external_allow_download = coalesce(${body.allowDownload ?? null}::boolean, external_allow_download),
        external_allow_ai = coalesce(${body.allowAi ?? null}::boolean, external_allow_ai), updated_at = now() WHERE id = ${params.id}`);
    if (body.departmentIds) await setMemberships(db, params.id, body.departmentIds.map((departmentId) => ({ departmentId })));
    if (body.documentIds) await shareDocs(db, params.id, body.documentIds, actor.settings.classification.externalAllowed);
    if (body.expiresAt && new Date(body.expiresAt) <= new Date()) await db.exec(sql`UPDATE sessions SET revoked_at = now() WHERE user_id = ${params.id} AND revoked_at IS NULL`);
    await audit(db, actor, 'external.update', { type: 'user', id: params.id }, `外部メンバー「${u.name}」の共有設定を変更`, { before: { expiresAt: u.external_expires_at }, after: body }, ip);
    return { ok: true };
  });

  api(app, 'POST', '/api/admin/externals/:id/revoke', { params: idParams }, async ({ db, actor, params, ip }) => {
    need(actor, 'external.manage');
    const u = await db.one(sql`UPDATE users SET external_expires_at = now(), updated_at = now() WHERE id = ${params.id} AND is_external RETURNING name`);
    if (!u) throw notFound();
    await db.exec(sql`UPDATE sessions SET revoked_at = now() WHERE user_id = ${params.id} AND revoked_at IS NULL`);
    await audit(db, actor, 'external.revoke', { type: 'user', id: params.id }, `外部メンバー「${u.name}」のアクセスを停止`, {}, ip);
    return { ok: true };
  });

  // ------------------------------------------------------------------ settings
  api(app, 'GET', '/api/admin/settings', {}, async ({ db, actor }) => {
    if (!has(actor, 'org.settings') && !has(actor, 'doc.admin')) throw forbidden();
    const o = await db.one(sql`SELECT name, slug, is_sample FROM organizations WHERE id = ${db.orgId}`);
    return { ...o, settings: actor.settings, aiKeyConfigured: !!process.env.ANTHROPIC_API_KEY };
  });

  api(app, 'PUT', '/api/admin/settings', { body: z.object({ name: z.string().trim().min(1).max(100).optional(), settings: settingsSchema }) }, async ({ db, actor, body, ip }) => {
    need(actor, 'org.settings');
    const before = actor.settings;
    await db.exec(sql`UPDATE organizations SET settings = ${JSON.stringify(body.settings)}, name = coalesce(${body.name ?? null}, name) WHERE id = ${db.orgId}`);
    const aiChanged = JSON.stringify(before.ai) !== JSON.stringify(body.settings.ai);
    await audit(db, actor, 'settings.update', { type: 'organization', id: db.orgId }, '組織設定を変更', { aiChanged });
    if (aiChanged) await audit(db, actor, 'ai.settings', { type: 'organization', id: db.orgId }, `AI設定を変更（${body.settings.ai.enabled ? 'ON' : 'OFF'} / ${body.settings.ai.provider}）`, { before: before.ai, after: body.settings.ai }, ip);
    return { settings: resolveSettings(body.settings) };
  });
}
