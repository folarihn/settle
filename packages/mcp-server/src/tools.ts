import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { SettleApiError, type SettleAgent } from "@settle/agent-sdk";
import { z } from "zod";
import { summarize } from "./guide.js";
import { nearToYocto, yoctoToNear } from "./units.js";

export interface SettleMcpOptions {
  /** Largest agreement total this agent may create or fund, in yoctoNEAR. */
  maxAgreementYocto: bigint;
  /** How long settle_submit_work waits for an automated verification. */
  verificationWaitMs?: number;
}

const INSTRUCTIONS = `SETTLE lets you hire, or be hired by, humans and other AI agents with payment held in a NEAR testnet escrow contract.
Money only moves by the contract's rules: automated milestones pay after an independent verifier's signed PASS and a challenge window; human-review milestones pay after the client approves or both sides agree a split.
Typical client flow: settle_create_agreement -> (worker accepts) -> settle_fund_agreement -> (worker submits) -> settle_review for human-review milestones.
Typical worker flow: settle_list_agreements -> settle_accept_agreement -> (client funds) -> settle_submit_work -> payment arrives (settle_claim_payment if it does not).
Call settle_get_agreement whenever unsure: it returns nextSteps for your role. Amounts are NEAR decimal strings. Testnet only.`;

const AgreementId = z.string().min(1).max(80).describe("Agreement id, e.g. job_abc123");
const MilestoneId = z.string().min(1).max(64).describe("Milestone id within the agreement");

const ApiCheckMilestone = z.object({
  type: z.literal("api_check"),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).describe("Lowercase slug, unique in the agreement"),
  title: z.string().min(1).max(200),
  amountNear: z.string().describe('Payment for this milestone in NEAR, e.g. "0.1"'),
  useDemoPlan: z.boolean().optional().describe("Use the deployment's demo health check instead of writing one"),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
  path: z.string().optional().describe("Path the verifier calls on the submitted deployment, e.g. /health"),
  requestBody: z.record(z.unknown()).optional(),
  expectedStatus: z.number().int().optional(),
  assertions: z
    .array(z.record(z.unknown()))
    .optional()
    .describe('JSON checks on the response, e.g. {"op":"equals","path":"$.status","value":"ok"}; ops: exists, equals, type'),
  timeoutMs: z.number().int().optional(),
  sustained: z
    .object({ probes: z.number().int().min(2).max(20), intervalSeconds: z.number().int().min(1).max(60) })
    .optional()
    .describe("Sustained health: repeat the check this many times, this far apart (at most 2 minutes in total); every probe must pass"),
});

const GithubCiMilestone = z.object({
  type: z.literal("github_ci"),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  title: z.string().min(1).max(200),
  amountNear: z.string(),
  repo: z.string().describe("GitHub repository as owner/name"),
  branch: z.string().optional().describe("Branch the commit must be merged into (default main)"),
  requiredChecks: z.array(z.string().min(1)).min(1).max(20).describe('Names of CI check runs or commit statuses that must succeed, e.g. ["test"]'),
});

const HumanReviewMilestone = z.object({
  type: z.literal("human_review"),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  title: z.string().min(1).max(200),
  amountNear: z.string(),
  rubric: z.string().min(1).max(5000).describe("What the client will judge the deliverable against"),
  maxRevisions: z.number().int().min(0).max(10).optional(),
  guaranteedNear: z.string().optional().describe("Minimum the worker keeps once something is delivered, even if disputed"),
});

type MilestoneInput = z.infer<typeof ApiCheckMilestone> | z.infer<typeof GithubCiMilestone> | z.infer<typeof HumanReviewMilestone>;

const ok = (data: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const fail = (message: string): CallToolResult => ({ content: [{ type: "text", text: message }], isError: true });

/** Every tool returns errors as tool results (not protocol errors) so the model can read and recover. */
function guard<A>(fn: (args: A) => Promise<CallToolResult>) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return await fn(args);
    } catch (e) {
      if (e instanceof SettleApiError) return fail(`${e.code}: ${e.message.replace(/^[A-Z_]+: /, "")}`);
      return fail((e as Error).message);
    }
  };
}

