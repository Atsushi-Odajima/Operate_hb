import pg from 'pg';
import { config } from '../config.js';
import { SQL } from '../lib/sql.js';

// numeric -> number, date -> 'YYYY-MM-DD' string (avoid TZ shifts), bigint -> number
pg.types.setTypeParser(1700, (v) => Number(v));
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(20, (v) => Number(v));

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: Number(process.env.DB_POOL_MAX ?? 20) });
let _admin: pg.Pool | null = null;
export const adminPool = () => (_admin ??= new pg.Pool({ connectionString: config.adminDatabaseUrl, max: 4 }));

export interface Db {
  q<T = any>(s: SQL): Promise<T[]>;
  one<T = any>(s: SQL): Promise<T | undefined>;
  exec(s: SQL): Promise<number>;
  client: pg.PoolClient;
  orgId: string;
  /** callbacks run after COMMIT (e.g. wake the job worker) */
  afterCommit(fn: () => void): void;
}

function wrap(client: pg.PoolClient, orgId: string, after: Array<() => void>): Db {
  return {
    client,
    orgId,
    async q(s) {
      const { text, values } = s.toQuery();
      return (await client.query(text, values)).rows;
    },
    async one(s) {
      const { text, values } = s.toQuery();
      return (await client.query(text, values)).rows[0];
    },
    async exec(s) {
      const { text, values } = s.toQuery();
      return (await client.query(text, values)).rowCount ?? 0;
    },
    afterCommit(fn) {
      after.push(fn);
    },
  };
}

/** Run fn in a transaction scoped to one tenant (RLS: app.org_id). */
export async function tx<T>(orgId: string, fn: (db: Db) => Promise<T>, p: pg.Pool = pool): Promise<T> {
  const client = await p.connect();
  const after: Array<() => void> = [];
  try {
    await client.query('BEGIN');
    // jit off: request queries are short; JIT compile time (~0.5s) dominated large-tenant lists in load tests.
    await client.query(`SELECT set_config('app.org_id', $1, true), set_config('jit', 'off', true)`, [orgId]);
    const res = await fn(wrap(client, orgId, after));
    await client.query('COMMIT');
    for (const f of after) f();
    return res;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/** Queries that are not tenant scoped (auth bootstrap via SECURITY DEFINER functions, job queue). */
export async function sys<T = any>(s: SQL): Promise<T[]> {
  const { text, values } = s.toQuery();
  return (await pool.query(text, values)).rows;
}
