import { PGlite } from "@electric-sql/pglite";
import pg from "pg";

export interface Sql {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }>;
}

/** Postgres access. Production uses a pg Pool; tests and local demos use in-process PGlite. */
export interface Db extends Sql {
  tx<T>(fn: (sql: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function createPgDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString, max: 10 });
  const wrap = (q: { query: pg.Pool["query"] }): Sql => ({
    async query<T>(text: string, params: unknown[] = []) {
      const r = await q.query(text, params);
      return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 };
    },
  });
  return {
    ...wrap(pool),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const out = await fn(wrap(client as unknown as pg.Pool));
        await client.query("COMMIT");
        return out;
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

export function createPgliteDb(dataDir?: string): Db {
  const db = new PGlite(dataDir);
  const wrap = (q: { query: PGlite["query"] }): Sql => ({
    async query<T>(text: string, params: unknown[] = []) {
      const r = await q.query<T>(text, params);
      return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
    },
  });
  return {
    ...wrap(db),
    tx: (fn) => db.transaction((t) => fn(wrap(t as unknown as PGlite))),
    close: () => db.close(),
  };
}

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS auth_challenges (
     nonce TEXT PRIMARY KEY,
     account_id TEXT NOT NULL,
     message TEXT NOT NULL,
     expires_at BIGINT NOT NULL,
     used BOOLEAN NOT NULL DEFAULT FALSE
   )`,
  `CREATE TABLE IF NOT EXISTS sessions (
     token_hash TEXT PRIMARY KEY,
     account_id TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('HUMAN', 'AGENT')),
     public_key TEXT NOT NULL,
     expires_at BIGINT NOT NULL,
     created_at BIGINT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS jobs (
     id TEXT PRIMARY KEY,
     client_account TEXT NOT NULL,
     worker_account TEXT NOT NULL,
     state JSONB NOT NULL,
     version INTEGER NOT NULL,
     created_at BIGINT NOT NULL,
     updated_at BIGINT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS jobs_client ON jobs (client_account)`,
  `CREATE INDEX IF NOT EXISTS jobs_worker ON jobs (worker_account)`,
  `CREATE TABLE IF NOT EXISTS job_events (
     job_id TEXT NOT NULL REFERENCES jobs(id),
     version INTEGER NOT NULL,
     actor TEXT NOT NULL,
     type TEXT NOT NULL,
     event JSONB NOT NULL,
     at BIGINT NOT NULL,
     PRIMARY KEY (job_id, version)
   )`,
  `CREATE TABLE IF NOT EXISTS verifications (
     id TEXT PRIMARY KEY,
     job_id TEXT NOT NULL REFERENCES jobs(id),
     milestone_id TEXT NOT NULL,
     submission_seq INTEGER NOT NULL,
     requested_by TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('QUEUED', 'RUNNING', 'DONE', 'FAILED')),
     request JSONB NOT NULL,
     report JSONB,
     signature TEXT,
     evidence JSONB,
     error TEXT,
     created_at BIGINT NOT NULL,
     updated_at BIGINT NOT NULL
   )`,
  // At most one in-flight run per submission; finished INCONCLUSIVE runs may be repeated.
  `CREATE UNIQUE INDEX IF NOT EXISTS verifications_in_flight
     ON verifications (job_id, milestone_id, submission_seq) WHERE status IN ('QUEUED', 'RUNNING')`,
  `CREATE TABLE IF NOT EXISTS idempotency (
     account_id TEXT NOT NULL,
     key TEXT NOT NULL,
     status INTEGER NOT NULL,
     body JSONB NOT NULL,
     created_at BIGINT NOT NULL,
     PRIMARY KEY (account_id, key)
   )`,
];

export async function migrate(db: Db): Promise<void> {
  for (const statement of MIGRATIONS) await db.query(statement);
}
