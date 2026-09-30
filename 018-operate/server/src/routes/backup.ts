import type { FastifyInstance } from 'fastify';
import { gunzipSync, gzipSync } from 'node:zlib';
import { config } from '../config.js';
import { api } from '../http.js';
import { need } from '../lib/authz.js';
import { badRequest } from '../lib/errors.js';
import { sql } from '../lib/sql.js';
import { audit } from '../services/audit.js';
import { createBackup, validateBackup, type Backup } from '../services/backup.js';

export default async function backupRoutes(app: FastifyInstance) {
  /** Owner-only full backup of THIS organization (gzip JSON). Restore is done with the CLI (see バックアップと復元.txt). */
  api(app, 'POST', '/api/admin/backup', {}, async ({ db, actor, reply, ip }) => {
    need(actor, 'backup');
    const o = await db.one(sql`SELECT slug FROM organizations WHERE id = ${db.orgId}`);
    const b = await createBackup(config.adminDatabaseUrl, o.slug);
    await audit(db, actor, 'backup.create', { type: 'organization', id: db.orgId }, 'バックアップを作成・ダウンロード', { counts: b.counts }, ip);
    const gz = gzipSync(Buffer.from(JSON.stringify(b)));
    reply.header('Content-Type', 'application/gzip').header('Cache-Control', 'no-store')
      .header('Content-Disposition', `attachment; filename="operate-backup-${o.slug}-${b.generatedAt.slice(0, 10)}.json.gz"`);
    return reply.send(gz);
  });

  api(app, 'POST', '/api/admin/backup/validate', {}, async ({ actor, req }) => {
    need(actor, 'backup');
    const f = await req.file({ limits: { fileSize: 500 * 1024 * 1024 } });
    if (!f) throw badRequest('ファイルを選択してください');
    const buf = await f.toBuffer();
    let b: Backup;
    try { b = JSON.parse((buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf).toString('utf8')); } catch { throw badRequest('バックアップファイルを読み込めません'); }
    const r = validateBackup(b);
    return { ...r, generatedAt: b.generatedAt, appVersion: b.appVersion, organization: { name: (b.organization as any)?.name, slug: (b.organization as any)?.slug } };
  });
}
