import { beforeEach, describe, expect, it } from "vitest";
import {
  applyEvent,
  BOUNTY_PLACEHOLDER_WORKER,
  claimBountyCall,
  computeOnchainTermsHash,
  computeTermsHash,
  createDraft,
  DomainError,
  escrowSummary,
  postBountyCall,
  toContractTerms,
  type AgreementState,
} from "../src/index.js";
import { CLIENT, NOW, resetClock, RESOLVER, run, sampleTerms, TOTAL, VERIFIER } from "./fixtures.js";

const CLAIMER = "claimer.testnet";

function bountyTerms() {
  return { ...sampleTerms(), worker: { ...BOUNTY_PLACEHOLDER_WORKER }, openBounty: true as const };
}

/** Posted onchain and mirrored: the deposit is in escrow, nobody has claimed it yet. */
function openBounty(): AgreementState {
  resetClock();
  const draft = createDraft(bountyTerms(), NOW);
  return run(draft, ["ACCEPT_TERMS", CLIENT, { termsHash: draft.termsHash }], ["FUND", CLIENT, { termsHash: draft.termsHash, amountYocto: TOTAL }]);
}

function code(f: () => unknown): string {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(DomainError);
    return (e as DomainError).code;
  }
  throw new Error("expected a DomainError");
}

describe("open bounties", () => {
  beforeEach(resetClock);

  it("is funded without a worker: OPEN, with the whole total locked", () => {
    const s = openBounty();
    expect(s.status).toBe("OPEN");
    expect(escrowSummary(s).lockedYocto).toBe(BigInt(TOTAL));
    // Nobody can work an open bounty before claiming it.
    expect(code(() => run(s, ["SUBMIT", CLIENT, { milestoneId: "api", artifactHash: "x" }]))).toBe("INVALID_TRANSITION");
  });

  it("the claimer becomes the worker and the agreed hashes stay those of the posted terms", () => {
    const s = openBounty();
    const postedOnchain = computeOnchainTermsHash(toContractTerms(s.terms));
    const claimCall = claimBountyCall(s.terms);
    expect(claimCall.args).toEqual({ agreement_id: s.terms.agreementId, terms_hash: postedOnchain });

    const claimed = run(s, ["CLAIM_BOUNTY", CLAIMER, { workerKind: "HUMAN" }]);
    expect(claimed.status).toBe("FUNDED");
    expect(claimed.terms.worker).toEqual({ kind: "HUMAN", nearAccountId: CLAIMER });
    expect(claimed.termsHash).toBe(s.termsHash);
    // What the contract stores after claim_bounty: same offchain hash, worker replaced.
    const onchain = toContractTerms(claimed.terms);
    expect(onchain.offchain_terms_hash).toBe(s.termsHash);
    expect(onchain.worker).toBe(CLAIMER);
    expect(computeOnchainTermsHash(onchain)).not.toBe(postedOnchain);
    // The claim call is the same before and after: it always names the posted terms.
    expect(claimBountyCall(claimed.terms)).toEqual(claimCall);

    const submitted = run(claimed, ["SUBMIT", CLAIMER, { milestoneId: "api", artifactHash: "c1" }]);
    expect(submitted.milestones[0]!.status).toBe("SUBMITTED");
    expect(code(() => run(claimed, ["CLAIM_BOUNTY", "late.testnet", { workerKind: "AGENT" }]))).toBe("INVALID_TRANSITION");
  });

  it.each([CLIENT, VERIFIER, RESOLVER])("%s cannot claim the bounty", (who) => {
    expect(code(() => run(openBounty(), ["CLAIM_BOUNTY", who, { workerKind: "AGENT" }]))).toBe("UNAUTHORIZED");
  });

  it("closes claims at the deadline", () => {
    const s = openBounty();
    const late = { type: "CLAIM_BOUNTY", actor: CLAIMER, at: s.terms.fundingDeadline + 1, workerKind: "AGENT" };
    expect(code(() => applyEvent(s, late))).toBe("DEADLINE");
  });

  it("only the client cancels, only while unclaimed, and a cancelled bounty holds nothing", () => {
    const s = openBounty();
    expect(code(() => run(s, ["CANCEL_BOUNTY", CLAIMER]))).toBe("UNAUTHORIZED");
    const cancelled = run(s, ["CANCEL_BOUNTY", CLIENT]);
    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.fundedYocto).toBe("0");
    expect(code(() => run(cancelled, ["CLAIM_BOUNTY", CLAIMER, { workerKind: "AGENT" }]))).toBe("INVALID_TRANSITION");
    const claimed = run(s, ["CLAIM_BOUNTY", CLAIMER, { workerKind: "AGENT" }]);
    expect(code(() => run(claimed, ["CANCEL_BOUNTY", CLIENT]))).toBe("INVALID_TRANSITION");
  });

  it("posting deposits the total plus refundable storage, and the placeholder is reserved for bounties", () => {
    const s = openBounty();
    expect(BigInt(postBountyCall(s.terms).deposit)).toBeGreaterThan(BigInt(TOTAL));
    expect(postBountyCall(s.terms).args).toEqual({ terms: toContractTerms(s.terms) });
    expect(code(() => createDraft({ ...sampleTerms(), worker: { ...BOUNTY_PLACEHOLDER_WORKER } }, NOW))).toBe("VALIDATION");
    // A bounty's hash differs from the same terms without the flag, so the two can never be confused.
    const { openBounty: _flag, ...plain } = bountyTerms();
    expect(computeTermsHash(createDraft(bountyTerms(), NOW).terms)).not.toBe(computeTermsHash({ ...plain, worker: sampleTerms().worker } as never));
  });
});
