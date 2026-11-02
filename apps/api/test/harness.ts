import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPairSync, sign } from "node:crypto";
import { publicKeyFromSeed, type ContractAgreement } from "@settle/domain";
import { DEMO_PLAN, fixtureResponse } from "@settle/fixture-api";
import { base58Encode, buildApp, createPgDb, createPgliteDb, drainQueue, migrate, nep413Hash, type ChainReader, type Config, type Db } from "../src/index.js";

export const VERIFIER_SEED = "55".repeat(32); // test-only
export const CLIENT = "client.testnet";
export const WORKER = "agent-worker.testnet";
export const STRANGER = "stranger.testnet";
export const NEAR = 10n ** 24n;

export const config: Config = {
  port: 0,
  network: "testnet",
  rpcUrl: "https://rpc.invalid",
  escrowContract: "settle-escrow.testnet",
  verifierAccount: "verifier.testnet",
  verifierPublicKey: publicKeyFromSeed(VERIFIER_SEED),
  resolverAccount: "resolver.testnet",
  authRecipient: "settle",
  enableFixture: true,
};

/** Stands in for NEAR RPC: which keys belong to which accounts, and what the contract holds. */
export class FakeChain implements ChainReader {
  keys = new Map<string, { accountId: string; permission: "FullAccess" | "FunctionCall" }>();
  agreements = new Map<string, ContractAgreement>();
  down = false;
  async accessKeyPermission(accountId: string, publicKey: string) {
    const k = this.keys.get(publicKey);
    return k && k.accountId === accountId ? k.permission : null;
  }
  async getAgreement(id: string) {
    if (this.down) {
      const { ChainUnavailable } = await import("../src/chain.js");
      throw new ChainUnavailable("RPC timeout");
    }
    return this.agreements.get(id) ?? null;
  }
}

export interface Harness {
  db: Db;
  chain: FakeChain;
  app: ReturnType<typeof buildApp>["app"];
  verifications: ReturnType<typeof buildApp>["verifications"];
  fixtureOrigin: string;
  runVerifier: () => Promise<number>;
  close: () => Promise<void>;
}

export async function startHarness(db?: Db): Promise<Harness> {
  // CI also runs these tests against a real Postgres service (SETTLE_TEST_DATABASE_URL).
  const url = process.env.SETTLE_TEST_DATABASE_URL;
  const ownsDb = !db;
  const database = db ?? (url ? createPgDb(url) : createPgliteDb());
  await migrate(database);
  const chain = new FakeChain();
  const { app, verifications } = buildApp({ db: database, chain, config });

  const fixture = createServer((req, res) => {
    const r = fixtureResponse(req.method ?? "GET", req.url ?? "/");
    res.writeHead(r?.status ?? 404, { "content-type": "application/json" }).end(r?.body ?? "{}");
  });
  await new Promise<void>((r) => fixture.listen(0, "127.0.0.1", r));
  const fixtureOrigin = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;
  // The verifier's default policy blocks loopback; only these tests open it for the local fixture.
  const policy = { insecureTestOrigins: [fixtureOrigin], testAddresses: ["127.0.0.1"] };

  return {
    db: database,
    chain,
    app,
    verifications,
    fixtureOrigin,
    runVerifier: () => drainQueue(verifications, { seedHex: VERIFIER_SEED, policy }),
    close: async () => {
      await app.close();
      fixture.closeAllConnections();
      await new Promise((r) => fixture.close(r));
      if (ownsDb) await database.close();
    },
  };
}

/** A NEAR full-access key held by a human's wallet or an agent; signs NEP-413 logins. */
export function newKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12);
  return { publicKey: `ed25519:${base58Encode(raw)}`, privateKey };
}

export async function login(h: Harness, accountId: string, kind: "HUMAN" | "AGENT" = "HUMAN"): Promise<string> {
  const key = newKey();
  h.chain.keys.set(key.publicKey, { accountId, permission: "FullAccess" });
  const ch = (await h.app.inject({ method: "POST", url: "/v1/auth/challenge", payload: { accountId } })).json();
  const signature = sign(null, nep413Hash(ch.message, Buffer.from(ch.nonce, "hex"), ch.recipient), key.privateKey).toString("base64");
  const res = await h.app.inject({
    method: "POST",
    url: "/v1/auth/verify",
    payload: { accountId, publicKey: key.publicKey, signature, nonce: ch.nonce, kind },
  });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.body}`);
  return res.json().token;
}

export function jobInput() {
  const api = (NEAR * 35n) / 100n;
  const design = (NEAR * 15n) / 100n;
  return {
    worker: { kind: "AGENT", nearAccountId: WORKER },
    totalYocto: (api + design).toString(),
    milestones: [
      { id: "api", title: "Health endpoint", type: "AUTOMATED", amountYocto: api.toString(), verificationPlan: DEMO_PLAN },
      {
        id: "design",
        title: "Landing page design",
        type: "HUMAN_REVIEW",
        amountYocto: design.toString(),
        rubric: "Matches the brief on mobile and desktop.",
        maxRevisions: 2,
        partialCompensation: { condition: "DELIVERABLE_SUBMITTED", floorYocto: (design / 2n).toString() },
      },
    ],
    challengePeriodSec: 3600,
    fundingDeadline: Date.now() + 86_400_000,
    expiresAt: Date.now() + 14 * 86_400_000,
  };
}

/** Authenticated request helper. */
export function as(h: Harness, token: string) {
  const call = (method: "GET" | "POST", url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    h.app.inject({ method, url, headers: { authorization: `Bearer ${token}`, ...headers }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  return {
    get: (url: string) => call("GET", url),
    post: (url: string, payload: unknown = {}, headers?: Record<string, string>) => call("POST", url, payload, headers),
  };
}
