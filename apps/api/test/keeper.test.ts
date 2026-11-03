import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ContractCall } from "@settle/domain";
import { JobService, Keeper, type Relayer } from "../src/index.js";
import { as, config, jobInput, login, onchainFunded, startHarness, WORKER, type Harness } from "./harness.js";

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(() => h.close());

describe("keeper: automatic record, finalize and payout", () => {
  it("sends only the step the contract is waiting for, and never before the challenge window ends", async () => {
    const client = as(h, await login(h, "client.testnet"));
    const agent = as(h, await login(h, WORKER, "AGENT"));
    const job = (await client.post("/v1/jobs", jobInput())).json();
    await agent.post(`/v1/jobs/${job.id}/actions`, { type: "ACCEPT_TERMS", termsHash: job.state.termsHash });
    const chainView = onchainFunded((await client.get(`/v1/jobs/${job.id}`)).json().job.state);
    h.chain.agreements.set(job.id, chainView);
    await client.post(`/v1/jobs/${job.id}/sync`);
    await agent.post(`/v1/jobs/${job.id}/actions`, { type: "SUBMIT", milestoneId: "api", artifactHash: "c1", uri: `${h.fixtureOrigin}/fixed` });
    await agent.post(`/v1/jobs/${job.id}/milestones/api/verifications`);
    await h.runVerifier();

    const sent: ContractCall[] = [];
    const relayer: Relayer = { accountId: config.verifierAccount, send: async (c) => (sent.push(c), `tx-${sent.length}`) };
    const log = { info: () => undefined, warn: () => undefined };
    let now = Date.now();
    const keeper = new Keeper(h.db, new JobService(h.db, h.chain, config, () => now), h.chain, relayer, config, log, () => now);
    const api = chainView.milestones[0]!;

    // The contract still waits for the result of submission 1: record the signed report.
    api.status = "Submitted";
    api.submission = { seq: 1, artifact_hash: "c1", submitted_at_ms: now };
    expect(await keeper.tick(job.id)).toBe(1);
    expect(sent.at(-1)).toMatchObject({ methodName: "record_verification", args: { report: { outcome: "Pass", submission_seq: 1 } } });

    // PASS recorded, challenge window still open: nothing to do.
    api.status = "VerifiedPendingChallenge";
    api.challenge_ends_at_ms = now + 60 * 60_000;
    expect(await keeper.tick(job.id)).toBe(0);

    // After the window (onchain and offchain): finalize, and mirror it offchain.
    now += 2 * 60 * 60_000;
    api.challenge_ends_at_ms = now - 1000;
    expect(await keeper.tick(job.id)).toBe(1);
    expect(sent.at(-1)).toMatchObject({ methodName: "finalize_challenge", args: { milestone_id: "api" } });
    expect((await client.get(`/v1/jobs/${job.id}`)).json().job.state.milestones[0].status).toBe("CLAIMABLE");

    // Claimable onchain: trigger the fixed payout.
    api.status = "Claimable";
    expect(await keeper.tick(job.id)).toBe(1);
    expect(sent.at(-1)).toMatchObject({ methodName: "payout", args: { milestone_id: "api" }, deposit: "0" });

    // A human-review milestone waiting on the client is never touched.
    expect(sent.filter((c) => (c.args as { milestone_id?: string }).milestone_id === "design")).toHaveLength(0);
  });
});
