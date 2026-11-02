import { beforeEach, describe, expect, it } from "vitest";
import { confirmPayout, escrowSummary, type AgreementState } from "../src/index.js";
import {
  advance,
  API_AMOUNT,
  CLIENT,
  expectCode,
  fundedAgreement,
  HOUR,
  milestone,
  report,
  RESOLVER,
  run,
  VERIFIER,
  WORKER,
} from "./fixtures.js";

const submit = (s: AgreementState, submissionId: string, commit: string) =>
  run(s, ["SUBMIT", WORKER, { milestoneId: "api", submissionId, artifactHash: commit }]);

const verify = (s: AgreementState, overrides: Parameters<typeof report>[1] = {}, actor = VERIFIER) =>
  run(s, ["RECORD_VERIFICATION", actor, { milestoneId: "api", report: report(s, overrides) }]);

describe("automated API milestone", () => {
  let funded: AgreementState;
  beforeEach(() => {
    funded = fundedAgreement();
  });

  it("pays nothing on FAIL, then pays exactly the milestone after PASS and the challenge window", () => {
    let s = verify(submit(funded, "sub-1", "commit-bad"), { outcome: "FAIL" });
    expect(milestone(s, "api")).toMatchObject({ status: "PENDING", allocation: null, submission: null });
    expect(escrowSummary(s).claimableWorkerYocto).toBe(0n);

    s = verify(submit(s, "sub-2", "commit-good"));
    expect(milestone(s, "api").status).toBe("VERIFIED_PENDING_CHALLENGE");
    expectCode(() => run(s, ["FINALIZE_CHALLENGE", WORKER, { milestoneId: "api" }]), "DEADLINE");

    advance(HOUR);
    s = run(s, ["FINALIZE_CHALLENGE", WORKER, { milestoneId: "api" }]);
    expect(milestone(s, "api").allocation).toEqual({ workerYocto: API_AMOUNT, clientYocto: "0" });

    s = run(s, ["START_PAYOUT", WORKER, { milestoneId: "api" }]);
    expect(escrowSummary(s).pendingPayoutYocto).toBe(BigInt(API_AMOUNT));
    s = confirmPayout(s, "api", true);
    expect(escrowSummary(s).paidWorkerYocto).toBe(BigInt(API_AMOUNT));
  });

  it.each(["INCONCLUSIVE", "RUNNER_ERROR"] as const)("fails closed on %s: stays submitted, nothing allocated", (outcome) => {
    const s = verify(submit(funded, "sub-1", "commit-1"), { outcome });
    expect(milestone(s, "api")).toMatchObject({ status: "SUBMITTED", allocation: null });
    // A fresh run against the same submission may still pass.
    expect(milestone(verify(s), "api").status).toBe("VERIFIED_PENDING_CHALLENGE");
  });

  it.each([
    ["another submission", { submissionId: "sub-other" }],
    ["a different commit", { artifactHash: "commit-other" }],
    ["a changed verification plan", { planHash: `sha256:${"1".repeat(64)}` }],
    ["another agreement", { agreementId: "job_other_0001" }],
    ["a different verifier identity", { verifierId: "someone.testnet" }],
  ])("rejects a report bound to %s", (_name, overrides) => {
    const s = submit(funded, "sub-1", "commit-1");
    expectCode(() => verify(s, overrides), "BINDING_MISMATCH");
  });

  it("rejects a worker spoofing the verifier", () => {
    const s = submit(funded, "sub-1", "commit-1");
    expectCode(() => verify(s, { verifierId: WORKER }, WORKER), "UNAUTHORIZED");
  });

  it("rejects replayed report nonces and reused submission ids", () => {
    let s = verify(submit(funded, "sub-1", "commit-1"), { outcome: "FAIL", nonce: "nonce-replay-000001" });
    expectCode(() => submit(s, "sub-1", "commit-2"), "REPLAY");
    s = submit(s, "sub-2", "commit-2");
    expectCode(() => verify(s, { nonce: "nonce-replay-000001" }), "REPLAY");
  });

  it("rejects an expired report", () => {
    const s = submit(funded, "sub-1", "commit-1");
    expectCode(() => verify(s, { expiresAt: 0 }), "DEADLINE");
  });

  it("lets the client challenge a PASS inside the window and the resolver decide", () => {
    let s = verify(submit(funded, "sub-1", "commit-1"));
    s = run(s, ["CHALLENGE", CLIENT, { milestoneId: "api", reason: "endpoint returns stale data" }]);
    expect(milestone(s, "api").status).toBe("DISPUTED");
    expectCode(() => run(s, ["RESOLVE_DISPUTE", CLIENT, { milestoneId: "api", workerYocto: "0" }]), "UNAUTHORIZED");
    s = run(s, ["RESOLVE_DISPUTE", RESOLVER, { milestoneId: "api", workerYocto: API_AMOUNT }]);
    expect(milestone(s, "api").allocation?.workerYocto).toBe(API_AMOUNT);
  });

  it("does not accept a challenge after the window closes", () => {
    const s = verify(submit(funded, "sub-1", "commit-1"));
    advance(HOUR);
    expectCode(() => run(s, ["CHALLENGE", CLIENT, { milestoneId: "api", reason: "late" }]), "DEADLINE");
  });

  it("prevents double payout and restores the claim if the transfer fails", () => {
    let s = verify(submit(funded, "sub-1", "commit-1"));
    advance(HOUR);
    s = run(s, ["FINALIZE_CHALLENGE", CLIENT, { milestoneId: "api" }], ["START_PAYOUT", WORKER, { milestoneId: "api" }]);
    expectCode(() => run(s, ["START_PAYOUT", WORKER, { milestoneId: "api" }]), "INVALID_TRANSITION");

    s = confirmPayout(s, "api", false);
    expect(milestone(s, "api")).toMatchObject({ status: "CLAIMABLE", allocation: { workerYocto: API_AMOUNT } });
    s = confirmPayout(run(s, ["START_PAYOUT", WORKER, { milestoneId: "api" }]), "api", true);
    expectCode(() => confirmPayout(s, "api", true), "INVALID_TRANSITION");
    expectCode(() => run(s, ["START_PAYOUT", WORKER, { milestoneId: "api" }]), "INVALID_TRANSITION");
  });

  it("rejects human-review actions on an automated milestone", () => {
    const s = submit(funded, "sub-1", "commit-1");
    expectCode(() => run(s, ["APPROVE", CLIENT, { milestoneId: "api" }]), "INVALID_TRANSITION");
  });
});
