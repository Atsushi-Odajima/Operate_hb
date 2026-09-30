import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z, ZodError, type ZodType } from 'zod';
import { config } from './config.js';
import { sys, tx, type Db } from './db/pool.js';
import type { Actor, Role } from './lib/authz.js';
import { safeEqual, sha256 } from './lib/crypto.js';
import { AppError, forbidden, unauthorized } from './lib/errors.js';
import { resolveSettings } from './lib/settings.js';
import { sql } from './lib/sql.js';

export const SESSION_COOKIE = 'op_session';

export interface Ctx<B, Q, P> {
  db: Db;
  actor: Actor;
  body: B;
  query: Q;
  params: P;
  req: FastifyRequest;
  reply: FastifyReply;
  ip: string;
}

interface Opts<B, Q, P> {
  body?: ZodType<B>;
  query?: ZodType<Q>;
  params?: ZodType<P>;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

function parse<T>(schema: ZodType<T> | undefined, v: unknown): T {
  if (!schema) return v as T;
  return schema.parse(v);
}

const ACTOR_SELECT = sql`u.id, u.name, u.email, u.status, u.is_external, u.external_expires_at, u.external_allow_download, u.external_allow_ai,
           o.name AS org_name, o.settings,
           coalesce((SELECT array_agg(role) FROM user_roles r WHERE r.user_id = u.id), '{}') AS roles,
           coalesce((SELECT array_agg(DISTINCT m.department_id::text) FROM memberships m WHERE m.user_id = u.id), '{}') AS depts,
           coalesce((SELECT array_agg(DISTINCT m.team_id::text) FROM memberships m WHERE m.user_id = u.id AND m.team_id IS NOT NULL), '{}') AS teams,
           coalesce((SELECT array_agg(a.department_id::text) FROM approver_scopes a WHERE a.user_id = u.id AND a.department_id IS NOT NULL), '{}') AS scopes,
           EXISTS (SELECT 1 FROM approver_scopes a WHERE a.user_id = u.id AND a.department_id IS NULL) AS scope_all`;

function toActor(u: any, orgId: string, sessionId: string, csrf: string): Actor {
  return {
    id: u.id,
    orgId,
    orgName: u.org_name,
    name: u.name,
    email: u.email,
    roles: u.roles as Role[],
    deptIds: u.depts,
    teamIds: u.teams,
    isExternal: u.is_external,
    externalExpiresAt: u.external_expires_at,
    extAllowDownload: u.external_allow_download,
    extAllowAi: u.external_allow_ai,
    approverScopes: [...u.scopes, ...(u.scope_all ? [null] : [])],
    settings: resolveSettings(u.settings),
    sessionId,
    csrf,
  };
}

/** Actor without an HTTP session (seed, jobs, tests). Same permission data as a logged-in request. */
export async function actorForUser(db: Db, userId: string): Promise<Actor> {
  const u = await db.one(sql`SELECT ${ACTOR_SELECT} FROM users u JOIN organizations o ON o.id = u.org_id WHERE u.id = ${userId}`);
  if (!u) throw unauthorized();
  return toActor(u, db.orgId, '', '');
}

export async function loadActor(db: Db, sessionId: string, userId: string): Promise<Actor> {
  const u = await db.one(sql`SELECT ${ACTOR_SELECT}, s.csrf_token, s.last_seen_at
      FROM users u JOIN organizations o ON o.id = u.org_id JOIN sessions s ON s.id = ${sessionId} AND s.user_id = u.id
     WHERE u.id = ${userId}`);
  if (!u || u.status !== 'active') throw unauthorized();
  if (u.is_external && (!u.external_expires_at || new Date(u.external_expires_at) <= new Date())) {
    await db.exec(sql`UPDATE sessions SET revoked_at = now() WHERE user_id = ${userId} AND revoked_at IS NULL`);
    throw new AppError(401, 'external_expired', '共有期間が終了しました');
  }
  if (Date.now() - new Date(u.last_seen_at).getTime() > 5 * 60_000) {
    await db.exec(sql`UPDATE sessions SET last_seen_at = now(), expires_at = greatest(expires_at, now() + make_interval(hours => ${config.sessionHours})) WHERE id = ${sessionId}`);
  }
  return toActor(u, db.orgId, sessionId, u.csrf_token);
}

export async function resolveSession(req: FastifyRequest): Promise<{ sessionId: string; orgId: string; userId: string } | null> {
  const tok = req.cookies[SESSION_COOKIE];
  if (!tok || tok.length > 200) return null;
  const sessionId = sha256(tok);
  const [row] = await sys(sql`SELECT org_id, user_id FROM auth_session(${sessionId})`);
  return row ? { sessionId, orgId: row.org_id, userId: row.user_id } : null;
}

function checkCsrf(req: FastifyRequest, actor: Actor) {
  const h = req.headers['x-csrf-token'];
  if (typeof h !== 'string' || !safeEqual(h, actor.csrf)) throw forbidden('CSRF トークンが不正です。再読み込みしてください');
  const origin = req.headers.origin;
  if (origin && config.isProd) {
    const allowed = new URL(config.publicUrl).origin;
    if (origin !== allowed) throw forbidden('不正な送信元です');
  }
}

export function clientIp(req: FastifyRequest) {
  return req.ip;
}

/** Authenticated, tenant-scoped, validated route. One DB transaction per request. */
export function api<B = unknown, Q = unknown, P = unknown>(
  app: FastifyInstance,
  method: Method,
  url: string,
  opts: Opts<B, Q, P>,
  fn: (c: Ctx<B, Q, P>) => Promise<unknown>,
) {
  app.route({
    method,
    url,
    handler: async (req, reply) => {
      const params = parse(opts.params, req.params);
      const query = parse(opts.query, req.query);
      const body = parse(opts.body, req.body ?? {});
      const s = await resolveSession(req);
      if (!s) throw unauthorized();
      const result = await tx(s.orgId, async (db) => {
        const actor = await loadActor(db, s.sessionId, s.userId);
        if (method !== 'GET') checkCsrf(req, actor);
        return fn({ db, actor, body, query, params, req, reply, ip: clientIp(req) });
      });
      if (reply.sent) return reply;
      if (result === undefined) return reply.code(204).send();
      return result;
    },
  });
}

export function errorHandler(err: unknown, req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof ZodError) {
    return reply.code(400).send({ error: 'validation', message: '入力内容を確認してください', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  }
  if (err instanceof AppError) return reply.code(err.status).send({ error: err.code, message: err.message, detail: err.detail });
  const e = err as { code?: string; statusCode?: number; message?: string };
  if (e.code === 'P0001') return reply.code(409).send({ error: 'locked', message: 'この版は確定済みのため変更できません' });
  if (e.code === '23505') return reply.code(409).send({ error: 'duplicate', message: '同じ内容が既に登録されています' });
  if (e.code === '22P02') return reply.code(404).send({ error: 'not_found', message: '見つかりません' });
  if (e.code === '23503') return reply.code(400).send({ error: 'reference', message: '参照先が存在しません' });
  if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: 'request', message: e.message });
  req.log.error(err);
  if (process.env.NODE_ENV === 'test') console.error(err);
  return reply.code(500).send({ error: 'internal', message: 'サーバーエラーが発生しました' });
}

// ---- shared zod helpers
export const zId = z.string().uuid();
export const idParams = z.object({ id: zId });
export const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const zPage = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
