import { createHmac, timingSafeEqual } from "node:crypto";
import { Account, type KeyPairString } from "near-api-js";

/**
 * TypeScript SDK for AI agents. It talks to the same API as the web app (same routes,
 * same domain rules) and signs with the agent's own NEAR key: NEP-413 for login and
 * normal function calls for onchain steps. The API never sees the key.
 */

/** A contract call returned by the API, to be signed by the acting party. */
export interface ContractCall {
  contractId: string;
  methodName: string;
  args: Record<string, unknown>;
  deposit: string;
  gas: string;
}

export interface Executor {
  /** Signs and sends one contract call; returns the transaction hash. */
  execute(call: ContractCall): Promise<string>;
}

export class SettleApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "SettleApiError";
  }
}

export interface SettleAgentOptions {
  apiUrl: string;
  accountId: string;
  /** "ed25519:<base58 secret>" — load from the agent's secret store, never hard-code. */
  privateKey: KeyPairString;
  /** NEAR RPC for onchain calls; defaults to the API's advertised RPC. */
  rpcUrl?: string;
  /** Override how onchain calls are sent (e.g. tests, or a custom relayer). */
  executor?: Executor;
}

export type Action = { type: string; milestoneId?: string } & Record<string, unknown>;

export interface MilestoneView {
  id: string;
  status: string;
  submission: { seq: number; artifactHash: string; uri?: string; submittedAt: number } | null;
  revisionsUsed: number;
  challengeEndsAt: number | null;
  lastVerification: { outcome: string; evidenceDigest: string } | null;
  settlementProposal: { proposer: string; workerYocto: string } | null;
  allocation: { workerYocto: string; clientYocto: string } | null;
}

/** A job as the API returns it: the offchain record, the viewer's roles and the calls they may sign. */
export interface JobView {
  id: string;
  version: number;
  roles: string[];
  state: {
    status: string;
    termsHash: string;
    acceptedBy: { client: boolean; worker: boolean };
    terms: {
      client: { kind: string; nearAccountId: string };
      worker: { kind: string; nearAccountId: string };
      totalYocto: string;
      challengePeriodSec: number;
      fundingDeadline: number;
      expiresAt: number;
      milestones: ({ id: string; title: string; type: "AUTOMATED" | "HUMAN_REVIEW"; amountYocto: string } & Record<string, unknown>)[];
    };
    milestones: MilestoneView[];
  };
  calls: { createAgreement?: ContractCall; fund?: ContractCall; payout: Record<string, ContractCall> };
}

export interface ChainSnapshot {
  agreement: { status: string; milestones: { status: string; submission: { seq: number } | null; challenge_ends_at_ms?: number }[] } | null;
  error: string | null;
  termsMatch: boolean | null;
  divergences: { milestoneId: string; offchain: string; onchain: string }[];
}

export class SettleAgent {
  private token: string | null = null;
  wakeUrl: string | null = null;
  private lastWake = 0;
  private account: Account;
  private executor: Executor;

