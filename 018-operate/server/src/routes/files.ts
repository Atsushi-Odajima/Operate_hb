import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { tx } from '../db/pool.js';
import { api, idParams, loadActor, resolveSession, revokedReason } from '../http.js';
import { canDownload, docAccessible, has } from '../lib/authz.js';
import { sha256 } from '../lib/crypto.js';
import { badRequest, forbidden, notFound, unauthorized } from '../lib/errors.js';
import { sql } from '../lib/sql.js';
import { audit } from '../services/audit.js';
import { getDoc } from '../services/documents.js';

const IMAGE_TYPES: Record<string, (b: Buffer) => boolean> = {
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': (b) => b.subarray(0, 4).toString('latin1') === 'GIF8',
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
};
const zip = (b: Buffer) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
const textish = (b: Buffer) => !b.includes(0) && Buffer.from(b.toString('utf8'), 'utf8').equals(b);
const FILE_TYPES: Record<string, { mime: string; check: (b: Buffer) => boolean }> = {
  pdf: { mime: 'application/pdf', check: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', check: zip },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', check: zip },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', check: zip },
  txt: { mime: 'text/plain; charset=utf-8', check: textish },
  md: { mime: 'text/markdown; charset=utf-8', check: textish },
  csv: { mime: 'text/csv; charset=utf-8', check: textish },
};

/** Validate by magic bytes, never by the client supplied Content-Type. SVG/HTML are rejected (script risk). */
export function detectFile(filename: string, data: Buffer, kind: 'image' | 'attachment' | 'import_source'): string {
  if (kind === 'image') {
    for (const [mime, check] of Object.entries(IMAGE_TYPES)) if (check(data)) return mime;
    throw badRequest('画像は PNG / JPEG / GIF / WebP のみアップロードできます');
  }
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  const t = FILE_TYPES[ext];
  if (t && t.check(data)) return t.mime;
  for (const [mime, check] of Object.entries(IMAGE_TYPES)) if (check(data)) return mime;
  throw badRequest('このファイル形式はアップロードできません（PDF, Word, Excel, PowerPoint, テキスト, CSV, 画像）');
}

export function safeFilename(name: string) {
  return (name.split(/[\\/]/).pop() ?? 'file').replace(/[\u0000-\u001f"<>|:*?]/g, '_').slice(0, 150) || 'file';
}

export default async function fileRoutes(app: FastifyInstance) {
  api(app, 'POST', '/api/documents/:id/attachments', { params: idParams }, async ({ db, actor, params, req, ip }) => {
    const d = await getDoc(db, actor, params.id, 'edit');
    const file = await req.file({ limits: { fileSize: config.maxUploadBytes, files: 1 } });
    if (!file) throw badRequest('ファイルを選択してください');
    const kind = (file.fields.kind as any)?.value === 'image' ? 'image' : 'attachment';
    const data = await file.toBuffer();
    if (file.file.truncated) throw badRequest(`ファイルサイズは ${Math.round(config.maxUploadBytes / 1024 / 1024)}MB までです`);
    const filename = safeFilename(file.filename);
    const mime = detectFile(filename, data, kind);
    const row = await db.one(sql`INSERT INTO attachments (org_id, document_id, kind, filename, mime, size, sha256, data, uploaded_by)
      VALUES (${db.orgId}, ${d.id}, ${kind}, ${filename}, ${mime}, ${data.length}, ${sha256(data)}, ${data}, ${actor.id}) RETURNING id, filename, mime, size, kind`);
    await audit(db, actor, 'attachment.upload', { type: 'document', id: d.id }, `ファイル「${filename}」を添付`, { attachmentId: row.id, size: data.length, mime }, ip);
    return { ...row, url: `/api/attachments/${row.id}/content` };
  });

  api(app, 'GET', '/api/documents/:id/attachments', { params: idParams }, async ({ db, actor, params }) => {
    await getDoc(db, actor, params.id, 'access');
    return db.q(sql`SELECT id, filename, mime, size, kind, created_at FROM attachments WHERE document_id = ${params.id} AND kind <> 'import_source' ORDER BY created_at`);
  });

  // Served through the app (not a public bucket): authorization is checked on every request.
  app.get('/api/attachments/:id/content', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const s = await resolveSession(req);
    if (!s) throw await revokedReason(req);
    const file = await tx(s.orgId, async (db) => {
      const actor = await loadActor(db, s.sessionId, s.userId);
      const f = await db.one(sql`SELECT a.id, a.filename, a.mime, a.data, a.kind, a.document_id, d.classification FROM attachments a
          JOIN documents d ON d.id = a.document_id WHERE a.id = ${id} AND ${docAccessible(actor)}`);
      if (!f) throw notFound();
      if (f.kind === 'import_source' && !has(actor, 'import')) throw notFound();
      if (f.kind !== 'image' && !canDownload(actor, f.classification)) throw forbidden('この文書の添付ファイルはダウンロードできません');
      if (f.kind !== 'image') await audit(db, actor, 'attachment.download', { type: 'document', id: f.document_id }, `「${f.filename}」をダウンロード`, { attachmentId: f.id });
      return f;
    });
    reply.header('Content-Type', file.mime);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Security-Policy', "default-src 'none'; sandbox");
    reply.header('Cache-Control', 'private, max-age=300');
    reply.header('Content-Disposition', `${file.kind === 'image' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
    return reply.send(file.data);
  });

  void z;
}
