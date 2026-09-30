import type { FastifyInstance } from 'fastify';
import mammoth from 'mammoth';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { z } from 'zod';
import { config } from '../config.js';
import { api, idParams, zId } from '../http.js';
import { has, need } from '../lib/authz.js';
import { normalizeContent, plainText, type Content } from '../lib/content.js';
import { sha256 } from '../lib/crypto.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { markdownToDoc } from '../lib/markdown.js';
import { sql } from '../lib/sql.js';
import { audit } from '../services/audit.js';
import { createDocument } from '../services/documents.js';
import { detectFile, safeFilename } from './files.js';

export async function extractText(filename: string, data: Buffer): Promise<{ markdown: string; warnings: string[] }> {
  const ext = filename.toLowerCase().split('.').pop();
  const warnings: string[] = [];
  if (ext === 'docx') {
    const r = await (mammoth as any).convertToMarkdown({ buffer: data });
    if (r.messages?.length) warnings.push('一部の書式は取り込めませんでした');
    return { markdown: String(r.value).replace(/\\([.\-()#*_])/g, '$1').replace(/__(.+?)__/g, '**$1**'), warnings };
  }
  if (ext === 'pdf') {
    const r = await pdfParse(data);
    const text = String(r.text ?? '').trim();
    if (text.replace(/\s/g, '').length < 20) warnings.push('PDFから文字を抽出できませんでした（スキャンPDFのOCRには対応していません）');
    else warnings.push('PDFのレイアウト（表・段組み）は再現されません。内容を確認してください');
    return { markdown: text, warnings };
  }
  if (ext === 'md' || ext === 'txt' || ext === 'markdown') return { markdown: data.toString('utf8'), warnings };
  throw badRequest(`${filename}: 取り込めるのは Word(.docx) / PDF / Markdown / テキスト です`);
}

export default async function importRoutes(app: FastifyInstance) {
  /** Step 1: upload -> extraction preview. Originals are stored; nothing is created yet. */
  api(app, 'POST', '/api/import/preview', {}, async ({ db, actor, req, ip }) => {
    need(actor, 'import');
    const items: any[] = [];
    for await (const part of req.files({ limits: { fileSize: config.maxUploadBytes, files: 20 } })) {
      const filename = safeFilename(part.filename);
      const data = await part.toBuffer();
      if (part.file.truncated) throw badRequest(`${filename}: ファイルが大きすぎます`);
      const ext = filename.toLowerCase().split('.').pop() ?? '';
      if (!['docx', 'pdf', 'md', 'txt', 'markdown'].includes(ext)) { items.push({ key: String(items.length), filename, valid: false, warnings: ['対応していない形式です'] }); continue; }
      detectFile(ext === 'markdown' ? filename.replace(/markdown$/i, 'md') : filename, data, 'attachment');
      let res: { markdown: string; warnings: string[] };
      try { res = await extractText(filename, data); } catch (e: any) { items.push({ key: String(items.length), filename, valid: false, warnings: [e.message ?? '読み込めませんでした'] }); continue; }
      const content = normalizeContent({ body: markdownToDoc(res.markdown) });
      const att = await db.one(sql`INSERT INTO attachments (org_id, document_id, kind, filename, mime, size, sha256, data, uploaded_by)
        VALUES (${db.orgId}, NULL, 'import_source', ${filename}, ${'application/octet-stream'}, ${data.length}, ${sha256(data)}, ${data}, ${actor.id}) RETURNING id`);
      const text = plainText(content);
      items.push({
        key: String(items.length), filename, attachmentId: att.id, title: filename.replace(/\.[^.]+$/, '').slice(0, 200), type: 'sop',
        preview: text.slice(0, 600), chars: text.length, headings: (content.body.content ?? []).filter((n) => n.type === 'heading').length,
        warnings: res.warnings, valid: text.trim().length > 0, content,
      });
    }
    if (!items.length) throw badRequest('ファイルを選択してください');
    const b = await db.one(sql`INSERT INTO import_batches (org_id, created_by, items) VALUES (${db.orgId}, ${actor.id}, ${JSON.stringify(items)}) RETURNING id`);
    await audit(db, actor, 'import.preview', { type: 'import', id: b.id }, `${items.length} 件のファイルを取り込みプレビュー`, { files: items.map((x) => x.filename) }, ip);
    return { id: b.id, items: items.map(({ content: _c, ...x }) => x) };
  });

  api(app, 'GET', '/api/import/:id', { params: idParams }, async ({ db, actor, params }) => {
    need(actor, 'import');
    const b = await db.one(sql`SELECT * FROM import_batches WHERE id = ${params.id} AND (created_by = ${actor.id} OR ${has(actor, 'doc.admin')})`);
    if (!b) throw notFound();
    return { ...b, items: b.items.map(({ content: _c, ...x }: any) => x) };
  });

  /** Step 2: human-confirmed commit. Import ALWAYS creates Drafts; it never publishes. */
  api(app, 'POST', '/api/import/:id/commit', {
    params: idParams,
    body: z.object({ items: z.array(z.object({ key: z.string(), include: z.boolean(), title: z.string().trim().min(1).max(200), type: z.enum(['sop', 'policy', 'guide', 'faq', 'checklist', 'reference']), departmentId: zId.nullable().optional() })).max(20) }),
  }, async ({ db, actor, params, body, ip }) => {
    need(actor, 'import');
    const b = await db.one(sql`SELECT * FROM import_batches WHERE id = ${params.id} AND created_by = ${actor.id} FOR UPDATE`);
    if (!b) throw notFound();
    if (b.status !== 'preview') throw conflict('この取り込みは確定済みです');
    const created = [];
    for (const sel of body.items.filter((x) => x.include)) {
      const it = b.items.find((x: any) => x.key === sel.key);
      if (!it || !it.valid) throw badRequest('取り込めない項目が含まれています');
      if (!has(actor, 'doc.create')) throw forbidden();
      const r = await createDocument(db, actor, { type: sel.type, title: sel.title, departmentId: sel.departmentId ?? null, content: it.content as Content }, ip);
      await db.exec(sql`UPDATE attachments SET document_id = ${r.document.id} WHERE id = ${it.attachmentId} AND document_id IS NULL`);
      created.push({ key: sel.key, documentId: r.document.id, title: sel.title });
    }
    await db.exec(sql`UPDATE import_batches SET status = 'committed', committed_at = now() WHERE id = ${params.id}`);
    await audit(db, actor, 'import.commit', { type: 'import', id: params.id }, `${created.length} 件を下書きとして取り込み`, { created }, ip);
    return { created };
  });
}
