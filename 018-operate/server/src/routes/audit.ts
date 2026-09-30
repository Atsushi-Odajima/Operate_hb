import { ZipArchive } from 'archiver';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tx, type Db } from '../db/pool.js';
import { api, idParams, loadActor, resolveSession, revokedReason, zDate, zId } from '../http.js';
import { canDownload, has, need, type Actor } from '../lib/authz.js';
import type { Content } from '../lib/content.js';
import { sha256, token } from '../lib/crypto.js';
import { safeName, toCsv } from '../lib/csv.js';
import { documentPdf } from '../lib/docpdf.js';
import { forbidden, notFound, unauthorized } from '../lib/errors.js';
import { and, sql, type SQL } from '../lib/sql.js';
import { audit } from '../services/audit.js';
import { getDoc } from '../services/documents.js';

const packageParams = z.object({
  from: zDate, to: zDate,
  departmentId: zId.nullable().optional(),
  documentIds: z.array(zId).max(500).optional(),
  includePdf: z.boolean().default(true),
});
type PackageParams = z.infer<typeof packageParams>;

async function docPdfBuffer(db: Db, actor: Actor, documentId: string, versionId?: string) {
  const d = await db.one(sql`SELECT d.*, u.name AS owner_name, dp.name AS dept_name, o.name AS org_name FROM documents d LEFT JOIN users u ON u.id = d.owner_id
      LEFT JOIN departments dp ON dp.id = d.department_id JOIN organizations o ON o.id = d.org_id WHERE d.id = ${documentId}`);
  const v = await db.one(sql`SELECT * FROM document_versions WHERE id = ${versionId ?? d.current_version_id}`);
  return documentPdf({
    title: v.title, docNumber: d.doc_number, version: `${v.major}.${v.minor}`, classification: d.classification, effectiveDate: v.effective_date ?? d.effective_date,
    publishedAt: v.published_at, owner: d.owner_name, department: d.dept_name, orgName: d.org_name, generatedBy: actor.name, status: v.status,
  }, v.content as Content);
}

/**
 * Audit Package: everything is queried inside the tenant transaction (RLS) with explicit scope filters,
 * and entry names are built only from sanitized components (no path traversal).
 */
