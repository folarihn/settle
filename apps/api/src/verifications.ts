import { randomBytes } from "node:crypto";
import { contractCallFor, type AgreementState, type VerificationReport } from "@settle/domain";
import { evidenceMatchesReport, verifySubmission, type Evidence, type VerificationRequest, type VerifyOptions } from "@settle/verifier";
import type { Principal } from "./auth.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { ApiError } from "./errors.js";
import type { JobService } from "./jobs.js";

interface Row {
  id: string;
  job_id: string;
  milestone_id: string;
  submission_seq: number;
  requested_by: string;
  status: "QUEUED" | "RUNNING" | "DONE" | "FAILED";
  request: VerificationRequest;
  report: VerificationReport | null;
  signature: string | null;
  evidence: Evidence | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

const STALE_RUN_MS = 10 * 60 * 1000;

/**
 * Verification requests are queued in Postgres. The internet-facing API only enqueues
 * and reads; a separate worker process (worker-main.ts) holds the verifier seed, runs
 * the checks and records the signed result through the same job service.
 */
export class VerificationService {
  constructor(
    private readonly db: Db,
    private readonly jobs: JobService,
    private readonly config: Config,
    private readonly now: () => number = Date.now,
  ) {}

  async request(p: Principal, jobId: string, milestoneId: string) {
    const state = await this.jobs.load(this.db, jobId);
    this.jobs.requireParticipant(state, p.accountId);
    const roles = this.jobs.view(state, p.accountId).roles;
    if (!roles.includes("client") && !roles.includes("worker")) {
      throw new ApiError(403, "UNAUTHORIZED", "only the client or worker can request verification");
    }
    const terms = state.terms.milestones.find((m) => m.id === milestoneId);
    const m = state.milestones.find((x) => x.id === milestoneId);
    if (!terms || !m) throw new ApiError(404, "NOT_FOUND", "milestone not found");
    if (terms.type !== "AUTOMATED") throw new ApiError(409, "INVALID_TRANSITION", "milestone is not automatically verified");
    if (m.status !== "SUBMITTED" || !m.submission) throw new ApiError(409, "INVALID_TRANSITION", `milestone is ${m.status}, not SUBMITTED`);
    if (!m.submission.uri) throw new ApiError(400, "VALIDATION", "submission has no deployment URL to verify");

    const request: VerificationRequest = {
      escrowContract: state.terms.escrowContract,
      agreementId: jobId,
      milestoneId,
      plan: terms.verificationPlan,
      submission: { seq: m.submission.seq, artifactHash: m.submission.artifactHash, uri: m.submission.uri },
    };
    const id = `ver_${randomBytes(12).toString("base64url")}`;
    const at = this.now();
    try {
      await this.db.query(
        `INSERT INTO verifications (id, job_id, milestone_id, submission_seq, requested_by, status, request, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'QUEUED', $6, $7, $7)`,
        [id, jobId, milestoneId, m.submission.seq, p.accountId, JSON.stringify(request), at],
      );
    } catch (e) {
      if (/verifications_in_flight|duplicate key/i.test(String((e as Error).message))) {
        throw new ApiError(409, "IN_FLIGHT", "a verification for this submission is already queued or running");
      }
      throw e;
    }
    return this.get(p, id);
  }

  async get(p: Principal, id: string) {
    const row = await this.row(id);
    const state = await this.jobs.load(this.db, row.job_id);
    this.jobs.requireParticipant(state, p.accountId);
    return this.toView(row, state);
  }

  async evidence(p: Principal, id: string) {
    const row = await this.row(id);
    this.jobs.requireParticipant(await this.jobs.load(this.db, row.job_id), p.accountId);
    if (!row.evidence || !row.report) throw new ApiError(409, "NOT_READY", `verification is ${row.status}`);
    return { evidence: row.evidence, report: row.report, matchesReport: evidenceMatchesReport(row.evidence, row.report) };
  }

  async listForJob(p: Principal, jobId: string) {
    const state = await this.jobs.load(this.db, jobId);
    this.jobs.requireParticipant(state, p.accountId);
    const { rows } = await this.db.query<Row>("SELECT * FROM verifications WHERE job_id = $1 ORDER BY created_at DESC", [jobId]);
    return rows.map((r) => this.toView(r, state));
  }

  /** Worker side: claim the oldest queued (or abandoned) run. */
  async claim(): Promise<Row | null> {
    const at = this.now();
    const { rows } = await this.db.query<Row>(
      `UPDATE verifications SET status = 'RUNNING', updated_at = $1
       WHERE id = (
         SELECT id FROM verifications
         WHERE status = 'QUEUED' OR (status = 'RUNNING' AND updated_at < $2)
         ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
       ) RETURNING *`,
      [at, at - STALE_RUN_MS],
    );
    return rows[0] ?? null;
  }

  /** Worker side: run one claimed request, store the signed result and apply it to the job. */
  async process(row: Row, opts: VerifyOptions): Promise<void> {
    let signed;
    try {
      signed = await verifySubmission(row.request, opts);
    } catch (e) {
      await this.db.query("UPDATE verifications SET status = 'FAILED', error = $1, updated_at = $2 WHERE id = $3", [
        e instanceof Error ? e.message : String(e),
        this.now(),
        row.id,
      ]);
      return;
    }
    await this.db.tx(async (sql) => {
      let applyError: string | null = null;
      try {
        await this.jobs.apply(
          row.job_id,
          {
            type: "RECORD_VERIFICATION",
            actor: this.config.verifierAccount,
            at: this.now(),
            milestoneId: row.milestone_id,
            report: signed.report,
            signature: signed.signature,
          },
          sql,
        );
      } catch (e) {
        // The signed report is still valid evidence; record why it could not be applied.
        applyError = `not applied to job: ${e instanceof Error ? e.message : String(e)}`;
      }
      await sql.query(
        "UPDATE verifications SET status = 'DONE', report = $1, signature = $2, evidence = $3, error = $4, updated_at = $5 WHERE id = $6",
        [JSON.stringify(signed.report), signed.signature, JSON.stringify(signed.evidence), applyError, this.now(), row.id],
      );
    });
  }

  private async row(id: string): Promise<Row> {
    const { rows } = await this.db.query<Row>("SELECT * FROM verifications WHERE id = $1", [id]);
    if (!rows[0]) throw new ApiError(404, "NOT_FOUND", "verification not found");
    return rows[0];
  }

  private toView(r: Row, state: AgreementState) {
    const recordCall =
      r.report && r.signature
        ? contractCallFor(state, {
            type: "RECORD_VERIFICATION",
            actor: r.requested_by,
            at: 0,
            milestoneId: r.milestone_id,
            report: r.report,
            signature: r.signature,
          })
        : null;
    return {
      id: r.id,
      jobId: r.job_id,
      milestoneId: r.milestone_id,
      submissionSeq: r.submission_seq,
      status: r.status,
      outcome: r.report?.outcome ?? null,
      report: r.report,
      signature: r.signature,
      error: r.error,
      createdAt: Number(r.created_at),
      /** Anyone may relay this signed report onchain; it cannot be altered in transit. */
      contractCall: recordCall,
    };
  }
}
