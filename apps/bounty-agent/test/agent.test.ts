import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KeyPair } from "near-api-js";
import { SettleAgent, type ContractCall } from "@settle/agent-sdk";
import { computeOnchainTermsHash } from "@settle/domain";
import { DEMO_PLAN } from "@settle/fixture-api";
import { runPlan } from "@settle/verifier";
import { onchainFunded, startHarness, type Harness } from "../../api/test/harness.js";
import { BountyAgent, screen } from "../src/index.js";

const POSTER = "poster.testnet";
const BOT = "bounty-bot.testnet";
const NEAR = 10n ** 24n;

let h: Harness;
let apiUrl: string;
let drain: ReturnType<typeof setInterval>;
beforeAll(async () => {
  h = await startHarness();
  await h.app.listen({ port: 0, host: "127.0.0.1" });
  apiUrl = `http://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
  drain = setInterval(() => void h.runVerifier().catch(() => undefined), 100);
});
afterAll(async () => {
  clearInterval(drain);
  await h.close();
});

/** An SDK agent whose onchain calls are applied to the fake chain the way the contract would. */
async function connect(accountId: string, opts: { refuseClaims?: boolean } = {}) {
  const key = KeyPair.fromRandom("ed25519");
  h.chain.keys.set(key.getPublicKey().toString(), { accountId, permission: "FullAccess" });
  const sent: ContractCall[] = [];
  const agent: SettleAgent = await SettleAgent.connect({
    apiUrl,
    accountId,
    privateKey: key.toString() as `ed25519:${string}`,
    executor: {
      execute: async (call) => {
        sent.push(call);
        const id = (call.args.agreement_id ?? (call.args.terms as { agreement_id: string }).agreement_id) as string;
        if (call.methodName === "post_bounty") {
          const { job } = await agent.getJob(id);
          h.chain.agreements.set(id, { ...onchainFunded(job.state as never), status: "Open", accepted_by_worker: false, funded_at_ms: null });
        }
        if (call.methodName === "claim_bounty") {
          const a = h.chain.agreements.get(id)!;
          if (opts.refuseClaims || a.status !== "Open") throw new Error("INVALID_TRANSITION: not an open bounty");
          a.terms = { ...a.terms, worker: accountId };
          a.terms_hash = computeOnchainTermsHash(a.terms);
          a.status = "Funded";
          a.accepted_by_worker = true;
        }
        return `tx-${sent.length}`;
      },
    },
  });
  return { agent, sent };
}

function bounty(milestones: Record<string, unknown>[]) {
  const total = milestones.reduce((s, m) => s + BigInt(m.amountYocto as string), 0n);
  return { totalYocto: total.toString(), milestones, challengePeriodSec: 60, fundingDeadline: Date.now() + 3_600_000, expiresAt: Date.now() + 86_400_000 };
}
const apiCheck = (id: string, amount: bigint, plan: unknown = DEMO_PLAN) => ({ id, title: `API ${id}`, type: "AUTOMATED", amountYocto: amount.toString(), verificationPlan: plan });

describe("autonomous bounty agent", () => {
  it("claims and delivers only bounties its own deployment passes, within its limit", async () => {
    const { agent: poster } = await connect(POSTER);
    const good = (await poster.postBounty(bounty([apiCheck("api", NEAR / 50n)]))).job.id;
    const tooBig = (await poster.postBounty(bounty([apiCheck("api", NEAR)]))).job.id;
    const human = (
      await poster.postBounty(bounty([{ id: "doc", title: "Docs", type: "HUMAN_REVIEW", amountYocto: (NEAR / 100n).toString(), rubric: "Clear.", maxRevisions: 1, partialCompensation: null }]))
    ).job.id;
    // A check the bot's deployment fails: it expects a status the deployment never returns.
    const impossible = (await poster.postBounty(bounty([apiCheck("api", NEAR / 100n, { ...DEMO_PLAN, expectedStatus: 201 })]))).job.id;

    const { agent: bot, sent } = await connect(BOT);
    const events: [string, Record<string, unknown>][] = [];
    const worker = new BountyAgent(bot, { deploymentUrl: `${h.fixtureOrigin}/fixed`, artifactHash: "bot@1", maxBountyYocto: NEAR / 20n }, (e, f = {}) => events.push([e, f]), {
      check: (plan, url) => runPlan(plan, url, { policy: h.policy }),
      verificationTimeoutMs: 15_000,
    });
    expect(await worker.tick()).toBe(1);

    const reason = (id: string) => events.find(([e, f]) => e === "skipped" && f.bounty === id)?.[1].reason;
    expect(reason(tooBig)).toBe("pays more than this agent's limit");
    expect(reason(human)).toBe("milestone doc needs human review");
    expect(reason(impossible)).toMatch(/own deployment would not pass: api: FAIL \(status\)/);
    expect(sent.map((c) => c.methodName)).toEqual(["claim_bounty", "submit"]); // nothing signed for the skipped ones
    expect(events.find(([e]) => e === "verified")?.[1]).toMatchObject({ bounty: good, outcome: "PASS" });

    const { job } = await bot.getJob(good);
    expect(job.state.terms.worker.nearAccountId).toBe(BOT);
    expect(job.state.milestones[0]!.status).toBe("VERIFIED_PENDING_CHALLENGE");
    // Decisions are remembered: the next pass signs nothing new.
    expect(await worker.tick()).toBe(0);
    expect(sent).toHaveLength(2);
  });

  it("moves on when another claimer wins the race", async () => {
    const { agent: poster } = await connect(POSTER);
    const id = (await poster.postBounty(bounty([apiCheck("api", NEAR / 100n)]))).job.id;
    const { agent: bot } = await connect("slow-bot.testnet", { refuseClaims: true });
    const events: [string, Record<string, unknown>][] = [];
    const worker = new BountyAgent(bot, { deploymentUrl: `${h.fixtureOrigin}/fixed`, artifactHash: "bot@1", maxBountyYocto: NEAR }, (e, f = {}) => events.push([e, f]), {
      check: (plan, url) => runPlan(plan, url, { policy: h.policy }),
    });
    expect(await worker.tick()).toBe(0);
    expect(events.find(([e, f]) => e === "skipped" && f.bounty === id)?.[1].reason).toMatch(/claim failed: INVALID_TRANSITION/);
  });

  it("screens out bounties it cannot or should not take before any network call", () => {
    const base = {
      id: "b",
      version: 1,
      roles: [],
      state: {
        status: "OPEN",
        termsHash: "",
        acceptedBy: { client: true, worker: false },
        terms: {
          client: { kind: "AGENT", nearAccountId: POSTER },
          worker: { kind: "AGENT", nearAccountId: "open-bounty" },
          totalYocto: "1",
          challengePeriodSec: 60,
          fundingDeadline: 1_000_000,
          expiresAt: 2_000_000,
          milestones: [apiCheck("api", 1n)],
          openBounty: true,
        },
        milestones: [],
      },
      calls: { claimBounty: {}, payout: {} },
    } as never;
    const cfg = { deploymentUrl: "https://x.example", artifactHash: "a", maxBountyYocto: 10n };
    expect(screen(base, cfg, 0)).toEqual({ take: true });
    expect(screen(base, cfg, 999_000)).toEqual({ take: false, reason: "claim deadline too close" });
    expect(screen({ ...(base as object), calls: { payout: {} } } as never, cfg, 0)).toMatchObject({ take: false });
    const github = structuredClone(base) as { state: { terms: { milestones: { verificationPlan: unknown }[] } } };
    github.state.terms.milestones[0]!.verificationPlan = { kind: "GITHUB_CHECKS", version: 1, repo: "a/b", branch: "main", requiredChecks: ["t"] };
    expect(screen(github as never, cfg, 0)).toEqual({ take: false, reason: "milestone api is not an HTTP API check" });
  });
});
