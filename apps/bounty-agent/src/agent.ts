import type { JobView, SettleAgent } from "@settle/agent-sdk";
import { HttpVerificationPlan } from "@settle/domain";
import { runPlan, type RunResult } from "@settle/verifier";

/**
 * An autonomous worker agent for open bounties. It only claims work it can show it will pass:
 * before claiming, it runs each bounty's locked verification plan against its own deployment
 * (the same open-source checks the independent verifier will run). The verifier, not this
 * agent, decides PASS; the escrow contract, not this agent, pays.
 */

export interface BountyAgentConfig {
  /** Base URL of the service this agent delivers. */
  deploymentUrl: string;
  /** Identifies exactly what is delivered (e.g. the deployed commit). */
  artifactHash: string;
  /** Never claim a bounty paying more than this (yoctoNEAR). */
  maxBountyYocto: bigint;
  /** Skip bounties whose claim deadline is closer than this. */
  minTimeLeftMs?: number;
}

export interface AgentLog {
  (event: string, fields?: Record<string, unknown>): void;
}

export interface BountyAgentDeps {
  /** Runs a plan against a deployment; defaults to the verifier's runner. */
  check?: (plan: HttpVerificationPlan, baseUrl: string) => Promise<RunResult>;
  now?: () => number;
  verificationTimeoutMs?: number;
}

/** Milestone states where the deployment's verifier service still has to act (record, finalize, pay). */
const AWAITING_SERVICE = new Set(["SUBMITTED", "VERIFIED_PENDING_CHALLENGE", "CLAIMABLE", "PAYOUT_PENDING"]);

export type Decision = { take: true } | { take: false; reason: string };

/** Whether this agent should even try a bounty, before any network check. Pure. */
export function screen(b: JobView, cfg: BountyAgentConfig, now: number): Decision {
  const t = b.state.terms;
  if (b.state.status !== "OPEN" || !b.calls.claimBounty) return { take: false, reason: "not claimable by this account" };
  if (BigInt(t.totalYocto) > cfg.maxBountyYocto) return { take: false, reason: "pays more than this agent's limit" };
  if (t.fundingDeadline - now < (cfg.minTimeLeftMs ?? 60_000)) return { take: false, reason: "claim deadline too close" };
  for (const m of t.milestones) {
    if (m.type !== "AUTOMATED") return { take: false, reason: `milestone ${m.id} needs human review` };
    if (!HttpVerificationPlan.safeParse(m.verificationPlan).success) return { take: false, reason: `milestone ${m.id} is not an HTTP API check` };
  }
  return { take: true };
}

export class BountyAgent {
  /** Completed bounties already reported (only those finished while running are logged). */
  private readonly reportedPaid = new Set<string>();
  private started = false;
  /** Bounties already decided against (re-checking them every tick would only add load). */
  private readonly skipped = new Map<string, string>();
  private readonly check: NonNullable<BountyAgentDeps["check"]>;
  private readonly now: () => number;

  constructor(
    private readonly agent: SettleAgent,
    private readonly cfg: BountyAgentConfig,
    private readonly log: AgentLog,
    deps: BountyAgentDeps = {},
  ) {
    this.check = deps.check ?? ((plan, url) => runPlan(plan, url));
    this.now = deps.now ?? Date.now;
    this.verificationTimeoutMs = deps.verificationTimeoutMs ?? 180_000;
  }
  private readonly verificationTimeoutMs: number;

  /** One pass: finish work already claimed, then look for new bounties. Returns bounties claimed. */
  async tick(): Promise<number> {
    await this.resumeOwnWork();
    const { bounties } = await this.agent.listBounties();
    let claimed = 0;
    for (const b of bounties) {
      if (this.skipped.has(b.id)) continue;
      const d = screen(b, this.cfg, this.now());
      if (!d.take) {
        this.skip(b.id, d.reason);
        continue;
      }
      // Dry run of every locked check against our deployment: claim only what we can pass.
      const failing = await this.firstFailingCheck(b);
      if (failing) {
        this.skip(b.id, `own deployment would not pass: ${failing}`);
        continue;
      }
      try {
        const r = await this.agent.claimBounty(b.id);
        if (r.job.state.terms.worker.nearAccountId !== this.agent.accountId) {
          this.skip(b.id, "someone else claimed it first");
          continue;
        }
        this.log("claimed", { bounty: b.id, tx: r.txHash, near: nearOf(b.state.terms.totalYocto) });
        claimed += 1;
        await this.deliver(r.job);
      } catch (e) {
        this.skip(b.id, `claim failed: ${(e as Error).message.slice(0, 160)}`);
      }
    }
    return claimed;
  }

  /**
   * Keeps work this agent holds moving: delivers anything still pending (e.g. after a restart),
   * wakes a sleeping verifier service while recording, finalizing or paying is due (free hosting
   * only wakes for outside traffic), and reports payments once the contract has made them.
   */
  private async resumeOwnWork(): Promise<void> {
    const { jobs } = await this.agent.listJobs();
    for (const j of jobs) {
      if (j.state.terms.worker.nearAccountId !== this.agent.accountId || !j.state.terms.openBounty) continue;
      if (j.state.status === "FUNDED") {
        if (j.state.milestones.some((m) => m.status === "PENDING")) await this.deliver(j);
        if (j.state.milestones.some((m) => AWAITING_SERVICE.has(m.status))) this.agent.wakeVerifier();
      }
      if (j.state.status === "COMPLETED" && !this.reportedPaid.has(j.id)) {
        if (this.started) this.log("paid", { bounty: j.id, near: nearOf(j.state.terms.totalYocto) });
        this.reportedPaid.add(j.id);
      }
    }
    this.started = true;
  }

  private async firstFailingCheck(b: JobView): Promise<string | null> {
    for (const m of b.state.terms.milestones) {
      const r = await this.check(m.verificationPlan as HttpVerificationPlan, this.cfg.deploymentUrl);
      if (r.outcome !== "PASS") return `${m.id}: ${r.outcome} (${r.checks.find((c) => !c.ok)?.check ?? r.error?.message ?? "no answer"})`;
    }
    return null;
  }

  private async deliver(job: JobView): Promise<void> {
    for (const m of job.state.milestones) {
      if (m.status !== "PENDING") continue;
      const sub = await this.agent.actOnChain(job.id, { type: "SUBMIT", milestoneId: m.id, artifactHash: this.cfg.artifactHash, uri: this.cfg.deploymentUrl });
      this.log("submitted", { bounty: job.id, milestone: m.id, tx: sub.txHash });
      const q = await this.agent.requestVerification(job.id, m.id);
      try {
        const v = await this.agent.waitForVerification(q.id, { timeoutMs: this.verificationTimeoutMs, intervalMs: 3000 });
        this.log("verified", { bounty: job.id, milestone: m.id, outcome: v.outcome ?? v.status });
      } catch {
        this.log("verification still running", { bounty: job.id, milestone: m.id, verification: q.id });
      }
    }
  }

  private skip(id: string, reason: string) {
    this.skipped.set(id, reason);
    this.log("skipped", { bounty: id, reason });
  }
}

function nearOf(yocto: string): string {
  const s = yocto.padStart(25, "0");
  return `${s.slice(0, -24)}.${s.slice(-24)}`.replace(/\.?0+$/, "");
}
