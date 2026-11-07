import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { filterBounties } from "./BountyBoard";
import { autoplayAllowed, DEMO_STEPS, demoReducer, LAST_STEP, receiptAt } from "./demo";
import { docsApiOrigin, PRODUCTION_ORIGIN } from "./docs";
import { describeError, txReducer, walletState, type TxPhase } from "./feedback";
import { agreementStages } from "./stages";
import { makeJob } from "./test-fixtures";

const stateOf = (v: ReturnType<typeof agreementStages>, key: string) => v.stages.find((s) => s.key === key)!.state;
const nowStage = (v: ReturnType<typeof agreementStages>) => v.stages.find((s) => s.state === "now")?.key;

describe("escrow machine demo (simulated)", () => {
  it("runs the eight required steps in order", () => {
    expect(DEMO_STEPS.map((s) => s.label)).toEqual([
      "Agreement created",
      "Funds locked",
      "Work submitted",
      "Verification failed",
      "Corrected submission",
      "Verification passed",
      "Challenge window",
      "Payment released",
    ]);
  });

  it("keeps the funds in the vault on a failed check, and pays only after the challenge window", () => {
    const by = Object.fromEntries(DEMO_STEPS.map((s, i) => [s.key, { ...s, i }]));
    expect(by.failed).toMatchObject({ token: "vault", locked: true, verdict: "fail", paid: false });
    expect(DEMO_STEPS.slice(0, by.released!.i).every((s) => !s.paid && s.token !== "worker")).toBe(true);
    expect(by.challenge!.i).toBe(by.released!.i - 1);
    expect(by.challenge).toMatchObject({ verdict: "pass", challenge: true, paid: false, token: "vault" });
    expect(by.released).toMatchObject({ token: "worker", paid: true, locked: false });
  });

  it("steps within bounds, jumps, and replays", () => {
    expect(demoReducer(0, { type: "back" })).toBe(0);
    expect(demoReducer(LAST_STEP, { type: "next" })).toBe(LAST_STEP);
    expect(demoReducer(2, { type: "goto", step: 99 })).toBe(LAST_STEP);
    expect(demoReducer(5, { type: "replay" })).toBe(0);
    expect(receiptAt(2)).toHaveLength(3);
    expect(receiptAt(2)[0]).toMatch(/^01 {2}/);
  });

  it("never autoplays under reduced motion, offscreen, or when paused", () => {
    expect(autoplayAllowed({ playing: true, inView: true, reducedMotion: false })).toBe(true);
    expect(autoplayAllowed({ playing: true, inView: true, reducedMotion: true })).toBe(false);
    expect(autoplayAllowed({ playing: true, inView: false, reducedMotion: false })).toBe(false);
    expect(autoplayAllowed({ playing: false, inView: true, reducedMotion: false })).toBe(false);
  });
});

