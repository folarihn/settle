#!/usr/bin/env node
/**
 * Live NEAR testnet end-to-end run against the deployed escrow contract.
 *
 * Runs the real API (local, not exposed), the real verification worker and verifier, and
 * drives every party through the agent SDK, which signs real testnet transactions.
 * Secrets arrive on stdin as JSON and are never printed:
 *   {"contract": "...testnet", "client": {"accountId","privateKey"}, "agent": {...},
 *    "verifierAccount": "...", "resolverAccount": "...", "verifierSeed": "<64 hex>",
 *    "apiUrl"?: "https://<deployment>", "workerDatabaseUrl"?: "postgres://..."}
 * With apiUrl, the parties use that deployed API and its hosted demo fixture (/fixture/broken
 * then /fixture/fixed). With workerDatabaseUrl this process acts as the verification worker;
 * without it, the deployment's own hosted worker does the verifying and this script waits.
 * Without it, a local API is started and a public GitHub API endpoint is used as the target.
 * "resumeAgreementId" continues an agreement (with the same milestones) from its challenge
 * window: finalize, payout, creative revision/approval and partial settlement. It needs no
 * database access, because these steps go only through the API and the chain.
 * Usage (after `pnpm build`):  <secrets json> | node scripts/testnet-e2e.mjs > report.json
 */
import { buildApp, createPgDb, createPgliteDb, configFromEnv, drainQueue, JobService, migrate, RpcChainReader, VerificationService } from "../apps/api/dist/index.js";
import { DEMO_PLAN } from "../apps/fixture-api/dist/index.js";
import { publicKeyFromSeed } from "../packages/domain/dist/index.js";
import { SettleAgent } from "../packages/agent-sdk/dist/index.js";

const RPC = "https://rpc.testnet.fastnear.com";
const NEAR = 10n ** 24n;
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const secrets = JSON.parse(await new Promise((res) => {
  let s = "";
  process.stdin.on("data", (d) => (s += d)).on("end", () => res(s));
}));

async function rpc(params) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "e2e", method: "query", params: { finality: "optimistic", ...params } }),
  });
  const j = await r.json();
  if (j.error || j.result?.error) throw new Error(JSON.stringify(j.error ?? j.result.error));
  return j.result;
}
const balance = async (id) => BigInt((await rpc({ request_type: "view_account", account_id: id })).amount);
const view = async (method, args) =>
  JSON.parse(Buffer.from((await rpc({
    request_type: "call_function",
    account_id: secrets.contract,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  })).result).toString());
const near = (y) => `${Number((y * 1000000n) / NEAR) / 1e6} NEAR`;

const config = configFromEnv(
  {
    NEAR_NETWORK: "testnet",
    NEAR_RPC_URL: RPC,
    SETTLE_ESCROW_CONTRACT: secrets.contract,
    SETTLE_VERIFIER_ACCOUNT: secrets.verifierAccount,
    SETTLE_VERIFIER_PUBLIC_KEY: publicKeyFromSeed(secrets.verifierSeed),
    SETTLE_RESOLVER_ACCOUNT: secrets.resolverAccount,
    SETTLE_ALLOW_EPHEMERAL_DB: "1",
  },
  "worker",
);
const live = Boolean(secrets.apiUrl);
const resume = secrets.resumeAgreementId ?? null;
const chain = new RpcChainReader(RPC, config.escrowContract);
const hostedWorker = live && !secrets.workerDatabaseUrl;
const db = resume || hostedWorker ? null : live ? createPgDb(secrets.workerDatabaseUrl) : createPgliteDb();
if (db) await migrate(db);
let app = null;
let verifications;
let apiUrl;
if (live) {
  apiUrl = secrets.apiUrl.replace(/\/+$/, "");
  if (db) verifications = new VerificationService(db, new JobService(db, chain, config), config);
} else {
  ({ app, verifications } = buildApp({ db, chain, config }));
  await app.listen({ port: 0, host: "127.0.0.1" });
  apiUrl = `http://127.0.0.1:${app.server.address().port}`;
}
const runVerifier = async () => (verifications ? drainQueue(verifications, { seedHex: secrets.verifierSeed }) : 0);

const report = { contract: secrets.contract, apiUrl: live ? apiUrl : "local (not exposed)", worker: hostedWorker ? "hosted" : "local", startedAt: new Date().toISOString(), txs: [], checks: [] };
const tx = (step, hash) => {
  report.txs.push({ step, hash, explorer: `https://testnet.nearblocks.io/txns/${hash}` });
  log(`tx ${step}: ${hash}`);
};
const check = (name, ok, detail) => {
  report.checks.push({ name, ok, detail });
  log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) throw new Error(`check failed: ${name}`);
};

