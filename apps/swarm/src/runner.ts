import type { JobView, SettleAgent } from "@settle/agent-sdk";
import { backfillCosts, recordInference, type Db } from "@settle/api";
import { SHORT_THINKING_TOKENS, worstCaseNanoUsd, type ChatMessage, type NearAi, type Pricing } from "@settle/near-ai";
import type { KeyPairString } from "near-api-js";
import { decryptSecret, encryptSecret, newAgentKey } from "./keys.js";

/**
 * Swarm-for-Hire runner (ADR 0006). Brings agents online once their owners fund them, has each
 * active agent find open bounties it can do, claim one, write the deliverable with NEAR AI, store
 * it content-addressed and submit it. People judge the work; the contract pays. Every inference
 * call is in the ledger with its exact cost, and the agent pays for it out of its balance.
 */

/** An agent must hold at least this before it starts (gas for claims and submissions). */
export const MIN_FUNDING_YOCTO = 5n * 10n ** 22n; // 0.05 NEAR
/** Left on the implicit account at withdrawal so the final transfers can pay their own gas. */
export const WITHDRAW_RESERVE_YOCTO = 10n ** 22n; // 0.01 NEAR

export type SwarmAi = Pick<NearAi, "chat" | "costs" | "model">;

export interface ChainOps {
  /** Balance of an account, or null if it does not exist (an implicit account before funding). */
  balance(accountId: string): Promise<bigint | null>;
  transfer(fromAccount: string, secret: KeyPairString, to: string, yocto: bigint): Promise<string>;
}

export interface SwarmDeps {
  db: Db;
  ai: SwarmAi;
  pricing: Pricing;
  chain: ChainOps;
  /** Encryption key for agent secrets (32 bytes). */
  secretKey: Buffer;
  /** Signs in as an agent (the same SDK any agent uses). */
  connect: (accountId: string, secret: KeyPairString) => Promise<SettleAgent>;
  /** Public origin of the API, for deliverable links. */
  publicUrl: string;
  operator: string;
  /** NEAR price in USD used to charge inference (a configured testnet rate). */
  nearUsd: string;
  log: (event: string, fields?: Record<string, unknown>) => void;
  now?: () => number;
}

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
  secret_enc: string | null;
}

const DELIVERABLE_TOKENS = 2000;
const TRIAGE_TOKENS = 150;

/** Whether an agent may even consider a bounty. Pure: no network, no model. */
export function screenBounty(b: JobView, maxBountyYocto: bigint, now: number): string | null {
  const t = b.state.terms;
  if (b.state.status !== "OPEN" || !b.calls.claimBounty) return "not claimable by this agent";
  if (BigInt(t.totalYocto) > maxBountyYocto) return "pays more than this agent's limit";
  if (t.fundingDeadline - now < 60_000) return "claim deadline too close";
  if (t.milestones.some((m) => m.type !== "HUMAN_REVIEW")) return "has milestones that need a deployment or code, not writing";
  return null;
}

/** NEAR equivalent of an inference bill at the configured rate, rounded up to the yoctoNEAR. */
export function nanoUsdToYocto(nano: number, nearUsd: string): bigint {
  const [w, f = ""] = nearUsd.split(".");
  const rate = BigInt(w! + f); // nearUsd * 10^f.length
  if (rate === 0n) throw new Error("SETTLE_SWARM_NEAR_USD must be positive");
  const num = BigInt(Math.ceil(nano)) * 10n ** 15n * 10n ** BigInt(f.length);
  return (num + rate - 1n) / rate;
}

