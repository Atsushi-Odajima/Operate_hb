// Usage: npm run seed            -> creates the "sample-works" demo organization (skips if it exists)
//        npm run seed -- --reset -> removes the sample organization first (sample data only)
import pg from 'pg';
import { config } from '../config.js';
import { migrate } from '../db/migrate.js';
import { pool } from '../db/pool.js';
import { DEMO_PASSWORD, seedSample } from '../services/seed.js';

await migrate(config.adminDatabaseUrl, config.appRole, () => undefined);
const admin = new pg.Client({ connectionString: config.adminDatabaseUrl });
await admin.connect();
const existing = (await admin.query(`SELECT id, is_sample FROM organizations WHERE slug = 'sample-works'`)).rows[0];
if (existing && process.argv.includes('--reset')) {
  if (!existing.is_sample) throw new Error('refusing to delete a non-sample organization');
  await admin.query('BEGIN');
  await admin.query(`SELECT set_config('app.allow_purge', 'on', true)`);
  await admin.query('DELETE FROM jobs WHERE org_id = $1', [existing.id]);
  await admin.query('DELETE FROM organizations WHERE id = $1', [existing.id]);
  await admin.query('COMMIT');
}
await admin.end();
if (existing && !process.argv.includes('--reset')) {
  console.log('sample organization already exists (use --reset to recreate)');
} else {
  const r = await seedSample();
  console.log(JSON.stringify({ org: 'sample-works', password: DEMO_PASSWORD, users: Object.keys(r.users).map((k) => `${k}@sample-works.example`) }, null, 2));
}
await pool.end();
