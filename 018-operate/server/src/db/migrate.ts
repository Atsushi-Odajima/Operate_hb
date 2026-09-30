import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export async function migrate(adminUrl: string, appRole: string, log = console.log) {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(f)) continue;
      log(`migrate: ${f}`);
      await client.query('BEGIN');
      await client.query(readFileSync(join(dir, f), 'utf8'));
      await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
      await client.query('COMMIT');
    }
    // Least privilege for the application role.
    const role = pg.escapeIdentifier(appRole);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
    await client.query(`REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM ${role}`);
    await client.query(`REVOKE INSERT, UPDATE, DELETE ON schema_migrations FROM ${role}`);
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
    await client.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${role}`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await client.end();
  }
}
