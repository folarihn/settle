import { createHash, randomBytes } from "node:crypto";
import type { AgreementState } from "@settle/domain";
import { z } from "zod";
import type { Principal } from "./auth.js";
import type { Db } from "./db.js";
import { ApiError } from "./errors.js";

/**
 * Swarm-for-Hire (ADR 0006): registry of NEAR AI worker agents anyone can add, content-addressed
 * deliverables, and the inference ledger. This module never holds agent keys; the swarm runner
 * generates and keeps them.
 */

export const MAX_AGENTS_PER_OWNER = 5;
/** Agents never funded within this long drop out of the public directory; their owner still sees them. */
export const UNFUNDED_LISTING_MS = 24 * 60 * 60_000;

/** Names people read in a public directory: letters, numbers, spaces and plain punctuation. */
const AgentName = z
  .string()
  .trim()
  .min(2)
  .max(40)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} .,&()_-]*$/u, "use letters, numbers, spaces and . , & ( ) _ - only");
export const MAX_DELIVERABLE_BYTES = 64 * 1024;

const NearAmount = z.string().regex(/^\d{1,6}(\.\d{1,24})?$/, "a NEAR amount like 0.05");
const UsdAmount = z.string().regex(/^\d{1,3}(\.\d{1,9})?$/, "a USD amount like 0.02");

export const CreateAgentInput = z
  .object({
    name: AgentName,
    prompt: z.string().trim().min(10).max(4000),
    knowledge: z.string().max(20_000).default(""),
    maxBountyNear: NearAmount,
    maxJobUsd: UsdAmount,
  })
  .strict();

/** An owner's changes to an agent. Takes effect on the runner's next pass; the agent's account and balance are unchanged. */
export const UpdateAgentInput = z
  .object({
    name: CreateAgentInput.shape.name.optional(),
    prompt: CreateAgentInput.shape.prompt.optional(),
    knowledge: z.string().max(20_000).optional(),
    maxBountyNear: NearAmount.optional(),
    maxJobUsd: UsdAmount.optional(),
  })
  .strict()
  .refine((u) => Object.values(u).some((v) => v !== undefined), "nothing to change");

export const toYocto = (near: string) => {
  const [w, f = ""] = near.split(".");
  return (BigInt(w!) * 10n ** 24n + BigInt(f.padEnd(24, "0") || "0")).toString();
};
const toNanoUsd = (usd: string) => {
  const [w, f = ""] = usd.split(".");
  return Number(BigInt(w!) * 1_000_000_000n + BigInt(f.padEnd(9, "0") || "0"));
};

interface AgentRow {
  id: string;
  owner_account: string;
  name: string;
  prompt: string;
  knowledge: string;
  max_bounty_yocto: string;
  max_job_nano_usd: string | number;
  status: string;
  account_id: string | null;
  created_at: string | number;
}

export interface AgentView {
  id: string;
  name: string;
  owner: string;
  account: string | null;
  status: string;
  prompt: string;
  knowledgeChars: number;
  maxBountyYocto: string;
  maxJobNanoUsd: number;
  createdAt: number;
  stats: { jobsWon: number; jobsPaid: number; earnedYocto: string; inferenceCalls: number; inferenceNanoUsd: number; pendingCostCalls: number; unsettledNanoUsd: number };
  withdrawal: { status: string; paidYocto: string | null; feeYocto: string | null; feeTx: string | null; payoutTx: string | null; error: string | null } | null;
}

export class SwarmService {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  async createAgent(p: Principal, input: unknown): Promise<AgentView> {
    const a = CreateAgentInput.parse(input);
    const maxJobNanoUsd = toNanoUsd(a.maxJobUsd);
    if (maxJobNanoUsd <= 0 || maxJobNanoUsd > 1_000_000_000) throw new ApiError(400, "VALIDATION", "inference spend per job must be above $0 and at most $1");
    if (BigInt(toYocto(a.maxBountyNear)) <= 0n) throw new ApiError(400, "VALIDATION", "maximum bounty must be above 0");
    const { rows } = await this.db.query<{ n: string }>("SELECT count(*) AS n FROM swarm_agents WHERE owner_account = $1", [p.accountId]);
    if (Number(rows[0]!.n) >= MAX_AGENTS_PER_OWNER) throw new ApiError(400, "LIMIT", `at most ${MAX_AGENTS_PER_OWNER} agents per owner`);
    const id = `agt_${randomBytes(9).toString("base64url")}`;
    const at = this.now();
    await this.db.query(
      `INSERT INTO swarm_agents (id, owner_account, name, prompt, knowledge, max_bounty_yocto, max_job_nano_usd, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'provisioning', $8, $8)`,
      [id, p.accountId, a.name, a.prompt, a.knowledge, toYocto(a.maxBountyNear), maxJobNanoUsd, at],
    );
    return this.get(id);
  }

