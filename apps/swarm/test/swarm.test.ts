import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { KeyPair } from "near-api-js";
import { SettleAgent, type ContractCall } from "@settle/agent-sdk";
import { computeOnchainTermsHash } from "@settle/domain";
import { configFromEnv, ReviewWorker } from "@settle/api";
import type { ChatMessage, Completion, SignatureRecord } from "@settle/near-ai";
import { as, login, onchainFunded, startHarness, type Harness } from "../../api/test/harness.js";
import { decryptSecret, encryptSecret, MIN_FUNDING_YOCTO, nanoUsdToYocto, SwarmRunner, WITHDRAW_RESERVE_YOCTO } from "../src/index.js";

const NEAR = 10n ** 24n;
const OWNER = "agent-owner.testnet";
const POSTER = "poster.testnet";
const OPERATOR = "swarm-operator.testnet";
const MODEL = "z-ai/glm-5.3-flash";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

let h: Harness;
let apiUrl: string;
beforeAll(async () => {
  h = await startHarness();
  await h.app.listen({ port: 0, host: "127.0.0.1" });
  apiUrl = `http://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
});
afterAll(() => h.close());

/** Stands in for NEAR AI: deterministic answers, exact costs, and TEE-style signatures. */
class FakeAi {
  model = MODEL;
  calls: { purpose: string; messages: ChatMessage[] }[] = [];
  private n = 0;
  private readonly tee = secp256k1.utils.randomSecretKey();
  private readonly bodies = new Map<string, { req: string; res: string }>();
  declineIf = /Rust/;
  async chat(messages: ChatMessage[]): Promise<Completion> {
    const text = messages.map((m) => m.content).join("\n");
    const purpose = text.includes('{"take"') ? "triage" : text.includes("impartial reviewer") ? "review" : "deliverable";
    this.calls.push({ purpose, messages });
    const content =
      purpose === "triage"
        ? JSON.stringify(this.declineIf.test(text) ? { take: false, reason: "outside my skills" } : { take: true, reason: "fits" })
        : purpose === "review"
          ? JSON.stringify({ verdict: "meets", summary: "Covers the rubric.", points: ["Has setup steps"] })
          : `# Setup guide\n\nStep ${++this.n}: run the demo.${text.includes("revision") ? "\n\nRevised as asked." : ""}`;
    const id = `chatcmpl-${this.calls.length}`;
    const req = JSON.stringify({ model: MODEL, messages });
    const res = JSON.stringify({ id, choices: [{ message: { content } }] });
    this.bodies.set(id, { req, res });
    return { id, inferenceId: `inf-${id}`, model: MODEL, content, usage: { promptTokens: 100, completionTokens: 50 }, requestBody: req, responseBody: res };
  }
  async costs(ids: string[]) {
    return new Map(ids.map((id) => [id, 2_000_000])); // $0.002 each
  }
  async signature(id: string): Promise<SignatureRecord | null> {
    const b = this.bodies.get(id)!;
    const text = `${MODEL}:${sha(b.req)}:${sha(b.res)}`;
    const msg = new TextEncoder().encode(text);
    const digest = keccak_256(new Uint8Array([...new TextEncoder().encode(`\x19Ethereum Signed Message:\n${msg.length}`), ...msg]));
    const rec = secp256k1.sign(digest, this.tee, { prehash: false, format: "recovered" });
    const address = keccak_256(secp256k1.getPublicKey(this.tee, false).subarray(1)).subarray(12);
    return {
      text,
      signature: `0x${Buffer.from([...rec.subarray(1), rec[0]! + 27]).toString("hex")}`,
      signingAddress: `0x${Buffer.from(address).toString("hex")}`,
      signingAlgo: "ecdsa",
      signatureKind: "provider_tee",
    };
  }
}

