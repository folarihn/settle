import { createHmac, randomBytes } from "node:crypto";
import type { AgreementState } from "@settle/domain";
import { buildTargetUrl, DEFAULT_POLICY, resolvePinned, sendRequest, systemResolver, type NetworkPolicy, type Resolver } from "@settle/verifier";
import { z } from "zod";
import type { Principal } from "./auth.js";
import type { Db, Sql } from "./db.js";
import { ApiError } from "./errors.js";

/**
 * Webhooks: a party registers an HTTPS URL and is told about every event on the jobs it
 * takes part in. They are notifications only; nothing about money depends on delivery.
 * Deliveries are queued in the same transaction as the event and sent by the worker
 * process (never the internet-facing API) through the verifier's SSRF-guarded client.
 */

export const MAX_WEBHOOKS_PER_ACCOUNT = 5;
export const MAX_ATTEMPTS = 6;
const BASE_BACKOFF_MS = 30_000;

export const CreateWebhookInput = z.object({ url: z.string().url().max(2000) }).strict();

export interface WebhookPayload {
  deliveryId: string;
  type: "job.event";
  jobId: string;
  version: number;
  event: { type: string; actor: string; at: number; milestoneId?: string };
  agreementStatus: string;
  milestones: { id: string; status: string }[];
}

/** `t=<ms>,v1=<hex HMAC-SHA256 of "<t>.<body>">`; receivers recompute it with their secret. */
export function signWebhook(secret: string, body: string, t: number): string {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
}

/** Queues one delivery per webhook of each party to the job. Runs inside the event's transaction. */
export async function enqueueWebhooks(sql: Sql, state: AgreementState, actor: string, type: string, fields: object, at: number) {
  const t = state.terms;
  const parties = [t.client.nearAccountId, t.worker.nearAccountId, t.disputeResolver];
  const { rows } = await sql.query<{ id: string }>("SELECT id FROM webhooks WHERE account_id = ANY($1)", [parties]);
  const milestoneId = (fields as { milestoneId?: unknown }).milestoneId;
  for (const hook of rows) {
    const deliveryId = `whd_${randomBytes(12).toString("base64url")}`;
    const payload: WebhookPayload = {
      deliveryId,
      type: "job.event",
      jobId: t.agreementId,
      version: state.version,
      event: { type, actor, at, ...(typeof milestoneId === "string" ? { milestoneId } : {}) },
      agreementStatus: state.status,
      milestones: state.milestones.map((m) => ({ id: m.id, status: m.status })),
    };
    await sql.query(
      "INSERT INTO webhook_deliveries (id, webhook_id, job_id, payload, attempts, next_attempt_at, created_at) VALUES ($1, $2, $3, $4, 0, $5, $5)",
      [deliveryId, hook.id, t.agreementId, JSON.stringify(payload), at],
    );
  }
}

export class WebhookService {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
    private readonly policy: NetworkPolicy = DEFAULT_POLICY,
    private readonly resolve: Resolver = systemResolver,
  ) {}

  /** Returns the signing secret once; it is never shown again. */
  async create(p: Principal, input: unknown) {
    const { url } = CreateWebhookInput.parse(input);
    try {
      buildTargetUrl(url, "", this.policy);
    } catch (e) {
      throw new ApiError(400, "VALIDATION", `webhook URL rejected: ${(e as Error).message}`);
    }
    const { rows } = await this.db.query<{ n: string }>("SELECT count(*) AS n FROM webhooks WHERE account_id = $1", [p.accountId]);
    if (Number(rows[0]!.n) >= MAX_WEBHOOKS_PER_ACCOUNT) throw new ApiError(400, "LIMIT", `at most ${MAX_WEBHOOKS_PER_ACCOUNT} webhooks per account`);
    const id = `wh_${randomBytes(12).toString("base64url")}`;
    const secret = `whsec_${randomBytes(32).toString("hex")}`;
    await this.db.query("INSERT INTO webhooks (id, account_id, url, secret, created_at) VALUES ($1, $2, $3, $4, $5)", [id, p.accountId, url, secret, this.now()]);
    return { id, url, secret };
  }

  async list(p: Principal) {
    const { rows } = await this.db.query("SELECT id, url, created_at AS \"createdAt\" FROM webhooks WHERE account_id = $1 ORDER BY created_at", [p.accountId]);
    return rows;
  }

  async remove(p: Principal, id: string) {
    await this.db.tx(async (sql) => {
      const r = await sql.query("SELECT 1 FROM webhooks WHERE id = $1 AND account_id = $2", [id, p.accountId]);
      if (r.rows.length === 0) throw new ApiError(404, "NOT_FOUND", "webhook not found");
      await sql.query("DELETE FROM webhook_deliveries WHERE webhook_id = $1", [id]);
      await sql.query("DELETE FROM webhooks WHERE id = $1", [id]);
    });
  }

  async deliveries(p: Principal, id: string) {
    const owned = await this.db.query("SELECT 1 FROM webhooks WHERE id = $1 AND account_id = $2", [id, p.accountId]);
    if (owned.rows.length === 0) throw new ApiError(404, "NOT_FOUND", "webhook not found");
    const { rows } = await this.db.query(
      `SELECT id, job_id AS "jobId", payload->'event'->>'type' AS "eventType", attempts, delivered_at AS "deliveredAt",
              last_status AS "lastStatus", last_error AS "lastError", next_attempt_at AS "nextAttemptAt"
       FROM webhook_deliveries WHERE webhook_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [id],
    );
    return rows;
  }

  /** Sends due deliveries; failures back off exponentially and stop after MAX_ATTEMPTS. Returns how many were attempted. */
  async deliverDue(limit = 20): Promise<number> {
    const now = this.now();
    const { rows } = await this.db.query<{ id: string; url: string; secret: string; payload: WebhookPayload; attempts: number }>(
      `SELECT d.id, w.url, w.secret, d.payload, d.attempts FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id
       WHERE d.delivered_at IS NULL AND d.attempts < $1 AND d.next_attempt_at <= $2 ORDER BY d.next_attempt_at LIMIT $3`,
      [MAX_ATTEMPTS, now, limit],
    );
    for (const d of rows) {
      // Claim it: only the worker that bumps the attempt count sends it.
      const claimed = await this.db.query("UPDATE webhook_deliveries SET attempts = attempts + 1, next_attempt_at = $3 WHERE id = $1 AND attempts = $2", [
        d.id,
        d.attempts,
        now + BASE_BACKOFF_MS * 2 ** d.attempts,
      ]);
      if (claimed.rowCount !== 1) continue;
      const body = JSON.stringify(d.payload);
      let status: number | null = null;
      let error: string | null = null;
      try {
        const url = buildTargetUrl(d.url, "", this.policy);
        const pinned = await resolvePinned(url.hostname, this.resolve, this.policy);
        const res = await sendRequest({
          method: "POST",
          url,
          pinned,
          body,
          timeoutMs: 5000,
          maxResponseBytes: 4096,
          headers: { "settle-signature": signWebhook(d.secret, body, this.now()), "settle-delivery-id": d.id, "settle-event": d.payload.event.type },
        });
        status = res.status;
        if (status < 200 || status > 299) error = `receiver answered ${status}`;
      } catch (e) {
        error = (e as Error).message;
      }
      await this.db.query("UPDATE webhook_deliveries SET last_status = $2, last_error = $3, delivered_at = $4 WHERE id = $1", [
        d.id,
        status,
        error,
        error ? null : this.now(),
      ]);
    }
    return rows.length;
  }
}
