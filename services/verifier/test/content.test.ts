import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ContentRulesPlan, verifyReportSignature } from "@settle/domain";
import { DEFAULT_POLICY, runContentPlan, verifySubmission, type NetworkPolicy } from "../src/index.js";

const DOC = "# Claim a bounty\n\n## Steps\n1. Open Bounties.\n2. Pick one.\n3. Claim it and approve in your wallet.\n";
const sha = (s: string) => `sha256:${createHash("sha256").update(s).digest("hex")}`;
const PLAN = ContentRulesPlan.parse({ kind: "CONTENT_RULES", version: 1, format: "markdown", maxBytes: 2000, minWords: 10, mustInclude: ["wallet"], minHeadings: 2 });

let server: Server;
let origin: string;
let policy: NetworkPolicy;
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/d/doc") return res.writeHead(200, { "content-type": "text/plain" }).end(DOC);
    if (req.url === "/d/broken") return res.writeHead(500).end("oops");
    res.writeHead(404).end("not found");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  policy = { insecureTestOrigins: [origin], testAddresses: ["127.0.0.1"] };
});
afterAll(() => server.close());

const failedChecks = (r: Awaited<ReturnType<typeof runContentPlan>>) => r.checks.filter((c) => !c.ok).map((c) => c.check);

describe("content verification (CONTENT_RULES)", () => {
  it("passes the exact submitted bytes read from SETTLE's store, without any network call", async () => {
    const r = await runContentPlan(PLAN, { artifactHash: sha(DOC) }, { loadContent: async (h) => (h === sha(DOC) ? DOC : null), policy: DEFAULT_POLICY });
    expect(r.outcome).toBe("PASS");
    expect(r.content).toEqual({ source: "settle-store" });
    expect(r.checks[0]).toMatchObject({ check: "matches the submitted hash", ok: true });
  });

  it("reads the deliverable from the submitted URL when the store does not have it", async () => {
    const r = await runContentPlan(PLAN, { artifactHash: sha(DOC), uri: `${origin}/d/doc` }, { policy, loadContent: async () => null });
    expect([r.outcome, r.content?.source, r.status]).toEqual(["PASS", "url", 200]);
  });

  it("fails when the bytes are not the ones whose hash was submitted onchain", async () => {
    const r = await runContentPlan(PLAN, { artifactHash: sha("something else"), uri: `${origin}/d/doc` }, { policy });
    expect(r.outcome).toBe("FAIL");
    expect(failedChecks(r)).toEqual(["matches the submitted hash"]);
  });

  it("fails on a broken rule and names it", async () => {
    const strict = ContentRulesPlan.parse({ ...PLAN, mustInclude: ["testnet"] });
    const r = await runContentPlan(strict, { artifactHash: sha(DOC), uri: `${origin}/d/doc` }, { policy });
    expect([r.outcome, failedChecks(r)]).toEqual(["FAIL", ['includes "testnet"']]);
  });

  it("fails closed on a missing deliverable, a bad hash, an oversized one or a blocked target", async () => {
    expect((await runContentPlan(PLAN, { artifactHash: sha(DOC), uri: `${origin}/d/missing` }, { policy })).outcome).toBe("FAIL");
    expect((await runContentPlan(PLAN, { artifactHash: "not-a-hash", uri: `${origin}/d/doc` }, { policy })).outcome).toBe("FAIL");
    expect((await runContentPlan({ ...PLAN, maxBytes: 20 }, { artifactHash: sha(DOC), uri: `${origin}/d/doc` }, { policy })).outcome).toBe("FAIL");
    expect((await runContentPlan(PLAN, { artifactHash: sha(DOC), uri: `${origin}/d/doc` }, { policy: DEFAULT_POLICY })).outcome).toBe("FAIL");
    expect((await runContentPlan(PLAN, { artifactHash: sha(DOC) }, {})).outcome).toBe("FAIL");
  });

  it("is inconclusive, never a pass, when the deliverable cannot be read", async () => {
    expect((await runContentPlan(PLAN, { artifactHash: sha(DOC), uri: `${origin}/d/broken` }, { policy })).outcome).toBe("INCONCLUSIVE");
    expect((await runContentPlan(PLAN, { artifactHash: sha(DOC), uri: "http://127.0.0.1:1/d/doc" }, { policy: { insecureTestOrigins: ["http://127.0.0.1:1"], testAddresses: ["127.0.0.1"] } })).outcome).toBe(
      "INCONCLUSIVE",
    );
  });

  it("produces a signed report whose evidence records the content checks", async () => {
    const seed = "44".repeat(32);
    const signed = await verifySubmission(
      { escrowContract: "settle-escrow.testnet", agreementId: "job_content", milestoneId: "work", plan: PLAN, submission: { seq: 1, artifactHash: sha(DOC) } },
      { seedHex: seed, loadContent: async () => DOC },
    );
    expect(signed.report.outcome).toBe("PASS");
    expect(signed.evidence.content).toEqual({ source: "settle-store" });
    const { publicKeyFromSeed } = await import("@settle/domain");
    expect(verifyReportSignature("settle-escrow.testnet", signed.report, signed.signature, publicKeyFromSeed(seed))).toBe(true);
  });
});
