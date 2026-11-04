import { NearAccountId } from "@settle/domain";
import { z } from "zod";

/**
 * Public keys of the fixed seeds used in tests (0x11.., 0x22.., 0x33.., 0x44.., 0x55..).
 * Their seeds are in the repository, so anyone could sign reports with them.
 */
const TEST_ONLY_VERIFIER_KEYS = new Set([
  "d04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737",
  "a09aa5f47a6759802ff955f8dc2d2a14a5c99d23be97f864127ff9383455a4f0",
  "17cb79fb2b4120f2b1ec65e4198d6e08b28e813feb01e4a400839b85e18080ce",
  "d759793bbc13a2819a827c76adb6fba8a49aee007f49f2d0992d99b825ad2c48",
  "c6822637c7d310ec57627be00ba259d253749f4aaf644470cffbe53a35f73242",
]);

/**
 * API configuration. Deliberately contains no private keys: the API never signs
 * NEAR transactions, and the verifier's signing seed is only read by the worker
 * process (worker-main.ts).
 */
export const Config = z.object({
  port: z.coerce.number().int().default(8080),
  /** Postgres URL. When absent, an in-process PGlite database is used (local demo/tests only). */
  databaseUrl: z.string().optional(),
  pgliteDir: z.string().optional(),
  network: z.enum(["testnet", "sandbox"]).default("testnet"),
  rpcUrl: z.string().url().default("https://rpc.testnet.fastnear.com"),
  escrowContract: NearAccountId,
  verifierAccount: NearAccountId,
  verifierPublicKey: z.string().regex(/^[0-9a-f]{64}$/, "SETTLE_VERIFIER_PUBLIC_KEY must be 64 hex chars"),
  resolverAccount: NearAccountId,
  /** NEP-413 recipient that login signatures are bound to. */
  authRecipient: z.string().min(1).default("settle"),
  /** Directory of the built web app to serve at `/`. */
  webDist: z.string().optional(),
  /** Serve the controlled demo API under /fixture (see apps/fixture-api). */
  enableFixture: z.coerce.boolean().default(false),
  /** Stable public HTTPS origin of this deployment, e.g. https://settle-demo.onrender.com. */
  publicUrl: z.string().url().optional(),
  /** Base URL of a worker hosted on a sleep-on-idle plan; the API calls its /kick after queueing. */
  workerWakeUrl: z.string().url().optional(),
  /** Trust X-Forwarded-For (set when running behind the host's load balancer). */
  trustProxy: z.coerce.boolean().default(false),
});
export type Config = z.infer<typeof Config>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(`configuration error: ${message}`);
    this.name = "ConfigError";
  }
}

const flag = (v: string | undefined) => v === "1" || v === "true";

/**
 * Reads and checks the API process environment. Fails fast on unsafe setups instead of
 * starting a deployment that could leak the verifier key or lose data.
 */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env, role: "api" | "worker" = "api"): Config {
  const parsed = Config.safeParse({
    port: env.PORT,
    databaseUrl: env.SETTLE_DATABASE_URL || undefined,
    pgliteDir: env.SETTLE_PGLITE_DIR || undefined,
    network: env.NEAR_NETWORK || undefined,
    rpcUrl: env.NEAR_RPC_URL || undefined,
    escrowContract: env.SETTLE_ESCROW_CONTRACT,
    verifierAccount: env.SETTLE_VERIFIER_ACCOUNT,
    verifierPublicKey: env.SETTLE_VERIFIER_PUBLIC_KEY,
    resolverAccount: env.SETTLE_RESOLVER_ACCOUNT,
    authRecipient: env.SETTLE_AUTH_RECIPIENT || undefined,
    webDist: env.SETTLE_WEB_DIST || undefined,
    enableFixture: flag(env.SETTLE_ENABLE_FIXTURE),
    // Render sets RENDER_EXTERNAL_URL to the service's stable https://<name>.onrender.com origin.
    publicUrl: env.SETTLE_PUBLIC_URL || env.RENDER_EXTERNAL_URL || undefined,
    trustProxy: flag(env.SETTLE_TRUST_PROXY),
    workerWakeUrl: env.SETTLE_WORKER_WAKE_URL || undefined,
  });
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new ConfigError(missing);
  }
  const config = parsed.data;

  if (TEST_ONLY_VERIFIER_KEYS.has(config.verifierPublicKey)) {
    throw new ConfigError("SETTLE_VERIFIER_PUBLIC_KEY is a test-only key whose seed is public; run `settle-verify keygen`");
  }
  if (config.network === "testnet" && !config.escrowContract.endsWith(".testnet")) {
    throw new ConfigError("SETTLE_ESCROW_CONTRACT must be a .testnet account on testnet");
  }
  if (config.publicUrl && new URL(config.publicUrl).protocol !== "https:") {
    throw new ConfigError("SETTLE_PUBLIC_URL must be https (the verifier only calls https targets)");
  }
  if (config.network === "testnet" && config.workerWakeUrl && new URL(config.workerWakeUrl).protocol !== "https:") {
    throw new ConfigError("SETTLE_WORKER_WAKE_URL must be https");
  }
  if (role === "api") {
    // The internet-facing API must never hold the verifier seed. The only exception is the
    // single-process PGlite demo, where the worker runs in-process by design.
    if (env.SETTLE_RELAYER_PRIVATE_KEY) {
      throw new ConfigError("SETTLE_RELAYER_PRIVATE_KEY must not be set on the API process; give it only to the worker");
    }
    if (config.databaseUrl && env.SETTLE_VERIFIER_SEED) {
      throw new ConfigError("SETTLE_VERIFIER_SEED must not be set on the API process; give it only to the worker");
    }
    if (!config.databaseUrl && !flag(env.SETTLE_ALLOW_EPHEMERAL_DB)) {
      throw new ConfigError("SETTLE_DATABASE_URL is required (set SETTLE_ALLOW_EPHEMERAL_DB=1 only for a throwaway local demo)");
    }
  }
  return config;
}