  async updateAgent(p: Principal, id: string, input: unknown): Promise<AgentView> {
    const u = UpdateAgentInput.parse(input);
    const a = await this.owned(p, id);
    const maxJobNanoUsd = u.maxJobUsd !== undefined ? toNanoUsd(u.maxJobUsd) : Number(a.max_job_nano_usd);
    if (maxJobNanoUsd <= 0 || maxJobNanoUsd > 1_000_000_000) throw new ApiError(400, "VALIDATION", "inference spend per job must be above $0 and at most $1");
    const maxBounty = u.maxBountyNear !== undefined ? toYocto(u.maxBountyNear) : a.max_bounty_yocto;
    if (BigInt(maxBounty) <= 0n) throw new ApiError(400, "VALIDATION", "maximum bounty must be above 0");
    await this.db.query(
      "UPDATE swarm_agents SET name = $2, prompt = $3, knowledge = $4, max_bounty_yocto = $5, max_job_nano_usd = $6, updated_at = $7 WHERE id = $1",
      [id, u.name ?? a.name, u.prompt ?? a.prompt, u.knowledge ?? a.knowledge, maxBounty, maxJobNanoUsd, this.now()],
    );
    return this.get(id);
  }

  /** The owner's own view of what the agent works from, for editing. Knowledge is not public. */
  async settings(p: Principal, id: string): Promise<{ prompt: string; knowledge: string }> {
    const a = await this.owned(p, id);
    return { prompt: a.prompt, knowledge: a.knowledge };
  }

  /** The directory. Agents left unfunded for a day are hidden from everyone but their owner. */
  async list(viewer: Principal | null = null): Promise<AgentView[]> {
    const { rows } = await this.db.query<AgentRow>(
      `SELECT * FROM swarm_agents
       WHERE status NOT IN ('provisioning', 'awaiting_funds') OR created_at >= $1 OR owner_account = $2
       ORDER BY created_at DESC LIMIT 200`,
      [this.now() - UNFUNDED_LISTING_MS, viewer?.accountId ?? null],
    );
    return Promise.all(rows.map((r) => this.view(r)));
  }

  async get(id: string): Promise<AgentView> {
    const { rows } = await this.db.query<AgentRow>("SELECT * FROM swarm_agents WHERE id = $1", [id]);
    if (!rows[0]) throw new ApiError(404, "NOT_FOUND", "agent not found");
    return this.view(rows[0]);
  }

  /** Owner pauses or resumes an agent. Activation itself happens when the runner sees the agent funded. */
  async setPaused(p: Principal, id: string, paused: boolean): Promise<AgentView> {
    const a = await this.owned(p, id);
    const from = paused ? "active" : "paused";
    if (a.status !== from) throw new ApiError(409, "INVALID_TRANSITION", `agent is ${a.status}`);
    await this.db.query("UPDATE swarm_agents SET status = $2, updated_at = $3 WHERE id = $1", [id, paused ? "paused" : "active", this.now()]);
    return this.get(id);
  }

  /** Owner asks for the agent's balance; the runner settles inference first, then pays the owner. */
  async requestWithdrawal(p: Principal, id: string): Promise<AgentView> {
    const a = await this.owned(p, id);
    if (!a.account_id) throw new ApiError(409, "INVALID_TRANSITION", "agent has no account yet");
    const open = await this.db.query("SELECT 1 FROM swarm_withdrawals WHERE agent_id = $1 AND status = 'requested'", [id]);
    if (open.rows.length) throw new ApiError(409, "IN_FLIGHT", "a withdrawal is already in progress");
    const at = this.now();
    await this.db.query("INSERT INTO swarm_withdrawals (id, agent_id, status, created_at, updated_at) VALUES ($1, $2, 'requested', $3, $3)", [`wd_${randomBytes(9).toString("base64url")}`, id, at]);
    // Withdrawing stops the agent taking new work.
    if (a.status === "active") await this.db.query("UPDATE swarm_agents SET status = 'paused', updated_at = $2 WHERE id = $1", [id, at]);
    return this.get(id);
  }

  private async owned(p: Principal, id: string): Promise<AgentRow> {
    const { rows } = await this.db.query<AgentRow>("SELECT * FROM swarm_agents WHERE id = $1", [id]);
    if (!rows[0] || rows[0].owner_account !== p.accountId) throw new ApiError(404, "NOT_FOUND", "agent not found");
    return rows[0];
  }

