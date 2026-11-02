import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KeyPair } from "near-api-js";
import { computeOnchainTermsHash, toContractTerms } from "@settle/domain";
import { as, CLIENT, jobInput, login, startHarness, WORKER, type Harness } from "../../../apps/api/test/harness.js";
import { SettleAgent, SettleApiError, type ContractCall } from "../src/index.js";

let h: Harness;
let apiUrl: string;
beforeAll(async () => {
  h = await startHarness();
  await h.app.listen({ port: 0, host: "127.0.0.1" });
  apiUrl = `http://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
});
afterAll(() => h.close());

describe("agent SDK against the real API", () => {
  it("drives the same workflow as a human: login, accept, submit, verify FAIL then PASS, relay reports", async () => {
    const key = KeyPair.fromRandom("ed25519");
    h.chain.keys.set(key.getPublicKey().toString(), { accountId: WORKER, permission: "FullAccess" });
    const sent: ContractCall[] = [];
    // Onchain execution is exercised by the contract sandbox tests; here we capture what would be signed.
    const agent = await SettleAgent.connect({
      apiUrl,
      accountId: WORKER,
      privateKey: key.toString() as `ed25519:${string}`,
      executor: { execute: async (call) => (sent.push(call), `tx-${sent.length}`) },
    });

    const client = as(h, await login(h, CLIENT));
    const created = (await client.post("/v1/jobs", jobInput())).json();
    const accepted = await agent.actOnChain(created.id, { type: "ACCEPT_TERMS", termsHash: created.state.termsHash });
    expect(accepted.txHash).toBe("tx-1");
    expect(sent[0]).toMatchObject({
      methodName: "accept_terms",
      args: { terms_hash: computeOnchainTermsHash(toContractTerms(created.state.terms)) },
    });

    await expect(agent.act(created.id, { type: "APPROVE", milestoneId: "design" })).rejects.toMatchObject({ code: "INVALID_TRANSITION" });

    // The client funds onchain; the contract now reports Funded.
    const terms = toContractTerms(created.state.terms);
    h.chain.agreements.set(created.id, {
      terms,
      terms_hash: computeOnchainTermsHash(terms),
      status: "Funded",
      accepted_by_worker: true,
      funded_at_ms: Date.now(),
      milestones: terms.milestones.map(() => ({
        status: "Pending",
        submission: null,
        submission_count: 0,
        allocated: false,
        worker: { due: "0", pending: "0", paid: "0" },
        client: { due: "0", pending: "0", paid: "0" },
      })),
    });
    expect(((await agent.sync(created.id)).job as { state: { status: string } }).state.status).toBe("FUNDED");

    const outcomes: string[] = [];
    for (const deployment of ["broken", "fixed"]) {
      await agent.actOnChain(created.id, { type: "SUBMIT", milestoneId: "api", artifactHash: `c-${deployment}`, uri: `${h.fixtureOrigin}/${deployment}` });
      const queued = await agent.requestVerification(created.id, "api");
      await h.runVerifier();
      const done = await agent.waitForVerification(queued.id, { timeoutMs: 5000 });
      outcomes.push(done.outcome!);
      await agent.execute(done.contractCall!);
    }
    expect(outcomes).toEqual(["FAIL", "PASS"]);
    expect(sent.map((c) => c.methodName)).toEqual(["accept_terms", "submit", "record_verification", "submit", "record_verification"]);
    expect((await agent.getJob(created.id)).job.state.milestones[0]!.status).toBe("VERIFIED_PENDING_CHALLENGE");
  });

  it("surfaces API errors with their codes", async () => {
    const key = KeyPair.fromRandom("ed25519");
    // The key is not registered on the account, so login must fail.
    await expect(
      SettleAgent.connect({ apiUrl, accountId: WORKER, privateKey: key.toString() as `ed25519:${string}`, executor: { execute: async () => "" } }),
    ).rejects.toBeInstanceOf(SettleApiError);
  });
});