describe("agreement path from recorded state", () => {
  it("draft before acceptance waits on acceptance; after acceptance waits on funding", () => {
    expect(nowStage(agreementStages(makeJob({ status: "DRAFT", accepted: false }), null))).toBe("accepted");
    expect(nowStage(agreementStages(makeJob({ status: "DRAFT", accepted: true }), null))).toBe("funded");
  });

  it("marks an unfunded draft past its deadline as expired", () => {
    const v = agreementStages(makeJob({ status: "DRAFT", fundingDeadline: 1000 }), null, 5000);
    expect(v.branch?.kind).toBe("expired");
  });

  it("an open bounty is funded and waiting to be claimed", () => {
    const v = agreementStages(makeJob({ status: "OPEN", openBounty: true, worker: "open-bounty" }), null);
    expect(stateOf(v, "funded")).toBe("done");
    expect(v.stages.find((s) => s.key === "accepted")).toMatchObject({ state: "now", label: "Claimed" });
  });

  it("a failed verification is a branch, and the money is still in escrow", () => {
    const v = agreementStages(makeJob({ milestones: [{ state: { status: "PENDING", lastVerification: { outcome: "FAIL" } } }] }), null);
    expect(nowStage(v)).toBe("submitted");
    expect(v.branch?.kind).toBe("failed");
    expect(stateOf(v, "paid")).toBe("todo");
  });

  it("a pass enters the challenge window before payment", () => {
    const v = agreementStages(makeJob({ milestones: [{ state: { status: "VERIFIED_PENDING_CHALLENGE" } }] }), null);
    expect(nowStage(v)).toBe("challenge");
    expect(stateOf(v, "verified")).toBe("done");
  });

  it("never shows a payout as paid while the transfer awaits its callback", () => {
    const v = agreementStages(makeJob({ milestones: [{ state: { status: "PAYOUT_PENDING" } }] }), null);
    expect(stateOf(v, "paid")).toBe("now");
    expect(v.awaitingChain).toBe(true);
  });

  it("human review has no challenge window and says Approved", () => {
    const v = agreementStages(makeJob({ milestones: [{ terms: { type: "HUMAN_REVIEW" }, state: { status: "SUBMITTED" } }] }), null);
    expect(stateOf(v, "challenge")).toBe("skip");
    expect(v.stages.find((s) => s.key === "verified")!.label).toBe("Approved");
  });

  it("revision and dispute are explicit branches", () => {
    expect(agreementStages(makeJob({ milestones: [{ state: { status: "REVISION_REQUESTED" } }] }), null).branch?.kind).toBe("revision");
    expect(agreementStages(makeJob({ milestones: [{ state: { status: "DISPUTED" } }] }), null).branch?.kind).toBe("dispute");
  });

  it("a completed split is shown as a partial settlement; a cancelled bounty as cancelled", () => {
    const split = makeJob({ status: "COMPLETED", milestones: [{ state: { status: "PAID", allocation: { workerYocto: "6", clientYocto: "4" } } }] });
    expect(agreementStages(split, null).branch?.kind).toBe("partial");
    expect(agreementStages(makeJob({ status: "CANCELLED", openBounty: true }), null).branch?.kind).toBe("cancelled");
  });

  it("follows the first unpaid milestone and flags a disagreement with the contract", () => {
    const j = makeJob({ milestones: [{ state: { status: "PAID" } }, { state: { status: "SUBMITTED" } }] });
    const v = agreementStages(j, { agreement: null, error: null, termsMatch: true, divergences: [{ milestoneId: "m1", offchain: "SUBMITTED", onchain: "Pending" }] });
    expect(v.focus).toMatchObject({ index: 1, total: 2 });
    expect(v.syncing).toBe(true);
  });
});

describe("public instructions use the deployment's address", () => {
  it("prefers the API's published origin", () => {
    expect(docsApiOrigin("https://settle-9ewd.onrender.com/", { hostname: "localhost", origin: "http://localhost:5173" })).toBe("https://settle-9ewd.onrender.com");
  });
  it("never shows localhost when the API does not say", () => {
    for (const hostname of ["localhost", "127.0.0.1", "app.localhost"]) {
      expect(docsApiOrigin(null, { hostname, origin: `http://${hostname}:5173` })).toBe(PRODUCTION_ORIGIN);
    }
  });
  it("uses the page's own origin on a real host", () => {
    expect(docsApiOrigin(undefined, { hostname: "settle.example.com", origin: "https://settle.example.com" })).toBe("https://settle.example.com");
  });
});

describe("what people see when something fails", () => {
  it("never shows a raw bearer-token error", () => {
    const msg = describeError(new ApiError("AUTH_REQUIRED", "missing bearer token"));
    expect(msg).not.toMatch(/bearer/i);
    expect(msg).toMatch(/sign in/i);
  });
  it("explains wallet cancellations, network failures and server errors", () => {
    expect(describeError(new Error("User rejected the request"))).toMatch(/cancelled\. Nothing was sent/);
    expect(describeError(new TypeError("Failed to fetch"))).toMatch(/Could not reach/);
    expect(describeError(new ApiError("HTTP_502", "Bad Gateway"))).toMatch(/waking up/);
    expect(describeError(new ApiError("INTERNAL", "internal error"))).not.toBe("internal error");
  });
  it("keeps rule messages written for people", () => {
    expect(describeError(new ApiError("INVALID_TRANSITION", "SUBMIT is not allowed while FUNDED/PAID"))).toBe("SUBMIT is not allowed while FUNDED/PAID");
  });
});