  private async view(r: AgentRow): Promise<AgentView> {
    const stats = { jobsWon: 0, jobsPaid: 0, earnedYocto: "0", inferenceCalls: 0, inferenceNanoUsd: 0, pendingCostCalls: 0, unsettledNanoUsd: 0 };
    if (r.account_id) {
      const jobs = await this.db.query<{ state: AgreementState }>("SELECT state FROM jobs WHERE worker_account = $1", [r.account_id]);
      let earned = 0n;
      for (const { state } of jobs.rows) {
        stats.jobsWon += 1;
        if (state.status === "COMPLETED") stats.jobsPaid += 1;
        for (const m of state.milestones) if (m.status === "PAID" && m.allocation) earned += BigInt(m.allocation.workerYocto);
      }
      stats.earnedYocto = earned.toString();
    }
    const inf = await this.db.query<{ n: string; cost: string | null; pending: string; unsettled: string | null }>(
      `SELECT count(*) AS n, sum(cost_nano_usd) AS cost, count(*) FILTER (WHERE cost_nano_usd IS NULL) AS pending,
              sum(cost_nano_usd) FILTER (WHERE NOT settled) AS unsettled
       FROM inference_calls WHERE agent_id = $1`,
      [r.id],
    );
    stats.inferenceCalls = Number(inf.rows[0]!.n);
    stats.inferenceNanoUsd = Number(inf.rows[0]!.cost ?? 0);
    stats.pendingCostCalls = Number(inf.rows[0]!.pending);
    stats.unsettledNanoUsd = Number(inf.rows[0]!.unsettled ?? 0);
    const wd = await this.db.query<{ status: string; paid_yocto: string | null; fee_yocto: string | null; fee_tx: string | null; payout_tx: string | null; error: string | null }>(
      "SELECT status, paid_yocto, fee_yocto, fee_tx, payout_tx, error FROM swarm_withdrawals WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 1",
      [r.id],
    );
    const w = wd.rows[0];
    return {
      id: r.id,
      name: r.name,
      owner: r.owner_account,
      account: r.account_id,
      status: r.status,
      prompt: r.prompt,
      knowledgeChars: r.knowledge.length,
      maxBountyYocto: r.max_bounty_yocto,
      maxJobNanoUsd: Number(r.max_job_nano_usd),
      createdAt: Number(r.created_at),
      stats,
      withdrawal: w ? { status: w.status, paidYocto: w.paid_yocto, feeYocto: w.fee_yocto, feeTx: w.fee_tx, payoutTx: w.payout_tx, error: w.error } : null,
    };
  }
}

/** Deliverables addressed by the SHA-256 of their bytes: the address is also the onchain artifact hash. */
export class DeliverableService {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  async create(p: Principal, input: unknown): Promise<{ hash: string; bytes: number }> {
    const { content, jobId } = z.object({ content: z.string().min(1), jobId: z.string().max(80).optional() }).strict().parse(input);
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_DELIVERABLE_BYTES) throw new ApiError(400, "VALIDATION", `deliverables are limited to ${MAX_DELIVERABLE_BYTES} bytes`);
    const hash = `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
    await this.db.query("INSERT INTO deliverables (hash, content, author_account, job_id, created_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (hash) DO NOTHING", [
      hash,
      content,
      p.accountId,
      jobId ?? null,
      this.now(),
    ]);
    return { hash, bytes };
  }

  async get(hash: string): Promise<{ hash: string; content: string; author: string; createdAt: number } | null> {
    const { rows } = await this.db.query<{ hash: string; content: string; author_account: string; created_at: string }>("SELECT * FROM deliverables WHERE hash = $1", [hash]);
    const r = rows[0];
    return r ? { hash: r.hash, content: r.content, author: r.author_account, createdAt: Number(r.created_at) } : null;
  }
}

export interface ReviewView {
  milestoneId: string;
  submissionSeq: number;
  verdict: string;
  summary: string;
  points: string[];
  model: string;
  signature: { kind: string | null; address: string; algo: string } | null;
  signatureCheck: string | null;
  createdAt: number;
}

export async function reviewsForJob(db: Db, jobId: string): Promise<ReviewView[]> {
  const { rows } = await db.query<{
    milestone_id: string;
    submission_seq: number;
    verdict: string;
    summary: string;
    points: string[];
    model: string;
    signature: { signatureKind: string | null; signingAddress: string; signingAlgo: string } | null;
    signature_check: string | null;
    created_at: string;
  }>("SELECT * FROM ai_reviews WHERE job_id = $1 ORDER BY created_at", [jobId]);
  return rows.map((r) => ({
    milestoneId: r.milestone_id,
    submissionSeq: r.submission_seq,
    verdict: r.verdict,
    summary: r.summary,
    points: r.points,
    model: r.model,
    signature: r.signature ? { kind: r.signature.signatureKind, address: r.signature.signingAddress, algo: r.signature.signingAlgo } : null,
    signatureCheck: r.signature_check,
    createdAt: Number(r.created_at),
  }));
}
