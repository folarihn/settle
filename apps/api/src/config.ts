import { NearAccountId } from "@settle/domain";
import { z } from "zod";

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
});
export type Config = z.infer<typeof Config>;

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  return Config.parse({
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
    enableFixture: env.SETTLE_ENABLE_FIXTURE === "1" || env.SETTLE_ENABLE_FIXTURE === "true",
  });
}
