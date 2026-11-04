import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  computeOnchainTermsHash,
  toContractTerms,
  type AgreementState,
  type ContractAgreement,
  type ContractMilestoneStatus,
} from "@settle/domain";
import { buildApp } from "../src/index.js";
import { as, CLIENT, config, jobInput, login, newKey, STRANGER, startHarness, WORKER, type Harness } from "./harness.js";

// One database for the file (PGlite start-up is slow); every test creates its own jobs.
let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(() => h.close());

/** What the escrow contract would report for this job. */
function onchain(state: AgreementState, status: ContractAgreement["status"], milestones: ContractMilestoneStatus[]): ContractAgreement {
  const terms = toContractTerms(state.terms);
  return {
    terms,
    terms_hash: computeOnchainTermsHash(terms),
    status,
    accepted_by_worker: true,
    funded_at_ms: status === "Draft" ? null : Date.now(),
    milestones: milestones.map((s) => ({
      status: s,
      submission: null,
      submission_count: 0,
      allocated: false,
      worker: { due: "0", pending: "0", paid: "0" },
      client: { due: "0", pending: "0", paid: "0" },
    })),
  };
}

/** Client creates, worker accepts, the contract reports Funded and the client syncs. */
async function fundedJob() {
  const client = as(h, await login(h, CLIENT));
  const worker = as(h, await login(h, WORKER, "AGENT"));
  const created = await client.post("/v1/jobs", jobInput());
  expect(created.statusCode).toBe(201);
  const id: string = created.json().id;
  const accepted = await worker.post(`/v1/jobs/${id}/actions`, { type: "ACCEPT_TERMS", termsHash: created.json().state.termsHash });
  expect(accepted.statusCode).toBe(200);
  h.chain.agreements.set(id, onchain(accepted.json().job.state, "Funded", ["Pending", "Pending"]));
  const synced = await client.post(`/v1/jobs/${id}/sync`);
  expect(synced.json().job.state.status).toBe("FUNDED");
  return { client, worker, id };
}

describe("authentication", () => {
  it("issues a session for a valid NEP-413 signature by a full-access key", async () => {
    const token = await login(h, WORKER, "AGENT");
    const me = await as(h, token).get("/v1/me");
    expect(me.json()).toEqual({ accountId: WORKER, kind: "AGENT" });
  });

  it("rejects replayed challenges, foreign keys, function-call keys and bad signatures", async () => {
    const attempt = async (accountId: string, register: "FullAccess" | "FunctionCall" | null, tamper = false, reuse?: string) => {
      const key = newKey();
      if (register) h.chain.keys.set(key.publicKey, { accountId, permission: register });
      const ch = reuse
        ? JSON.parse(reuse)
        : (await h.app.inject({ method: "POST", url: "/v1/auth/challenge", payload: { accountId } })).json();
      const { sign } = await import("node:crypto");
      const { nep413Hash } = await import("../src/index.js");
      const msg = tamper ? "Sign in to SETTLE as someone-else.testnet" : ch.message;
      const signature = sign(null, nep413Hash(msg, Buffer.from(ch.nonce, "hex"), ch.recipient), key.privateKey).toString("base64");
      const res = await h.app.inject({
        method: "POST",
        url: "/v1/auth/verify",
        payload: { accountId, publicKey: key.publicKey, signature, nonce: ch.nonce, kind: "HUMAN" },
      });
      return { res, ch: JSON.stringify(ch) };
    };
    expect((await attempt(CLIENT, null)).res.statusCode).toBe(401); // key not on the account
    expect((await attempt(CLIENT, "FunctionCall")).res.statusCode).toBe(401);
    expect((await attempt(CLIENT, "FullAccess", true)).res.statusCode).toBe(401);
    const ok = await attempt(CLIENT, "FullAccess");
    expect(ok.res.statusCode).toBe(200);
    expect((await attempt(CLIENT, "FullAccess", false, ok.ch)).res.statusCode).toBe(401); // replay
  });

  it("accepts wallets that include their callback URL in the signed NEP-413 payload", async () => {
    const { sign } = await import("node:crypto");
    const { nep413Hash } = await import("../src/index.js");
    const key = newKey();
    h.chain.keys.set(key.publicKey, { accountId: CLIENT, permission: "FullAccess" });
    const ch = (await h.app.inject({ method: "POST", url: "/v1/auth/challenge", payload: { accountId: CLIENT } })).json();
    const callbackUrl = "https://settle.example/";
    const signature = sign(null, nep413Hash(ch.message, Buffer.from(ch.nonce, "hex"), ch.recipient, callbackUrl), key.privateKey).toString("base64");
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/auth/verify",
      payload: { accountId: CLIENT, publicKey: key.publicKey, signature, nonce: ch.nonce, kind: "HUMAN", callbackUrl },
    });
    expect(res.statusCode).toBe(200);
  });

  it("requires a valid bearer token", async () => {
    expect((await h.app.inject({ method: "GET", url: "/v1/jobs" })).statusCode).toBe(401);
    expect((await as(h, "not-a-real-token-at-all-xx").get("/v1/jobs")).statusCode).toBe(401);
  });
});

