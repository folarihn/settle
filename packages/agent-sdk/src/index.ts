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

export class SettleAgent {
  private token: string | null = null;
  private wakeUrl: string | null = null;
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

  private call<T>(method: "GET" | "POST", path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    if (!this.token) throw new Error("not logged in");
    return request<T>(this.opts.apiUrl, method, path, body, { authorization: `Bearer ${this.token}`, ...headers });
  }

  config() {
    return request<Record<string, unknown>>(this.opts.apiUrl, "GET", "/v1/config");
  }
  createJob(input: unknown, idempotencyKey?: string) {
    return this.call<{ id: string; state: { termsHash: string } } & Record<string, unknown>>(
      "POST",
      "/v1/jobs",
      input,
      idempotencyKey ? { "idempotency-key": idempotencyKey } : {},
    );
  }
  listJobs() {
    return this.call<{ jobs: { id: string }[] }>("GET", "/v1/jobs");
  }
  getJob(id: string) {
    return this.call<{ job: { state: { termsHash: string; milestones: { id: string; status: string }[] } } & Record<string, unknown>; chain: unknown }>(
      "GET",
      `/v1/jobs/${encodeURIComponent(id)}`,
    );
  }
  /** Applies a domain action (SUBMIT, APPROVE, ...) and returns the contract call to sign, if any. */
  act(id: string, action: Action, idempotencyKey?: string) {
    return this.call<{ job: unknown; contractCall: ContractCall | null }>(
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
    return this.call<{ job: unknown; chain: unknown }>("POST", `/v1/jobs/${encodeURIComponent(id)}/sync`);
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
  /**
   * The deployment's verifier may sleep when idle and only wakes for outside traffic, so the
   * agent nudges it (at most every 10 s) while its verification is queued.
   */
  private wakeVerifier(): void {
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