/** SDK agents whose onchain calls are applied to the fake chain the way the contract would. */
function executorFor(accountId: string, agentRef: () => SettleAgent) {
  return {
    execute: async (call: ContractCall) => {
      const id = (call.args.agreement_id ?? (call.args.terms as { agreement_id: string }).agreement_id) as string;
      if (call.methodName === "post_bounty") {
        const { job } = await agentRef().getJob(id);
        h.chain.agreements.set(id, { ...onchainFunded(job.state as never), status: "Open", accepted_by_worker: false, funded_at_ms: null });
      }
      if (call.methodName === "claim_bounty") {
        const a = h.chain.agreements.get(id)!;
        if (a.status !== "Open") throw new Error("INVALID_TRANSITION: not an open bounty");
        a.terms = { ...a.terms, worker: accountId };
        a.terms_hash = computeOnchainTermsHash(a.terms);
        a.status = "Funded";
        a.accepted_by_worker = true;
      }
      return `tx-${call.methodName}`;
    },
  };
}

async function sdk(accountId: string, secret?: string) {
  const key = secret ? KeyPair.fromString(secret as `ed25519:${string}`) : KeyPair.fromRandom("ed25519");
  h.chain.keys.set(key.getPublicKey().toString(), { accountId, permission: "FullAccess" });
  let agent!: SettleAgent;
  agent = await SettleAgent.connect({ apiUrl, accountId, privateKey: key.toString() as `ed25519:${string}`, executor: executorFor(accountId, () => agent) });
  return agent;
}

const humanBounty = (title: string, rubric: string, near: bigint) => ({
  totalYocto: near.toString(),
  milestones: [{ id: "doc", title, type: "HUMAN_REVIEW", amountYocto: near.toString(), rubric, maxRevisions: 1, partialCompensation: null }],
  challengePeriodSec: 60,
  fundingDeadline: Date.now() + 3_600_000,
  expiresAt: Date.now() + 86_400_000,
});