try {
  const client = await SettleAgent.connect({ apiUrl, accountId: secrets.client.accountId, privateKey: secrets.client.privateKey });
  const agent = await SettleAgent.connect({ apiUrl, accountId: secrets.agent.accountId, privateKey: secrets.agent.privateKey });
  log("both parties logged in with NEP-413 signatures checked against testnet access keys");

  // The verification plan is locked into the agreement before funding.
  const plan = live
    ? DEMO_PLAN
    : {
        kind: "HTTP_API", version: 1, method: "GET", path: "/", expectedStatus: 200,
        assertions: [{ op: "type", path: "$.current_user_url", type: "string" }],
        timeoutMs: 10000, maxResponseBytes: 65536,
      };
  const targets = live
    ? { failing: `${apiUrl}/fixture/broken`, passing: `${apiUrl}/fixture/fixed` }
    : { failing: "https://api.github.com/settle-demo-missing", passing: "https://api.github.com" };
  report.targets = targets;
  const amounts = { api: (NEAR * 3n) / 10n, design: NEAR / 10n, copy: NEAR / 10n };
  const total = amounts.api + amounts.design + amounts.copy;
  const ms = async (i) => (await view("get_agreement", { agreement_id: id })).milestones[i];
  const syncUntil = async (pred) => {
    for (let i = 0; i < 10; i++) {
      const s = await client.sync(id);
      if (pred(s)) return s;
      await sleep(1500);
    }
    return client.sync(id);
  };
  let id = resume;
  if (!resume) {
  const job = await client.createJob({
    worker: { kind: "AGENT", nearAccountId: secrets.agent.accountId },
    totalYocto: total.toString(),
    milestones: [
      { id: "api", title: "API passes the locked check", type: "AUTOMATED", amountYocto: amounts.api.toString(), verificationPlan: plan },
      { id: "design", title: "Design, approved after a revision", type: "HUMAN_REVIEW", amountYocto: amounts.design.toString(),
        rubric: "Matches the brief.", maxRevisions: 1, partialCompensation: null },
      { id: "copy", title: "Copy, settled partially", type: "HUMAN_REVIEW", amountYocto: amounts.copy.toString(),
        rubric: "Clear launch copy.", maxRevisions: 1, partialCompensation: { condition: "DELIVERABLE_SUBMITTED", floorYocto: (amounts.copy / 2n).toString() } },
    ],
    challengePeriodSec: 60,
    fundingDeadline: Date.now() + 3600_000,
    expiresAt: Date.now() + 24 * 3600_000,
  });
  id = job.id;
  log(`agreement ${id}`);

  tx("create_agreement (client)", await client.execute(job.calls.createAgreement));
  tx("accept_terms (agent worker)", (await agent.actOnChain(id, { type: "ACCEPT_TERMS", termsHash: job.state.termsHash })).txHash);
  const heldBefore = BigInt(await view("get_total_held", {}));
  tx("fund (client)", await client.execute(job.calls.fund));
  // The API mirrors chain state at "final" finality, a couple of blocks behind inclusion.
  const synced = await syncUntil((s) => s.job.state.status === "FUNDED");
  check("contract terms hash equals the agreed terms", synced.chain.termsMatch === true);
  check("offchain mirror shows FUNDED after the onchain fund", synced.job.state.status === "FUNDED");
  check("escrow holds exactly the total", BigInt(await view("get_total_held", {})) - heldBefore === total, near(total));

  const verify = async (label, uri) => {
    tx(`submit ${label} (agent)`, (await agent.actOnChain(id, { type: "SUBMIT", milestoneId: "api", artifactHash: `commit-${label}`, uri })).txHash);
    const queuedAt = Date.now();
    const queued = await agent.requestVerification(id, "api");
    const dup = await client.requestVerification(id, "api").then(() => "accepted", (e) => e.code ?? e.message);
    check(`a second verification request for the same submission is refused (${label})`, ["IN_FLIGHT", "INVALID_TRANSITION"].includes(dup), dup);
    await runVerifier();
    const done = hostedWorker
      ? await agent.waitForVerification(queued.id, { timeoutMs: 240_000, intervalMs: 3000 })
      : await agent.getVerification(queued.id);
    if (hostedWorker) log(`hosted worker finished ${done.outcome} ${Math.round((Date.now() - queuedAt) / 1000)} s after queueing`);
    const ev = await agent.evidence(queued.id);
    tx(`record_verification ${done.outcome} (agent relays signed report)`, await agent.execute(done.contractCall));
    return { done, ev };
  };

  const fail = await verify("failing", targets.failing);
  check("failing endpoint produced FAIL", fail.done.outcome === "FAIL", fail.ev.evidence.checks.filter((c) => !c.ok).map((c) => `${c.check}: ${c.detail}`).join("; "));
  check("evidence matches the signed report", fail.ev.matchesReport === true);
  const afterFail = await ms(0);
  check("FAIL released nothing onchain", afterFail.status === "Pending" && afterFail.allocated === false, `onchain status ${afterFail.status}`);

  const pass = await verify("passing", targets.passing);
  check("passing endpoint produced PASS", pass.done.outcome === "PASS", `submission #${pass.done.submissionSeq}`);
  const afterPass = await ms(0);
  check("PASS opens the challenge window, nothing payable yet", afterPass.status === "VerifiedPendingChallenge" && !afterPass.allocated);
  const early = await agent.actOnChain(id, { type: "FINALIZE_CHALLENGE", milestoneId: "api" }).then(() => "accepted", (e) => e.code ?? e.message);
  check("finalizing inside the challenge window is refused", early === "DEADLINE", early);

  log("waiting for the 60 s challenge window to pass onchain...");
  await sleep(75_000);
  } else {
    report.resumed = true;
    const m = await ms(0);
    check("resumed agreement is in its challenge window after a real PASS", m.status === "VerifiedPendingChallenge" && !m.allocated, `onchain status ${m.status}`);
  }
  report.agreementId = id;
  tx("finalize_challenge (agent)", (await agent.actOnChain(id, { type: "FINALIZE_CHALLENGE", milestoneId: "api" })).txHash);

  const pay = async (milestoneId) => {
    const { job: j } = await client.getJob(id);
    await sleep(4000); // let earlier gas refunds land so balance deltas show only the payout
    const before = await balance(secrets.agent.accountId);
    tx(`payout ${milestoneId} (client triggers; agent pays no gas)`, await client.execute(j.calls.payout[milestoneId]));
    await sleep(6000); // transfer + callback receipts
    return (await balance(secrets.agent.accountId)) - before;
  };

  const gotApi = await pay("api");
  check("agent balance rose by exactly the API milestone", gotApi === amounts.api, near(gotApi));
  check("API milestone is Paid onchain", (await ms(0)).status === "Paid");
  const again = await client.execute((await client.getJob(id)).job.calls.payout.api ?? { contractId: secrets.contract, methodName: "payout", args: { agreement_id: id, milestone_id: "api" }, deposit: "0", gas: "60000000000000" }).then(() => "accepted", (e) => String(e.message ?? e).match(/INVALID_TRANSITION/)?.[0] ?? String(e.message ?? e).slice(0, 120));
  check("a second payout of the same milestone is rejected onchain", again === "INVALID_TRANSITION", again);

  // Creative milestone: revision, then approval.
  const d = { milestoneId: "design" };
  tx("submit design v1 (agent)", (await agent.actOnChain(id, { type: "SUBMIT", ...d, artifactHash: "design-v1", uri: "https://example.com/design-v1.png" })).txHash);
  tx("request_revision (client)", (await client.actOnChain(id, { type: "REQUEST_REVISION", ...d, feedback: "Increase contrast on mobile." })).txHash);
  const locked = (await ms(1));
  check("revision keeps design funds locked", locked.status === "RevisionRequested" && !locked.allocated);
  tx("submit design v2 (agent)", (await agent.actOnChain(id, { type: "SUBMIT", ...d, artifactHash: "design-v2", uri: "https://example.com/design-v2.png" })).txHash);
  tx("approve (client)", (await client.actOnChain(id, { type: "APPROVE", ...d })).txHash);
  const gotDesign = await pay("design");
  check("approval paid the full design milestone", gotDesign === amounts.design, near(gotDesign));

  // Creative milestone: agreed partial compensation.
  const c = { milestoneId: "copy" };
  const half = amounts.copy / 2n;
  tx("submit copy v1 (agent)", (await agent.actOnChain(id, { type: "SUBMIT", ...c, artifactHash: "copy-v1" })).txHash);
  tx("propose_settlement 50% (agent)", (await agent.actOnChain(id, { type: "PROPOSE_SETTLEMENT", ...c, workerYocto: half.toString() })).txHash);
  tx("accept_settlement (client)", (await client.actOnChain(id, { type: "ACCEPT_SETTLEMENT", ...c, workerYocto: half.toString() })).txHash);
  const gotCopy = await pay("copy");
  check("partial settlement paid the agent exactly the agreed half", gotCopy === half, near(gotCopy));
  const copyOnchain = await ms(2);
  check("client refund of the other half confirmed onchain", copyOnchain.client.paid === half.toString() && copyOnchain.worker.paid === half.toString(),
    `worker paid ${near(BigInt(copyOnchain.worker.paid))}, client refunded ${near(BigInt(copyOnchain.client.paid))}`);

  const final = await syncUntil((s) => s.job.state.status === "COMPLETED");
  const agreement = await view("get_agreement", { agreement_id: id });
  check("agreement Completed onchain and offchain", agreement.status === "Completed" && final.job.state.status === "COMPLETED");
  check("no divergence between offchain record and contract", final.chain.divergences.length === 0);
  report.workerReceived = near(amounts.api + amounts.design + half);
  report.clientRefunded = near(half);
  report.ok = true;
} catch (e) {
  report.ok = false;
  report.error = e instanceof Error ? e.message : String(e);
  log("ERROR", report.error);
} finally {
  report.finishedAt = new Date().toISOString();
  if (app) await app.close();
  if (db) await db.close();
  console.log(JSON.stringify(report, null, 2));
}