describe("transaction feedback", () => {
  const idle: TxPhase = { phase: "idle" };
  it("goes signing → sent → confirmed, and only confirms after a hash", () => {
    let s = txReducer(idle, { type: "confirmed" });
    expect(s.phase).toBe("idle");
    s = txReducer(idle, { type: "sign", label: "fund" });
    expect(txReducer(s, { type: "confirmed" }).phase).toBe("signing");
    s = txReducer(s, { type: "sent", hash: "H" });
    expect(s).toMatchObject({ phase: "sent", hash: "H" });
    expect(txReducer(s, { type: "confirmed" })).toMatchObject({ phase: "confirmed", hash: "H" });
  });
  it("ignores a second click while a transaction is in flight", () => {
    const s = txReducer(idle, { type: "sign", label: "fund" });
    expect(txReducer(s, { type: "sign", label: "approve" })).toBe(s);
  });
  it("turns a wallet rejection into a plain failure", () => {
    const s = txReducer(txReducer(idle, { type: "sign", label: "fund" }), { type: "error", error: new Error("User closed the window") });
    expect(s).toMatchObject({ phase: "failed", message: expect.stringMatching(/cancelled/) });
  });
});

describe("wallet states", () => {
  it("separates connecting a wallet from signing in", () => {
    expect(walletState({ walletReady: false, accountId: null, signedIn: false })).toBe("loading");
    expect(walletState({ walletReady: true, accountId: null, signedIn: false })).toBe("disconnected");
    expect(walletState({ walletReady: true, accountId: "a.testnet", signedIn: false })).toBe("connected");
    expect(walletState({ walletReady: true, accountId: "a.testnet", signedIn: true })).toBe("signed-in");
  });
});

describe("bounty marketplace filters", () => {
  const now = 1_000_000;
  const open = makeJob({ id: "open", status: "OPEN", openBounty: true, worker: "open-bounty", totalNear: 2, fundingDeadline: now + 10, milestones: [{ terms: { title: "Logo", rubric: "an SVG logo", type: "HUMAN_REVIEW" } }] });
  const big = makeJob({ id: "big", status: "OPEN", openBounty: true, worker: "open-bounty", totalNear: 5, fundingDeadline: now + 99, milestones: [{ terms: { title: "API" } }] });
  const done = makeJob({ id: "done", status: "COMPLETED", openBounty: true, totalNear: 1 });
  const expired = makeJob({ id: "expired", status: "OPEN", openBounty: true, worker: "open-bounty", fundingDeadline: now - 1 });
  const all = [open, big, done, expired];
  const q = { text: "", status: "open" as const, kind: "all", sort: "reward-desc" as const };
  it("shows only claimable bounties as open, sorted by reward", () => {
    expect(filterBounties(all, q, now).map((b) => b.id)).toEqual(["big", "open"]);
  });
  it("searches titles and requirements, and filters by verification type", () => {
    expect(filterBounties(all, { ...q, text: "svg" }, now).map((b) => b.id)).toEqual(["open"]);
    expect(filterBounties(all, { ...q, kind: "Human review" }, now).map((b) => b.id)).toEqual(["open"]);
  });
  it("puts claimed, completed and expired bounties on the record", () => {
    expect(filterBounties(all, { ...q, status: "closed", sort: "newest" }, now).map((b) => b.id)).toEqual(["done", "expired"]);
  });
});

describe("code highlighting", () => {
  it("marks flags at word starts only", async () => {
    const { highlight } = await import("./code");
    const flags = (highlight("node mcp-server --env X=1", "bash") as unknown[])
      .filter((n): n is { props: { className: string; children: string } } => typeof n === "object" && n !== null && "props" in n)
      .filter((n) => n.props.className === "c-flag")
      .map((n) => n.props.children);
    expect(flags).toEqual(["--env"]);
  });
});

