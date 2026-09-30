import pg from 'pg';

export default async function setup() {
  const db = process.env.TEST_DB ?? 'operate_test';
  const c = new pg.Client({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5432/postgres' });
  await c.connect();
  await c.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='operate_app') THEN CREATE ROLE operate_app LOGIN PASSWORD 'operate_app' NOSUPERUSER NOBYPASSRLS; END IF; END $$;`);
  await c.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  await c.query(`CREATE DATABASE ${db} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C.UTF-8' LC_CTYPE 'C.UTF-8'`);
  await c.end();
  const { migrate } = await import('../src/db/migrate.js');
  await migrate(`postgres://postgres:postgres@127.0.0.1:5432/${db}`, 'operate_app', () => undefined);
}
