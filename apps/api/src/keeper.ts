import { contractCallFor, milestoneStatusFromChain, payoutCall, type AgreementState, type ContractCall, type VerificationReport } from "@settle/domain";
import { Account, type KeyPairString } from "near-api-js";
import type { ChainReader } from "./chain.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import type { JobService } from "./jobs.js";

/** Sends contract calls with the verifier's own testnet account (pays gas; cannot redirect funds). */
export interface Relayer {
  accountId: string;
  send(call: ContractCall): Promise<string>;
}

export function createRelayer(accountId: string, privateKey: string, rpcUrl: string): Relayer {
  const account = new Account(accountId, rpcUrl, privateKey as KeyPairString);
  return {
    accountId,
    async send(call) {
      const res = await account.callFunctionRaw({
        contractId: call.contractId,
        methodName: call.methodName,
        args: call.args,
        deposit: BigInt(call.deposit),
        gas: BigInt(call.gas),
      });
      return res.transaction.hash;
    },
  };
}

export interface KeeperLog {
  info: (o: object, msg: string) => void;
  warn: (o: object, msg: string) => void;
}

/**
 * Moves funded agreements forward without anyone clicking, using only steps any party (or
 * the verifier) is allowed to take and that cannot change who gets paid what:
 *  - records the signed verification result the contract is waiting for,
 *  - finalizes a PASS once the challenge window has ended onchain,
 *  - triggers the payout of an already fixed allocation.
 * Every action is checked against the contract's current state first, and failures are
 * simply retried on the next tick; the parties can still do each step themselves.
 */
export class Keeper {
  constructor(
    private readonly db: Db,
    private readonly jobs: JobService,
    private readonly chain: ChainReader,
    private readonly relayer: Relayer,
    private readonly config: Config,
    private readonly log: KeeperLog,
    private readonly now: () => number = Date.now,
  ) {}

  /** One pass over funded agreements. Returns how many onchain calls were sent. */
  async tick(onlyJobId?: string): Promise<number> {
    if (!onlyJobId) await this.watchBounties();
    const { rows } = await this.db.query<{ id: string }>(
      onlyJobId ? "SELECT id FROM jobs WHERE id = $1" : "SELECT id FROM jobs WHERE state->>'status' = 'FUNDED'",
      onlyJobId ? [onlyJobId] : [],
    );
    let sent = 0;
    for (const { id } of rows) {
      try {
        sent += await this.advance(id);
      } catch (e) {
        this.log.warn({ jobId: id, err: e instanceof Error ? e.message : String(e) }, "keeper could not advance job");
      }
    }
    return sent;
  }

  /** Mirrors claims and cancellations of posted bounties, so parties and webhooks learn of them without a manual sync. */
  private async watchBounties(): Promise<void> {
    const { rows } = await this.db.query<{ id: string }>("SELECT id FROM jobs WHERE state->>'status' = 'OPEN' LIMIT 100");
    for (const { id } of rows) {
      await this.jobs.syncFromChain({ accountId: this.config.verifierAccount, kind: "AGENT" }, id).catch((e) => {
        this.log.warn({ jobId: id, err: e instanceof Error ? e.message : String(e) }, "keeper could not sync bounty");
      });
    }
  }

  private async advance(jobId: string): Promise<number> {
    const state = await this.jobs.load(this.db, jobId);
    if (state.status !== "FUNDED") return 0;
    const onchain = await this.chain.getAgreement(jobId);
    if (!onchain) return 0;
    let sent = 0;
    const now = this.now();

    for (const [i, m] of state.milestones.entries()) {
      const oc = onchain.milestones[i];
      if (!oc) continue;

      if (oc.status === "Submitted" && oc.submission) {
        const report = await this.signedReportFor(jobId, m.id, oc.submission.seq);
        if (report) sent += await this.send(jobId, contractCallFor(state, { type: "RECORD_VERIFICATION", actor: this.relayer.accountId, at: now, milestoneId: m.id, ...report }), "record_verification");
      } else if (oc.status === "VerifiedPendingChallenge" && oc.challenge_ends_at_ms && oc.challenge_ends_at_ms <= now) {
        sent += await this.send(jobId, finalizeCall(state, m.id), "finalize_challenge");
        if (m.status === "VERIFIED_PENDING_CHALLENGE" && (m.challengeEndsAt ?? 0) <= now) {
          await this.jobs
            .apply(jobId, { type: "FINALIZE_CHALLENGE", actor: this.config.verifierAccount, at: now, milestoneId: m.id })
            .catch((e) => this.log.warn({ jobId, err: String(e) }, "offchain finalize deferred"));
        }
      } else if (oc.status === "Claimable") {
        sent += await this.send(jobId, payoutCall(state.terms, m.id), "payout");
      }
    }
    // Mirror the chain after our own calls, and whenever the record lags it (e.g. a payout
    // someone else sent), so dashboards and webhooks catch up without anyone opening the page.
    const lagging = state.milestones.some((m, i) => onchain.milestones[i] && milestoneStatusFromChain(onchain.milestones[i]!.status) !== m.status);
    if (sent > 0 || lagging) await this.jobs.syncFromChain({ accountId: this.config.verifierAccount, kind: "AGENT" }, jobId).catch(() => undefined);
    return sent;
  }

  /**
   * Only definitive outcomes are relayed. INCONCLUSIVE and RUNNER_ERROR change nothing onchain
   * (the milestone stays Submitted for a re-run), so relaying them would only burn gas.
   */
  private async signedReportFor(jobId: string, milestoneId: string, seq: number) {
    const { rows } = await this.db.query<{ report: VerificationReport; signature: string }>(
      `SELECT report, signature FROM verifications
       WHERE job_id = $1 AND milestone_id = $2 AND submission_seq = $3 AND status = 'DONE' AND report IS NOT NULL
         AND report->>'outcome' IN ('PASS', 'FAIL')
       ORDER BY updated_at DESC LIMIT 1`,
      [jobId, milestoneId, seq],
    );
    return rows[0] ? { report: rows[0].report, signature: rows[0].signature } : null;
  }

  private async send(jobId: string, call: ContractCall | null, label: string): Promise<number> {
    if (!call) return 0;
    try {
      const hash = await this.relayer.send(call);
      this.log.info({ jobId, method: label, tx: hash }, "keeper sent onchain call");
      return 1;
    } catch (e) {
      // e.g. not yet final, or another party already did it; retried next tick.
      this.log.warn({ jobId, method: label, err: e instanceof Error ? e.message.slice(0, 200) : String(e) }, "keeper call refused");
      return 0;
    }
  }
}

function finalizeCall(state: AgreementState, milestoneId: string): ContractCall {
  return contractCallFor(state, { type: "FINALIZE_CHALLENGE", actor: "keeper.testnet", at: 0, milestoneId })!;
}
