import { RpcChainReader } from "./chain.js";
import { configFromEnv } from "./config.js";
import { createPgDb, createPgliteDb, migrate } from "./db.js";
import { buildApp } from "./server.js";
import { runWorkerLoop } from "./worker.js";

let config: ReturnType<typeof configFromEnv>;
try {
  config = configFromEnv();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
const db = config.databaseUrl ? createPgDb(config.databaseUrl) : createPgliteDb(config.pgliteDir);
await migrate(db);
const { app, verifications } = buildApp({ db, chain: new RpcChainReader(config.rpcUrl, config.escrowContract), config, logger: true });

// Local demo only: PGlite cannot be shared between processes, so the worker runs in-process.
// With Postgres, run `node dist/worker-main.js` as its own process instead.
if (!config.databaseUrl && process.env.SETTLE_VERIFIER_SEED) {
  app.log.warn("running the verifier in the API process (PGlite demo mode); do not do this in production");
  void runWorkerLoop(verifications, process.env.SETTLE_VERIFIER_SEED, app.log);
}

await app.listen({ port: config.port, host: "0.0.0.0" });
