#!/usr/bin/env node
/**
 * Swarm runner (ADR 0006). The only process that holds swarm agents' keys; it never holds the
 * verifier seed or the keeper key (configFromEnv refuses). Settings:
 *
 *   SETTLE_DATABASE_URL, SETTLE_ESCROW_CONTRACT, SETTLE_VERIFIER_ACCOUNT, SETTLE_VERIFIER_PUBLIC_KEY,
 *   SETTLE_RESOLVER_ACCOUNT          same as the API
 *   SETTLE_API_URL                   the API agents talk to (normally the public URL)
 *   NEAR_AI_API_KEY                  NEAR AI Cloud key (set a spend limit on it in the dashboard)
 *   NEAR_AI_MODEL                    default z-ai/glm-5.3-flash
 *   SETTLE_SWARM_SECRET              64 hex chars; encrypts agent keys at rest
 *   SETTLE_SWARM_OPERATOR            account that receives inference fees (it pays the NEAR AI bill)
 *   SETTLE_SWARM_NEAR_USD            NEAR/USD rate used to charge inference, e.g. 2.5
 */
import { SettleAgent } from "@settle/agent-sdk";
import { configFromEnv, createPgDb, migrate, startWakeServer } from "@settle/api";
import { modelPricing, NearAi } from "@settle/near-ai";
import { Account, type KeyPairString } from "near-api-js";
import { SwarmRunner } from "./runner.js";

const env = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
};
const config = configFromEnv(process.env, "swarm");
if (!config.databaseUrl) throw new Error("the swarm runner needs SETTLE_DATABASE_URL (Postgres)");
if (config.network !== "testnet") throw new Error("the swarm runner is testnet only");
const secretHex = env("SETTLE_SWARM_SECRET");
if (!/^[0-9a-f]{64}$/.test(secretHex)) throw new Error("SETTLE_SWARM_SECRET must be 64 hex characters");
const nearUsd = env("SETTLE_SWARM_NEAR_USD");
if (!/^\d+(\.\d+)?$/.test(nearUsd) || Number(nearUsd) <= 0) throw new Error("SETTLE_SWARM_NEAR_USD must be a positive number");
const apiUrl = env("SETTLE_API_URL").replace(/\/+$/, "");

const ai = new NearAi({ apiKey: env("NEAR_AI_API_KEY"), ...(process.env.NEAR_AI_MODEL ? { model: process.env.NEAR_AI_MODEL } : {}) });
const pricing = await modelPricing(ai.model);
const db = createPgDb(config.databaseUrl);
await migrate(db);

const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(`${event.padEnd(24)} ${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(" ")}`);

const runner = new SwarmRunner({
  db,
  ai,
  pricing,
  secretKey: Buffer.from(secretHex, "hex"),
  // Deliverable links point at the public API (which serves /d/<hash>), not at this runner.
  publicUrl: apiUrl,
  operator: env("SETTLE_SWARM_OPERATOR"),
  nearUsd,
  log,
  connect: (accountId: string, secret: KeyPairString) => SettleAgent.connect({ apiUrl, accountId, privateKey: secret }),
  chain: {
    balance: async (accountId) => {
      try {
        return await new Account(accountId, config.rpcUrl).getBalance();
      } catch {
        return null;
      }
    },
    transfer: async (from, secret, to, yocto) => {
      const res = await new Account(from, config.rpcUrl, secret).transfer({ receiverId: to, amount: yocto });
      return res.transaction.hash;
    },
  },
});

if (process.env.PORT) startWakeServer(Number(process.env.PORT));
log("swarm runner started", { model: ai.model, inUsdPerM: (pricing.inputNanoUsdPerToken / 1000).toFixed(3), outUsdPerM: (pricing.outputNanoUsdPerToken / 1000).toFixed(3) });
for (;;) {
  try {
    await runner.tick();
  } catch (e) {
    log("tick failed", { error: (e as Error).message.slice(0, 200) });
  }
  await new Promise((r) => setTimeout(r, 10_000));
}
