import { publicKeyFromSeed } from "@settle/domain";
import { RpcChainReader } from "./chain.js";
import { configFromEnv } from "./config.js";
import { createPgDb, migrate } from "./db.js";
import { JobService } from "./jobs.js";
import { VerificationService } from "./verifications.js";
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
const jobs = new JobService(db, new RpcChainReader(config.rpcUrl, config.escrowContract), config);
// When hosted as a web service (PORT is set), answer health checks and wake-up calls.
if (process.env.PORT) startWakeServer(Number(process.env.PORT));
console.log(`verification worker started for verifier key ${config.verifierPublicKey.slice(0, 12)}...`);
await runWorkerLoop(new VerificationService(db, jobs, config), seed, { error: (o, msg) => console.error(msg, o) });
