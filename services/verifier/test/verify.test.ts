import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyEvent,
  createDraft,
  escrowSummary,
  publicKeyFromSeed,
  verifyReportSignature,
  type AgreementState,
} from "@settle/domain";
import { evidenceMatchesReport, verifySubmission } from "../src/index.js";
import { PLAN, startFixture, type Fixture } from "./fixture-server.js";

const NOW = Date.now();
const ESCROW = "settle-escrow.testnet";
const SEED = "33".repeat(32); // test-only key
const CLIENT = "client.testnet";
const WORKER = "worker.testnet";

let fx: Fixture;
beforeAll(async () => {
  fx = await startFixture();
});
afterAll(() => fx.close());

/** A funded one-milestone agreement whose locked plan is the fixture plan. */
function fundedAgreement(): AgreementState {
  const draft = createDraft(
    {
      schemaVersion: 1,
      agreementId: "job_verify_0001",
      client: { kind: "HUMAN", nearAccountId: CLIENT },
      worker: { kind: "AGENT", nearAccountId: WORKER },
      escrowContract: ESCROW,
      verifierAuthority: "verifier.testnet",
      verifierPublicKey: publicKeyFromSeed(SEED),
      disputeResolver: "resolver.testnet",
      asset: "NEAR",
      totalYocto: "1000",
      milestones: [{ id: "api", title: "Health endpoint", type: "AUTOMATED", amountYocto: "1000", verificationPlan: PLAN }],
      challengePeriodSec: 3600,
      fundingDeadline: NOW + 60_000,
      expiresAt: NOW + 86_400_000,
    },
    NOW,
  );
  let s = applyEvent(draft, { type: "ACCEPT_TERMS", actor: CLIENT, at: NOW + 1, termsHash: draft.termsHash });
  s = applyEvent(s, { type: "ACCEPT_TERMS", actor: WORKER, at: NOW + 2, termsHash: draft.termsHash });
  return applyEvent(s, { type: "FUND", actor: CLIENT, at: NOW + 3, termsHash: draft.termsHash, amountYocto: "1000" });
}

/** Worker submits a deployment, the verifier checks it, and anyone relays the signed report. */
async function submitAndVerify(s: AgreementState, deployment: string, at: number) {
  s = applyEvent(s, { type: "SUBMIT", actor: WORKER, at, milestoneId: "api", artifactHash: `commit-${deployment}` });
  const sub = s.milestones[0]!.submission!;
  const plan = s.terms.milestones[0]!.type === "AUTOMATED" ? s.terms.milestones[0]!.verificationPlan : PLAN;
  const signed = await verifySubmission(
    {
      escrowContract: ESCROW,
      agreementId: s.terms.agreementId,
      milestoneId: "api",
      plan,
      submission: { seq: sub.seq, artifactHash: sub.artifactHash, uri: `${fx.origin}/${deployment}` },
    },
    { seedHex: SEED, policy: fx.policy, now: () => at + 1 },
  );
  const next = applyEvent(s, {
    type: "RECORD_VERIFICATION",
    actor: WORKER,
    at: at + 2,
    milestoneId: "api",
    report: signed.report,
    signature: signed.signature,
  });
  return { s: next, signed };
}

describe("verifier end to end with the agreement engine", () => {
  it("a genuine failure pays nothing; a genuine pass moves to the challenge window", async () => {
    let { s, signed } = await submitAndVerify(fundedAgreement(), "wrong-value", NOW + 10);
    expect(signed.report.outcome).toBe("FAIL");
    expect(s.milestones[0]!.status).toBe("PENDING");
    expect(escrowSummary(s).claimableWorkerYocto).toBe(0n);

    ({ s, signed } = await submitAndVerify(s, "good", NOW + 20));
    expect(signed.report.outcome).toBe("PASS");
    expect(signed.report.submissionSeq).toBe(2);
    expect(s.milestones[0]!.status).toBe("VERIFIED_PENDING_CHALLENGE");
  });

  it("signs reports the contract format accepts and commits to the evidence", async () => {
    const { signed } = await submitAndVerify(fundedAgreement(), "good", NOW + 10);
    expect(verifyReportSignature(ESCROW, signed.report, signed.signature, publicKeyFromSeed(SEED))).toBe(true);
    expect(evidenceMatchesReport(signed.evidence, signed.report)).toBe(true);
    expect(signed.evidence).not.toHaveProperty("body");

    const tampered = { ...signed.evidence, status: 500 };
    expect(evidenceMatchesReport(tampered, signed.report)).toBe(false);
  });

  it("rejects a malformed verification request instead of guessing", async () => {
    await expect(verifySubmission({ escrowContract: ESCROW }, { seedHex: SEED })).rejects.toThrow();
  });
});