export async function buildAuditPackage(db: Db, actor: Actor, p: PackageParams): Promise<{ zip: Buffer; manifest: any }> {
  const scope: SQL[] = [sql`d.org_id = ${db.orgId}`];
  if (p.departmentId) scope.push(sql`d.department_id = ${p.departmentId}::uuid`);
  if (p.documentIds?.length) scope.push(sql`d.id = ANY(${p.documentIds}::uuid[])`);
  const where = and(scope);
  const from = p.from, to = p.to;
  const files: Array<{ name: string; data: Buffer }> = [];
  const add = (name: string, data: Buffer) => files.push({ name, data });

  const docs = await db.q(sql`SELECT d.id, d.doc_number, d.type, d.title, d.status, d.classification, dp.name AS department, u.name AS owner, v.major, v.minor,
      v.published_at, d.effective_date, d.next_review_date, d.last_reviewed_at, d.review_cycle_days, v.content_hash, d.current_version_id
    FROM documents d LEFT JOIN departments dp ON dp.id = d.department_id LEFT JOIN users u ON u.id = d.owner_id LEFT JOIN document_versions v ON v.id = d.current_version_id
    WHERE ${where} AND d.status = 'published' ORDER BY d.doc_number NULLS LAST, d.title`);
  add('01_現行SOP一覧.csv', toCsv(['文書番号', '種別', 'タイトル', '状態', '機密区分', '部署', '担当', '版', '公開日', '施行日', '次回レビュー', '最終レビュー', 'レビュー周期(日)', 'contentHash'],
    docs.map((d) => [d.doc_number, d.type, d.title, d.status, d.classification, d.department, d.owner, `${d.major}.${d.minor}`, d.published_at, d.effective_date, d.next_review_date, d.last_reviewed_at, d.review_cycle_days, d.content_hash])));

  const versions = await db.q(sql`SELECT d.doc_number, d.title AS doc_title, v.major, v.minor, v.status, v.change_type, v.change_summary, u.name AS author, v.ai_generated,
      v.created_at, v.submitted_at, v.approved_at, v.published_at, v.superseded_at, v.content_hash
    FROM document_versions v JOIN documents d ON d.id = v.document_id LEFT JOIN users u ON u.id = v.author_id
    WHERE ${where} AND (v.created_at::date BETWEEN ${from}::date AND ${to}::date OR v.published_at::date BETWEEN ${from}::date AND ${to}::date OR v.id = d.current_version_id)
    ORDER BY d.doc_number, v.major, v.minor`);
  add('02_version履歴.csv', toCsv(['文書番号', '文書', '版', '状態', '変更区分', '変更内容', '作成者', 'AI生成', '作成日時', '提出日時', '承認日時', '公開日時', '置換日時', 'contentHash'],
    versions.map((v) => [v.doc_number, v.doc_title, `${v.major}.${v.minor}`, v.status, v.change_type, v.change_summary, v.author, v.ai_generated ? 'はい' : 'いいえ', v.created_at, v.submitted_at, v.approved_at, v.published_at, v.superseded_at, v.content_hash])));

  const approvals = await db.q(sql`SELECT d.doc_number, d.title, v.major, v.minor, st.round, st.step_no, st.mode, u.name AS approver, ap.decision, ap.comment, ap.content_hash, ap.created_at,
      (ap.content_hash = v.content_hash) AS hash_matches
    FROM approvals ap JOIN approval_steps st ON st.id = ap.step_id JOIN document_versions v ON v.id = ap.version_id JOIN documents d ON d.id = v.document_id LEFT JOIN users u ON u.id = ap.approver_id
    WHERE ${where} AND ap.created_at::date BETWEEN ${from}::date AND ${to}::date ORDER BY ap.created_at`);
  add('03_承認履歴.csv', toCsv(['文書番号', '文書', '版', 'ラウンド', 'ステップ', '方式', '承認者', '判断', 'コメント', '承認時contentHash', '日時', '現行内容と一致'],
    approvals.map((a) => [a.doc_number, a.title, `${a.major}.${a.minor}`, a.round, a.step_no, a.mode, a.approver, a.decision, a.comment, a.content_hash, a.created_at, a.hash_matches ? '一致' : '不一致'])));

  const reviews = await db.q(sql`SELECT d.doc_number, d.title, v.major, v.minor, rr.round, u.name AS reviewer, ra.status, ra.comment, ra.decided_at
    FROM review_assignments ra JOIN review_requests rr ON rr.id = ra.review_id JOIN document_versions v ON v.id = rr.version_id JOIN documents d ON d.id = v.document_id
    LEFT JOIN users u ON u.id = ra.reviewer_id WHERE ${where} AND rr.created_at::date BETWEEN ${from}::date AND ${to}::date ORDER BY rr.created_at`);
  add('04_レビュー履歴.csv', toCsv(['文書番号', '文書', '版', 'ラウンド', 'レビュー担当', '結果', 'コメント', '日時'],
    reviews.map((r) => [r.doc_number, r.title, `${r.major}.${r.minor}`, r.round, r.reviewer, r.status, r.comment, r.decided_at])));

  const att = await db.q(sql`SELECT d.doc_number, d.title, v.major, v.minor, u.name, ua.status, ua.assigned_at, ua.due_date, ua.viewed_at, ua.reached_end_at, ua.acknowledged_at, ua.waived_reason
    FROM user_attestations ua JOIN document_versions v ON v.id = ua.version_id JOIN documents d ON d.id = ua.document_id JOIN users u ON u.id = ua.user_id
    WHERE ${where} AND ua.assigned_at::date <= ${to}::date AND (ua.acknowledged_at IS NULL OR ua.acknowledged_at::date >= ${from}::date) ORDER BY d.doc_number, v.major, v.minor, u.name`);
  add('05_重要文書の確認記録.csv', toCsv(['文書番号', '文書', '版', '対象者', '状態', '依頼日時', '期限', '閲覧日時', '最後まで表示', '確認日時', '免除理由'],
    att.map((a) => [a.doc_number, a.title, `${a.major}.${a.minor}`, a.name, a.status, a.assigned_at, a.due_date, a.viewed_at, a.reached_end_at, a.acknowledged_at, a.waived_reason])));

  const tr = await db.q(sql`SELECT c.title, cv.version_no, u.name, ta.status, ta.assigned_at, ta.due_date, ta.completed_at, ta.waived_reason, ce.verification_code
    FROM training_assignments ta JOIN courses c ON c.id = ta.course_id JOIN course_versions cv ON cv.id = ta.course_version_id JOIN users u ON u.id = ta.user_id
    LEFT JOIN certificates ce ON ce.assignment_id = ta.id
    WHERE ta.org_id = ${db.orgId} AND ta.assigned_at::date <= ${to}::date AND (ta.completed_at IS NULL OR ta.completed_at::date >= ${from}::date)
      AND (${p.departmentId ?? null}::uuid IS NULL OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id AND m.department_id = ${p.departmentId ?? null}::uuid))
    ORDER BY c.title, u.name`);
  add('06_研修受講記録.csv', toCsv(['コース', '版', '受講者', '状態', '割当日時', '期限', '修了日時', '免除理由', '完了証照合コード'],
    tr.map((t) => [t.title, t.version_no, t.name, t.status, t.assigned_at, t.due_date, t.completed_at, t.waived_reason, t.verification_code])));

  add('07_改訂期限.csv', toCsv(['文書番号', 'タイトル', '担当', 'レビュー周期(日)', '最終レビュー', '次回レビュー', '期限超過'],
    docs.map((d) => [d.doc_number, d.title, d.owner, d.review_cycle_days, d.last_reviewed_at, d.next_review_date, d.next_review_date && d.next_review_date < new Date().toISOString().slice(0, 10) ? '超過' : ''])));

  const docIds = docs.map((d) => d.id);
  const logs = await db.q(sql`SELECT e.created_at, e.actor_label, e.action, e.target_type, e.target_id, e.summary FROM audit_events e
    WHERE e.org_id = ${db.orgId} AND e.created_at::date BETWEEN ${from}::date AND ${to}::date
      AND (${!p.departmentId && !p.documentIds?.length} OR e.target_id = ANY(${docIds}::text[])
           OR e.target_id IN (SELECT v.id::text FROM document_versions v WHERE v.document_id = ANY(${docIds}::uuid[])))
    ORDER BY e.id LIMIT 50000`);
  add('08_監査ログ抜粋.csv', toCsv(['日時', '操作者', '操作', '対象種別', '対象ID', '概要'], logs.map((l) => [l.created_at, l.actor_label, l.action, l.target_type, l.target_id, l.summary])));

  if (p.includePdf) {
    for (const d of docs.slice(0, 300)) {
      add(`SOP/${safeName(d.doc_number ?? 'DOC')}_${safeName(d.title, 40)}_v${d.major}.${d.minor}.pdf`, await docPdfBuffer(db, actor, d.id));
    }
  }

  const generatedAt = new Date().toISOString();
  const manifest = {
    product: 'Operate', kind: 'audit-package', generatedAt, generatedBy: actor.name, organization: actor.orgName, params: p,
    counts: { documents: docs.length, versions: versions.length, approvals: approvals.length, reviews: reviews.length, attestations: att.length, training: tr.length, auditEvents: logs.length },
    files: files.map((f) => ({ name: f.name, bytes: f.data.length, sha256: sha256(f.data) })),
  };
  const readme = `Operate 監査用パッケージ\n\n生成日時: ${generatedAt}\n生成者: ${actor.name}\n組織: ${actor.orgName}\n対象期間: ${from} 〜 ${to}\n` +
    `対象部署: ${p.departmentId ?? 'すべて'}\n\n各ファイルの SHA-256 は manifest.json に記録しています。\n` +
    `本パッケージは Operate に記録された操作履歴をまとめたものです。法令・規格への準拠を自動的に保証するものではありません。\n`;
  const archive = new ZipArchive({ zlib: { level: 6 } });
  const chunks: Buffer[] = [];
  archive.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((res, rej) => { archive.on('end', () => res()); archive.on('error', rej); });
  archive.append(readme, { name: 'README.txt' });
  archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
  for (const f of files) archive.append(f.data, { name: f.name });
  await archive.finalize();
  await done;
  return { zip: Buffer.concat(chunks), manifest };
}

