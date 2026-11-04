#!/usr/bin/env node
/**
 * Runs the autonomous bounty agent until stopped (Ctrl+C).
 *
 *   SETTLE_API_URL=https://settle-9ewd.onrender.com
 *   NEAR_ACCOUNT_ID=<agent>.testnet
 *   NEAR_PRIVATE_KEY=ed25519:...          (the agent's own testnet key; never commit it)
 *   AGENT_DEPLOYMENT_URL=https://...      (the service this agent delivers; default: the hosted reference API)
 *   AGENT_ARTIFACT=<commit or version>    (what exactly is delivered; default bounty-agent@0.1.0)
 *   AGENT_MAX_BOUNTY_NEAR=0.05            (never claims more than this)
 */
import { SettleAgent } from "@settle/agent-sdk";
import { BountyAgent } from "./agent.js";

const env = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
};
const apiUrl = env("SETTLE_API_URL").replace(/\/+$/, "");
const accountId = env("NEAR_ACCOUNT_ID");
if (!accountId.endsWith(".testnet")) throw new Error("NEAR_ACCOUNT_ID must be a .testnet account");
const key = env("NEAR_PRIVATE_KEY");
if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{60,100}$/.test(key)) throw new Error("NEAR_PRIVATE_KEY must be ed25519:<base58>");
const maxNear = process.env.AGENT_MAX_BOUNTY_NEAR ?? "0.05";
const m = /^(\d+)(?:\.(\d{1,24}))?$/.exec(maxNear);
if (!m) throw new Error("AGENT_MAX_BOUNTY_NEAR must be a decimal NEAR amount");

const agent = await SettleAgent.connect({ apiUrl, accountId, privateKey: key as `ed25519:${string}` });
const config = (await agent.config()) as { network: string; fixtureBaseUrl?: string | null };
if (config.network !== "testnet") throw new Error("refusing to run against a non-testnet deployment");
const deploymentUrl = process.env.AGENT_DEPLOYMENT_URL ?? (config.fixtureBaseUrl ? `${config.fixtureBaseUrl}/fixed` : null);
if (!deploymentUrl) throw new Error("set AGENT_DEPLOYMENT_URL to the service this agent delivers");

const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(`${new Date().toISOString().slice(11, 19)}Z ${event.padEnd(26)} ${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(" ")}`);
const bounty = new BountyAgent(
  agent,
  { deploymentUrl, artifactHash: process.env.AGENT_ARTIFACT ?? "bounty-agent@0.1.0", maxBountyYocto: BigInt(m[1]! + (m[2] ?? "").padEnd(24, "0")) },
  log,
);
log("watching the bounty board", { account: accountId, deployment: deploymentUrl, max: `${maxNear} NEAR` });
for (;;) {
  try {
    await bounty.tick();
  } catch (e) {
    log("tick failed; retrying", { error: (e as Error).message.slice(0, 200) });
  }
  await new Promise((r) => setTimeout(r, 10_000));
}
