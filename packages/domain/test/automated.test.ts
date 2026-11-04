import { beforeEach, describe, expect, it } from "vitest";
import {
  confirmPayout,
  escrowSummary,
  publicKeyFromSeed,
  signReport,
  type AgreementState,
  type VerificationReport,
} from "../src/index.js";
import {
  advance,
  API_AMOUNT,
  CLIENT,
  ESCROW,
  expectCode,
  fundedAgreement,
  HOUR,
  milestone,
  OTHER_SEED,
  RESOLVER,
  run,
  signed,
  unsignedReport,
  VERIFIER_SEED,
  WORKER,
} from "./fixtures.js";

const submit = (s: AgreementState, commit: string) => run(s, ["SUBMIT", WORKER, { milestoneId: "api", artifactHash: commit }]);

// Reports are authenticated by signature, so any account may relay them; the worker does here.
const record = (s: AgreementState, fields: { report: VerificationReport; signature: string }) =>
  run(s, ["RECORD_VERIFICATION", WORKER, { milestoneId: "api", ...fields }]);

const verify = (s: AgreementState, overrides: Partial<VerificationReport> = {}, seed = VERIFIER_SEED) =>
  record(s, signed(s, overrides, seed));

describe("automated API milestone", () => {
  let funded: AgreementState;
  beforeEach(() => {
    funded = fundedAgreement();
  });

  it("pays nothing on FAIL, then pays exactly the milestone after PASS and the challenge window", () => {
    let s = verify(submit(funded, "commit-bad"), { outcome: "FAIL" });
    expect(milestone(s, "api")).toMatchObject({ status: "PENDING", allocation: null, submission: null });
    expect(escrowSummary(s).claimableWorkerYocto).toBe(0n);

    s = submit(s, "commit-good");
    expect(milestone(s, "api").submission?.seq).toBe(2);
    s = verify(s);
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
    const s = verify(submit(funded, "commit-1"), { outcome });
    expect(milestone(s, "api")).toMatchObject({ status: "SUBMITTED", allocation: null });
    // A fresh run against the same submission may still pass.
    expect(milestone(verify(s), "api").status).toBe("VERIFIED_PENDING_CHALLENGE");
  });

  it.each([
    ["another submission", { submissionSeq: 99 }],
    ["a different commit", { artifactHash: "commit-other" }],
    ["a changed verification plan", { planHash: `sha256:${"1".repeat(64)}` }],
    ["another agreement", { agreementId: "job_other_0001" }],
  ])("rejects a correctly signed report bound to %s", (_name, overrides) => {
    const s = submit(funded, "commit-1");
    expectCode(() => verify(s, overrides), "BINDING_MISMATCH");
  });

  it("rejects reports not signed by the agreed verifier key", () => {
    const s = submit(funded, "commit-1");
    expectCode(() => verify(s, {}, OTHER_SEED), "INVALID_SIGNATURE");

    const { report, signature } = signed(s, { outcome: "FAIL" });
    expectCode(() => record(s, { report: { ...report, outcome: "PASS" }, signature }), "INVALID_SIGNATURE");

    // A signature for another escrow deployment does not transfer.
    const r = unsignedReport(s);
    expectCode(() => record(s, { report: r, signature: signReport("other-escrow.testnet", r, VERIFIER_SEED) }), "INVALID_SIGNATURE");
  });

  it("rejects replayed reports", () => {
    let s = submit(funded, "commit-bad");
    const stalePass = signed(s, { nonce: "nonce-stale-pass-01" });
    s = verify(s, { outcome: "FAIL" });
    s = submit(s, "commit-good");
    // A PASS signed for submission 1 cannot pay submission 2.
    expectCode(() => record(s, stalePass), "BINDING_MISMATCH");

    const inconclusive = signed(s, { outcome: "INCONCLUSIVE", nonce: "nonce-inconclusive-1" });
    s = record(s, inconclusive);
    expectCode(() => record(s, inconclusive), "REPLAY");
  });

  it("rejects an expired report", () => {
    const s = submit(funded, "commit-1");
    expectCode(() => verify(s, { expiresAt: 0 }), "DEADLINE");
  });

  it("lets the client challenge a PASS inside the window and the resolver decide", () => {
    let s = verify(submit(funded, "commit-1"));
    s = run(s, ["CHALLENGE", CLIENT, { milestoneId: "api", reason: "endpoint returns stale data" }]);
    expect(milestone(s, "api").status).toBe("DISPUTED");
    expectCode(() => run(s, ["RESOLVE_DISPUTE", CLIENT, { milestoneId: "api", workerYocto: "0" }]), "UNAUTHORIZED");
    s = run(s, ["RESOLVE_DISPUTE", RESOLVER, { milestoneId: "api", workerYocto: API_AMOUNT }]);
    expect(milestone(s, "api").allocation?.workerYocto).toBe(API_AMOUNT);
  });

  it("does not accept a challenge after the window closes", () => {
    const s = verify(submit(funded, "commit-1"));
    advance(HOUR);
    expectCode(() => run(s, ["CHALLENGE", CLIENT, { milestoneId: "api", reason: "late" }]), "DEADLINE");
  });

  it("prevents double payout and restores the claim if the transfer fails", () => {
    let s = verify(submit(funded, "commit-1"));
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
    const s = submit(funded, "commit-1");
    expectCode(() => run(s, ["APPROVE", CLIENT, { milestoneId: "api" }]), "INVALID_TRANSITION");
  });
});

describe("report signing format", () => {
  // Shared with contracts/escrow/src/tests.rs (`signing_vector_matches_domain`): the contract must
  // verify this signature over its own borsh encoding, which proves both sides sign identical bytes.
  it("produces the pinned cross-language test vector", () => {
    const report: VerificationReport = {
      agreementId: "job_demo_0001",
      milestoneId: "api",
      submissionSeq: 2,
      artifactHash: "commit-good",
      planHash: `sha256:${"a".repeat(64)}`,
      outcome: "PASS",
      evidenceDigest: `sha256:${"e".repeat(64)}`,
      nonce: "nonce-vector-000001",
      issuedAt: 1_800_000_000_000,
      expiresAt: 1_802_592_000_000,
    };
    expect(publicKeyFromSeed(VERIFIER_SEED)).toBe("d04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737");
    expect(signReport(ESCROW, report, VERIFIER_SEED)).toBe(
      "1baab16ab1bc2c385d624804c1a8abc0b67205e03953edeb9e625f03f4a4d948ec86154406aba6dbdee58960994cb5ba2835d6d620a6185029ad775c81b8e403",
    );
  });
});
