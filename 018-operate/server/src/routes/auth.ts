import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { sys, tx } from '../db/pool.js';
import { api, clientIp, SESSION_COOKIE } from '../http.js';
import { has, PERMS, type Perm } from '../lib/authz.js';
import { hashPassword, sha256, token, verifyPassword } from '../lib/crypto.js';
import { AppError, badRequest, tooMany, unauthorized } from '../lib/errors.js';
import { allow } from '../lib/ratelimit.js';
import { sql } from '../lib/sql.js';
import { audit } from '../services/audit.js';

const loginBody = z.object({
  org: z.string().trim().toLowerCase().min(2).max(63),
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(1).max(200),
});

export const passwordPolicy = z.string().min(10, 'パスワードは10文字以上にしてください').max(200);

export async function createSession(orgId: string, userId: string, ip: string, ua: string) {
  const tok = token(32);
  const csrf = token(24);
  await tx(orgId, (db) =>
    db.exec(sql`INSERT INTO sessions (id, org_id, user_id, csrf_token, expires_at, ip, user_agent)
      VALUES (${sha256(tok)}, ${orgId}, ${userId}, ${csrf}, now() + make_interval(hours => ${config.sessionHours}), ${ip}, ${ua.slice(0, 300)})`),
  );
  return { tok, csrf };
}

export function cookieOpts() {
  return { path: '/', httpOnly: true, sameSite: 'lax' as const, secure: config.isProd, maxAge: config.sessionHours * 3600 };
}

export default async function authRoutes(app: FastifyInstance) {
  app.post('/api/auth/login', async (req, reply) => {
    const body = loginBody.parse(req.body);
    const ip = clientIp(req);
    if (!allow(`login-ip:${ip}`, 30, 60_000) || !allow(`login-acct:${body.org}:${body.email}`, 8, 60_000)) throw tooMany();
    const [org] = await sys(sql`SELECT id, name FROM auth_org_by_slug(${body.org})`);
    if (!org) {
      await verifyPassword(body.password, null);
      throw unauthorized('組織ID・メールアドレス・パスワードを確認してください');
    }
    const result = await tx(org.id, async (db) => {
      const u = await db.one(sql`SELECT * FROM users WHERE lower(email) = ${body.email}`);
      const ok = await verifyPassword(body.password, u?.password_hash ?? null);
      if (!u || u.status !== 'active') {
        await audit(db, null, 'auth.login_failed', { type: 'user', id: u?.id ?? '' }, 'ログイン失敗', { reason: u ? 'disabled' : 'unknown_user' }, ip);
        return { error: 'invalid' as const };
      }
      if (u.locked_until && new Date(u.locked_until) > new Date()) return { error: 'locked' as const };
      if (!ok) {
        await db.exec(sql`UPDATE users SET failed_logins = failed_logins + 1,
            locked_until = CASE WHEN failed_logins + 1 >= 10 THEN now() + interval '15 minutes' ELSE locked_until END WHERE id = ${u.id}`);
        await audit(db, null, 'auth.login_failed', { type: 'user', id: u.id }, 'ログイン失敗', { reason: 'password' }, ip);
        return { error: 'invalid' as const };
      }
      if (u.is_external && (!u.external_expires_at || new Date(u.external_expires_at) <= new Date())) return { error: 'expired' as const };
      await db.exec(sql`UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ${u.id}`);
      await audit(db, { id: u.id, name: u.name }, 'auth.login', { type: 'user', id: u.id }, 'ログイン', {}, ip);
      return { user: u };
    });
    if ('error' in result) {
      if (result.error === 'locked') throw new AppError(423, 'locked', 'ログイン失敗が続いたため一時的にロックされています。15分後に再度お試しください');
      if (result.error === 'expired') throw new AppError(401, 'external_expired', '共有期間が終了しました');
      throw unauthorized('組織ID・メールアドレス・パスワードを確認してください');
    }
    const { tok, csrf } = await createSession(org.id, result.user.id, ip, String(req.headers['user-agent'] ?? ''));
    reply.setCookie(SESSION_COOKIE, tok, cookieOpts());
    return { ok: true, csrf };
  });

  api(app, 'POST', '/api/auth/logout', {}, async ({ db, actor, reply }) => {
    await db.exec(sql`UPDATE sessions SET revoked_at = now() WHERE id = ${actor.sessionId}`);
    await audit(db, actor, 'auth.logout', { type: 'user', id: actor.id }, 'ログアウト');
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  api(app, 'GET', '/api/me', {}, async ({ db, actor }) => {
    const unread = await db.one(sql`SELECT count(*)::int AS n FROM notifications WHERE user_id = ${actor.id} AND read_at IS NULL`);
    const perms = (Object.keys(PERMS) as Perm[]).filter((p) => has(actor, p));
    const s = actor.settings;
    return {
      id: actor.id, name: actor.name, email: actor.email, orgId: actor.orgId, orgName: actor.orgName, roles: actor.roles,
      departmentIds: actor.deptIds, teamIds: actor.teamIds, isExternal: actor.isExternal, externalExpiresAt: actor.externalExpiresAt,
      csrf: actor.csrf, perms, unreadNotifications: unread.n,
      policy: {
        offlineAllowed: actor.isExternal && !actor.extAllowDownload ? [] : s.classification.offlineAllowed,
        downloadAllowed: actor.isExternal && !actor.extAllowDownload ? [] : s.classification.downloadAllowed,
        ai: { enabled: s.ai.enabled && s.ai.answerEnabled && (!actor.isExternal || actor.extAllowAi), draft: s.ai.enabled && s.ai.draftEnabled, quizDraft: s.ai.enabled && s.ai.quizDraftEnabled, provider: s.ai.provider },
        requireChangeSummary: s.requireChangeSummary,
        docTypes: s.docTypes,
        overduePolicy: s.overduePolicy,
      },
    };
  });

  api(app, 'POST', '/api/me/password', { body: z.object({ current: z.string().max(200), next: passwordPolicy }) }, async ({ db, actor, body, ip }) => {
    const u = await db.one(sql`SELECT password_hash FROM users WHERE id = ${actor.id}`);
    if (!(await verifyPassword(body.current, u.password_hash))) throw badRequest('現在のパスワードが違います');
    await db.exec(sql`UPDATE users SET password_hash = ${await hashPassword(body.next)}, updated_at = now() WHERE id = ${actor.id}`);
    await db.exec(sql`UPDATE sessions SET revoked_at = now() WHERE user_id = ${actor.id} AND id <> ${actor.sessionId} AND revoked_at IS NULL`);
    await audit(db, actor, 'auth.password_changed', { type: 'user', id: actor.id }, 'パスワード変更', {}, ip);
    return { ok: true };
  });
}
