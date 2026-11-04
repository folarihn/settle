import { randomBytes } from "node:crypto";
import {
  AgreementEvent,
  applyEvent,
  computeOnchainTermsHash,
  confirmPayout,
  contractCallFor,
  createAgreementCall,
  createDraft,
  fundCall,
  milestoneStatusFromChain,
  MilestoneTerms,
  payoutCall,
  Principal as PartyPrincipal,
  rolesOf,
  toContractTerms,
  YoctoString,
  type AgreementState,
  type ContractAgreement,
  type ContractCall,
} from "@settle/domain";
import { z } from "zod";
import type { Principal } from "./auth.js";
import { ChainUnavailable, type ChainReader } from "./chain.js";
import type { Config } from "./config.js";
import type { Db, Sql } from "./db.js";
import { ApiError } from "./errors.js";
import { enqueueWebhooks } from "./webhooks.js";

/**
 * Job workflow service. It owns no business rules: every change goes through the
 * domain state machine (`applyEvent`), and money movements are only mirrored from
 * the escrow contract via `syncFromChain`. Humans (web) and agents (SDK) both land here.
 */

export const CreateJobInput = z
  .object({
    worker: PartyPrincipal,
    totalYocto: YoctoString,
    milestones: z.array(MilestoneTerms).min(1).max(10),
    challengePeriodSec: z.number().int(),
    fundingDeadline: z.number().int(),
    expiresAt: z.number().int(),
  })
  .strict();

/** Party actions accepted by the API. FUND and START_PAYOUT happen onchain and arrive through sync. */
const CHAIN_ONLY = new Set(["FUND", "START_PAYOUT"]);

export interface JobView {
  id: string;
  version: number;
  state: AgreementState;
  roles: string[];
  onchainTermsHash: string;
  /** Calls a party signs directly that have no API action: creating, funding, paying out. */
  calls: { createAgreement?: ContractCall; fund?: ContractCall; payout: Record<string, ContractCall> };
}

export interface ChainSnapshot {
  agreement: ContractAgreement | null;
  error: string | null;
  termsMatch: boolean | null;
  divergences: { milestoneId: string; offchain: string; onchain: string }[];
}

export class JobService {
  constructor(
    private readonly db: Db,
    private readonly chain: ChainReader,
    private readonly config: Config,
    private readonly now: () => number = Date.now,
  ) {}

  async create(p: Principal, input: unknown): Promise<JobView> {
    const body = CreateJobInput.parse(input);
    const at = this.now();
    const state = createDraft(
      {
        schemaVersion: 1,
        agreementId: `job_${randomBytes(12).toString("base64url")}`,
        client: { kind: p.kind, nearAccountId: p.accountId },
        worker: body.worker,
        escrowContract: this.config.escrowContract,
        verifierAuthority: this.config.verifierAccount,
        verifierPublicKey: this.config.verifierPublicKey,
        disputeResolver: this.config.resolverAccount,
        asset: "NEAR",
        totalYocto: body.totalYocto,
        milestones: body.milestones,
        challengePeriodSec: body.challengePeriodSec,
        fundingDeadline: body.fundingDeadline,
        expiresAt: body.expiresAt,
      },
      at,
    );
    // Creating the job is the client's acceptance, exactly as create_agreement is onchain.
    const accepted = applyEvent(state, { type: "ACCEPT_TERMS", actor: p.accountId, at, termsHash: state.termsHash });
    await this.db.tx(async (sql) => {
      await sql.query(
        "INSERT INTO jobs (id, client_account, worker_account, state, version, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $6)",
        [accepted.terms.agreementId, p.accountId, body.worker.nearAccountId, JSON.stringify(accepted), accepted.version, at],
      );
      await this.logEvent(sql, accepted, p.accountId, "ACCEPT_TERMS", { termsHash: state.termsHash }, at);
    });
    return this.view(accepted, p.accountId);
  }

  async list(p: Principal): Promise<JobView[]> {
    const { rows } = await this.db.query<{ state: AgreementState }>(
      "SELECT state FROM jobs WHERE client_account = $1 OR worker_account = $1 OR state->'terms'->>'disputeResolver' = $1 OR state->'terms'->>'verifierAuthority' = $1 ORDER BY updated_at DESC LIMIT 100",
      [p.accountId],
    );
    return rows.map((r) => this.view(r.state, p.accountId));
  }

  async get(p: Principal, jobId: string): Promise<JobView> {
    const state = await this.load(this.db, jobId);
    this.requireParticipant(state, p.accountId);
    return this.view(state, p.accountId);
  }

  async events(p: Principal, jobId: string) {
    const state = await this.load(this.db, jobId);
    this.requireParticipant(state, p.accountId);
    const { rows } = await this.db.query("SELECT version, actor, type, event, at FROM job_events WHERE job_id = $1 ORDER BY version", [jobId]);
    return rows;
  }

  /** A party action. Returns the updated job and the contract call the party must now sign. */
  async act(p: Principal, jobId: string, input: unknown): Promise<{ job: JobView; contractCall: ContractCall | null }> {
    const raw = z.object({ type: z.string() }).passthrough().parse(input);
    // Non-participants get 404 before any rule runs, so job existence is never revealed.
    this.requireParticipant(await this.load(this.db, jobId), p.accountId);
    if (CHAIN_ONLY.has(raw.type)) {
      throw new ApiError(400, "CHAIN_ONLY", `${raw.type} happens onchain: sign the contract call, then POST /sync`);
    }
    const { state, event } = await this.apply(jobId, { ...raw, actor: p.accountId, at: this.now() });
    return { job: this.view(state, p.accountId), contractCall: contractCallFor(state, event) };
  }

