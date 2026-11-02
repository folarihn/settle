#!/usr/bin/env node
/**
 * Demo: an AI agent acting as the worker on a funded job, using only the SDK.
 * It submits the broken fixture deployment (real FAIL), relays the signed report
 * onchain, then submits the fixed deployment (real PASS) and relays that too.
 *
 *   SETTLE_API_URL=https://<api-host>  NEAR_ACCOUNT_ID=<agent>.testnet
 *   NEAR_PRIVATE_KEY=ed25519:...   (the agent's own testnet key, from your secret store)
 *   JOB_ID=job_...   FIXTURE_BASE=https://<api-host>/fixture
 *   node dist/demo-worker.js
 */
import type { KeyPairString } from "near-api-js";
import { SettleAgent } from "./index.js";

const env = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
};

const agent = await SettleAgent.connect({
  apiUrl: env("SETTLE_API_URL"),
  accountId: env("NEAR_ACCOUNT_ID"),
  privateKey: env("NEAR_PRIVATE_KEY") as KeyPairString,
});
const jobId = env("JOB_ID");
const fixture = env("FIXTURE_BASE").replace(/\/+$/, "");

const { job } = await agent.getJob(jobId);
if (job.state.milestones[0]?.status === undefined) throw new Error("job has no milestones");
const state = job.state as unknown as { status: string; acceptedBy: { worker: boolean }; termsHash: string };
if (!state.acceptedBy.worker) {
  const r = await agent.actOnChain(jobId, { type: "ACCEPT_TERMS", termsHash: state.termsHash });
  console.log(`accepted terms onchain: tx ${r.txHash}`);
}
const synced = (await agent.sync(jobId)).job as { state: { status: string } };
if (synced.state.status !== "FUNDED") {
  console.log("Job is not funded yet. Ask the client to fund escrow, then run this again.");
  process.exit(0);
}

for (const deployment of ["broken", "fixed"]) {
  const sub = await agent.actOnChain(jobId, {
    type: "SUBMIT",
    milestoneId: "api",
    artifactHash: `demo-${deployment}`,
    uri: `${fixture}/${deployment}`,
  });
  console.log(`submitted ${deployment}: tx ${sub.txHash}`);
  const queued = await agent.requestVerification(jobId, "api");
  const done = await agent.waitForVerification(queued.id);
  console.log(`verification ${done.id}: ${done.outcome ?? done.status}${done.error ? ` (${done.error})` : ""}`);
  if (done.contractCall) console.log(`  report relayed onchain: tx ${await agent.execute(done.contractCall)}`);
}
console.log("Done. After the challenge window, finalize and pay out from the web app or via agent.actOnChain.");
