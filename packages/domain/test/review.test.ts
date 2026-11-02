import { beforeEach, describe, expect, it } from "vitest";
import { confirmPayout, escrowSummary, type AgreementState } from "../src/index.js";
import {
  advance,
  API_AMOUNT,
  CLIENT,
  DAY,
  DESIGN_AMOUNT,
  DESIGN_FLOOR,
  expectCode,
  fundedAgreement,
  HOUR,
  milestone,
  report,
  RESOLVER,
  run,
  TOTAL,
  VERIFIER,
  WORKER,
} from "./fixtures.js";

let n = 0;
const submitDesign = (s: AgreementState) =>
  run(s, ["SUBMIT", WORKER, { milestoneId: "design", submissionId: `design-${++n}`, artifactHash: `sha256-design-${n}` }]);

describe("human-review milestone", () => {
  let funded: AgreementState;
  beforeEach(() => {
    funded = fundedAgreement();
  });

  it("keeps funds locked during revisions, then pays the full amount on approval", () => {
    let s = run(submitDesign(funded), ["REQUEST_REVISION", CLIENT, { milestoneId: "design", feedback: "Increase contrast" }]);
    expect(milestone(s, "design").status).toBe("REVISION_REQUESTED");
    expectCode(() => run(s, ["START_PAYOUT", WORKER, { milestoneId: "design" }]), "INVALID_TRANSITION");

    s = run(submitDesign(s), ["APPROVE", CLIENT, { milestoneId: "design" }]);
    expect(milestone(s, "design").allocation).toEqual({ workerYocto: DESIGN_AMOUNT, clientYocto: "0" });
  });

  it("enforces the agreed revision limit", () => {
    let s = funded;
    for (let i = 0; i < 2; i++) {
      s = run(submitDesign(s), ["REQUEST_REVISION", CLIENT, { milestoneId: "design", feedback: `round ${i}` }]);
    }
    s = submitDesign(s);
    expectCode(() => run(s, ["REQUEST_REVISION", CLIENT, { milestoneId: "design", feedback: "again" }]), "INVALID_TRANSITION");
  });

  it("only the client approves; the worker cannot approve their own work", () => {
    const s = submitDesign(funded);
    expectCode(() => run(s, ["APPROVE", WORKER, { milestoneId: "design" }]), "UNAUTHORIZED");
    expectCode(() => run(s, ["APPROVE", RESOLVER, { milestoneId: "design" }]), "UNAUTHORIZED");
  });

  it("settles a mutually agreed partial payment, refunding the rest to the client", () => {
    const half = (BigInt(DESIGN_AMOUNT) / 2n).toString();
    let s = run(submitDesign(funded), ["PROPOSE_SETTLEMENT", WORKER, { milestoneId: "design", workerYocto: half }]);
    expectCode(() => run(s, ["ACCEPT_SETTLEMENT", WORKER, { milestoneId: "design", workerYocto: half }]), "UNAUTHORIZED");
    expectCode(() => run(s, ["ACCEPT_SETTLEMENT", CLIENT, { milestoneId: "design", workerYocto: DESIGN_AMOUNT }]), "BINDING_MISMATCH");

    s = run(s, ["ACCEPT_SETTLEMENT", CLIENT, { milestoneId: "design", workerYocto: half }]);
    expect(milestone(s, "design").allocation).toEqual({
      workerYocto: half,
      clientYocto: (BigInt(DESIGN_AMOUNT) - BigInt(half)).toString(),
    });
  });

  it("bounds a dispute ruling between the protected floor and the milestone amount", () => {
    const s = run(submitDesign(funded), ["OPEN_DISPUTE", WORKER, { milestoneId: "design", reason: "client unresponsive" }]);
    expectCode(() => run(s, ["RESOLVE_DISPUTE", RESOLVER, { milestoneId: "design", workerYocto: "0" }]), "ACCOUNTING");
    expectCode(
      () => run(s, ["RESOLVE_DISPUTE", RESOLVER, { milestoneId: "design", workerYocto: (BigInt(DESIGN_AMOUNT) + 1n).toString() }]),
      "ACCOUNTING",
    );
    const resolved = run(s, ["RESOLVE_DISPUTE", RESOLVER, { milestoneId: "design", workerYocto: DESIGN_FLOOR }]);
    expect(milestone(resolved, "design").allocation?.workerYocto).toBe(DESIGN_FLOOR);
  });

  it("does not let a design rejection claw back an earned technical milestone", () => {
    let s = run(funded, ["SUBMIT", WORKER, { milestoneId: "api", submissionId: "api-1", artifactHash: "commit-1" }]);
    s = run(s, ["RECORD_VERIFICATION", VERIFIER, { milestoneId: "api", report: report(s) }]);
    advance(HOUR);
    s = run(s, ["FINALIZE_CHALLENGE", WORKER, { milestoneId: "api" }]);

    s = run(submitDesign(s), ["OPEN_DISPUTE", CLIENT, { milestoneId: "design", reason: "does not match brief" }]);
    s = run(s, ["RESOLVE_DISPUTE", RESOLVER, { milestoneId: "design", workerYocto: DESIGN_FLOOR }]);
    expect(milestone(s, "api").allocation?.workerYocto).toBe(API_AMOUNT);

    for (const id of ["api", "design"]) s = confirmPayout(run(s, ["START_PAYOUT", CLIENT, { milestoneId: id }]), id, true);
    const sum = escrowSummary(s);
    expect(s.status).toBe("COMPLETED");
    expect(sum.paidWorkerYocto).toBe(BigInt(API_AMOUNT) + BigInt(DESIGN_FLOOR));
    expect(sum.paidWorkerYocto + sum.refundedClientYocto).toBe(BigInt(TOTAL));
  });

  it("refunds unstarted milestones after expiry but never expires submitted work", () => {
    let s = submitDesign(funded);
    advance(15 * DAY);
    s = run(s, ["EXPIRE_MILESTONE", CLIENT, { milestoneId: "api" }]);
    expect(milestone(s, "api").allocation).toEqual({ workerYocto: "0", clientYocto: API_AMOUNT });
    expectCode(() => run(s, ["EXPIRE_MILESTONE", CLIENT, { milestoneId: "design" }]), "INVALID_TRANSITION");
    expectCode(
      () => run(s, ["SUBMIT", WORKER, { milestoneId: "api", submissionId: "late", artifactHash: "x" }]),
      "INVALID_TRANSITION",
    );
  });

  it("does not expire milestones before the agreement deadline", () => {
    expectCode(() => run(funded, ["EXPIRE_MILESTONE", CLIENT, { milestoneId: "api" }]), "DEADLINE");
  });
});
