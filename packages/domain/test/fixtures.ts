import {
  applyEvent,
  computePlanHash,
  createDraft,
  publicKeyFromSeed,
  signReport,
  YOCTO_PER_NEAR,
  type AgreementState,
  type AutomatedMilestoneTerms,
  type VerificationReport,
} from "../src/index.js";

export const NOW = 1_800_000_000_000;
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export const CLIENT = "client.testnet";
export const WORKER = "worker.testnet";
export const VERIFIER = "verifier.testnet";
export const RESOLVER = "resolver.testnet";
export const ESCROW = "settle-escrow.testnet";

// Fixed test keys; never used outside tests.
export const VERIFIER_SEED = "11".repeat(32);
export const OTHER_SEED = "22".repeat(32);

export const API_AMOUNT = ((YOCTO_PER_NEAR * 35n) / 100n).toString(); // 0.35 NEAR (70%)
export const DESIGN_AMOUNT = ((YOCTO_PER_NEAR * 15n) / 100n).toString(); // 0.15 NEAR (30%)
export const DESIGN_FLOOR = ((YOCTO_PER_NEAR * 75n) / 1000n).toString(); // half of design
export const TOTAL = ((YOCTO_PER_NEAR * 50n) / 100n).toString();

export function sampleTerms() {
  return {
    schemaVersion: 1 as const,
    agreementId: "job_demo_0001",
    client: { kind: "HUMAN" as const, nearAccountId: CLIENT },
    worker: { kind: "AGENT" as const, nearAccountId: WORKER },
    escrowContract: ESCROW,
    verifierAuthority: VERIFIER,
    verifierPublicKey: publicKeyFromSeed(VERIFIER_SEED),
    disputeResolver: RESOLVER,
    asset: "NEAR" as const,
    totalYocto: TOTAL,
    milestones: [
      {
        id: "api",
        title: "Health endpoint contract",
        type: "AUTOMATED" as const,
        amountYocto: API_AMOUNT,
        verificationPlan: {
          kind: "HTTP_API" as const,
          version: 1 as const,
          method: "GET" as const,
          path: "/health",
          expectedStatus: 200,
          assertions: [{ op: "equals" as const, path: "$.status", value: "ok" }],
          timeoutMs: 5000,
          maxResponseBytes: 65_536,
        },
      },
      {
        id: "design",
        title: "Landing page design",
        type: "HUMAN_REVIEW" as const,
        amountYocto: DESIGN_AMOUNT,
        rubric: "Matches the brief; mobile and desktop layouts.",
        maxRevisions: 2,
        partialCompensation: { condition: "DELIVERABLE_SUBMITTED" as const, floorYocto: DESIGN_FLOOR },
      },
    ],
    challengePeriodSec: 3600,
    fundingDeadline: NOW + DAY,
    expiresAt: NOW + 14 * DAY,
  };
}

// Test clock: each event is one second after the previous; `advance` jumps forward.
let clock = NOW;
export const resetClock = () => {
  clock = NOW;
};
export const advance = (ms: number) => {
  clock += ms;
};
export const now = () => clock;

/** Apply a sequence of [type, actor, fields] events in order. */
export function run(state: AgreementState, ...events: Array<[string, string, Record<string, unknown>?]>): AgreementState {
  for (const [type, actor, fields] of events) {
    clock += 1000;
    state = applyEvent(state, { type, actor, at: clock, ...fields });
  }
  return state;
}

export function fundedAgreement(): AgreementState {
  resetClock();
  const draft = createDraft(sampleTerms(), NOW);
  return run(
    draft,
    ["ACCEPT_TERMS", CLIENT, { termsHash: draft.termsHash }],
    ["ACCEPT_TERMS", WORKER, { termsHash: draft.termsHash }],
    ["FUND", CLIENT, { termsHash: draft.termsHash, amountYocto: TOTAL }],
  );
}

let nonceCounter = 0;
export function unsignedReport(state: AgreementState, overrides: Partial<VerificationReport> = {}): VerificationReport {
  const terms = state.terms.milestones.find((m) => m.id === "api") as AutomatedMilestoneTerms;
  const m = state.milestones.find((x) => x.id === "api")!;
  nonceCounter += 1;
  return {
    agreementId: state.terms.agreementId,
    milestoneId: "api",
    submissionSeq: m.submission?.seq ?? 1,
    artifactHash: m.submission?.artifactHash ?? "none",
    planHash: computePlanHash(terms.verificationPlan),
    outcome: "PASS",
    evidenceDigest: `sha256:${"ab".repeat(32)}`,
    nonce: `nonce-${nonceCounter.toString().padStart(12, "0")}`,
    issuedAt: m.submission?.submittedAt ?? NOW,
    expiresAt: NOW + 30 * DAY,
    ...overrides,
  };
}

/** Event fields for RECORD_VERIFICATION: a report signed (by default) with the agreed verifier key. */
export function signed(state: AgreementState, overrides: Partial<VerificationReport> = {}, seed = VERIFIER_SEED) {
  const report = unsignedReport(state, overrides);
  return { report, signature: signReport(ESCROW, report, seed) };
}

export const milestone = (state: AgreementState, id: string) => state.milestones.find((m) => m.id === id)!;

export function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (e) {
    if ((e as { code?: string }).code !== code) {
      throw new Error(`expected ${code}, got ${(e as { code?: string }).code}: ${(e as Error).message}`);
    }
    return;
  }
  throw new Error(`expected ${code}, but the operation succeeded`);
}