  private constructor(
    private readonly opts: SettleAgentOptions,
    rpcUrl: string,
  ) {
    this.account = new Account(opts.accountId, rpcUrl, opts.privateKey);
    this.executor = opts.executor ?? {
      execute: async (call) => {
        const res = await this.account.callFunctionRaw({
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

  /** Reads the API's public config and logs in with the agent's key. */
  static async connect(opts: SettleAgentOptions): Promise<SettleAgent> {
    const config = await request<{ rpcUrl: string; workerWakeUrl?: string | null }>(opts.apiUrl, "GET", "/v1/config");
    const agent = new SettleAgent(opts, opts.rpcUrl ?? config.rpcUrl);
    agent.wakeUrl = config.workerWakeUrl ?? null;
    await agent.login();
    return agent;
  }

  async login(): Promise<void> {
    const ch = await request<{ nonce: string; message: string; recipient: string }>(this.opts.apiUrl, "POST", "/v1/auth/challenge", {
      accountId: this.opts.accountId,
    });
    const signed = await this.account.signNep413Message({ message: ch.message, recipient: ch.recipient, nonce: Buffer.from(ch.nonce, "hex") });
    const { token } = await request<{ token: string }>(this.opts.apiUrl, "POST", "/v1/auth/verify", {
      accountId: this.opts.accountId,
      publicKey: signed.publicKey.toString(),
      signature: Buffer.from(signed.signature).toString("base64"),
      nonce: ch.nonce,
      kind: "AGENT",
    });
    this.token = token;
  }

  private call<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    if (!this.token) throw new Error("not logged in");
    return request<T>(this.opts.apiUrl, method, path, body, { authorization: `Bearer ${this.token}`, ...headers });
  }

  config() {
    return request<Record<string, unknown>>(this.opts.apiUrl, "GET", "/v1/config");
  }
  get accountId(): string {
    return this.opts.accountId;
  }
  createJob(input: unknown, idempotencyKey?: string) {
    return this.call<JobView>(
      "POST",
      "/v1/jobs",
      input,
      idempotencyKey ? { "idempotency-key": idempotencyKey } : {},
    );
  }
  listJobs() {
    return this.call<{ jobs: JobView[] }>("GET", "/v1/jobs");
  }
  getJob(id: string) {
    return this.call<{ job: JobView; chain: ChainSnapshot }>(
      "GET",
      `/v1/jobs/${encodeURIComponent(id)}`,
    );
  }
  /** Applies a domain action (SUBMIT, APPROVE, ...) and returns the contract call to sign, if any. */
  act(id: string, action: Action, idempotencyKey?: string) {
    return this.call<{ job: JobView; contractCall: ContractCall | null }>(
      "POST",
      `/v1/jobs/${encodeURIComponent(id)}/actions`,
      action,
      idempotencyKey ? { "idempotency-key": idempotencyKey } : {},
    );
  }
  /** `act`, then sign and send the matching contract call with the agent's key. */
  async actOnChain(id: string, action: Action, idempotencyKey?: string) {
    const res = await this.act(id, action, idempotencyKey);
    const txHash = res.contractCall ? await this.executor.execute(res.contractCall) : null;
    return { ...res, txHash };
  }
  execute(call: ContractCall) {
    return this.executor.execute(call);
  }
  sync(id: string) {
    return this.call<{ job: JobView; chain: ChainSnapshot }>("POST", `/v1/jobs/${encodeURIComponent(id)}/sync`);
  }
  /**
   * Syncs until `done` holds or the tries run out. Right after a transaction the RPC may not
   * show it at `final` yet, so a single sync can miss it.
   */
  async syncUntil(id: string, done: (job: JobView) => boolean, { tries = 10, intervalMs = 1500 } = {}) {
    let last = await this.sync(id);
    for (let i = 1; i < tries && !done(last.job); i++) {
      await new Promise((r) => setTimeout(r, intervalMs));
      last = await this.sync(id);
    }
    return last;
  }

  /** Client: deposit exactly the agreed total into escrow (the contract checks the amount). */
  async fund(id: string): Promise<{ txHash: string; job: JobView }> {
    const { job } = await this.getJob(id);
    if (!job.calls.fund) throw new Error(`job ${id} is ${job.state.status}; only a DRAFT job can be funded`);
    const txHash = await this.execute(job.calls.fund);
    const synced = await this.syncUntil(id, (j) => j.state.status !== "DRAFT");
    return { txHash, job: synced.job };
  }

  /** Either party: send the payout of a claimable milestone (the contract pays the fixed split). */
  async claimPayment(id: string, milestoneId: string): Promise<{ txHash: string; job: JobView }> {
    const { job } = await this.getJob(id);
    const call = job.calls.payout[milestoneId];
    if (!call) throw new Error(`milestone ${milestoneId} is not claimable`);
    const txHash = await this.execute(call);
    const synced = await this.syncUntil(id, (j) => j.state.milestones.find((m) => m.id === milestoneId)?.status !== "CLAIMABLE", { tries: 5 });
    return { txHash, job: synced.job };
  }
  requestVerification(id: string, milestoneId: string) {
    return this.call<Verification>("POST", `/v1/jobs/${encodeURIComponent(id)}/milestones/${encodeURIComponent(milestoneId)}/verifications`);
  }
  getVerification(verificationId: string) {
    return this.call<Verification>("GET", `/v1/verifications/${encodeURIComponent(verificationId)}`);
  }
  evidence(verificationId: string) {
    return this.call<{ evidence: unknown; matchesReport: boolean }>("GET", `/v1/verifications/${encodeURIComponent(verificationId)}/evidence`);
  }
  /** Registers an HTTPS URL that receives every event on your jobs. Keep the returned secret to verify signatures. */
  createWebhook(url: string) {
    return this.call<{ id: string; url: string; secret: string }>("POST", "/v1/webhooks", { url });
  }
  listWebhooks() {
    return this.call<{ webhooks: { id: string; url: string; createdAt: number }[] }>("GET", "/v1/webhooks");
  }
  deleteWebhook(id: string) {
    return this.call<unknown>("DELETE", `/v1/webhooks/${encodeURIComponent(id)}`);
  }
  webhookDeliveries(id: string) {
    return this.call<{ deliveries: Record<string, unknown>[] }>("GET", `/v1/webhooks/${encodeURIComponent(id)}/deliveries`);
  }

  /**
   * The deployment's verifier may sleep when idle and only wakes for outside traffic, so the
   * agent nudges it (at most every 10 s) while its verification is queued.
   */
  wakeVerifier(): void {
    if (!this.wakeUrl || Date.now() - this.lastWake < 10_000) return;
    this.lastWake = Date.now();
    fetch(`${this.wakeUrl.replace(/\/+$/, "")}/kick`, { method: "POST", body: "", signal: AbortSignal.timeout(90_000) }).catch(() => undefined);
  }

  /** Polls until the verifier finishes. A timeout is an error, never a PASS. */
  async waitForVerification(verificationId: string, { timeoutMs = 60_000, intervalMs = 1000 } = {}): Promise<Verification> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = await this.getVerification(verificationId);
      if (v.status === "DONE" || v.status === "FAILED") return v;
      if (v.status === "QUEUED") this.wakeVerifier();
      if (Date.now() > deadline) throw new Error(`verification ${verificationId} still ${v.status} after ${timeoutMs} ms`);
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}

export interface Verification {
  id: string;
  status: "QUEUED" | "RUNNING" | "DONE" | "FAILED";
  outcome: "PASS" | "FAIL" | "INCONCLUSIVE" | "RUNNER_ERROR" | null;
  submissionSeq: number;
  error: string | null;
  contractCall: ContractCall | null;
}

/**
 * Checks a webhook's `settle-signature` header (`t=<ms>,v1=<hex>`) against the raw request
 * body. Rejects signatures older than `toleranceMs` so a captured delivery cannot be replayed later.
 */
export function verifyWebhookSignature(secret: string, header: string | undefined, rawBody: string, { toleranceMs = 5 * 60_000, now = Date.now() } = {}): boolean {
  const m = /^t=(\d{1,15}),v1=([0-9a-f]{64})$/.exec(header ?? "");
  if (!m) return false;
  const t = Number(m[1]);
  if (Math.abs(now - t) > toleranceMs) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
  return timingSafeEqual(expected, Buffer.from(m[2]!, "hex"));
}

async function request<T>(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(new URL(path, base), {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: { code: string; message: string } };
  if (!res.ok) throw new SettleApiError(res.status, json.error?.code ?? "HTTP_ERROR", json.error?.message ?? res.statusText);
  return json as T;
}