export default async function auditRoutes(app: FastifyInstance) {
  api(app, 'GET', '/api/audit', {
    query: z.object({ action: z.string().max(60).optional(), actor: z.string().max(100).optional(), targetId: z.string().max(64).optional(), from: zDate.optional(), to: zDate.optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100), before: z.coerce.number().int().optional() }),
  }, async ({ db, actor, query }) => {
    need(actor, 'audit.read');
    const conds: SQL[] = [sql`TRUE`];
    if (query.action) conds.push(sql`action LIKE ${query.action.replace(/[\\%_]/g, '\\$&') + '%'}`);
    if (query.actor) conds.push(sql`actor_label ILIKE ${'%' + query.actor.replace(/[\\%_]/g, '\\$&') + '%'}`);
    if (query.targetId) conds.push(sql`target_id = ${query.targetId}`);
    if (query.from) conds.push(sql`created_at >= ${query.from}::date`);
    if (query.to) conds.push(sql`created_at < ${query.to}::date + 1`);
    if (query.before) conds.push(sql`id < ${query.before}`);
    return db.q(sql`SELECT id, created_at, actor_label, action, target_type, target_id, summary, detail, ip FROM audit_events WHERE ${and(conds)} ORDER BY id DESC LIMIT ${query.limit}`);
  });

  // ---- one-time, short-lived, user-bound download tokens ("signed URL")
  api(app, 'POST', '/api/exports', {
    body: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('audit-package'), params: packageParams }),
      z.object({ kind: z.literal('audit-log'), params: z.object({ from: zDate, to: zDate }) }),
      z.object({ kind: z.literal('attestations'), params: z.object({ documentId: zId.nullable().optional() }) }),
      z.object({ kind: z.literal('training'), params: z.object({ courseId: zId.nullable().optional() }) }),
      z.object({ kind: z.literal('document-pdf'), params: z.object({ documentId: zId, versionId: zId.optional() }) }),
      z.object({ kind: z.literal('document-list'), params: z.object({ departmentId: zId.nullable().optional() }) }),
    ]),
  }, async ({ db, actor, body }) => {
    if (body.kind === 'audit-package' || body.kind === 'audit-log') need(actor, 'audit.export');
    if (body.kind === 'attestations') need(actor, 'attestation.report');
    if (body.kind === 'training') need(actor, 'training.report');
    if (body.kind === 'document-list') need(actor, 'health.read');
    if (body.kind === 'document-pdf') {
      const d = await getDoc(db, actor, body.params.documentId, body.params.versionId ? 'access' : 'read');
      if (!canDownload(actor, d.classification)) throw forbidden('この機密区分の文書はダウンロードできません');
      if (body.params.versionId && body.params.versionId !== d.current_version_id && !(has(actor, 'doc.readAll') || d.can_edit)) throw notFound();
    }
    const id = token(24);
    await db.exec(sql`INSERT INTO download_tokens (id, org_id, user_id, kind, params, expires_at) VALUES (${sha256(id)}, ${db.orgId}, ${actor.id}, ${body.kind}, ${JSON.stringify(body.params)}, now() + interval '10 minutes')`);
    return { url: `/api/downloads/${id}`, expiresInSeconds: 600 };
  });

  app.get('/api/downloads/:token', async (req, reply) => {
    const { token: tok } = z.object({ token: z.string().min(20).max(64) }).parse(req.params);
    const s = await resolveSession(req);
    if (!s) throw await revokedReason(req);
    const out = await tx(s.orgId, async (db) => {
      const actor = await loadActor(db, s.sessionId, s.userId);
      const t = await db.one(sql`UPDATE download_tokens SET used_at = now() WHERE id = ${sha256(tok)} AND user_id = ${actor.id} AND used_at IS NULL AND expires_at > now() RETURNING *`);
      if (!t) throw notFound('ダウンロードリンクの有効期限が切れています。もう一度出力してください');
      const p = t.params;
      const day = new Date().toISOString().slice(0, 10);
      let file: Buffer, name: string, type = 'text/csv; charset=utf-8';
      switch (t.kind) {
        case 'audit-package': {
          need(actor, 'audit.export');
          const r = await buildAuditPackage(db, actor, packageParams.parse(p));
          file = r.zip; name = `Operate_監査パッケージ_${p.from}_${p.to}.zip`; type = 'application/zip';
          await audit(db, actor, 'export.audit_package', { type: 'organization', id: db.orgId }, `監査パッケージを出力（${p.from}〜${p.to}）`, { params: p, counts: r.manifest.counts });
          break;
        }
        case 'audit-log': {
          need(actor, 'audit.export');
          const rows = await db.q(sql`SELECT created_at, actor_label, action, target_type, target_id, summary, ip FROM audit_events WHERE created_at::date BETWEEN ${p.from}::date AND ${p.to}::date ORDER BY id LIMIT 200000`);
          file = toCsv(['日時', '操作者', '操作', '対象種別', '対象ID', '概要', 'IP'], rows.map((r) => [r.created_at, r.actor_label, r.action, r.target_type, r.target_id, r.summary, r.ip]));
          name = `Operate_監査ログ_${p.from}_${p.to}.csv`;
          await audit(db, actor, 'export.audit_log', { type: 'organization', id: db.orgId }, `監査ログCSVを出力（${rows.length}件）`, p);
          break;
        }
        case 'attestations': {
          need(actor, 'attestation.report');
          const rows = await db.q(sql`SELECT d.doc_number, d.title, v.major, v.minor, u.name, ua.status, ua.due_date, ua.acknowledged_at, ua.waived_reason
            FROM user_attestations ua JOIN documents d ON d.id = ua.document_id JOIN document_versions v ON v.id = ua.version_id JOIN users u ON u.id = ua.user_id
            WHERE ua.status <> 'cancelled' AND (${p.documentId ?? null}::uuid IS NULL OR ua.document_id = ${p.documentId ?? null}::uuid) ORDER BY d.doc_number, v.major, v.minor, u.name`);
          file = toCsv(['文書番号', '文書', '版', '対象者', '状態', '期限', '確認日時', '免除理由'], rows.map((r) => [r.doc_number, r.title, `${r.major}.${r.minor}`, r.name, r.status, r.due_date, r.acknowledged_at, r.waived_reason]));
          name = `Operate_確認記録_${day}.csv`;
          await audit(db, actor, 'export.attestations', { type: 'organization', id: db.orgId }, `確認記録CSVを出力（${rows.length}件）`, p);
          break;
        }
        case 'training': {
          need(actor, 'training.report');
          const rows = await db.q(sql`SELECT c.title, cv.version_no, u.name, ta.status, ta.due_date, ta.completed_at, ta.waived_reason FROM training_assignments ta
            JOIN courses c ON c.id = ta.course_id JOIN course_versions cv ON cv.id = ta.course_version_id JOIN users u ON u.id = ta.user_id
            WHERE ta.status <> 'cancelled' AND (${p.courseId ?? null}::uuid IS NULL OR ta.course_id = ${p.courseId ?? null}::uuid) ORDER BY c.title, u.name`);
          file = toCsv(['コース', '版', '受講者', '状態', '期限', '修了日時', '免除理由'], rows.map((r) => [r.title, r.version_no, r.name, r.status, r.due_date, r.completed_at, r.waived_reason]));
          name = `Operate_研修記録_${day}.csv`;
          await audit(db, actor, 'export.training', { type: 'organization', id: db.orgId }, `研修記録CSVを出力（${rows.length}件）`, p);
          break;
        }
        case 'document-list': {
          need(actor, 'health.read');
          const rows = await db.q(sql`SELECT d.doc_number, d.type, d.title, d.status, d.classification, dp.name AS dept, u.name AS owner, v.major, v.minor, d.next_review_date FROM documents d
            LEFT JOIN departments dp ON dp.id = d.department_id LEFT JOIN users u ON u.id = d.owner_id LEFT JOIN document_versions v ON v.id = d.current_version_id
            WHERE d.status = 'published' AND (${p.departmentId ?? null}::uuid IS NULL OR d.department_id = ${p.departmentId ?? null}::uuid) ORDER BY dp.name, d.doc_number`);
          file = toCsv(['文書番号', '種別', 'タイトル', '状態', '機密区分', '部署', '担当', '版', '次回レビュー'], rows.map((r) => [r.doc_number, r.type, r.title, r.status, r.classification, r.dept, r.owner, r.major != null ? `${r.major}.${r.minor}` : '', r.next_review_date]));
          name = `Operate_部署別SOP一覧_${day}.csv`;
          await audit(db, actor, 'export.document_list', { type: 'organization', id: db.orgId }, `SOP一覧CSVを出力（${rows.length}件）`, p);
          break;
        }
        case 'document-pdf': {
          const d = await getDoc(db, actor, p.documentId, p.versionId ? 'access' : 'read');
          if (!canDownload(actor, d.classification)) throw forbidden();
          file = await docPdfBuffer(db, actor, d.id, p.versionId);
          name = `${d.doc_number ?? 'SOP'}_${safeName(d.title, 40)}.pdf`; type = 'application/pdf';
          await audit(db, actor, 'export.document_pdf', { type: 'document', id: d.id }, `「${d.title}」をPDF出力`, { versionId: p.versionId ?? d.current_version_id, classification: d.classification });
          break;
        }
        default: throw notFound();
      }
      return { file, name, type };
    });
    reply.header('Content-Type', out.type).header('Cache-Control', 'no-store')
      .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(out.name)}`);
    return reply.send(out.file);
  });

  void idParams;
}