  /** Applies one event atomically with optimistic concurrency and an audit log entry. */
  async apply(jobId: string, input: unknown, sql: Db | Sql = this.db): Promise<{ state: AgreementState; event: AgreementEvent }> {
    const event = AgreementEvent.parse(input);
    const run = async (q: Sql) => {
      const before = await this.load(q, jobId);
      const after = applyEvent(before, event);
      await this.save(q, before, after);
      const { type, actor, at, ...fields } = event;
      await this.logEvent(q, after, actor, type, fields, at);
      return { state: after, event };
    };
    return "tx" in sql ? sql.tx(run) : run(sql);
  }

  async chainSnapshot(state: AgreementState): Promise<ChainSnapshot> {
    let agreement: ContractAgreement | null;
    try {
      agreement = await this.chain.getAgreement(state.terms.agreementId);
    } catch (e) {
      if (e instanceof ChainUnavailable) return { agreement: null, error: e.message, termsMatch: null, divergences: [] };
      throw e;
    }
    if (!agreement) return { agreement: null, error: null, termsMatch: null, divergences: [] };
    const termsMatch = agreement.terms_hash === computeOnchainTermsHash(toContractTerms(state.terms));
    const divergences = termsMatch
      ? state.milestones.flatMap((m, i) => {
          const onchain = agreement.milestones[i] ? milestoneStatusFromChain(agreement.milestones[i]!.status) : "MISSING";
          return onchain === m.status ? [] : [{ milestoneId: m.id, offchain: m.status, onchain }];
        })
      : [];
    return { agreement, error: null, termsMatch, divergences };
  }

  /**
   * Mirrors monetary facts from the contract into the offchain record: funding and
   * payouts. Nothing here can create money movement; it only records what the chain did.
   */
  async syncFromChain(p: Principal, jobId: string): Promise<{ job: JobView; chain: ChainSnapshot }> {
    let state = await this.load(this.db, jobId);
    this.requireParticipant(state, p.accountId);
    const chain = await this.chainSnapshot(state);
    const onchain = chain.agreement;
    if (!onchain || !chain.termsMatch) return { job: this.view(state, p.accountId), chain };

    const at = this.now();
    const t = state.terms;
    const step = async (e: Record<string, unknown>) => {
      state = (await this.apply(jobId, { at, ...e })).state;
    };

    if (state.status === "DRAFT" && onchain.status !== "Draft") {
      if (!state.acceptedBy.worker && onchain.accepted_by_worker) {
        await step({ type: "ACCEPT_TERMS", actor: t.worker.nearAccountId, termsHash: state.termsHash });
      }
      await step({ type: "FUND", actor: t.client.nearAccountId, termsHash: state.termsHash, amountYocto: t.totalYocto });
    }

    for (const [i, m] of state.milestones.entries()) {
      const chainStatus = onchain.milestones[i]?.status;
      if (m.status === "CLAIMABLE" && (chainStatus === "PayoutPending" || chainStatus === "Paid")) {
        await step({ type: "START_PAYOUT", actor: t.client.nearAccountId, milestoneId: m.id });
      }
      const current = state.milestones[i]!;
      if (current.status === "PAYOUT_PENDING" && (chainStatus === "Paid" || chainStatus === "Claimable")) {
        state = await this.db.tx(async (q) => {
          const before = await this.load(q, jobId);
          const after = confirmPayout(before, m.id, chainStatus === "Paid");
          await this.save(q, before, after);
          await this.logEvent(q, after, "chain", "CONFIRM_PAYOUT", { milestoneId: m.id, succeeded: chainStatus === "Paid" }, at);
          return after;
        });
      }
    }
    return { job: this.view(state, p.accountId), chain: await this.chainSnapshot(state) };
  }

  view(state: AgreementState, viewer: string): JobView {
    const roles = [...rolesOf(state.terms, viewer)];
    const payout: Record<string, ContractCall> = {};
    for (const m of state.milestones) if (m.status === "CLAIMABLE") payout[m.id] = payoutCall(state.terms, m.id);
    return {
      id: state.terms.agreementId,
      version: state.version,
      state,
      roles,
      onchainTermsHash: computeOnchainTermsHash(toContractTerms(state.terms)),
      calls: {
        ...(state.status === "DRAFT" ? { createAgreement: createAgreementCall(state.terms), fund: fundCall(state.terms) } : {}),
        payout,
      },
    };
  }

  requireParticipant(state: AgreementState, accountId: string): void {
    if (rolesOf(state.terms, accountId).size === 0) throw new ApiError(404, "NOT_FOUND", "job not found");
  }

  async load(sql: Sql, jobId: string): Promise<AgreementState> {
    const { rows } = await sql.query<{ state: AgreementState }>("SELECT state FROM jobs WHERE id = $1", [jobId]);
    if (!rows[0]) throw new ApiError(404, "NOT_FOUND", "job not found");
    return rows[0].state;
  }

  private async save(sql: Sql, before: AgreementState, after: AgreementState): Promise<void> {
    const r = await sql.query("UPDATE jobs SET state = $1, version = $2, updated_at = $3 WHERE id = $4 AND version = $5", [
      JSON.stringify(after),
      after.version,
      this.now(),
      after.terms.agreementId,
      before.version,
    ]);
    if (r.rowCount !== 1) throw new ApiError(409, "CONFLICT", "job changed concurrently; reload and retry");
  }

  private async logEvent(sql: Sql, state: AgreementState, actor: string, type: string, fields: object, at: number) {
    await sql.query("INSERT INTO job_events (job_id, version, actor, type, event, at) VALUES ($1, $2, $3, $4, $5, $6)", [
      state.terms.agreementId,
      state.version,
      actor,
      type,
      JSON.stringify(fields),
      at,
    ]);
    await enqueueWebhooks(sql, state, actor, type, fields, at);
  }
}
