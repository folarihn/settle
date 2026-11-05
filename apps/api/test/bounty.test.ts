import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeOnchainTermsHash, toContractTerms, type AgreementState, type ContractAgreement } from "@settle/domain";
import { as, CLIENT, jobInput, login, startHarness, type Harness } from "./harness.js";

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(() => h.close());

const CLAIMER = "claimer.testnet";

function bountyInput() {
  const { worker: _worker, ...rest } = jobInput();
  return { ...rest, openBounty: true };
}

/** What the contract holds after post_bounty, and after claim_bounty by `claimer`. */
function onchain(state: AgreementState, status: ContractAgreement["status"], claimer?: string): ContractAgreement {
  const terms = toContractTerms(claimer ? { ...state.terms, worker: { kind: "AGENT", nearAccountId: claimer } } : state.terms);
  return {
    terms,
    terms_hash: computeOnchainTermsHash(terms),
    status,
    accepted_by_worker: !!claimer,
    funded_at_ms: claimer ? Date.now() : null,
    milestones: terms.milestones.map(() => ({
      status: "Pending",
      submission: null,
      submission_count: 0,
      allocated: false,
      worker: { due: "0", pending: "0", paid: "0" },
      client: { due: "0", pending: "0", paid: "0" },
    })),
  };
}

async function postedBounty() {
  const client = as(h, await login(h, CLIENT));
  const created = await client.post("/v1/jobs", bountyInput());
  expect(created.statusCode).toBe(201);
  const job = created.json();
  h.chain.agreements.set(job.id, onchain(job.state, "Open"));
  const synced = (await client.post(`/v1/jobs/${job.id}/sync`)).json();
  expect(synced.job.state.status).toBe("OPEN");
  return { client, job: synced.job };
}

