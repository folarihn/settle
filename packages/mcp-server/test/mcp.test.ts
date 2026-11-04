import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { KeyPair } from "near-api-js";
import { SettleAgent, type ContractCall } from "@settle/agent-sdk";
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