describe("authorization", () => {
  it("hides jobs from non-participants and enforces roles through the domain rules", async () => {
    const { client, worker, id } = await fundedJob();
    const stranger = as(h, await login(h, STRANGER));
    expect((await stranger.get(`/v1/jobs/${id}`)).statusCode).toBe(404);
    expect((await stranger.post(`/v1/jobs/${id}/actions`, { type: "APPROVE", milestoneId: "design" })).statusCode).toBe(404);

    const submit = { type: "SUBMIT", milestoneId: "design", artifactHash: "sha256-design-v1" };
    expect((await client.post(`/v1/jobs/${id}/actions`, submit)).json().error.code).toBe("UNAUTHORIZED");
    expect((await worker.post(`/v1/jobs/${id}/actions`, submit)).statusCode).toBe(200);
    const selfApprove = await worker.post(`/v1/jobs/${id}/actions`, { type: "APPROVE", milestoneId: "design" });
    expect([selfApprove.statusCode, selfApprove.json().error.code]).toEqual([403, "UNAUTHORIZED"]);
  });

  it("refuses money movements through the API; they only arrive from the contract", async () => {
    const { client, id } = await fundedJob();
    const res = await client.post(`/v1/jobs/${id}/actions`, { type: "START_PAYOUT", milestoneId: "api" });
    expect(res.json().error.code).toBe("CHAIN_ONLY");
  });
});

describe("verification workflow", () => {
  it("records a real FAIL from the broken deployment, then a real PASS from the fixed one", async () => {
    const { client, worker, id } = await fundedJob();
    const submit = (deployment: string) =>
      worker.post(`/v1/jobs/${id}/actions`, {
        type: "SUBMIT",
        milestoneId: "api",
        artifactHash: `commit-${deployment}`,
        uri: `${h.fixtureOrigin}/${deployment}`,
      });

    const sub = await submit("broken");
    expect(sub.json().contractCall).toMatchObject({ methodName: "submit", args: { milestone_id: "api", artifact_hash: "commit-broken" } });

    const queued = await client.post(`/v1/jobs/${id}/milestones/api/verifications`);
    expect([queued.statusCode, queued.json().status]).toEqual([202, "QUEUED"]);
    const again = await worker.post(`/v1/jobs/${id}/milestones/api/verifications`);
    expect(again.json().error.code).toBe("IN_FLIGHT");

    expect(await h.runVerifier()).toBe(1);
    const failed = (await client.get(`/v1/verifications/${queued.json().id}`)).json();
    expect(failed).toMatchObject({ status: "DONE", outcome: "FAIL", error: null });
    expect(failed.contractCall).toMatchObject({ methodName: "record_verification", args: { report: { outcome: "Fail", submission_seq: 1 } } });
    const evidence = (await client.get(`/v1/verifications/${queued.json().id}/evidence`)).json();
    expect(evidence.matchesReport).toBe(true);
    expect(evidence.evidence.checks.find((c: { ok: boolean }) => !c.ok).check).toBe('$.status == "ok"');

    let job = (await client.get(`/v1/jobs/${id}`)).json().job;
    expect(job.state.milestones[0]).toMatchObject({ status: "PENDING", allocation: null });

    await submit("fixed");
    const pass = await worker.post(`/v1/jobs/${id}/milestones/api/verifications`);
    await h.runVerifier();
    expect((await worker.get(`/v1/verifications/${pass.json().id}`)).json()).toMatchObject({ outcome: "PASS", submissionSeq: 2 });
    job = (await client.get(`/v1/jobs/${id}`)).json().job;
    expect(job.state.milestones[0].status).toBe("VERIFIED_PENDING_CHALLENGE");
  });

  it("rejects verification for milestones that are not submitted or not automated", async () => {
    const { client, worker, id } = await fundedJob();
    expect((await client.post(`/v1/jobs/${id}/milestones/api/verifications`)).json().error.code).toBe("INVALID_TRANSITION");
    await worker.post(`/v1/jobs/${id}/actions`, { type: "SUBMIT", milestoneId: "design", artifactHash: "d1" });
    expect((await client.post(`/v1/jobs/${id}/milestones/design/verifications`)).json().error.code).toBe("INVALID_TRANSITION");
  });
});