/**
 * MCP server exposing SETTLE to any MCP-capable agent. It is a thin layer over the agent
 * SDK: same API, same contract rules, signed with the agent's own key.
 */
export async function createSettleMcpServer(agent: SettleAgent, opts: SettleMcpOptions): Promise<McpServer> {
  const config = (await agent.config()) as { network: string; escrowContract: string; demoPlan: unknown; fixtureBaseUrl?: string | null; verifierAccount: string };
  if (config.network !== "testnet") throw new Error(`refusing to run against ${config.network}: SETTLE's MCP server is testnet only`);
  const waitMs = opts.verificationWaitMs ?? 150_000;
  const server = new McpServer({ name: "settle", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  const me = agent.accountId;

  // Sync first so funding and payouts the chain already made show up in the summary.
  const view = async (id: string) => {
    const { job, chain } = await agent.sync(id);
    return summarize(job, chain, me);
  };
  const withinCap = (totalYocto: string) => {
    if (BigInt(totalYocto) > opts.maxAgreementYocto) {
      throw new Error(`total ${yoctoToNear(totalYocto)} NEAR exceeds this agent's limit of ${yoctoToNear(opts.maxAgreementYocto)} NEAR (SETTLE_MAX_AGREEMENT_NEAR)`);
    }
  };
  const toTerms = (m: MilestoneInput) => {
    const amountYocto = nearToYocto(m.amountNear);
    if (m.type === "human_review") {
      return {
        id: m.id,
        title: m.title,
        type: "HUMAN_REVIEW",
        amountYocto,
        rubric: m.rubric,
        maxRevisions: m.maxRevisions ?? 2,
        partialCompensation: m.guaranteedNear ? { condition: "DELIVERABLE_SUBMITTED", floorYocto: nearToYocto(m.guaranteedNear) } : null,
      };
    }
    if (m.type === "github_ci") {
      return {
        id: m.id,
        title: m.title,
        type: "AUTOMATED",
        amountYocto,
        verificationPlan: { kind: "GITHUB_CHECKS", version: 1, repo: m.repo, branch: m.branch ?? "main", requiredChecks: m.requiredChecks },
      };
    }
    const repeat = m.sustained ? { repeat: { count: m.sustained.probes, intervalMs: m.sustained.intervalSeconds * 1000 } } : {};
    const plan = m.useDemoPlan
      ? { ...(config.demoPlan as object), ...repeat }
      : {
          kind: "HTTP_API",
          version: 1,
          method: m.method ?? "GET",
          path: m.path ?? "/",
          ...(m.requestBody ? { requestBody: m.requestBody } : {}),
          expectedStatus: m.expectedStatus ?? 200,
          assertions: m.assertions ?? [],
          timeoutMs: m.timeoutMs ?? 10_000,
          maxResponseBytes: 65_536,
          ...repeat,
        };
    return { id: m.id, title: m.title, type: "AUTOMATED", amountYocto, verificationPlan: plan };
  };

  /** Queues a verification of the current submission and waits for its outcome (a timeout is reported, never treated as a result). */
  const verifyAndWait = async (agreementId: string, milestoneId: string) => {
    const queued = await agent.requestVerification(agreementId, milestoneId);
    try {
      const done = await agent.waitForVerification(queued.id, { timeoutMs: waitMs, intervalMs: 3000 });
      const outcome = done.outcome ?? done.status;
      return {
        verificationId: done.id,
        outcome,
        error: done.error,
        next:
          outcome === "PASS"
            ? "Passed. The result is recorded onchain, then paid after the challenge window."
            : outcome === "INCONCLUSIVE"
              ? "No definitive result yet (for example CI still running). Call settle_request_verification again later."
              : "Not passed: read the evidence with settle_check_verification, fix the work and submit again.",
      };
    } catch {
      return { verificationId: queued.id, outcome: "PENDING", next: "Still running; call settle_check_verification later." };
    }
  };

  server.registerTool(
    "settle_whoami",
    { description: "Your account, the network, the escrow contract and your spending limit.", inputSchema: {}, annotations: { readOnlyHint: true } },
    guard(async () =>
      ok({
        account: me,
        network: config.network,
        escrowContract: config.escrowContract,
        verifier: config.verifierAccount,
        maxAgreementNear: yoctoToNear(opts.maxAgreementYocto),
        demoDeployments: config.fixtureBaseUrl ? { failing: `${config.fixtureBaseUrl}/broken`, passing: `${config.fixtureBaseUrl}/fixed` } : null,
      }),
    ),
  );

  server.registerTool(
    "settle_list_agreements",
    { description: "Agreements where you are client, worker or resolver, newest first.", inputSchema: {}, annotations: { readOnlyHint: true } },
    guard(async () => {
      const { jobs } = await agent.listJobs();
      return ok(
        jobs.map((j) => ({
          agreementId: j.id,
          yourRoles: j.roles,
          status: j.state.status,
          counterparty: j.roles.includes("client") ? j.state.terms.worker.nearAccountId : j.state.terms.client.nearAccountId,
          totalNear: yoctoToNear(j.state.terms.totalYocto),
          milestones: j.state.milestones.map((m) => `${m.id}: ${m.status}`),
        })),
      );
    }),
  );

  server.registerTool(
    "settle_get_agreement",
    { description: "Full status of one agreement, the onchain view, and the next steps open to you.", inputSchema: { agreementId: AgreementId }, annotations: { readOnlyHint: true } },
    guard(async ({ agreementId }) => ok(await view(agreementId))),
  );

  server.registerTool(
    "settle_create_agreement",
    {
      description:
        "Hire a worker (human or AI agent): fixes milestones, payments and checks, then publishes the agreement onchain. You become the client. Nothing is paid until you fund it. Milestone types: api_check (the verifier calls the worker's deployed API, optionally repeatedly), github_ci (pays when a commit merged into the branch passes the named CI checks), human_review (you judge it).",
      inputSchema: {
        worker: z.string().describe("Worker's NEAR testnet account, e.g. alice.testnet"),
        workerKind: z.enum(["AGENT", "HUMAN"]).optional(),
        milestones: z.array(z.discriminatedUnion("type", [ApiCheckMilestone, GithubCiMilestone, HumanReviewMilestone])).min(1).max(10),
        challengePeriodMinutes: z.number().int().min(1).max(43_200).optional().describe("Time you have to challenge a PASS before payout (default 60)"),
        fundWithinHours: z.number().positive().max(720).optional(),
        expiresInDays: z.number().positive().max(365).optional(),
      },
    },
    guard(async (a) => {
      const milestones = a.milestones.map(toTerms);
      const total = milestones.reduce((s, m) => s + BigInt(m.amountYocto), 0n).toString();
      withinCap(total);
      const now = Date.now();
      const job = await agent.createJob({
        worker: { kind: a.workerKind ?? "AGENT", nearAccountId: a.worker },
        totalYocto: total,
        milestones,
        challengePeriodSec: (a.challengePeriodMinutes ?? 60) * 60,
        fundingDeadline: now + (a.fundWithinHours ?? 24) * 3_600_000,
        expiresAt: now + (a.expiresInDays ?? 14) * 86_400_000,
      });
      const txHash = await agent.execute(job.calls.createAgreement!);
      return ok({ created: job.id, createTx: txHash, totalNear: yoctoToNear(total), next: `Share the id ${job.id} with ${a.worker}; once they accept, call settle_fund_agreement.` });
    }),
  );

  server.registerTool(
    "settle_publish_agreement",
    { description: "Client: (re)send create_agreement onchain if creating it failed earlier.", inputSchema: { agreementId: AgreementId } },
    guard(async ({ agreementId }) => {
      const { job, chain } = await agent.getJob(agreementId);
      if (chain.agreement) return fail("the agreement is already onchain");
      if (!job.calls.createAgreement) return fail(`agreement is ${job.state.status}; nothing to publish`);
      return ok({ createTx: await agent.execute(job.calls.createAgreement) });
    }),
  );

  server.registerTool(
    "settle_accept_agreement",
    { description: "Worker: accept the exact terms (signed onchain). Read them with settle_get_agreement first.", inputSchema: { agreementId: AgreementId } },
    guard(async ({ agreementId }) => {
      const { job } = await agent.getJob(agreementId);
      const r = await agent.actOnChain(agreementId, { type: "ACCEPT_TERMS", termsHash: job.state.termsHash });
      return ok({ acceptTx: r.txHash, next: "Wait for the client to fund escrow." });
    }),
  );

  server.registerTool(
    "settle_fund_agreement",
    { description: "Client: deposit the agreed total into the escrow contract. Only after the worker has accepted.", inputSchema: { agreementId: AgreementId } },
    guard(async ({ agreementId }) => {
      const { job } = await agent.getJob(agreementId);
      withinCap(job.state.terms.totalYocto);
      const r = await agent.fund(agreementId);
      return ok({ fundTx: r.txHash, status: r.job.state.status, depositedNear: yoctoToNear(job.state.terms.totalYocto) });
    }),
  );

  server.registerTool(
    "settle_submit_work",
    {
      description:
        "Worker: submit a milestone and, for automated ones, wait for the independent verifier. API check: url = base URL of your deployment. GitHub CI: artifactHash = the full commit SHA merged into the agreed branch (url optional, e.g. the pull request). Human review: url = link to the deliverable.",
      inputSchema: {
        agreementId: AgreementId,
        milestoneId: MilestoneId,
        url: z.string().url().optional().describe("Deployment base URL (API check), pull request (GitHub CI, optional) or deliverable link (human review)"),
        artifactHash: z.string().min(1).max(200).describe("Git commit SHA or content hash identifying exactly what you deliver"),
      },
    },
    guard(async (a) => {
      const { job } = await agent.getJob(a.agreementId);
      const terms = job.state.terms.milestones.find((m) => m.id === a.milestoneId);
      const plan = terms?.type === "AUTOMATED" ? (terms.verificationPlan as { kind: string }) : null;
      if (plan?.kind === "HTTP_API" && !a.url) return fail("an API check needs url: the base URL of your deployment");
      const sub = await agent.actOnChain(a.agreementId, { type: "SUBMIT", milestoneId: a.milestoneId, artifactHash: a.artifactHash, ...(a.url ? { uri: a.url } : {}) });
      if (!plan) return ok({ submitTx: sub.txHash, next: "The client reviews it; check back with settle_get_agreement." });
      return ok({ submitTx: sub.txHash, ...(await verifyAndWait(a.agreementId, a.milestoneId)) });
    }),
  );

  server.registerTool(
    "settle_request_verification",
    {
      description:
        "Worker or client: run the verifier again on the current submission, e.g. when GitHub CI had not finished (INCONCLUSIVE) or the deployment was briefly unreachable. Waits for the result.",
      inputSchema: { agreementId: AgreementId, milestoneId: MilestoneId },
    },
    guard(async (a) => ok(await verifyAndWait(a.agreementId, a.milestoneId))),
  );

  server.registerTool(
    "settle_check_verification",
    {
      description:
        "Status, outcome and evidence of a verification. With record=true, also relays the signed result onchain if the contract is still waiting for it (only needed where the service does not do it automatically).",
      inputSchema: { verificationId: z.string().min(1).max(80), record: z.boolean().optional() },
      annotations: { readOnlyHint: false },
    },
    guard(async ({ verificationId, record }) => {
      const v = await agent.getVerification(verificationId);
      const evidence = v.status === "DONE" ? await agent.evidence(verificationId) : null;
      let recordTx: string | null = null;
      if (record && v.contractCall) {
        const args = v.contractCall.args as { agreement_id: string; milestone_id: string };
        const { job, chain } = await agent.getJob(args.agreement_id);
        const i = job.state.milestones.findIndex((m) => m.id === args.milestone_id);
        const onchain = chain.agreement?.milestones[i];
        if (onchain?.status === "Submitted" && onchain.submission?.seq === v.submissionSeq) recordTx = await agent.execute(v.contractCall);
      }
      return ok({ ...v, contractCall: undefined, evidence, recordTx });
    }),
  );

  server.registerTool(
    "settle_review",
    {
      description:
        "Client: decide on a submitted milestone. approve pays it in full; request_revision sends it back with feedback; open_dispute (human review) or challenge (automated, during the challenge window) stops payout for settlement or the resolver.",
      inputSchema: {
        agreementId: AgreementId,
        milestoneId: MilestoneId,
        decision: z.enum(["approve", "request_revision", "open_dispute", "challenge"]),
        reason: z.string().max(5000).optional().describe("Required for request_revision, open_dispute and challenge"),
      },
    },
    guard(async (a) => {
      const needsReason = a.decision !== "approve";
      if (needsReason && !a.reason?.trim()) return fail(`${a.decision} needs a reason`);
      const action =
        a.decision === "approve"
          ? { type: "APPROVE" }
          : a.decision === "request_revision"
            ? { type: "REQUEST_REVISION", feedback: a.reason }
            : { type: a.decision === "challenge" ? "CHALLENGE" : "OPEN_DISPUTE", reason: a.reason };
      const r = await agent.actOnChain(a.agreementId, { ...action, milestoneId: a.milestoneId });
      return ok({ tx: r.txHash, milestone: r.job.state.milestones.find((m) => m.id === a.milestoneId)?.status });
    }),
  );

  server.registerTool(
    "settle_settlement",
    {
      description: "Either party on a human-review milestone: propose how much of the milestone the worker gets (the rest is refunded), or accept the other side's proposal.",
      inputSchema: {
        agreementId: AgreementId,
        milestoneId: MilestoneId,
        action: z.enum(["propose", "accept"]),
        workerNear: z.string().optional().describe("Worker's share in NEAR; required to propose, defaults to the proposal when accepting"),
      },
    },
    guard(async (a) => {
      let workerYocto: string;
      if (a.workerNear) workerYocto = nearToYocto(a.workerNear);
      else if (a.action === "accept") {
        const { job } = await agent.getJob(a.agreementId);
        const p = job.state.milestones.find((m) => m.id === a.milestoneId)?.settlementProposal;
        if (!p) return fail("there is no proposal to accept");
        workerYocto = p.workerYocto;
      } else return fail("propose needs workerNear");
      const r = await agent.actOnChain(a.agreementId, { type: a.action === "propose" ? "PROPOSE_SETTLEMENT" : "ACCEPT_SETTLEMENT", milestoneId: a.milestoneId, workerYocto });
      return ok({ tx: r.txHash, workerNear: yoctoToNear(workerYocto), milestone: r.job.state.milestones.find((m) => m.id === a.milestoneId)?.status });
    }),
  );

  server.registerTool(
    "settle_finalize",
    { description: "Any party: close the challenge window of a passed milestone after it ends, making it payable.", inputSchema: { agreementId: AgreementId, milestoneId: MilestoneId } },
    guard(async (a) => {
      const r = await agent.actOnChain(a.agreementId, { type: "FINALIZE_CHALLENGE", milestoneId: a.milestoneId });
      return ok({ tx: r.txHash, milestone: r.job.state.milestones.find((m) => m.id === a.milestoneId)?.status });
    }),
  );

  server.registerTool(
    "settle_claim_payment",
    { description: "Either party: send the payout of a payable milestone. The contract pays the fixed split; nobody can change the amounts.", inputSchema: { agreementId: AgreementId, milestoneId: MilestoneId } },
    guard(async (a) => {
      const r = await agent.claimPayment(a.agreementId, a.milestoneId);
      return ok({ payoutTx: r.txHash, milestone: r.job.state.milestones.find((m) => m.id === a.milestoneId)?.status });
    }),
  );

  return server;
}
