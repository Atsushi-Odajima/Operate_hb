/** Feature & security tests beyond the 30 mandatory cases. Uses its own tenant ("feat-co"). */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tx } from '../src/db/pool.js';
import { normalizeContent } from '../src/lib/content.js';
import { sql } from '../src/lib/sql.js';
import { sweepOrg } from '../src/services/worker.js';
import { getApp, login, seed, type Client } from './helpers.js';

const ORG = 'feat-co';
let S: Awaited<ReturnType<typeof seed>>;
let admin: pg.Client;
let owner: Client, kadmin: Client, editor: Client, approver: Client, trainer: Client, memberCs: Client, memberOps: Client, auditor: Client, newhire: Client;
const q = async (t: string, p: unknown[] = []) => (await admin.query(t, p)).rows;

beforeAll(async () => {
  S = await seed(ORG);
  admin = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await admin.connect();
  [owner, kadmin, editor, approver, trainer, memberCs, memberOps, auditor, newhire] = await Promise.all(
    ['owner', 'admin', 'editor', 'approver', 'trainer', 'member-cs', 'member-ops', 'auditor', 'newhire'].map((u) => login(u, ORG)));
});
afterAll(async () => admin?.end());

describe('security basics', () => {
  it('CSRF token is required for state-changing requests', async () => {
    const app = await getApp();
    const r = await app.inject({ method: 'POST', url: `/api/documents/${S.docs.cs001}/feedback`, payload: { kind: 'helpful' }, headers: { cookie: memberCs.cookie } });
    expect(r.statusCode).toBe(403);
    const r2 = await app.inject({ method: 'POST', url: `/api/documents/${S.docs.cs001}/feedback`, payload: { kind: 'helpful' }, headers: { cookie: memberCs.cookie, 'x-csrf-token': 'wrong' } });
    expect(r2.statusCode).toBe(403);
  });

  it('unauthenticated requests are refused; security headers are set', async () => {
    const app = await getApp();
    const r = await app.inject({ method: 'GET', url: '/api/documents' });
    expect(r.statusCode).toBe(401);
    expect(r.headers['content-security-policy']).toContain("default-src 'self'");
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('login lockout after repeated failures, generic error message', async () => {
    const app = await getApp();
    const { resetRateLimits } = await import('../src/lib/ratelimit.js');
    let last: any;
    for (let i = 0; i < 10; i++) {
      resetRateLimits();
      last = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { org: ORG, email: `auditor@${ORG}.example`, password: 'wrong-password' } });
    }
    resetRateLimits();
    const locked = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { org: ORG, email: `auditor@${ORG}.example`, password: 'Operate-Demo-2026!' } });
    expect(locked.statusCode).toBe(423);
    const unknown = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { org: ORG, email: `nobody@${ORG}.example`, password: 'x' } });
    expect(unknown.json().message).toBe(last.json().message);
    await q(`UPDATE users SET locked_until = NULL, failed_logins = 0 WHERE email = $1`, [`auditor@${ORG}.example`]);
  });

  it('login is rate limited per account', async () => {
    const app = await getApp();
    const { resetRateLimits } = await import('../src/lib/ratelimit.js');
    resetRateLimits();
    const codes = [];
    for (let i = 0; i < 10; i++) codes.push((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { org: ORG, email: `ratelimit@${ORG}.example`, password: 'x' } })).statusCode);
    expect(codes).toContain(429);
    resetRateLimits();
  });

  it('rich text content is sanitised: scripts, javascript: links, foreign images are not stored', () => {
    const c = normalizeContent({ body: { type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'click', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }, { type: 'bold', attrs: { onclick: 'x' } }] }] },
      { type: 'heading', attrs: { level: 9, style: 'x' }, content: [{ type: 'text', text: 'h' }] },
    ] } });
    expect(JSON.stringify(c)).not.toContain('javascript');
    expect(JSON.stringify(c)).not.toContain('onclick');
    expect(c.body.content![1].attrs).toEqual({ level: 2 });
    expect(() => normalizeContent({ body: { type: 'doc', content: [{ type: 'script', content: [] }] } })).toThrow();
    expect(() => normalizeContent({ body: { type: 'doc', content: [{ type: 'image', attrs: { src: 'https://evil.example/x.png' } }] } })).toThrow();
    expect(() => normalizeContent({ body: { type: 'doc', content: [{ type: 'image', attrs: { src: 'data:image/svg+xml,<svg onload=alert(1)>' } }] } })).toThrow();
  });

  it('uploads are validated by magic bytes (SVG / HTML disguised as PNG rejected)', async () => {
    const app = await getApp();
    const docId = (await editor.post('/api/documents', { type: 'sop', title: 'アップロード検証', departmentId: S.dept.CS })).body.id;
    const upload = async (name: string, data: Buffer, kind = 'image') => {
      const boundary = '----op' + Math.random().toString(16).slice(2);
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\n${kind}\r\n`),
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: image/png\r\n\r\n`), data, Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      return app.inject({ method: 'POST', url: `/api/documents/${docId}/attachments`, payload: body, headers: { cookie: editor.cookie, 'x-csrf-token': editor.csrf, 'content-type': `multipart/form-data; boundary=${boundary}` } });
    };
    const svg = await upload('x.png', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'));
    expect(svg.statusCode).toBe(400);
    const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
    const ok = await upload('ok.png', png);
    expect(ok.statusCode).toBe(200);
    const get = await app.inject({ method: 'GET', url: ok.json().url, headers: { cookie: editor.cookie } });
    expect(get.headers['content-type']).toBe('image/png');
    expect(get.headers['content-security-policy']).toContain('sandbox');
    // Draft attachments are invisible to members
    const m = await app.inject({ method: 'GET', url: ok.json().url, headers: { cookie: memberCs.cookie } });
    expect(m.statusCode).toBe(404);
    const exe = await upload('run.exe', Buffer.from('MZ....'), 'attachment');
    expect(exe.statusCode).toBe(400);
  });
});

