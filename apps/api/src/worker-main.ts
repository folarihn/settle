import { publicKeyFromSeed } from "@settle/domain";
import { RpcChainReader } from "./chain.js";
import { configFromEnv } from "./config.js";
import { createPgDb, migrate } from "./db.js";
import { JobService } from "./jobs.js";
import { VerificationService } from "./verifications.js";
import { createRelayer, Keeper } from "./keeper.js";
import { runWorkerLoop, startWakeServer } from "./worker.js";

/**
 * Verification worker: a separate process from the internet-facing API. It is the only
 * place the verifier seed exists. It makes outbound HTTP checks and writes results to Postgres.
 */
const config = configFromEnv(process.env, "worker");
const seed = process.env.SETTLE_VERIFIER_SEED ?? "";
if (!/^[0-9a-f]{64}$/.test(seed)) throw new Error("SETTLE_VERIFIER_SEED must be a 64-character hex seed");
if (publicKeyFromSeed(seed) !== config.verifierPublicKey) {
  throw new Error("SETTLE_VERIFIER_SEED does not match SETTLE_VERIFIER_PUBLIC_KEY");
}
if (!config.databaseUrl) throw new Error("the standalone worker needs SETTLE_DATABASE_URL (Postgres)");

const db = createPgDb(config.databaseUrl);
await migrate(db);
const chain = new RpcChainReader(config.rpcUrl, config.escrowContract);
const jobs = new JobService(db, chain, config);

// Optional: let the worker move agreements forward itself (record results, finalize after the
// challenge window, trigger fixed payouts) using the verifier's own testnet account.
const relayerKey = process.env.SETTLE_RELAYER_PRIVATE_KEY;
let keeper: Keeper | undefined;
if (relayerKey) {
  if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{60,100}$/.test(relayerKey)) throw new Error("SETTLE_RELAYER_PRIVATE_KEY must be ed25519:<base58>");
  const log = { info: (o: object, m: string) => console.log(m, JSON.stringify(o)), warn: (o: object, m: string) => console.warn(m, JSON.stringify(o)) };
  // The contract accepts finalize/payout from the agreement's verifier account, so the relayer must be it.
  keeper = new Keeper(db, jobs, chain, createRelayer(config.verifierAccount, relayerKey, config.rpcUrl), config, log);
}
// When hosted as a web service (PORT is set), answer health checks and wake-up calls.
if (process.env.PORT) startWakeServer(Number(process.env.PORT));
console.log(`verification worker started for verifier key ${config.verifierPublicKey.slice(0, 12)}...`);
console.log(keeper ? `automatic record/finalize/payout enabled as ${config.verifierAccount}` : "automatic record/finalize/payout disabled");
await runWorkerLoop(new VerificationService(db, jobs, config), seed, { error: (o, msg) => console.error(msg, o) }, 1000, keeper);
