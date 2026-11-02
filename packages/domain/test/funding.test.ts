import { beforeEach, describe, expect, it } from "vitest";
import { applyEvent, createDraft, escrowSummary } from "../src/index.js";
import { CLIENT, DAY, expectCode, fundedAgreement, NOW, now, resetClock, run, sampleTerms, TOTAL, WORKER } from "./fixtures.js";

describe("agreement funding", () => {
  beforeEach(() => resetClock());

  const draft = () => createDraft(sampleTerms(), NOW);
  const acceptedByBoth = () => {
    const d = draft();
    return run(d, ["ACCEPT_TERMS", CLIENT, { termsHash: d.termsHash }], ["ACCEPT_TERMS", WORKER, { termsHash: d.termsHash }]);
  };

  it("locks the full total in escrow once both parties accept and the client funds exactly", () => {
    const funded = fundedAgreement();
    expect(funded.status).toBe("FUNDED");
    expect(escrowSummary(funded).lockedYocto).toBe(BigInt(TOTAL));
  });

  it("refuses funding before the worker has accepted the terms", () => {
    const d = run(draft(), ["ACCEPT_TERMS", CLIENT, { termsHash: draft().termsHash }]);
    expectCode(() => run(d, ["FUND", CLIENT, { termsHash: d.termsHash, amountYocto: TOTAL }]), "INVALID_TRANSITION");
  });

  it("refuses acceptance or funding against a different terms hash", () => {
    const d = acceptedByBoth();
    const other = `sha256:${"0".repeat(64)}`;
    expectCode(() => run(draft(), ["ACCEPT_TERMS", WORKER, { termsHash: other }]), "HASH_MISMATCH");
    expectCode(() => run(d, ["FUND", CLIENT, { termsHash: other, amountYocto: TOTAL }]), "HASH_MISMATCH");
  });

  it.each([
    ["underfunding", (BigInt(TOTAL) - 1n).toString()],
    ["overfunding", (BigInt(TOTAL) + 1n).toString()],
  ])("rejects %s", (_name, amountYocto) => {
    const d = acceptedByBoth();
    expectCode(() => run(d, ["FUND", CLIENT, { termsHash: d.termsHash, amountYocto }]), "ACCOUNTING");
  });

  it("rejects funding by anyone but the client, after the deadline, or twice", () => {
    const d = acceptedByBoth();
    expectCode(() => run(d, ["FUND", WORKER, { termsHash: d.termsHash, amountYocto: TOTAL }]), "UNAUTHORIZED");
    expectCode(
      () => applyEvent(d, { type: "FUND", actor: CLIENT, at: NOW + 2 * DAY, termsHash: d.termsHash, amountYocto: TOTAL }),
      "DEADLINE",
    );
    const funded = run(d, ["FUND", CLIENT, { termsHash: d.termsHash, amountYocto: TOTAL }]);
    expectCode(() => run(funded, ["FUND", CLIENT, { termsHash: d.termsHash, amountYocto: TOTAL }]), "TERMS_LOCKED");
  });

  it("clears prior acceptances when the draft is amended", () => {
    const d = acceptedByBoth();
    const terms = { ...sampleTerms(), challengePeriodSec: 7200 };
    const amended = run(d, ["AMEND_TERMS", CLIENT, { terms }]);
    expect(amended.termsHash).not.toBe(d.termsHash);
    expect(amended.acceptedBy).toEqual({ client: false, worker: false });
    expectCode(() => run(amended, ["FUND", CLIENT, { termsHash: amended.termsHash, amountYocto: TOTAL }]), "INVALID_TRANSITION");
  });

  it("makes terms immutable after funding", () => {
    const funded = fundedAgreement();
    expectCode(() => run(funded, ["AMEND_TERMS", CLIENT, { terms: { ...sampleTerms(), challengePeriodSec: 60 } }]), "TERMS_LOCKED");
    expectCode(() => run(funded, ["ACCEPT_TERMS", WORKER, { termsHash: funded.termsHash }]), "TERMS_LOCKED");
  });

  it("rejects milestone actions before funding and never mutates the input state", () => {
    const d = acceptedByBoth();
    const snapshot = structuredClone(d);
    expectCode(() => run(d, ["SUBMIT", WORKER, { milestoneId: "api", submissionId: "s1", artifactHash: "abc" }]), "INVALID_TRANSITION");
    run(d, ["FUND", CLIENT, { termsHash: d.termsHash, amountYocto: TOTAL }]);
    expect(d).toEqual(snapshot);
  });

  it("rejects malformed events with a validation error", () => {
    expectCode(() => applyEvent(draft(), { type: "FUND", actor: CLIENT, at: now(), amountYocto: "1e24" }), "VALIDATION");
    expectCode(() => applyEvent(draft(), { type: "PAY_ME", actor: WORKER, at: now() }), "VALIDATION");
  });
});