export class SwarmRunner {
  private readonly agents = new Map<string, SettleAgent>();
  private readonly skipped = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly d: SwarmDeps) {
    this.now = d.now ?? Date.now;
  }

  async tick(): Promise<void> {
    await this.provision();
    await this.activateFunded();
    await this.withdrawals();
    const { rows } = await this.d.db.query<AgentRow>("SELECT * FROM swarm_agents WHERE status = 'active' ORDER BY created_at");
    for (const a of rows) {
      try {
        await this.work(a);
      } catch (e) {
        this.d.log("agent pass failed", { agent: a.name, error: (e as Error).message.slice(0, 200) });
      }
    }
    await backfillCosts(this.d.db, this.d.ai).catch(() => undefined);
  }

  /** New agents get a key; their account is the implicit account of that key. */
  private async provision() {
    const { rows } = await this.d.db.query<AgentRow>("SELECT * FROM swarm_agents WHERE status = 'provisioning'");
    for (const a of rows) {
      const k = newAgentKey();
      await this.d.db.query(
        "UPDATE swarm_agents SET account_id = $2, public_key = $3, secret_enc = $4, status = 'awaiting_funds', updated_at = $5 WHERE id = $1 AND status = 'provisioning'",
        [a.id, k.accountId, k.publicKey, encryptSecret(k.secret, this.d.secretKey), this.now()],
      );
      this.d.log("agent provisioned", { agent: a.name, account: k.accountId });
    }
  }

  private async activateFunded() {
    const { rows } = await this.d.db.query<AgentRow>("SELECT * FROM swarm_agents WHERE status = 'awaiting_funds'");
    for (const a of rows) {
      const bal = await this.d.chain.balance(a.account_id!).catch(() => null);
      if (bal !== null && bal >= MIN_FUNDING_YOCTO) {
        await this.d.db.query("UPDATE swarm_agents SET status = 'active', updated_at = $2 WHERE id = $1 AND status = 'awaiting_funds'", [a.id, this.now()]);
        this.d.log("agent funded and active", { agent: a.name, balance: bal.toString() });
      }
    }
  }

  private async connected(a: AgentRow): Promise<SettleAgent> {
    const cached = this.agents.get(a.id);
    if (cached) return cached;
    const agent = await this.d.connect(a.account_id!, decryptSecret(a.secret_enc!, this.d.secretKey));
    this.agents.set(a.id, agent);
    return agent;
  }

  private async work(a: AgentRow) {
    // NEAR charges a call's gas up front (about 0.03 NEAR for 30 Tgas, mostly refunded), so an
    // agent below the funding minimum cannot act: send it back to "needs NEAR" instead of failing.
    const balance = await this.d.chain.balance(a.account_id!).catch(() => null);
    if (balance !== null && balance < MIN_FUNDING_YOCTO) {
      await this.d.db.query("UPDATE swarm_agents SET status = 'awaiting_funds', updated_at = $2 WHERE id = $1 AND status = 'active'", [a.id, this.now()]);
      this.d.log("needs NEAR for gas", { agent: a.name, balance: balance.toString() });
      return;
    }
    const agent = await this.connected(a);

    // 1. Finish work it already holds: new claims and revision requests.
    const { jobs } = await agent.listJobs();
    for (const listed of jobs) {
      if (listed.state.status !== "FUNDED" || listed.state.terms.worker.nearAccountId !== a.account_id) continue;
      await this.resync(a, agent, listed.id);
      for (const m of listed.state.milestones) {
        if (m.status === "PENDING" || m.status === "REVISION_REQUESTED") await this.deliver(a, agent, listed, m.id);
      }
    }

    // 2. Look for one new bounty per pass.
    const { bounties } = await agent.listBounties();
    for (const b of bounties) {
      const key = `${a.id}:${b.id}`;
      if (this.skipped.has(key)) continue;
      const reason = screenBounty(b, BigInt(a.max_bounty_yocto), this.now()) ?? (await this.triage(a, b));
      if (reason) {
        this.skipped.add(key);
        this.d.log("skipped", { agent: a.name, bounty: b.id, reason });
        continue;
      }
      try {
        const r = await agent.claimBounty(b.id);
        if (r.job.state.terms.worker.nearAccountId !== a.account_id) throw new Error("another agent claimed it first");
        this.d.log("claimed", { agent: a.name, bounty: b.id, tx: r.txHash });
        for (const m of r.job.state.milestones) await this.deliver(a, agent, r.job, m.id);
      } catch (e) {
        this.skipped.add(key);
        this.d.log("claim lost", { agent: a.name, bounty: b.id, reason: (e as Error).message.slice(0, 160) });
      }
      return;
    }
  }

  /**
   * The API records a submission before the agent signs it onchain. If signing failed (e.g. not
   * enough gas), the record shows SUBMITTED while the contract still waits; re-send only the
   * onchain call, with the artifact hash already recorded, so the two agree again.
   */
  private async resync(a: AgentRow, agent: SettleAgent, jobId: string) {
    const { job, chain } = await agent.getJob(jobId);
    if (!chain.agreement || chain.termsMatch === false) return;
    const escrow = (job.state.terms as unknown as { escrowContract: string }).escrowContract;
    for (const [i, m] of job.state.milestones.entries()) {
      const onchain = chain.agreement.milestones[i]?.status;
      if (m.status !== "SUBMITTED" || !m.submission || (onchain !== "Pending" && onchain !== "RevisionRequested")) continue;
      const tx = await agent.execute({
        contractId: escrow,
        methodName: "submit",
        args: { agreement_id: jobId, milestone_id: m.id, artifact_hash: m.submission.artifactHash },
        deposit: "0",
        gas: "30000000000000",
      });
      this.d.log("re-sent submission onchain", { agent: a.name, bounty: jobId, milestone: m.id, seq: m.submission.seq, tx });
    }
  }

  /** The agent decides whether the work fits its skills. This decides only whether to claim; people decide payment. */
  private async triage(a: AgentRow, b: JobView): Promise<string | null> {
    const t = b.state.terms;
    const brief = t.milestones.map((m) => `- ${m.title}\n  Acceptance: ${String(m.rubric ?? "")}`).join("\n");
    const messages: ChatMessage[] = [
      {
        role: "system",
        // The agent decides with the same knowledge it would write with, or it refuses work it could do.
        content:
          `${a.prompt}\n\n` +
          (a.knowledge ? `Knowledge you may rely on:\n${a.knowledge.slice(0, 20_000)}\n\n` : "") +
          'You decide whether to take a paid writing job. Answer JSON only: {"take": true|false, "reason": "short"}.',
      },
      { role: "user", content: `Job brief:\n${brief}\n\nCan you deliver this well as written text, given your skills and knowledge?` },
    ];
    // "minimal" reasoning adds a few dozen thinking tokens at most; budget generously for them.
    if (worstCaseNanoUsd(this.d.pricing, chars(messages), TRIAGE_TOKENS + 64) > Number(a.max_job_nano_usd)) return "even deciding would exceed the agent's inference limit";
    const c = await this.d.ai.chat(messages, { maxTokens: TRIAGE_TOKENS, temperature: 0, reasoning: "minimal" });
    await recordInference(this.d.db, c, "triage", { agentId: a.id, jobId: b.id }, this.now());
    const m = c.content.match(/\{[\s\S]*\}/);
    try {
      const j = JSON.parse(m?.[0] ?? "") as { take?: unknown; reason?: unknown };
      return j.take === true ? null : `declined: ${String(j.reason ?? "not a fit").slice(0, 160)}`;
    } catch {
      return "could not read its own decision";
    }
  }

  /** Writes the deliverable with NEAR AI, stores it content-addressed, and submits its hash. */
  private async deliver(a: AgentRow, agent: SettleAgent, job: JobView, milestoneId: string) {
    const terms = job.state.terms.milestones.find((m) => m.id === milestoneId);
    if (!terms || terms.type !== "HUMAN_REVIEW") return;
    const ms = job.state.milestones.find((m) => m.id === milestoneId)!;

    let revision = "";
    if (ms.status === "REVISION_REQUESTED") {
      const { events } = await agent.jobEvents(job.id);
      const ask = [...events].reverse().find((e) => e.type === "REQUEST_REVISION" && e.event.milestoneId === milestoneId);
      revision = `\n\nThe client asked for a revision: "${String(ask?.event.feedback ?? "").slice(0, 2000)}". Rewrite the full deliverable to address it.`;
    }

    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          `${a.prompt}\n\n` +
          (a.knowledge ? `Knowledge you may rely on:\n${a.knowledge.slice(0, 20_000)}\n\n` : "") +
          "Write the complete deliverable in Markdown. Do not add commentary about yourself or the task; produce only the deliverable.",
      },
      { role: "user", content: `Task: ${terms.title}\n\nAcceptance criteria (the client judges against these):\n${String(terms.rubric ?? "")}${revision}` },
    ];

    // Guardrail: never start a call that could push this job past the agent's inference limit.
    const spent = await this.jobSpend(a.id, job.id);
    const worst = worstCaseNanoUsd(this.d.pricing, chars(messages), DELIVERABLE_TOKENS + SHORT_THINKING_TOKENS);
    if (spent + worst > Number(a.max_job_nano_usd)) {
      this.d.log("held: inference limit", { agent: a.name, bounty: job.id, spentNanoUsd: spent, nextWorstNanoUsd: worst, limit: Number(a.max_job_nano_usd) });
      return;
    }
    const c = await this.d.ai.chat(messages, { maxTokens: DELIVERABLE_TOKENS, temperature: 0.4, reasoning: "short" });
    await recordInference(this.d.db, c, "deliverable", { agentId: a.id, jobId: job.id, milestoneId }, this.now());
    if (!c.content) {
      this.d.log("empty answer; will retry", { agent: a.name, bounty: job.id });
      return;
    }
    const d = await agent.createDeliverable(c.content, job.id);
    const sub = await agent.actOnChain(job.id, { type: "SUBMIT", milestoneId, artifactHash: d.hash, uri: `${this.d.publicUrl}${d.url}` });
    this.d.log("submitted", { agent: a.name, bounty: job.id, milestone: milestoneId, deliverable: d.hash.slice(0, 19), tx: sub.txHash });
  }

  /** Known cost of this agent's calls for a job, plus a worst-case figure for calls not yet billed. */
  private async jobSpend(agentId: string, jobId: string): Promise<number> {
    const { rows } = await this.d.db.query<{ cost: string | null; prompt_tokens: number; completion_tokens: number }>(
      "SELECT cost_nano_usd AS cost, prompt_tokens, completion_tokens FROM inference_calls WHERE agent_id = $1 AND job_id = $2",
      [agentId, jobId],
    );
    const p = this.d.pricing;
    return rows.reduce((s, r) => s + (r.cost !== null ? Number(r.cost) : r.prompt_tokens * p.inputNanoUsdPerToken + r.completion_tokens * p.outputNanoUsdPerToken), 0);
  }

  /**
   * Withdrawal: first pay the agent's accrued inference bill to the operator (at the configured
   * rate), then send the rest to the owner, keeping a small reserve for the transfers' gas.
   */
  private async withdrawals() {
    const { rows } = await this.d.db.query<AgentRow & { wd_id: string }>(
      "SELECT a.*, w.id AS wd_id FROM swarm_withdrawals w JOIN swarm_agents a ON a.id = w.agent_id WHERE w.status = 'requested' ORDER BY w.created_at",
    );
    for (const a of rows) {
      const fail = (error: string) => this.d.db.query("UPDATE swarm_withdrawals SET status = 'failed', error = $2, updated_at = $3 WHERE id = $1", [a.wd_id, error, this.now()]);
      const pending = await this.d.db.query<{ n: string }>("SELECT count(*) AS n FROM inference_calls WHERE agent_id = $1 AND cost_nano_usd IS NULL", [a.id]);
      if (Number(pending.rows[0]!.n) > 0) continue; // wait until NEAR AI has reported every cost
      try {
        const bal = (await this.d.chain.balance(a.account_id!)) ?? 0n;
        const bill = await this.d.db.query<{ nano: string | null }>("SELECT sum(cost_nano_usd) AS nano FROM inference_calls WHERE agent_id = $1 AND NOT settled", [a.id]);
        const nano = Number(bill.rows[0]!.nano ?? 0);
        const fee = nanoUsdToYocto(nano, this.d.nearUsd);
        const available = bal - WITHDRAW_RESERVE_YOCTO;
        if (available <= fee) {
          await fail("balance does not cover the inference bill plus the gas reserve");
          continue;
        }
        const secret = decryptSecret(a.secret_enc!, this.d.secretKey);
        const feeTx = fee > 0n ? await this.d.chain.transfer(a.account_id!, secret, this.d.operator, fee) : null;
        await this.d.db.query("UPDATE inference_calls SET settled = TRUE WHERE agent_id = $1 AND cost_nano_usd IS NOT NULL", [a.id]);
        const payout = available - fee;
        const payoutTx = await this.d.chain.transfer(a.account_id!, secret, a.owner_account, payout);
        await this.d.db.query(
          "UPDATE swarm_withdrawals SET status = 'done', inference_nano_usd = $2, fee_yocto = $3, paid_yocto = $4, fee_tx = $5, payout_tx = $6, updated_at = $7 WHERE id = $1",
          [a.wd_id, nano, fee.toString(), payout.toString(), feeTx, payoutTx, this.now()],
        );
        this.d.log("withdrawn", { agent: a.name, toOwner: payout.toString(), inferenceFee: fee.toString() });
      } catch (e) {
        await fail((e as Error).message.slice(0, 300));
      }
    }
  }
}

const chars = (m: ChatMessage[]) => m.reduce((s, x) => s + x.content.length, 0);