describe("Swarm-for-Hire", () => {
  const ai = new FakeAi();
  /** The bounty the swarm wins; later steps refer to it (the database may hold other suites' jobs). */
  let wonJob = "";
  const balances = new Map<string, bigint>();
  const transfers: { from: string; to: string; yocto: bigint }[] = [];
  const events: [string, Record<string, unknown>][] = [];
  const secretKey = Buffer.alloc(32, 7);
  const runner = new SwarmRunner({
    db: undefined as never,
    ai,
    pricing: { inputNanoUsdPerToken: 80, outputNanoUsdPerToken: 500 },
    chain: {
      balance: async (a) => balances.get(a) ?? null,
      transfer: async (from, _secret, to, yocto) => {
        transfers.push({ from, to, yocto });
        balances.set(from, (balances.get(from) ?? 0n) - yocto);
        return `tx-transfer-${transfers.length}`;
      },
    },
    secretKey,
    connect: (accountId, secret) => sdk(accountId, secret),
    publicUrl: "https://settle.example",
    operator: OPERATOR,
    nearUsd: "2.5",
    log: (e, f = {}) => events.push([e, f]),
  });

  it("an owner adds an agent; it gets its own implicit account and starts once funded", async () => {
    (runner as unknown as { d: { db: unknown } }).d.db = h.db;
    const owner = as(h, await login(h, OWNER));
    const created = await owner.post("/v1/swarm/agents", {
      name: "Docs writer",
      prompt: "You are a precise technical writer for developer tools.",
      knowledge: "SETTLE runs on NEAR testnet.",
      maxBountyNear: "0.05",
      maxJobUsd: "0.05",
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ status: "provisioning", account: null });

    await runner.tick();
    const agent = (await owner.get(`/v1/swarm/agents/${created.json().id}`)).json();
    expect(agent.status).toBe("awaiting_funds");
    expect(agent.account).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(agent)).not.toMatch(/ed25519:|secret/i); // the API never exposes the key

    balances.set(agent.account, MIN_FUNDING_YOCTO - 1n);
    await runner.tick();
    expect((await owner.get(`/v1/swarm/agents/${agent.id}`)).json().status).toBe("awaiting_funds");
    balances.set(agent.account, 2n * MIN_FUNDING_YOCTO);
    await runner.tick();
    expect((await owner.get(`/v1/swarm/agents/${agent.id}`)).json().status).toBe("active");
  });

  it("claims only writing work it accepts, writes it with NEAR AI, and submits a content-addressed deliverable", async () => {
    const poster = await sdk(POSTER);
    const good = (await poster.postBounty(humanBounty("Write a setup guide", "A new user can run the demo.", NEAR / 100n))).job.id;
    wonJob = good;
    const tooBig = (await poster.postBounty(humanBounty("Write a long manual", "Complete.", NEAR))).job.id;
    const rust = (await poster.postBounty(humanBounty("Explain Rust lifetimes", "Accurate.", NEAR / 100n))).job.id;

    await runner.tick(); // one claim per pass
    await runner.tick();
    const skip = (id: string) => events.find(([e, f]) => e === "skipped" && f.bounty === id)?.[1].reason;
    expect(skip(tooBig)).toBe("pays more than this agent's limit");
    expect(skip(rust)).toMatch(/^declined: outside my skills/);

    const { job } = await poster.getJob(good);
    const m = job.state.milestones[0]!;
    expect(job.state.terms.worker.nearAccountId).toMatch(/^[0-9a-f]{64}$/);
    expect(m.status).toBe("SUBMITTED");
    const content = ai.calls.length && (await (await fetch(`${apiUrl}/d/${m.submission!.artifactHash.slice(7)}`)).text());
    expect(m.submission!.artifactHash).toBe(`sha256:${sha(String(content))}`); // the onchain hash is the hash of the bytes served
    expect(m.submission!.uri).toBe(`https://settle.example/d/${m.submission!.artifactHash.slice(7)}`);
    const res = await fetch(`${apiUrl}/d/${m.submission!.artifactHash.slice(7)}`);
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(res.headers.get("content-security-policy")).toContain("sandbox");

    const ledger = (await h.db.query<{ purpose: string }>("SELECT purpose FROM inference_calls WHERE job_id = $1 ORDER BY created_at", [good])).rows.map((r) => r.purpose);
    expect(ledger).toEqual(["triage", "deliverable"]);
  });

  it("an advisory AI review is written, signed by the TEE key, verified, and changes nothing", async () => {
    const reviewer = new ReviewWorker(h.db, ai, { warn: () => undefined });
    expect(await reviewer.tick()).toBeGreaterThan(0);
    await reviewer.tick(); // attaches the signature
    const { rows } = await h.db.query<{ verdict: string; signature_check: string }>("SELECT verdict, signature_check FROM ai_reviews WHERE job_id = $1", [wonJob]);
    expect(rows[0]).toMatchObject({ verdict: "meets", signature_check: "verified (provider_tee)" });
    const client = as(h, await login(h, POSTER));
    const view = (await client.get(`/v1/jobs/${wonJob}/reviews`)).json().reviews[0];
    expect(view).toMatchObject({ verdict: "meets", signatureCheck: "verified (provider_tee)", signature: { kind: "provider_tee", algo: "ecdsa" } });
    expect((await client.get(`/v1/jobs/${wonJob}`)).json().job.state.milestones[0].status).toBe("SUBMITTED"); // advisory only
  });

  it("revises with the client's feedback when asked", async () => {
    const poster = await sdk(POSTER);
    const id = wonJob;
    await poster.act(id, { type: "REQUEST_REVISION", milestoneId: "doc", feedback: "Add a troubleshooting section." });
    await runner.tick();
    const { job } = await poster.getJob(id);
    expect(job.state.milestones[0]).toMatchObject({ status: "SUBMITTED", submission: { seq: 2 } });
    expect(ai.calls.at(-1)!.messages[1]!.content).toContain("Add a troubleshooting section.");
  });

  it("never starts a call that could exceed the agent's per-job inference limit", async () => {
    const owner = as(h, await login(h, OWNER));
    const frugal = (await owner.post("/v1/swarm/agents", { name: "Frugal", prompt: "You write very short notes.", maxBountyNear: "1", maxJobUsd: "0.000001" })).json();
    await runner.tick();
    const acct = (await owner.get(`/v1/swarm/agents/${frugal.id}`)).json().account;
    balances.set(acct, MIN_FUNDING_YOCTO);
    await runner.tick();
    const poster = await sdk(POSTER);
    // The first agent declines Rust work, so the frugal agent is the one that considers it.
    const id = (await poster.postBounty(humanBounty("Note on Rust errors", "Short.", NEAR / 100n))).job.id;
    const before = ai.calls.length;
    await runner.tick();
    expect(events.find(([e, f]) => e === "skipped" && f.bounty === id && f.agent === "Frugal")?.[1].reason).toBe("even deciding would exceed the agent's inference limit");
    // The frugal agent made no call of its own.
    expect(ai.calls.slice(before).every((c) => !c.messages[0]!.content.includes("very short notes"))).toBe(true);
  });

  it("withdrawal pays the inference bill to the operator at the stated rate, then the rest to the owner", async () => {
    const owner = as(h, await login(h, OWNER));
    const [writer] = (await owner.get("/v1/swarm/agents")).json().agents.filter((a: { name: string }) => a.name === "Docs writer");
    await runner.tick(); // backfills exact costs
    const bill = Number((await h.db.query<{ n: string }>("SELECT sum(cost_nano_usd) AS n FROM inference_calls WHERE agent_id = $1", [writer.id])).rows[0]!.n);
    expect(bill).toBeGreaterThan(0);
    const start = balances.get(writer.account)!;

    expect((await owner.post(`/v1/swarm/agents/${writer.id}/withdraw`)).statusCode).toBe(200);
    expect((await as(h, await login(h, "stranger.testnet")).post(`/v1/swarm/agents/${writer.id}/withdraw`)).statusCode).toBe(404);
    await runner.tick();

    const fee = nanoUsdToYocto(bill, "2.5");
    expect(transfers.filter((t) => t.from === writer.account)).toEqual([
      { from: writer.account, to: OPERATOR, yocto: fee },
      { from: writer.account, to: OWNER, yocto: start - WITHDRAW_RESERVE_YOCTO - fee },
    ]);
    const after = (await owner.get(`/v1/swarm/agents/${writer.id}`)).json();
    expect(after).toMatchObject({ status: "paused", withdrawal: { status: "done" }, stats: { unsettledNanoUsd: 0 } });
  });
});

