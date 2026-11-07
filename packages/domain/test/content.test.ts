import { describe, expect, it } from "vitest";
import { checkContent, ContentRulesPlan, VerificationPlan } from "../src/index.js";

const plan = (over: Record<string, unknown> = {}) => ContentRulesPlan.parse({ kind: "CONTENT_RULES", version: 1, format: "markdown", maxBytes: 4000, ...over });
const failed = (checks: ReturnType<typeof checkContent>) => checks.filter((c) => !c.ok).map((c) => c.check);

describe("CONTENT_RULES plan", () => {
  it("is a verification plan alongside HTTP and GitHub plans", () => {
    expect(VerificationPlan.parse({ kind: "CONTENT_RULES", version: 1, format: "text", maxBytes: 100 }).kind).toBe("CONTENT_RULES");
    // The cross-field rules hold inside an agreement too, not only when parsed on their own.
    expect(() => VerificationPlan.parse({ kind: "CONTENT_RULES", version: 1, format: "text", maxBytes: 100, minWords: 9, maxWords: 1 })).toThrow(/minWords/);
  });

  it("rejects contradictory or misplaced rules", () => {
    expect(() => plan({ minWords: 300, maxWords: 100 })).toThrow(/minWords/);
    expect(() => plan({ format: "text", assertions: [{ op: "exists", path: "$.name" }] })).toThrow(/JSON assertions/);
    expect(() => plan({ format: "json", minHeadings: 2 })).toThrow(/minHeadings/);
    expect(() => plan({ maxBytes: 100_000 })).toThrow();
    expect(() => plan({ unknownRule: true })).toThrow();
  });
});

describe("checkContent", () => {
  const guide = "# Claim a bounty\n\n## Steps\n1. Open Bounties.\n2. Pick an open bounty.\n3. Click Claim and approve in your wallet.\n";

  it("passes when every rule holds", () => {
    const checks = checkContent(plan({ minWords: 10, maxWords: 60, mustInclude: ["bounties", "WALLET"], mustNotInclude: ["mainnet"], minHeadings: 2 }), guide);
    expect(failed(checks)).toEqual([]);
  });

  it("names each rule that fails", () => {
    const checks = checkContent(plan({ maxWords: 5, mustInclude: ["testnet"], mustNotInclude: ["wallet"], minHeadings: 3 }), guide);
    expect(failed(checks)).toEqual(["words 0–5", 'includes "testnet"', 'does not include "wallet"', "at least 3 headings"]);
  });

  it("enforces the size limit and refuses an empty deliverable", () => {
    expect(failed(checkContent(plan({ maxBytes: 10 }), guide))).toEqual(["size"]);
    expect(failed(checkContent(plan(), ""))).toEqual(["size"]);
  });

  it("parses JSON and applies assertions", () => {
    const p = plan({ format: "json", assertions: [{ op: "type", path: "$.items", type: "array" }, { op: "equals", path: "$.items[0].ok", value: true }] });
    expect(failed(checkContent(p, '{"items":[{"ok":true}]}'))).toEqual([]);
    expect(failed(checkContent(p, '{"items":[{"ok":false}]}'))).toEqual(["$.items[0].ok == true"]);
    expect(failed(checkContent(p, "```json\n{}\n```"))).toEqual(["valid JSON"]);
  });
});