describe('checklist run (現場実行)', () => {
  it('start (idempotent), check items, cannot complete until required items are checked', async () => {
    const r1 = await memberOps.post(`/api/documents/${S.docs.ops010}/checklist-runs`, { clientKey: 'offline-key-1' });
    const r2 = await memberOps.post(`/api/documents/${S.docs.ops010}/checklist-runs`, { clientKey: 'offline-key-1' });
    expect(r1.body.id).toBe(r2.body.id);
    expect((await memberOps.post(`/api/checklist-runs/${r1.body.id}/complete`)).status).toBe(400);
    const items = r1.body.items.filter((x: any) => x.required).map((x: any) => ({ id: x.id, checked: true, note: '' }));
    expect((await memberOps.patch(`/api/checklist-runs/${r1.body.id}`, { items })).status).toBe(200);
    const done = await memberOps.post(`/api/checklist-runs/${r1.body.id}/complete`);
    expect(done.body.status).toBe('completed');
    expect((await memberOps.patch(`/api/checklist-runs/${r1.body.id}`, { items })).status).toBe(409);
    // manager sees it in the "all" list; another member does not
    const all = await kadmin.get(`/api/checklist-runs?scope=all&documentId=${S.docs.ops010}`);
    expect(all.body.some((x: any) => x.id === r1.body.id)).toBe(true);
    expect((await memberCs.get(`/api/checklist-runs/${r1.body.id}`)).status).toBe(404);
  });
});

