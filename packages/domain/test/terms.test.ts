import { describe, expect, it } from "vitest";
import { computePlanHash, computeTermsHash, DomainError, parseTerms, U128_MAX } from "../src/index.js";
import { CLIENT, sampleTerms, WORKER } from "./fixtures.js";

function rejection(mutate: (t: ReturnType<typeof sampleTerms>) => void): string {
  const t = structuredClone(sampleTerms());
  mutate(t);
  try {
    parseTerms(t);
  } catch (e) {
    expect(e).toBeInstanceOf(DomainError);
    expect((e as DomainError).code).toBe("VALIDATION");
    return (e as DomainError).message;
  }
  throw new Error("expected terms to be rejected");
}

describe("agreement terms", () => {
  it("accepts the reference two-milestone agreement", () => {
    expect(parseTerms(sampleTerms()).milestones).toHaveLength(2);
  });

  it("hashes identically regardless of key order", () => {
    const a = parseTerms(sampleTerms());
    const reordered = Object.fromEntries(Object.entries(sampleTerms()).reverse());
    expect(computeTermsHash(parseTerms(reordered))).toBe(computeTermsHash(a));
    expect(computeTermsHash(a)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("changes the plan hash when any acceptance check changes", () => {
    const t = parseTerms(sampleTerms());
    const plan = t.milestones[0]!.type === "AUTOMATED" ? t.milestones[0]!.verificationPlan : null;
    expect(computePlanHash({ ...plan!, expectedStatus: 201 })).not.toBe(computePlanHash(plan!));
  });

  it.each([
    ["milestone amounts that do not sum to the total", (t: any) => (t.totalYocto = "1"), "totalYocto"],
    ["a zero-amount milestone", (t: any) => {
      t.totalYocto = t.milestones[1].amountYocto;
      t.milestones[0].amountYocto = "0";
    }, "must be positive"],
    ["fractional yoctoNEAR", (t: any) => (t.milestones[0].amountYocto = "1.5"), "integer"],
    ["negative amounts", (t: any) => (t.milestones[0].amountYocto = "-1"), "integer"],
    ["amounts above u128", (t: any) => (t.totalYocto = (U128_MAX + 1n).toString()), "u128"],
    ["duplicate milestone ids", (t: any) => (t.milestones[1].id = "api"), "duplicate"],
    ["the same account as client and worker", (t: any) => (t.worker.nearAccountId = CLIENT), "different accounts"],
    ["the worker acting as verifier", (t: any) => (t.verifierAuthority = WORKER), "independent"],
    ["the client acting as dispute resolver", (t: any) => (t.disputeResolver = CLIENT), "independent"],
    ["a partial-compensation floor above the milestone", (t: any) => (t.milestones[1].partialCompensation.floorYocto = t.totalYocto), "floor"],
    ["expiry before the funding deadline", (t: any) => (t.expiresAt = t.fundingDeadline), "expiresAt"],
    ["an invalid NEAR account", (t: any) => (t.client.nearAccountId = "Bad..Account"), "invalid NEAR account"],
    ["unknown fields", (t: any) => (t.autoApprove = true), "Unrecognized"],
    ["an unsupported JSON path", (t: any) => (t.milestones[0].verificationPlan.assertions[0].path = "status"), "JSON path"],
  ])("rejects %s", (_name, mutate, expected) => {
    expect(rejection(mutate)).toContain(expected);
  });
});
