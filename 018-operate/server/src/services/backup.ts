import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { sha256 } from '../lib/crypto.js';

export const BACKUP_FORMAT = 'operate-backup';
export const APP_VERSION = '1.0.0';

/** Parent tables first. sessions / download_tokens / embedding_cache are intentionally not backed up. */
export const BACKUP_TABLES = [
  'departments', 'teams', 'users', 'user_roles', 'memberships', 'approver_scopes', 'templates', 'documents', 'document_audiences',
  'document_versions', 'attachments', 'review_requests', 'review_assignments', 'review_comments', 'approval_steps', 'approval_step_approvers',
  'approvals', 'document_relations', 'feedback', 'improvement_tickets', 'checklist_runs', 'attestation_campaigns', 'user_attestations',
  'quizzes', 'quiz_versions', 'courses', 'course_versions', 'training_assignments', 'module_progress', 'quiz_attempts', 'certificates',
  'onboarding_templates', 'onboarding_runs', 'search_index', 'knowledge_chunks', 'search_queries', 'ai_usage', 'notifications',
  'audit_events', 'import_batches', 'jobs',
] as const;

export function schemaVersion(): string[] {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '../db/migrations');
  return readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
}

export interface Backup {
  format: string;
  schemaVersion: string[];
  appVersion: string;
  generatedAt: string;
  organization: Record<string, unknown>;
  counts: Record<string, number>;
  checksums: Record<string, string>;
  tables: Record<string, unknown[]>;
}

/** Runs with the owner (admin) connection; every query is explicitly filtered by org_id. */
export async function createBackup(adminUrl: string, orgSlug: string): Promise<Backup> {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const org = (await c.query('SELECT row_to_json(o) AS r FROM organizations o WHERE slug = $1', [orgSlug])).rows[0]?.r;
    if (!org) throw new Error(`organization not found: ${orgSlug}`);
    const tables: Record<string, unknown[]> = {};
    const counts: Record<string, number> = {};
    const checksums: Record<string, string> = {};
    for (const t of BACKUP_TABLES) {
      // parents before children inside self-referencing tables (based_on_version_id)
      const order = ['audit_events', 'search_queries', 'ai_usage'].includes(t) ? 'ORDER BY id' : t === 'document_versions' ? 'ORDER BY created_at, major, minor' : '';
      const rows = (await c.query(`SELECT row_to_json(x) AS r FROM ${pg.escapeIdentifier(t)} x WHERE org_id = $1 ${order}`, [org.id])).rows.map((r) => r.r);
      tables[t] = rows;
      counts[t] = rows.length;
      checksums[t] = sha256(JSON.stringify(rows));
    }
    await c.query('COMMIT');
    return { format: BACKUP_FORMAT, schemaVersion: schemaVersion(), appVersion: APP_VERSION, generatedAt: new Date().toISOString(), organization: org, counts, checksums, tables };
  } finally {
    await c.end();
  }
}

export interface ValidationReport { ok: boolean; errors: string[]; counts: Record<string, number> }

export function validateBackup(b: Backup): ValidationReport {
  const errors: string[] = [];
  if (b?.format !== BACKUP_FORMAT) errors.push('ファイル形式が Operate のバックアップではありません');
  const cur = schemaVersion();
  if (!Array.isArray(b?.schemaVersion) || b.schemaVersion.some((m) => !cur.includes(m))) errors.push('このバックアップはより新しいバージョンの Operate で作成されています');
  for (const t of BACKUP_TABLES) {
    const rows = b?.tables?.[t];
    if (!Array.isArray(rows)) { errors.push(`テーブル ${t} がありません`); continue; }
    if (rows.length !== b.counts?.[t]) errors.push(`${t}: 件数が一致しません`);
    if (sha256(JSON.stringify(rows)) !== b.checksums?.[t]) errors.push(`${t}: チェックサムが一致しません（ファイル破損または改変）`);
    const orgId = (b.organization as any)?.id;
    if (rows.some((r: any) => r.org_id !== orgId)) errors.push(`${t}: 他組織のデータが含まれています`);
  }
  return { ok: errors.length === 0, errors, counts: b?.counts ?? {} };
}