describe("open bounties", () => {
  it("must either name a worker or be an open bounty, and posting deposits the total up front", async () => {
    const client = as(h, await login(h, CLIENT));
    expect((await client.post("/v1/jobs", { ...jobInput(), openBounty: true })).statusCode).toBe(400);
    expect((await client.post("/v1/jobs", bountyInput())).statusCode).toBe(201);
    const { worker: _w, ...noWorker } = jobInput();
    expect((await client.post("/v1/jobs", noWorker)).statusCode).toBe(400);

    const job = (await client.post("/v1/jobs", bountyInput())).json();
    expect(job.state.terms.worker.nearAccountId).toBe("open-bounty");
    expect(job.calls.createAgreement).toBeUndefined();
    expect(job.calls.postBounty).toMatchObject({ methodName: "post_bounty" });
    expect(BigInt(job.calls.postBounty.deposit)).toBeGreaterThan(BigInt(job.state.terms.totalYocto));
    // Not on the board, and private, until it is funded onchain.
    const stranger = as(h, await login(h, "someone.testnet"));
    expect((await stranger.get(`/v1/jobs/${job.id}`)).statusCode).toBe(404);
    expect((await stranger.get("/v1/bounties")).json().bounties.map((b: { id: string }) => b.id)).not.toContain(job.id);
  });

  it("is listed and readable by anyone once funded; the chain decides who claimed it", async () => {
    const { client, job } = await postedBounty();
    const claimer = as(h, await login(h, CLAIMER, "HUMAN"));
    const board = (await claimer.get("/v1/bounties")).json().bounties;
    expect(board.map((b: { id: string }) => b.id)).toContain(job.id);
    const seen = (await claimer.get(`/v1/jobs/${job.id}`)).json().job;
    expect(seen.roles).toEqual([]);
    expect(seen.calls.claimBounty).toMatchObject({ methodName: "claim_bounty", args: { agreement_id: job.id } });
    expect((await client.get(`/v1/jobs/${job.id}`)).json().job.calls.cancelBounty).toMatchObject({ methodName: "cancel_bounty" });

    // Claiming is chain-only: the API cannot be told who won.
    expect((await claimer.post(`/v1/jobs/${job.id}/actions`, { type: "CLAIM_BOUNTY", workerKind: "HUMAN" })).statusCode).toBe(404);

    // A chain record that does not match the posted terms is not mirrored as a claim.
    const forged = onchain(job.state, "Funded", CLAIMER);
    h.chain.agreements.set(job.id, { ...forged, terms_hash: `sha256:${"0".repeat(64)}` });
    expect((await claimer.post(`/v1/jobs/${job.id}/sync`)).json().job.state.status).toBe("OPEN");

    h.chain.agreements.set(job.id, forged);
    const claimed = (await claimer.post(`/v1/jobs/${job.id}/sync`)).json().job;
    expect(claimed.state.status).toBe("FUNDED");
    expect(claimed.state.terms.worker).toEqual({ kind: "HUMAN", nearAccountId: CLAIMER });
    expect(claimed.roles).toEqual(["worker"]);
    expect((await claimer.get("/v1/jobs")).json().jobs.map((j: { id: string }) => j.id)).toContain(job.id);
    expect((await claimer.get("/v1/bounties")).json().bounties.map((b: { id: string }) => b.id)).not.toContain(job.id);
    expect((await claimer.post(`/v1/jobs/${job.id}/actions`, { type: "SUBMIT", milestoneId: "api", artifactHash: "c1", uri: "https://x.example" })).statusCode).toBe(200);

    // Still public to read (ADR 0007), but only its parties can act on it.
    const other = as(h, await login(h, "other.testnet"));
    const read = await other.get(`/v1/jobs/${job.id}`);
    expect([read.statusCode, read.json().job.roles]).toEqual([200, []]);
    expect((await other.post(`/v1/jobs/${job.id}/actions`, { type: "APPROVE", milestoneId: "api" })).statusCode).toBe(404);
  });

  it("is readable without signing in for its whole life, but never actionable", async () => {
    const anon = (method: "GET" | "POST", url: string, payload?: object) => h.app.inject({ method, url, ...(payload ? { payload } : {}) });
    // A draft bounty (not yet posted onchain) and a direct agreement stay private.
    const client = as(h, await login(h, CLIENT));
    const draft = (await client.post("/v1/jobs", bountyInput())).json();
    expect((await anon("GET", `/v1/jobs/${draft.id}`)).statusCode).toBe(404);
    const direct = (await client.post("/v1/jobs", jobInput())).json();
    expect((await anon("GET", `/v1/jobs/${direct.id}`)).statusCode).toBe(404);
    expect((await anon("GET", `/v1/jobs/${direct.id}/events`)).statusCode).toBe(404);
    expect((await anon("GET", `/v1/jobs/${direct.id}/verifications`)).statusCode).toBe(404);

    const { job } = await postedBounty();
    expect((await anon("GET", "/v1/bounties")).json().bounties.map((b: { id: string }) => b.id)).toContain(job.id);
    const seen = await anon("GET", `/v1/jobs/${job.id}`);
    expect([seen.statusCode, seen.json().job.roles]).toEqual([200, []]);
    expect((await anon("GET", `/v1/jobs/${job.id}/events`)).statusCode).toBe(200);
    expect((await anon("GET", `/v1/jobs/${job.id}/reviews`)).statusCode).toBe(200);

    // Claimed: off the open board, still on the public record and readable.
    h.chain.agreements.set(job.id, onchain(job.state, "Funded", CLAIMER));
    await client.post(`/v1/jobs/${job.id}/sync`);
    expect((await anon("GET", "/v1/bounties")).json().bounties.map((b: { id: string }) => b.id)).not.toContain(job.id);
    const all = (await anon("GET", "/v1/bounties?scope=all")).json().bounties.map((b: { id: string }) => b.id);
    expect(all).toContain(job.id);
    expect(all).not.toContain(draft.id);
    expect(all).not.toContain(direct.id);
    expect((await anon("GET", `/v1/jobs/${job.id}`)).json().job.state.status).toBe("FUNDED");

    // Every write still needs a session; a bad token is refused rather than treated as anonymous.
    expect((await anon("POST", `/v1/jobs/${job.id}/actions`, { type: "APPROVE", milestoneId: "api" })).statusCode).toBe(401);
    expect((await anon("POST", `/v1/jobs/${job.id}/sync`, {})).statusCode).toBe(401);
    expect((await anon("POST", "/v1/swarm/agents", { name: "x" })).statusCode).toBe(401);
    expect((await h.app.inject({ method: "GET", url: `/v1/jobs/${job.id}`, headers: { authorization: "Bearer not-a-real-session-token-xx" } })).statusCode).toBe(401);
    expect((await anon("GET", "/v1/bounties?scope=everything")).statusCode).toBe(400);
  });

  it("mirrors a cancellation, which takes it off the board", async () => {
    const { client, job } = await postedBounty();
    h.chain.agreements.set(job.id, onchain(job.state, "Cancelled"));
    const after = (await client.post(`/v1/jobs/${job.id}/sync`)).json().job;
    expect(after.state.status).toBe("CANCELLED");
    expect(after.state.fundedYocto).toBe("0");
    expect((await client.get("/v1/bounties")).json().bounties.map((b: { id: string }) => b.id)).not.toContain(job.id);
  });
});