describe('feedback / improvement', () => {
  it('feedback is pinned to the version and never edits the body', async () => {
    const f = await memberCs.post(`/api/documents/${S.docs.cs001}/feedback`, { kind: 'unclear', body: '手順3の意味が分かりにくい' });
    expect(f.status).toBe(200);
    const cur = (await q('SELECT current_version_id, (SELECT content_hash FROM document_versions WHERE id = current_version_id) h FROM documents WHERE id = $1', [S.docs.cs001]))[0];
    const row = (await q('SELECT version_id FROM feedback WHERE id = $1', [f.body.id]))[0];
    expect(row.version_id).toBe(cur.current_version_id);
    expect((await memberCs.patch(`/api/feedback/${f.body.id}`, { status: 'resolved' })).status).toBe(403);
    expect((await kadmin.patch(`/api/feedback/${f.body.id}`, { status: 'dismissed', resolution: '' })).status).toBe(400);
    expect((await kadmin.patch(`/api/feedback/${f.body.id}`, { status: 'resolved', resolution: 'v1.1 で修正予定' })).status).toBe(200);
    const after = (await q('SELECT content_hash FROM document_versions WHERE id = $1', [cur.current_version_id]))[0];
    expect(after.content_hash).toBe(cur.h);
    const t = await approver.post('/api/improvements', { documentId: S.docs.cs001, title: '誤案内の再発防止', priority: 'high', ownerId: S.users.editor });
    expect(t.status).toBe(200);
    expect((await memberCs.post('/api/improvements', { title: 'x' })).status).toBe(403);
  });
});

describe('dashboards / health / analytics', () => {
  it('role-based dashboard and factual knowledge health', async () => {
    const m = await memberCs.get('/api/dashboard');
    expect(m.body.knowledge).toBeUndefined();
    expect(m.body.attestations.length).toBeGreaterThan(0);
    const k = await kadmin.get('/api/dashboard');
    expect(k.body.knowledge.review_overdue).toBeGreaterThanOrEqual(1);
    const h = await kadmin.get('/api/health/knowledge');
    expect(h.body.documents.published).toBeGreaterThan(5);
    expect(h.body.note).toContain('AI');
    expect((await memberCs.get('/api/health/knowledge')).status).toBe(403);
    const a = await kadmin.get('/api/analytics/search');
    expect(a.body.candidates.some((c: any) => c.query.includes('有給'))).toBe(true);
    expect(JSON.stringify(a.body)).not.toContain(S.users['member-cs']);
  });

  it('sweep sends review-due / overdue reminders once (idempotent)', async () => {
    const r1 = await tx(S.orgId, (db) => sweepOrg(db));
    const n1 = await q(`SELECT count(*)::int AS n FROM notifications WHERE org_id = $1 AND type IN ('review_overdue','review_due','training_overdue','attestation_overdue')`, [S.orgId]);
    const r2 = await tx(S.orgId, (db) => sweepOrg(db));
    const n2 = await q(`SELECT count(*)::int AS n FROM notifications WHERE org_id = $1 AND type IN ('review_overdue','review_due','training_overdue','attestation_overdue')`, [S.orgId]);
    expect(r1.reviewDue).toBeGreaterThanOrEqual(1);
    expect(r2.reviewDue).toBe(r1.reviewDue);
    expect(n2[0].n).toBe(n1[0].n);
  });

  it('notifications: list + mark read', async () => {
    const n = await memberCs.get('/api/notifications');
    expect(n.body.length).toBeGreaterThan(0);
    await memberCs.post('/api/notifications/read', { all: true });
    expect((await memberCs.get('/api/notifications?unread=true')).body.length).toBe(0);
  });
});