/**
 * Restore into a database. Everything happens in ONE transaction: if any step or the post-restore verification fails,
 * nothing is changed (current data is never partially overwritten).
 * mode 'new': the organization must not exist. mode 'replace': the existing organization with the same id is replaced.
 */
export async function restoreBackup(adminUrl: string, b: Backup, mode: 'new' | 'replace' = 'new') {
  const v = validateBackup(b);
  if (!v.ok) throw new Error('バックアップの検証に失敗しました: ' + v.errors.join(' / '));
  const org = b.organization as any;
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.org_id', $1, true)`, [org.id]);
    const exists = (await c.query('SELECT 1 FROM organizations WHERE id = $1 OR slug = $2', [org.id, org.slug])).rowCount;
    if (exists && mode === 'new') throw new Error(`組織が既に存在します（${org.slug}）。空の環境に復元するか replace を指定してください`);
    if (exists) {
      await c.query(`SELECT set_config('app.allow_purge', 'on', true)`);
      await c.query('DELETE FROM jobs WHERE org_id = $1', [org.id]);
      await c.query('DELETE FROM organizations WHERE id = $1 OR slug = $2', [org.id, org.slug]);
      await c.query(`SELECT set_config('app.allow_purge', 'off', true)`);
    }
    await c.query('SET CONSTRAINTS ALL DEFERRED');
    await c.query('INSERT INTO organizations SELECT * FROM json_populate_record(null::organizations, $1)', [JSON.stringify(org)]);
    for (const t of BACKUP_TABLES) {
      const rows = b.tables[t];
      for (let i = 0; i < rows.length; i += 2000) {
        await c.query(`INSERT INTO ${pg.escapeIdentifier(t)} SELECT * FROM json_populate_recordset(null::${pg.escapeIdentifier(t)}, $1)`, [JSON.stringify(rows.slice(i, i + 2000))]);
      }
      if (['audit_events', 'search_queries', 'ai_usage'].includes(t)) {
        await c.query(`SELECT setval(pg_get_serial_sequence($1, 'id'), greatest((SELECT coalesce(max(id), 1) FROM ${pg.escapeIdentifier(t)}), 1))`, [t]);
      }
    }
    const verify = await verifyRestored(c, org.id, b);
    if (!verify.ok) throw new Error('復元後の検証に失敗しました: ' + verify.errors.join(' / '));
    await c.query('COMMIT');
    return verify;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await c.end();
  }
}

async function verifyRestored(c: pg.Client, orgId: string, b: Backup): Promise<ValidationReport & { checks: Record<string, unknown> }> {
  const errors: string[] = [];
  const counts: Record<string, number> = {};
  for (const t of BACKUP_TABLES) {
    const n = Number((await c.query(`SELECT count(*) FROM ${pg.escapeIdentifier(t)} WHERE org_id = $1`, [orgId])).rows[0].count);
    counts[t] = n;
    if (n !== b.counts[t]) errors.push(`${t}: ${n} != ${b.counts[t]}`);
  }
  const cur = (await c.query(`SELECT count(*) AS n FROM documents d LEFT JOIN document_versions v ON v.id = d.current_version_id
      WHERE d.org_id = $1 AND d.current_version_id IS NOT NULL AND (v.id IS NULL OR v.status <> 'published')`, [orgId])).rows[0].n;
  if (Number(cur)) errors.push(`currentVersion 不整合: ${cur}`);
  const hash = (await c.query(`SELECT count(*) AS n FROM approvals a JOIN approval_steps s ON s.id = a.step_id WHERE a.org_id = $1 AND a.content_hash <> s.content_hash`, [orgId])).rows[0].n;
  if (Number(hash)) errors.push(`承認ハッシュ不整合: ${hash}`);
  const comp = (await c.query(`SELECT count(*) AS n FROM training_assignments ta WHERE ta.org_id = $1 AND ta.status = 'completed' AND NOT EXISTS (SELECT 1 FROM certificates c WHERE c.assignment_id = ta.id)`, [orgId])).rows[0].n;
  if (Number(comp)) errors.push(`修了記録と完了証の不整合: ${comp}`);
  return { ok: errors.length === 0, errors, counts, checks: { currentVersionMismatch: Number(cur), approvalHashMismatch: Number(hash), completionWithoutCertificate: Number(comp) } };
}