describe("swarm units and guards", () => {
  it("converts an inference bill to NEAR exactly, rounding up", () => {
    expect(nanoUsdToYocto(1_000_000_000, "2.5")).toBe(4n * 10n ** 23n); // $1 at $2.5 = 0.4 NEAR
    expect(nanoUsdToYocto(1, "3")).toBe(333333333333334n); // never rounds a bill down
  });

  it("encrypts agent keys so only the runner's secret opens them", () => {
    const k = Buffer.alloc(32, 1);
    const blob = encryptSecret("ed25519:abc", k);
    expect(blob).not.toContain("abc");
    expect(decryptSecret(blob, k)).toBe("ed25519:abc");
    expect(() => decryptSecret(blob, Buffer.alloc(32, 2))).toThrow();
  });

  it("refuses to run the swarm with the verifier's or keeper's keys, and keeps the swarm secret off the API", () => {
    const base = {
      SETTLE_DATABASE_URL: "postgres://x/y",
      SETTLE_ESCROW_CONTRACT: "escrow.testnet",
      SETTLE_VERIFIER_ACCOUNT: "v.testnet",
      SETTLE_VERIFIER_PUBLIC_KEY: "ab".repeat(32),
      SETTLE_RESOLVER_ACCOUNT: "r.testnet",
    };
    expect(() => configFromEnv({ ...base, SETTLE_VERIFIER_SEED: "11".repeat(32) }, "swarm")).toThrow(/must not hold the verifier seed/);
    expect(() => configFromEnv({ ...base, SETTLE_SWARM_SECRET: "22".repeat(32) }, "api")).toThrow(/SETTLE_SWARM_SECRET/);
  });
});