describe('training extras', () => {
  it('certificate PDF + verification code; skill matrix; onboarding run with relative due dates', async () => {
    const certs = await memberCs.get('/api/certificates');
    expect(certs.body.length).toBe(1);
    const app = await getApp();
    const pdf = await app.inject({ method: 'GET', url: `/api/certificates/${certs.body[0].id}/pdf`, headers: { cookie: memberCs.cookie } });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await app.inject({ method: 'GET', url: `/api/certificates/${certs.body[0].id}/pdf`, headers: { cookie: newhire.cookie } })).statusCode).toBe(404);
    const v = await kadmin.get(`/api/certificates/verify/${certs.body[0].verification_code}`);
    expect(v.body.valid).toBe(true);
    const sm = await trainer.get(`/api/training/skills?departmentId=${S.dept.CS}`);
    expect(sm.body.matrix[S.users['member-cs']][S.courseId]).toBe('completed');
    expect((await memberCs.get('/api/training/skills')).status).toBe(403);
    // onboarding: template change does not modify existing runs / assignments
    const tpl = await trainer.post('/api/onboarding/templates', { name: 'IT新人', items: [{ courseId: S.courseId, offsetDays: 30, label: 'Month1' }] });
    const run = await trainer.post('/api/onboarding/runs', { templateId: tpl.body.id, userId: S.users['member-it'], startDate: '2026-10-01' });
    expect(run.status).toBe(200);
    expect(run.body.results[0].due).toBe('2026-10-31');
    await trainer.put(`/api/onboarding/templates/${tpl.body.id}`, { name: 'IT新人', items: [{ courseId: S.courseId, offsetDays: 3, label: 'Day3' }] });
    const due = await q(`SELECT due_date::text FROM training_assignments WHERE user_id = $1 AND source = 'onboarding'`, [S.users['member-it']]);
    expect(due[0].due_date).toBe('2026-10-31');
    expect((await trainer.post('/api/onboarding/runs', { templateId: tpl.body.id, userId: S.users['member-it'], startDate: '2026-10-01' })).status).toBe(409);
  });

  it('quiz: attempt limit and answers are never sent before submit', async () => {
    const qz = await trainer.post('/api/quizzes', { title: '回数制限' });
    const settings = { passScore: 100, maxAttempts: 1, cooldownMinutes: 0, shuffleQuestions: true, shuffleChoices: true, showExplanation: 'after_pass' };
    await trainer.put(`/api/quizzes/${qz.body.id}/draft`, { questions: [{ id: 'q1', type: 'multiple', prompt: '正しいものを全て', choices: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }, { id: 'c', text: 'C' }], correct: ['a', 'c'], explanation: '解説', points: 2 }], settings });
    await trainer.post(`/api/quizzes/${qz.body.id}/publish`);
    const at = await trainer.post(`/api/quizzes/${qz.body.id}/attempts`, {});
    expect(JSON.stringify(at.body)).not.toContain('correct');
    const sub = await trainer.post(`/api/attempts/${at.body.id}/submit`, { answers: { q1: ['a'] } });
    expect(sub.body.result).toBe('fail');
    expect(sub.body.review[0].explanation).toBeUndefined(); // after_pass only
    expect((await trainer.post(`/api/quizzes/${qz.body.id}/attempts`, {})).status).toBe(409);
    // members cannot take a stand-alone quiz outside a course
    expect((await memberCs.post(`/api/quizzes/${qz.body.id}/attempts`, {})).status).toBe(403);
  });
});

describe('import / export', () => {
  it('import: preview -> human confirm -> Drafts only (never published)', async () => {
    const app = await getApp();
    const boundary = '----imp' + Date.now();
    const md = '# 在庫棚卸し手順\n\n## 目的\n月末在庫を確定する\n\n1. 棚卸表を印刷する\n2. 数量を数える\n\n注意 数え直しは2名で行う\n';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="棚卸.md"\r\nContent-Type: text/markdown\r\n\r\n`), Buffer.from(md), Buffer.from(`\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="evil.exe"\r\nContent-Type: application/octet-stream\r\n\r\nMZ\r\n--${boundary}--\r\n`),
    ]);
    const r = await app.inject({ method: 'POST', url: '/api/import/preview', payload: body, headers: { cookie: editor.cookie, 'x-csrf-token': editor.csrf, 'content-type': `multipart/form-data; boundary=${boundary}` } });
    expect(r.statusCode).toBe(200);
    const items = r.json().items;
    expect(items[0].valid).toBe(true);
    expect(items[0].headings).toBeGreaterThanOrEqual(2);
    expect(items[1].valid).toBe(false);
    const c = await editor.post(`/api/import/${r.json().id}/commit`, { items: [{ key: '0', include: true, title: '在庫棚卸し手順', type: 'sop', departmentId: S.dept.CS }] });
    expect(c.status).toBe(200);
    const d = await editor.get(`/api/documents/${c.body.created[0].documentId}`);
    expect(d.body.document.status).toBe('draft');
    expect((await editor.post(`/api/import/${r.json().id}/commit`, { items: [] })).status).toBe(409);
    expect((await memberCs.post(`/api/import/${r.json().id}/commit`, { items: [] })).status).toBe(403);
  });

  it('SOP PDF export respects download policy and records audit', async () => {
    const t = await memberCs.post('/api/exports', { kind: 'document-pdf', params: { documentId: S.docs.cs001 } });
    expect(t.status).toBe(200);
    const app = await getApp();
    const r = await app.inject({ method: 'GET', url: t.body.url, headers: { cookie: memberCs.cookie } });
    expect(r.statusCode).toBe(200);
    expect(r.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    // restricted documents: download not allowed by default policy
    const it = await login('member-it', ORG);
    expect((await it.post('/api/exports', { kind: 'document-pdf', params: { documentId: S.docs.it020 } })).status).toBe(403);
    const n = await q(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'export.document_pdf' AND target_id = $1`, [S.docs.cs001]);
    expect(n[0].n).toBe(1);
  });

  it('offline: only allowed classifications, and superseded/retired copies are detected', async () => {
    const ok = await memberCs.get(`/api/documents/${S.docs.cs001}/offline`);
    expect(ok.status).toBe(200);
    expect(ok.body.version).toBeTruthy();
    const bo = await login('admin', ORG);
    expect((await bo.get(`/api/documents/${S.docs.bo003}/offline`)).status).toBe(403); // confidential
    const chk = await memberCs.post('/api/offline/check', { items: [{ documentId: S.docs.cs001, versionId: ok.body.versionId }, { documentId: S.docs.pol001, versionId: (await q(`SELECT id FROM document_versions WHERE document_id = $1 AND status = 'superseded'`, [S.docs.pol001]))[0].id }, { documentId: S.docs.it005, versionId: ok.body.versionId }] });
    expect(chk.body.map((x: any) => x.state)).toEqual(['current', 'superseded', 'forbidden']);
  });
});

