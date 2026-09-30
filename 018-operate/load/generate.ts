/**
 * Load-test data generator. Creates a separate database with:
 *  - background tenants (default 1,000 orgs) to make tables large, and
 *  - measured tenants with 10 / 50 / 200 / 1,000 users (realistic sales sizes).
 * Usage: DB=operate_load BG_ORGS=1000 BG_USERS=100 npx tsx load/generate.ts
 * Everything is generated inside PostgreSQL with generate_series (fast, no network round trips).
 */
import pg from 'pg';
import { hashPassword } from '../server/src/lib/crypto.js';
import { embed, toVector } from '../server/src/ai/embed.js';

const DB = process.env.DB ?? 'operate_load';
const BG_ORGS = Number(process.env.BG_ORGS ?? 1000);
const BG_USERS = Number(process.env.BG_USERS ?? 100);
const BG_DOCS = Number(process.env.BG_DOCS ?? 200);
const AUDIT_PER_ORG = Number(process.env.AUDIT_PER_ORG ?? 5000);
const SIZES = (process.env.SIZES ?? '10,50,200,1000').split(',').map(Number);
const ADMIN = `postgres://postgres:postgres@127.0.0.1:5432/${DB}`;

const t0 = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

const root = new pg.Client({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5432/postgres' });
await root.connect();
await root.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await root.query(`CREATE DATABASE ${DB} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C.UTF-8' LC_CTYPE 'C.UTF-8'`);
await root.end();
const { migrate } = await import('../server/src/db/migrate.js');
await migrate(ADMIN, 'operate_app', () => undefined);
const c = new pg.Client({ connectionString: ADMIN });
await c.connect();
await c.query(`SET synchronous_commit = off`);
const pw = await hashPassword('Operate-Load-2026!');
const vec = toVector(embed('返金 問い合わせ 本人確認 手順'));

const TEXTS = ['返金問い合わせの一次対応', '出荷前の検品手順', '月末の請求データ確認', '新入社員アカウント発行', '情報持ち出しルール', '退職者アカウント停止', '在庫棚卸しの手順', 'クレーム対応の基本', '請求書発行フロー', 'パスワード再発行の受付'];

/** One tenant: orgs row + departments + users + roles + memberships + docs/versions/index/chunks + courses/assignments/attempts + audit. */
async function tenant(slug: string, users: number, docs: number, auditN: number) {
  const org = (await c.query(`INSERT INTO organizations (slug, name, settings) VALUES ($1, $2, $3) RETURNING id`, [slug, slug, JSON.stringify({ ai: { enabled: true, provider: 'local', userPerMinute: 120, orgPerDay: 1000000 } })])).rows[0].id;
  await c.query(`SELECT set_config('app.org_id', $1, false)`, [org]);
  await c.query(`INSERT INTO departments (org_id, name, code) SELECT $1, '部署' || g, 'D' || g FROM generate_series(1, 5) g`, [org]);
  const deps = (await c.query(`SELECT id FROM departments WHERE org_id = $1 ORDER BY code`, [org])).rows.map((r) => r.id);
  await c.query(`INSERT INTO users (org_id, email, name, password_hash) SELECT $1, 'u' || g || '@${slug}.example', 'ユーザー' || g, $2 FROM generate_series(1, $3) g`, [org, pw, users]);
  await c.query(`INSERT INTO user_roles (org_id, user_id, role) SELECT org_id, id, 'member' FROM users WHERE org_id = $1`, [org]);
  await c.query(`INSERT INTO user_roles (org_id, user_id, role) SELECT org_id, id, r FROM users, unnest(ARRAY['owner','knowledge_admin','trainer','auditor']) r WHERE org_id = $1 AND email = 'u1@${slug}.example'`, [org]);
  await c.query(`INSERT INTO memberships (org_id, user_id, department_id) SELECT u.org_id, u.id, ($2::uuid[])[1 + (row_number() OVER () % 5)] FROM users u WHERE u.org_id = $1`, [org, deps]);
  await c.query(`INSERT INTO documents (org_id, doc_number, type, title, summary, classification, status, department_id, audience_all, review_cycle_days, next_review_date, created_at, updated_at)
    SELECT $1, 'DOC-' || g, (ARRAY['sop','guide','faq','policy','checklist'])[1 + g % 5], ($3::text[])[1 + g % 10] || ' ' || g, '概要 ' || g,
           (ARRAY['public_internal','internal','internal','confidential','restricted'])[1 + g % 5], 'published', ($2::uuid[])[1 + g % 5], g % 3 = 0, 180,
           current_date + (g % 400) - 100, now() - make_interval(days => g % 700), now() - make_interval(days => g % 700)
      FROM generate_series(1, $4) g`, [org, deps, TEXTS, docs]);
  await c.query(`INSERT INTO document_audiences (org_id, document_id, kind, target) SELECT org_id, id, 'department', department_id::text FROM documents WHERE org_id = $1 AND NOT audience_all`, [org]);
  // two versions per document: v1.0 superseded, v1.1 published
  for (const [minor, status] of [[0, 'superseded'], [1, 'published']] as const) {
    await c.query(`INSERT INTO document_versions (org_id, document_id, major, minor, status, title, content, body_text, content_hash, published_at)
      SELECT org_id, id, 1, $2, $3, title, '{"body":{"type":"doc","content":[]},"steps":[],"checklistItems":[]}', title || ' の手順。本人確認を行い、記録する。担当者に連絡する。', md5(id::text || $2), now()
        FROM documents WHERE org_id = $1`, [org, minor, status]);
  }
  await c.query(`UPDATE documents d SET current_version_id = v.id FROM document_versions v WHERE v.document_id = d.id AND v.status = 'published' AND d.org_id = $1`, [org]);
  await c.query(`INSERT INTO search_index (document_id, org_id, version_id, title, summary, body_text, tags, category, search_text)
    SELECT d.id, d.org_id, d.current_version_id, d.title, d.summary, v.body_text, '', '', lower(d.doc_number || ' ' || d.title || ' ' || d.summary || ' ' || v.body_text)
      FROM documents d JOIN document_versions v ON v.id = d.current_version_id WHERE d.org_id = $1`, [org]);
  await c.query(`INSERT INTO knowledge_chunks (org_id, document_id, version_id, ordinal, section, text, text_hash, embedding)
    SELECT d.org_id, d.id, d.current_version_id, k, '手順' || k, d.title || ' 手順' || k || '：本人確認を行い、記録する。', md5(d.id::text || k), $2::vector
      FROM documents d, generate_series(1, 3) k WHERE d.org_id = $1`, [org, vec]);
  // training: 1 course with 1 quiz, every user assigned; 60% completed; 1 attempt per assignment
  const quiz = (await c.query(`INSERT INTO quizzes (org_id, title, status) VALUES ($1, '理解度テスト', 'published') RETURNING id`, [org])).rows[0].id;
  const qv = (await c.query(`INSERT INTO quiz_versions (org_id, quiz_id, version_no, status, questions, settings) VALUES ($1, $2, 1, 'published',
      '[{"id":"q1","type":"truefalse","prompt":"本人確認は必要？","choices":[{"id":"true","text":"正しい"},{"id":"false","text":"誤り"}],"correct":["true"],"explanation":"","points":1}]', '{"passScore":80}') RETURNING id`, [org, quiz])).rows[0].id;
  await c.query(`UPDATE quizzes SET current_version_id = $1 WHERE id = $2`, [qv, quiz]);
  const course = (await c.query(`INSERT INTO courses (org_id, title, status, due_days) VALUES ($1, '新人研修', 'published', 14) RETURNING id`, [org])).rows[0].id;
  const cv = (await c.query(`INSERT INTO course_versions (org_id, course_id, version_no, status, modules) VALUES ($1, $2, 1, 'published', $3) RETURNING id`,
    [org, course, JSON.stringify([{ id: 'm1', type: 'text', title: 'はじめに', required: true, text: 'x' }, { id: 'm2', type: 'quiz', title: 'テスト', required: true, quizId: quiz }])])).rows[0].id;
  await c.query(`UPDATE courses SET current_version_id = $1 WHERE id = $2`, [cv, course]);
  for (let k = 0; k < Number(process.env.COURSES_PER_ORG ?? 10); k++) {
    const extra = k === 0 ? cv : (await c.query(`INSERT INTO course_versions (org_id, course_id, version_no, status, modules) VALUES ($1, $2, $3, 'superseded', '[]') RETURNING id`, [org, course, k + 1])).rows[0].id;
    await c.query(`INSERT INTO training_assignments (org_id, course_id, course_version_id, user_id, status, due_date, completed_at)
      SELECT org_id, $2, $3, id, CASE WHEN random() < 0.6 THEN 'completed' ELSE 'in_progress' END, current_date + 7, now() FROM users WHERE org_id = $1`, [org, course, extra]);
  }
  await c.query(`INSERT INTO quiz_attempts (org_id, quiz_id, quiz_version_id, user_id, assignment_id, module_id, status, question_order, answers, score, max_score, result, submitted_at)
    SELECT ta.org_id, $2, $3, ta.user_id, ta.id, 'm2', 'submitted', '[{"id":"q1","choices":["true","false"]}]', '{"q1":"true"}', 1, 1, 'pass', now()
      FROM training_assignments ta WHERE ta.org_id = $1 AND ta.course_version_id = $4`, [org, quiz, qv, cv]);
  await c.query(`INSERT INTO audit_events (org_id, actor_label, action, target_type, target_id, summary, created_at)
    SELECT $1, 'ユーザー' || (g % 50), (ARRAY['auth.login','document.update','version.publish','export.document_pdf','training.completed'])[1 + g % 5], 'document', md5(g::text), '操作 ' || g, now() - make_interval(mins => g)
      FROM generate_series(1, $2) g`, [org, auditN]);
  return org;
}

log(`background: ${BG_ORGS} orgs × ${BG_USERS} users × ${BG_DOCS} docs`);
for (let i = 1; i <= BG_ORGS; i++) {
  await tenant(`bg-${i}`, BG_USERS, BG_DOCS, AUDIT_PER_ORG);
  if (i % 100 === 0) log(`  ${i} orgs`);
}
for (const n of SIZES) {
  await tenant(`t${n}`, n, Math.max(100, n * 3), n * 200);
  log(`measured tenant t${n} (${n} users)`);
}
await c.query('ANALYZE');
const counts = (await c.query(`SELECT
  (SELECT count(*) FROM organizations) orgs, (SELECT count(*) FROM users) users, (SELECT count(*) FROM documents) documents,
  (SELECT count(*) FROM document_versions) versions, (SELECT count(*) FROM search_index) search_index, (SELECT count(*) FROM knowledge_chunks) chunks,
  (SELECT count(*) FROM training_assignments) assignments, (SELECT count(*) FROM quiz_attempts) attempts, (SELECT count(*) FROM audit_events) audit_events,
  pg_size_pretty(pg_database_size(current_database())) db_size`)).rows[0];
log(JSON.stringify(counts));
await c.end();
