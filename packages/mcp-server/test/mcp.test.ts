import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { KeyPair } from "near-api-js";
import { SettleAgent, type ContractCall } from "@settle/agent-sdk";
import { computeOnchainTermsHash } from "@settle/domain";
import { onchainFunded, startHarness, type Harness } from "../../../apps/api/test/harness.js";
import { createSettleMcpServer, nearToYocto, yoctoToNear } from "../src/index.js";

const BUYER = "buyer-agent.testnet";
const SELLER = "seller-agent.testnet";

let h: Harness;
let apiUrl: string;
let drain: ReturnType<typeof setInterval>;
beforeAll(async () => {
  h = await startHarness();
  await h.app.listen({ port: 0, host: "127.0.0.1" });
  apiUrl = `http://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
  // Stands in for the verification worker: runs queued verifications in the background.
  drain = setInterval(() => void h.runVerifier().catch(() => undefined), 100);
});
afterAll(async () => {
  clearInterval(drain);
  await h.close();
});

/** An MCP client connected to a SETTLE MCP server for one agent. Onchain calls are captured and applied to the fake chain as the contract would. */
async function mcpAgent(accountId: string, sent: ContractCall[], maxNear = "1") {
  const key = KeyPair.fromRandom("ed25519");
  h.chain.keys.set(key.getPublicKey().toString(), { accountId, permission: "FullAccess" });
  const agent: SettleAgent = await SettleAgent.connect({
    apiUrl,
    accountId,
    privateKey: key.toString() as `ed25519:${string}`,
    executor: {
      execute: async (call) => {
        sent.push(call);
        const id = (call.args.agreement_id ?? (call.args.terms as { agreement_id: string }).agreement_id) as string;
        if (call.methodName === "create_agreement") {
          const { job } = await agent.getJob(id);
          h.chain.agreements.set(id, { ...onchainFunded(job.state as never), status: "Draft", accepted_by_worker: false, funded_at_ms: null });
        }
        if (call.methodName === "accept_terms") h.chain.agreements.get(id)!.accepted_by_worker = true;
        if (call.methodName === "fund") h.chain.agreements.get(id)!.status = "Funded";
        if (call.methodName === "post_bounty") {
          const { job } = await agent.getJob(id);
          h.chain.agreements.set(id, { ...onchainFunded(job.state as never), status: "Open", accepted_by_worker: false, funded_at_ms: null });
        }
        if (call.methodName === "claim_bounty") {
          // Like the contract: first claimer wins, the worker and terms hash change.
          const a = h.chain.agreements.get(id)!;
          if (a.status !== "Open") throw new Error("INVALID_TRANSITION: not an open bounty");
          a.terms = { ...a.terms, worker: accountId };
          a.terms_hash = computeOnchainTermsHash(a.terms);
          a.status = "Funded";
          a.accepted_by_worker = true;
        }
        if (call.methodName === "cancel_bounty") h.chain.agreements.get(id)!.status = "Cancelled";
        return `tx-${accountId}-${sent.length}`;
      },
    },
  });
  const server = await createSettleMcpServer(agent, { maxAgreementYocto: BigInt(nearToYocto(maxNear)), verificationWaitMs: 15_000 });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    const text = r.content[0]!.text;
    return { isError: r.isError === true, text, json: r.isError ? null : JSON.parse(text) };
  };
  return { call, client };
}

describe("units", () => {
  it("converts NEAR decimals exactly and rejects anything ambiguous", () => {
    expect(nearToYocto("0.1")).toBe("100000000000000000000000");
    expect(nearToYocto("1.000000000000000000000001")).toBe("1000000000000000000000001");
    expect(yoctoToNear("150000000000000000000000")).toBe("0.15");
    for (const bad of ["1e3", "-1", ".5", "0.1234567890123456789012345", "NaN", ""]) expect(() => nearToYocto(bad)).toThrow();
  });
});

describe("MCP server: an AI agent hires another AI agent", () => {
  it("runs create, accept, fund, failing and passing API checks, human review and payout through tools only", async () => {
    const buyerTx: ContractCall[] = [];
    const sellerTx: ContractCall[] = [];
    const buyer = await mcpAgent(BUYER, buyerTx);
    const seller = await mcpAgent(SELLER, sellerTx);

    const tools = (await buyer.client.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(["settle_create_agreement", "settle_submit_work", "settle_claim_payment"]));

    const created = await buyer.call("settle_create_agreement", {
      worker: SELLER,
      milestones: [
        { type: "api_check", id: "api", title: "Health endpoint", amountNear: "0.2", useDemoPlan: true },
        { type: "human_review", id: "report", title: "Write-up", amountNear: "0.1", rubric: "Explains the fix.", guaranteedNear: "0.05" },
      ],
    });
    expect(created.text).not.toMatch(/^[A-Z_]+:/);
    expect(created.isError).toBe(false);
    const id = created.json.created as string;
    expect(buyerTx.at(-1)).toMatchObject({ methodName: "create_agreement" });

    // The seller sees the offer as an agent-to-agent agreement and is told what to do.
    const offer = (await seller.call("settle_get_agreement", { agreementId: id })).json;
    expect(offer).toMatchObject({ yourRoles: ["worker"], client: { kind: "AGENT", nearAccountId: BUYER }, totalNear: "0.3" });
    expect(offer.nextSteps.join(" ")).toContain("settle_accept_agreement");

    await seller.call("settle_accept_agreement", { agreementId: id });
    const funded = await buyer.call("settle_fund_agreement", { agreementId: id });
    expect(funded.json).toMatchObject({ status: "FUNDED", depositedNear: "0.3" });
    expect(buyerTx.at(-1)).toMatchObject({ methodName: "fund", deposit: nearToYocto("0.3") });

    const broken = await seller.call("settle_submit_work", { agreementId: id, milestoneId: "api", url: `${h.fixtureOrigin}/broken`, artifactHash: "c-broken" });
    expect(broken.json.outcome).toBe("FAIL");
    const evidence = (await seller.call("settle_check_verification", { verificationId: broken.json.verificationId })).json;
    expect(evidence.evidence.matchesReport).toBe(true);
    const fixed = await seller.call("settle_submit_work", { agreementId: id, milestoneId: "api", url: `${h.fixtureOrigin}/fixed`, artifactHash: "c-fixed" });
    expect(fixed.json.outcome).toBe("PASS");

    // A passed check is only payable after the challenge window.
    expect((await seller.call("settle_claim_payment", { agreementId: id, milestoneId: "api" })).isError).toBe(true);
    expect((await seller.call("settle_finalize", { agreementId: id, milestoneId: "api" })).text).toContain("challenge period has not ended");

    await seller.call("settle_submit_work", { agreementId: id, milestoneId: "report", url: "https://example.com/report.md", artifactHash: "sha256-report" });
    expect((await seller.call("settle_review", { agreementId: id, milestoneId: "report", decision: "approve" })).isError).toBe(true); // only the client reviews
    expect((await buyer.call("settle_review", { agreementId: id, milestoneId: "report", decision: "request_revision" })).text).toContain("needs a reason");
    const approved = await buyer.call("settle_review", { agreementId: id, milestoneId: "report", decision: "approve" });
    expect(approved.json.milestone).toBe("CLAIMABLE");
    const paid = await seller.call("settle_claim_payment", { agreementId: id, milestoneId: "report" });
    expect(paid.isError).toBe(false);
    expect(sellerTx.at(-1)).toMatchObject({ methodName: "payout", args: { agreement_id: id, milestone_id: "report" }, deposit: "0" });
  });

  it("pays a GitHub CI bounty: INCONCLUSIVE while CI runs, PASS once the merged commit's checks succeed", async () => {
    let checks = [{ id: 1, name: "test", status: "in_progress", conclusion: null as string | null }];
    const github: Server = createServer((req, res) => {
      const url = req.url ?? "";
      const body = url.includes("/compare/") ? { status: "identical" } : url.includes("/check-runs") ? { check_runs: checks } : { statuses: [] };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    });
    await new Promise<void>((r) => github.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(github.address() as AddressInfo).port}`;
    h.policy.insecureTestOrigins.push(base);
    h.verifyDeps.githubApiBase = base;
    try {
      const buyer = await mcpAgent(BUYER, []);
      const seller = await mcpAgent(SELLER, []);
      const id = (
        await buyer.call("settle_create_agreement", {
          worker: SELLER,
          milestones: [{ type: "github_ci", id: "fix", title: "Fix the flaky test", amountNear: "0.1", repo: "acme/widget", requiredChecks: ["test"] }],
        })
      ).json.created as string;
      const offer = (await seller.call("settle_get_agreement", { agreementId: id })).json;
      expect(offer.milestones[0]).toMatchObject({ kind: "GitHub CI checks", check: { repo: "acme/widget", branch: "main", requiredChecks: ["test"] } });
      await seller.call("settle_accept_agreement", { agreementId: id });
      await buyer.call("settle_fund_agreement", { agreementId: id });
      expect((await seller.call("settle_get_agreement", { agreementId: id })).json.nextSteps.join(" ")).toContain("full commit SHA");

      const sha = "b".repeat(40);
      const first = await seller.call("settle_submit_work", { agreementId: id, milestoneId: "fix", artifactHash: sha });
      expect(first.json.outcome).toBe("INCONCLUSIVE");
      expect(first.json.next).toContain("settle_request_verification");

      checks = [{ id: 1, name: "test", status: "completed", conclusion: "success" }];
      const again = await seller.call("settle_request_verification", { agreementId: id, milestoneId: "fix" });
      expect(again.json.outcome).toBe("PASS");
      expect((await seller.call("settle_get_agreement", { agreementId: id })).json.milestones[0].status).toBe("VERIFIED_PENDING_CHALLENGE");
    } finally {
      delete h.verifyDeps.githubApiBase;
      github.closeAllConnections();
      await new Promise((r) => github.close(r));
    }
  });

  it("posts an open bounty that the first agent to claim wins, and a late claimer is refused", async () => {
    const poster = await mcpAgent(BUYER, []);
    const winner = await mcpAgent(SELLER, []);
    const late = await mcpAgent("late-agent.testnet", []);
    const posted = await poster.call("settle_post_bounty", {
      milestones: [{ type: "api_check", id: "api", title: "Health endpoint", amountNear: "0.2", useDemoPlan: true }],
    });
    expect(posted.json).toMatchObject({ status: "OPEN", escrowedNear: "0.2" });
    const id = posted.json.bounty as string;

    const board = (await winner.call("settle_list_bounties")).json;
    expect(board.find((b: { agreementId: string }) => b.agreementId === id)).toMatchObject({ client: BUYER, totalNear: "0.2", youCanClaim: true });
    expect((await winner.call("settle_get_agreement", { agreementId: id })).json.nextSteps.join(" ")).toContain("settle_claim_bounty");
    expect((await poster.call("settle_get_agreement", { agreementId: id })).json.nextSteps.join(" ")).toContain("settle_cancel_bounty");

    const claimed = await winner.call("settle_claim_bounty", { agreementId: id });
    expect(claimed.json).toMatchObject({ status: "FUNDED" });
    const lateTry = await late.call("settle_claim_bounty", { agreementId: id });
    expect(lateTry.isError).toBe(true);

    const view = (await winner.call("settle_get_agreement", { agreementId: id })).json;
    expect(view).toMatchObject({ yourRoles: ["worker"], status: "FUNDED", worker: { nearAccountId: SELLER } });
    const work = await winner.call("settle_submit_work", { agreementId: id, milestoneId: "api", url: `${h.fixtureOrigin}/fixed`, artifactHash: "c-fixed" });
    expect(work.json.outcome).toBe("PASS");

    // The poster can withdraw an unclaimed bounty, and spending limits apply to bounties too.
    const second = (await poster.call("settle_post_bounty", { milestones: [{ type: "human_review", id: "doc", title: "Docs", amountNear: "0.1", rubric: "Clear." }] })).json.bounty;
    expect((await poster.call("settle_cancel_bounty", { agreementId: second })).json.status).toBe("CANCELLED");
    const tooBig = await poster.call("settle_post_bounty", { milestones: [{ type: "human_review", id: "doc", title: "Docs", amountNear: "5", rubric: "Clear." }] });
    expect(tooBig.text).toContain("exceeds this agent's limit");
  });

  it("refuses agreements above the agent's spending limit before anything is created or signed", async () => {
    const sent: ContractCall[] = [];
    const buyer = await mcpAgent(BUYER, sent, "0.5");
    const before = (await buyer.call("settle_list_agreements")).json.length;
    const r = await buyer.call("settle_create_agreement", {
      worker: SELLER,
      milestones: [{ type: "api_check", id: "api", title: "x", amountNear: "0.6", useDemoPlan: true }],
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("exceeds this agent's limit of 0.5 NEAR");
    expect(sent).toHaveLength(0);
    expect((await buyer.call("settle_list_agreements")).json.length).toBe(before);
  });

  it("refuses to start against a non-testnet deployment", async () => {
    const fake = { config: async () => ({ network: "mainnet" }), accountId: BUYER } as unknown as SettleAgent;
    await expect(createSettleMcpServer(fake, { maxAgreementYocto: 1n })).rejects.toThrow("testnet only");
  });
});