describe('admin', () => {
  it('owner cannot remove the last owner; role changes are audited with before/after', async () => {
    const me = await owner.get('/api/me');
    expect((await owner.patch(`/api/admin/users/${me.body.id}`, { roles: ['member'] })).status).toBe(400);
    const r = await owner.patch(`/api/admin/users/${S.users['member-ops']}`, { roles: ['member', 'editor'] });
    expect(r.status).toBe(200);
    const a = await auditor.get(`/api/audit?targetId=${S.users['member-ops']}`);
    expect(a.body[0].detail.before.roles).toEqual(['member']);
    expect((await kadmin.patch(`/api/admin/users/${S.users['member-ops']}`, { roles: ['owner'] })).status).toBe(403);
  });

  it('anonymize a disabled user keeps history consistent', async () => {
    const u = await owner.post('/api/admin/users', { name: '退職 予定', email: `leaver@${ORG}.example`, roles: ['member'], memberships: [{ departmentId: S.dept.CS }] });
    await owner.post(`/api/admin/users/${u.body.id}/status`, { status: 'disabled' });
    const r = await owner.post(`/api/admin/users/${u.body.id}/anonymize`);
    expect(r.body.label).toMatch(/^退職者-/);
    const row = (await q('SELECT name, email, password_hash FROM users WHERE id = $1', [u.body.id]))[0];
    expect(row.password_hash).toBeNull();
    expect(row.email).toContain('anonymized.invalid');
  });

  it('audit log rows cannot be modified by the application role', async () => {
    await expect(tx(S.orgId, (db) => db.exec(sql`UPDATE audit_events SET summary = 'x'`))).rejects.toThrow();
    await expect(tx(S.orgId, (db) => db.exec(sql`DELETE FROM audit_events`))).rejects.toThrow();
  });
});

describe('search fallback', () => {
  it('a question typed as a sentence still finds the right SOP (fuzzy), without leaking other departments', async () => {
    const r = await memberCs.get(`/api/search?q=${encodeURIComponent('返金問い合わせの最初の手順は？')}`);
    expect(r.body.fuzzy).toBe(true);
    expect(r.body.items[0].id).toBe(S.docs.cs001);
    const it = await login('member-it', ORG);
    const r2 = await it.get(`/api/search?q=${encodeURIComponent('返金問い合わせの最初の手順は？')}`);
    expect(r2.body.items.some((x: any) => x.id === S.docs.cs001)).toBe(false);
  });
});
