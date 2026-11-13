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
  `CREATE TABLE IF NOT EXISTS webhooks (
     id TEXT PRIMARY KEY,
     account_id TEXT NOT NULL,
     url TEXT NOT NULL,
     secret TEXT NOT NULL,
     created_at BIGINT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS webhooks_account ON webhooks (account_id)`,
  `CREATE TABLE IF NOT EXISTS webhook_deliveries (
     id TEXT PRIMARY KEY,
     webhook_id TEXT NOT NULL REFERENCES webhooks(id),
     job_id TEXT NOT NULL,
     payload JSONB NOT NULL,
     attempts INTEGER NOT NULL,
     next_attempt_at BIGINT NOT NULL,
     delivered_at BIGINT,
     last_status INTEGER,
     last_error TEXT,
     created_at BIGINT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS webhook_deliveries_due ON webhook_deliveries (next_attempt_at) WHERE delivered_at IS NULL`,
  // Content-addressed deliverables: the id is the SHA-256 of the exact bytes.
  `CREATE TABLE IF NOT EXISTS deliverables (
     hash TEXT PRIMARY KEY,
     content TEXT NOT NULL,
     author_account TEXT NOT NULL,
     job_id TEXT,
     created_at BIGINT NOT NULL
   )`,
  // Swarm agents. Keys are generated and held (encrypted) only by the swarm runner.
  `CREATE TABLE IF NOT EXISTS swarm_agents (
     id TEXT PRIMARY KEY,
     owner_account TEXT NOT NULL,
     name TEXT NOT NULL,
     prompt TEXT NOT NULL,
     knowledge TEXT NOT NULL,
     max_bounty_yocto TEXT NOT NULL,
     max_job_nano_usd BIGINT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('provisioning', 'awaiting_funds', 'active', 'paused')),
     account_id TEXT UNIQUE,
     public_key TEXT,
     secret_enc TEXT,
     created_at BIGINT NOT NULL,
     updated_at BIGINT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS swarm_withdrawals (
     id TEXT PRIMARY KEY,
     agent_id TEXT NOT NULL REFERENCES swarm_agents(id),
     status TEXT NOT NULL CHECK (status IN ('requested', 'done', 'failed')),
     inference_nano_usd BIGINT,
     fee_yocto TEXT,
     paid_yocto TEXT,
     fee_tx TEXT,
     payout_tx TEXT,
     error TEXT,
     created_at BIGINT NOT NULL,
     updated_at BIGINT NOT NULL
   )`,
  // Every NEAR AI call: who for, what for, usage, and the exact billed cost once NEAR AI reports it.
  `CREATE TABLE IF NOT EXISTS inference_calls (
     id TEXT PRIMARY KEY,
     agent_id TEXT,
     job_id TEXT,
     milestone_id TEXT,
     purpose TEXT NOT NULL CHECK (purpose IN ('triage', 'deliverable', 'review')),
     model TEXT NOT NULL,
     completion_id TEXT NOT NULL,
     inference_id TEXT NOT NULL,
     prompt_tokens INTEGER NOT NULL,
     completion_tokens INTEGER NOT NULL,
     cost_nano_usd BIGINT,
     settled BOOLEAN NOT NULL DEFAULT FALSE,
     created_at BIGINT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS inference_calls_agent ON inference_calls (agent_id)`,
  // Advisory AI reviews of human-review submissions, with NEAR AI's TEE response signature.
  `CREATE TABLE IF NOT EXISTS ai_reviews (
     job_id TEXT NOT NULL,
     milestone_id TEXT NOT NULL,
     submission_seq INTEGER NOT NULL,
     verdict TEXT NOT NULL CHECK (verdict IN ('meets', 'partly', 'does_not_meet', 'cannot_review')),
     summary TEXT NOT NULL,
     points JSONB NOT NULL,
     model TEXT NOT NULL,
     completion_id TEXT,
     request_body TEXT,
     response_body TEXT,
     signature JSONB,
     signature_check TEXT,
     created_at BIGINT NOT NULL,
     PRIMARY KEY (job_id, milestone_id, submission_seq)
   )`,
];

/** Arbitrary constant naming the schema lock; any process that migrates takes the same one. */
const MIGRATION_LOCK = 7_172_211;

export async function migrate(db: Db): Promise<void> {
  // The API, worker, swarm runner and parallel test files can start at the same moment, and
  // CREATE ... IF NOT EXISTS is not safe under concurrency in Postgres (two creators can collide
  // on the catalog). One transaction-scoped advisory lock makes the schema setup run one at a time.
  await db.tx(async (sql) => {
    await sql.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
    for (const statement of MIGRATIONS) await sql.query(statement);
  });
}