describe("new agreement form", () => {
  const base = {
    template: "review" as const,
    openBounty: true,
    worker: "",
    workerKind: "AGENT" as const,
    workTitle: "A 300-word quickstart",
    brief: "Numbered steps, under 300 words.",
    workNear: "0.02",
    autoFormat: "markdown" as const,
    minWords: "",
    maxWords: "",
    mustInclude: "",
    mustNotInclude: "",
    minHeadings: "",
    maxBytes: "",
    apiNear: "0.35",
    designNear: "0.15",
    floorNear: "",
    revisions: 2,
    challengeMin: 2,
    deadlineHours: 24,
    expiresDays: 7,
    plan: "{}",
    probes: 5,
    probeIntervalSec: 15,
    repo: "",
    branch: "main",
    checks: "test",
    rubric: "Looks right.",
  };

  it("builds a review-only open bounty the swarm can take", async () => {
    const { buildAgreement, swarmCanTake } = await import("./agreementForm");
    const req = buildAgreement(base, 0);
    expect(req).toMatchObject({ openBounty: true, totalYocto: "20000000000000000000000", fundingDeadline: 24 * 3600_000 });
    expect(req.milestones).toEqual([
      { id: "work", title: "A 300-word quickstart", type: "HUMAN_REVIEW", amountYocto: "20000000000000000000000", rubric: "Numbered steps, under 300 words.", maxRevisions: 2, partialCompensation: null },
    ]);
    expect(req.milestones.every((m) => m.type === "HUMAN_REVIEW")).toBe(true);
    expect(swarmCanTake("review", true)).toBe(true);
    expect(swarmCanTake("api-design", true)).toBe(false);
  });

  it("explains what is missing in a review bounty", async () => {
    const { buildAgreement } = await import("./agreementForm");
    expect(() => buildAgreement({ ...base, workTitle: " " }, 0)).toThrow(/what should be delivered/i);
    expect(() => buildAgreement({ ...base, brief: "" }, 0)).toThrow(/good delivery/i);
    expect(() => buildAgreement({ ...base, workNear: "0" }, 0)).toThrow(/above 0/);
    expect(() => buildAgreement({ ...base, floorNear: "0.5" }, 0)).toThrow(/minimum cannot be more/);
    expect(buildAgreement({ ...base, floorNear: "0.01" }, 0).milestones[0]).toMatchObject({ partialCompensation: { condition: "DELIVERABLE_SUBMITTED", floorYocto: "10000000000000000000000" } });
  });

  it("keeps the existing API-and-design agreement unchanged", async () => {
    const { buildAgreement } = await import("./agreementForm");
    const req = buildAgreement({ ...base, template: "api-design", openBounty: false, worker: "w.testnet", floorNear: "0.075" }, 0);
    expect(req).toMatchObject({ worker: { kind: "AGENT", nearAccountId: "w.testnet" } });
    expect(req.milestones.map((m) => [m.id, m.type])).toEqual([
      ["api", "AUTOMATED"],
      ["design", "HUMAN_REVIEW"],
    ]);
    expect(req.totalYocto).toBe("500000000000000000000000");
  });
});

describe("auto-checked text form", () => {
  const form = {
    template: "auto-text" as const,
    openBounty: true,
    worker: "",
    workerKind: "AGENT" as const,
    workTitle: "A 150-word claim guide",
    brief: "",
    workNear: "0.02",
    autoFormat: "markdown" as const,
    minWords: "50",
    maxWords: "300",
    mustInclude: "wallet, testnet",
    mustNotInclude: "",
    minHeadings: "1",
    maxBytes: "",
    apiNear: "0.35",
    designNear: "0.15",
    floorNear: "",
    revisions: 2,
    challengeMin: 2,
    deadlineHours: 24,
    expiresDays: 7,
    plan: "{}",
    probes: 5,
    probeIntervalSec: 15,
    repo: "",
    branch: "main",
    checks: "test",
    rubric: "",
  };

  it("builds one automated milestone with a CONTENT_RULES plan, omitting empty rules", async () => {
    const { buildAgreement, swarmCanTake } = await import("./agreementForm");
    const req = buildAgreement(form, 0);
    expect(req.milestones).toEqual([
      {
        id: "work",
        title: "A 150-word claim guide",
        type: "AUTOMATED",
        amountYocto: "20000000000000000000000",
        verificationPlan: { kind: "CONTENT_RULES", version: 1, format: "markdown", maxBytes: 8000, minWords: 50, maxWords: 300, mustInclude: ["wallet", "testnet"], minHeadings: 1 },
      },
    ]);
    expect(swarmCanTake("auto-text", true)).toBe(true);
  });

  it("explains bad rules before anything is sent", async () => {
    const { buildAgreement } = await import("./agreementForm");
    expect(() => buildAgreement({ ...form, minWords: "400" }, 0)).toThrow(/cannot be more than maximum/);
    expect(() => buildAgreement({ ...form, maxWords: "1.5" }, 0)).toThrow(/whole number/);
    expect(() => buildAgreement({ ...form, maxBytes: "100000" }, 0)).toThrow(/Maximum size/);
  });

  it("describes the rules in plain words for people", async () => {
    const { describeRules } = await import("./derive");
    expect(describeRules({ kind: "CONTENT_RULES", format: "json", maxBytes: 500, mustInclude: ["id"] })).toEqual(["A JSON document, at most 500 bytes.", 'Includes "id".']);
  });
});