describe("human review and settlement", () => {
  it("runs revision, a mutual partial settlement, and mirrors the onchain payout", async () => {
    const { client, worker, id } = await fundedJob();
    const act = (who: typeof client, body: object) => who.post(`/v1/jobs/${id}/actions`, { milestoneId: "design", ...body });

    await act(worker, { type: "SUBMIT", artifactHash: "design-v1", uri: "https://example.com/design-v1.png" });
    const revision = await act(client, { type: "REQUEST_REVISION", feedback: "Increase contrast" });
    expect(revision.json().contractCall).toMatchObject({ methodName: "request_revision", args: { feedback: "Increase contrast" } });
    await act(worker, { type: "SUBMIT", artifactHash: "design-v2" });

    const half = (BigInt(jobInput().milestones[1]!.amountYocto) / 2n).toString();
    await act(worker, { type: "PROPOSE_SETTLEMENT", workerYocto: half });
    const settled = await act(client, { type: "ACCEPT_SETTLEMENT", workerYocto: half });
    const job = settled.json().job;
    expect(job.state.milestones[1]).toMatchObject({ status: "CLAIMABLE", allocation: { workerYocto: half } });
    expect(job.calls.payout.design).toMatchObject({ methodName: "payout", deposit: "0" });

    h.chain.agreements.set(id, onchain(job.state, "Funded", ["Pending", "Paid"]));
    const synced = (await client.post(`/v1/jobs/${id}/sync`)).json();
    expect(synced.job.state.milestones[1].status).toBe("PAID");
    expect(synced.chain.divergences).toEqual([]);
  });

  it("opens a dispute that only the resolver can settle, within the agreed floor", async () => {
    const { client, worker, id } = await fundedJob();
    await worker.post(`/v1/jobs/${id}/actions`, { type: "SUBMIT", milestoneId: "design", artifactHash: "d1" });
    await client.post(`/v1/jobs/${id}/actions`, { type: "OPEN_DISPUTE", milestoneId: "design", reason: "Off brief" });
    const resolver = as(h, await login(h, config.resolverAccount));
    const tooLow = await resolver.post(`/v1/jobs/${id}/actions`, { type: "RESOLVE_DISPUTE", milestoneId: "design", workerYocto: "0" });
    expect([tooLow.statusCode, tooLow.json().error.code]).toEqual([422, "ACCOUNTING"]);
    const floor = jobInput().milestones[1]!.partialCompensation!.floorYocto;
    const ok = await resolver.post(`/v1/jobs/${id}/actions`, { type: "RESOLVE_DISPUTE", milestoneId: "design", workerYocto: floor });
    expect(ok.json().contractCall).toMatchObject({ methodName: "resolve_dispute", args: { worker_amount: floor } });
  });
});

describe("persistence and failed requests", () => {
  it("keeps jobs and their event log across an API restart", async () => {
    const { id } = await fundedJob();
    const restarted = buildApp({ db: h.db, chain: h.chain, config });
    const token = await login({ ...h, app: restarted.app }, CLIENT);
    const res = await restarted.app.inject({ method: "GET", url: `/v1/jobs/${id}/events`, headers: { authorization: `Bearer ${token}` } });
    expect(res.json().events.map((e: { type: string }) => e.type)).toEqual(["ACCEPT_TERMS", "ACCEPT_TERMS", "FUND"]);
    await restarted.app.close();
  });

  it("replays an idempotent retry instead of applying it twice", async () => {
    const { worker, id } = await fundedJob();
    const body = { type: "SUBMIT", milestoneId: "design", artifactHash: "d1" };
    const first = await worker.post(`/v1/jobs/${id}/actions`, body, { "idempotency-key": "submit-design-0001" });
    const retry = await worker.post(`/v1/jobs/${id}/actions`, body, { "idempotency-key": "submit-design-0001" });
    expect(retry.headers["idempotent-replay"]).toBe("true");
    expect(retry.json()).toEqual(first.json());
    expect(retry.json().job.state.milestones[1].submissionCount).toBe(1);
  });

  it("returns structured errors for bad input, unknown jobs, malformed JSON and chain outages", async () => {
    const client = as(h, await login(h, CLIENT));
    const bad = await client.post("/v1/jobs", { ...jobInput(), totalYocto: "1" });
    expect([bad.statusCode, bad.json().error.code]).toEqual([400, "VALIDATION"]);
    expect((await client.get("/v1/jobs/job_does_not_exist")).statusCode).toBe(404);
    const malformed = await h.app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { "content-type": "application/json", authorization: "Bearer x" },
      payload: "{not json",
    });
    expect(malformed.statusCode).toBe(400);

    const created = (await client.post("/v1/jobs", jobInput())).json();
    h.chain.down = true;
    const view = await client.get(`/v1/jobs/${created.id}`);
    h.chain.down = false;
    expect(view.statusCode).toBe(200);
    expect(view.json().chain).toMatchObject({ agreement: null, error: "RPC timeout" });
  });

  it("never mirrors funding from an onchain agreement whose terms differ", async () => {
    const client = as(h, await login(h, CLIENT));
    const created = (await client.post("/v1/jobs", jobInput())).json();
    const forged = onchain(created.state, "Funded", ["Pending", "Pending"]);
    forged.terms_hash = `sha256:${"0".repeat(64)}`;
    h.chain.agreements.set(created.id, forged);
    const synced = (await client.post(`/v1/jobs/${created.id}/sync`)).json();
    expect(synced.chain.termsMatch).toBe(false);
    expect(synced.job.state.status).toBe("DRAFT");
  });
});
