import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { as, CLIENT, login, NEAR, onchainFunded, startHarness, WORKER, type Harness } from "./harness.js";

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(() => h.close());

const PLAN = { kind: "CONTENT_RULES", version: 1, format: "markdown", maxBytes: 4000, minWords: 8, mustInclude: ["wallet"], minHeadings: 1 };

async function fundedContentJob() {
  const client = as(h, await login(h, CLIENT));
  const worker = as(h, await login(h, WORKER, "AGENT"));
  const amount = (NEAR * 2n) / 100n;
  const created = await client.post("/v1/jobs", {
    worker: { kind: "AGENT", nearAccountId: WORKER },
    totalYocto: amount.toString(),
    milestones: [{ id: "guide", title: "A short claim guide", type: "AUTOMATED", amountYocto: amount.toString(), verificationPlan: PLAN }],
    challengePeriodSec: 120,
    fundingDeadline: Date.now() + 86_400_000,
    expiresAt: Date.now() + 7 * 86_400_000,
  });
  expect(created.statusCode).toBe(201);
  const id: string = created.json().id;
  const accepted = await worker.post(`/v1/jobs/${id}/actions`, { type: "ACCEPT_TERMS", termsHash: created.json().state.termsHash });
  h.chain.agreements.set(id, onchainFunded(accepted.json().job.state));
  expect((await client.post(`/v1/jobs/${id}/sync`)).json().job.state.status).toBe("FUNDED");
  return { client, worker, id };
}

describe("auto-checked written work (CONTENT_RULES)", () => {
  it("rejects contradictory rules when the agreement is created", async () => {
    const client = as(h, await login(h, CLIENT));
    const bad = await client.post("/v1/jobs", {
      worker: { kind: "AGENT", nearAccountId: WORKER },
      totalYocto: "1",
      milestones: [{ id: "x", title: "x", type: "AUTOMATED", amountYocto: "1", verificationPlan: { ...PLAN, minWords: 50, maxWords: 10 } }],
      challengePeriodSec: 120,
      fundingDeadline: Date.now() + 86_400_000,
      expiresAt: Date.now() + 7 * 86_400_000,
    });
    expect(bad.statusCode).toBe(400);
  });

  it("FAILs a delivery that breaks a rule, then PASSes a corrected one, read from SETTLE's store", async () => {
    const { client, worker, id } = await fundedContentJob();
    const deliver = async (content: string) => {
      const d = (await worker.post("/v1/deliverables", { content, jobId: id })).json();
      expect((await worker.post(`/v1/jobs/${id}/actions`, { type: "SUBMIT", milestoneId: "guide", artifactHash: d.hash, uri: `https://settle.invalid${d.url}` })).statusCode).toBe(200);
      const v = (await worker.post(`/v1/jobs/${id}/milestones/guide/verifications`)).json();
      expect(await h.runVerifier()).toBe(1);
      return (await client.get(`/v1/verifications/${v.id}`)).json();
    };

    // Too short and never mentions the wallet: FAIL, and the money stays in escrow.
    const first = await deliver("# Claim\nOpen Bounties.");
    expect(first).toMatchObject({ status: "DONE", outcome: "FAIL" });
    expect((await client.get(`/v1/jobs/${id}`)).json().job.state.milestones[0]).toMatchObject({ status: "PENDING", allocation: null });

    // The URL host is unreachable on purpose: the bytes come from the store, keyed by their hash.
    const second = await deliver("# Claim a bounty\n1. Open Bounties and pick one.\n2. Claim it and approve in your wallet.");
    expect(second).toMatchObject({ outcome: "PASS", submissionSeq: 2 });
    const evidence = (await client.get(`/v1/verifications/${second.id}/evidence`)).json();
    expect(evidence.matchesReport).toBe(true);
    expect(evidence.evidence.content).toEqual({ source: "settle-store" });
    expect((await client.get(`/v1/jobs/${id}`)).json().job.state.milestones[0].status).toBe("VERIFIED_PENDING_CHALLENGE");
  });
});
