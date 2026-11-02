import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { BorshWriter, NearAccountId } from "@settle/domain";
import { z } from "zod";
import { base58Decode, type ChainReader } from "./chain.js";
import type { Db } from "./db.js";
import { ApiError } from "./errors.js";

/**
 * Login is the same for humans and agents: sign a NEP-413 message with a full-access
 * key of your NEAR account (a wallet does this for humans; the agent SDK does it with
 * the agent's key). The server checks the signature and asks the chain that the key
 * really belongs to the account, then issues a short-lived bearer session.
 */

const NEP413_TAG = 2 ** 31 + 413;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface Principal {
  accountId: string;
  kind: "HUMAN" | "AGENT";
}

export const ChallengeRequest = z.object({ accountId: NearAccountId }).strict();

export const VerifyRequest = z
  .object({
    accountId: NearAccountId,
    publicKey: z.string().regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/, "expected ed25519:<base58>"),
    /** base64 ed25519 signature, as returned by NEAR wallets' signMessage. */
    signature: z.string().min(1).max(200),
    nonce: z.string().regex(/^[0-9a-f]{64}$/),
    kind: z.enum(["HUMAN", "AGENT"]),
    /** Some wallets (e.g. MyNearWallet) include their callback URL in the signed NEP-413 payload. */
    callbackUrl: z.string().url().max(2000).optional(),
  })
  .strict();

/** The exact bytes a NEP-413 signer signs: sha256(u32 tag || borsh(payload)). */
export function nep413Hash(message: string, nonce: Buffer, recipient: string, callbackUrl?: string): Buffer {
  const w = new BorshWriter().u32(NEP413_TAG).string(message).raw(nonce).string(recipient);
  const payload = (callbackUrl === undefined ? w.u8(0) : w.u8(1).string(callbackUrl)).bytes();
  return createHash("sha256").update(payload).digest();
}

export function challengeMessage(accountId: string): string {
  return `Sign in to SETTLE as ${accountId}`;
}

export async function createChallenge(db: Db, accountId: string, recipient: string, now: number) {
  const nonce = randomBytes(32).toString("hex");
  const message = challengeMessage(accountId);
  await db.query("INSERT INTO auth_challenges (nonce, account_id, message, expires_at) VALUES ($1, $2, $3, $4)", [
    nonce,
    accountId,
    message,
    now + CHALLENGE_TTL_MS,
  ]);
  return { nonce, message, recipient };
}

export async function verifyChallenge(
  db: Db,
  chain: ChainReader,
  req: z.infer<typeof VerifyRequest>,
  recipient: string,
  now: number,
): Promise<{ token: string; expiresAt: number }> {
  // Consume the challenge first so a signature can never be replayed, even if later checks fail.
  const { rows } = await db.query<{ message: string; expires_at: string }>(
    "UPDATE auth_challenges SET used = TRUE WHERE nonce = $1 AND account_id = $2 AND used = FALSE RETURNING message, expires_at",
    [req.nonce, req.accountId],
  );
  const challenge = rows[0];
  if (!challenge || Number(challenge.expires_at) < now) throw new ApiError(401, "AUTH_FAILED", "unknown, used or expired challenge");

  const rawKey = base58Decode(req.publicKey.slice("ed25519:".length));
  const signature = Buffer.from(req.signature, "base64");
  if (rawKey.length !== 32 || signature.length !== 64) throw new ApiError(401, "AUTH_FAILED", "malformed key or signature");
  const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, rawKey]), format: "der", type: "spki" });
  const nonce = Buffer.from(req.nonce, "hex");
  const candidates = [nep413Hash(challenge.message, nonce, recipient)];
  if (req.callbackUrl !== undefined) candidates.push(nep413Hash(challenge.message, nonce, recipient, req.callbackUrl));
  if (!candidates.some((digest) => verify(null, digest, key, signature))) {
    throw new ApiError(401, "AUTH_FAILED", "signature does not match");
  }

  const permission = await chain.accessKeyPermission(req.accountId, req.publicKey);
  if (permission !== "FullAccess") {
    throw new ApiError(401, "AUTH_FAILED", "public key is not a full-access key of this NEAR account");
  }

  const token = randomBytes(32).toString("base64url");
  const expiresAt = now + SESSION_TTL_MS;
  await db.query(
    "INSERT INTO sessions (token_hash, account_id, kind, public_key, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
    [hashToken(token), req.accountId, req.kind, req.publicKey, expiresAt, now],
  );
  return { token, expiresAt };
}

export async function principalFromToken(db: Db, authorization: string | undefined, now: number): Promise<Principal> {
  const token = authorization?.match(/^Bearer ([A-Za-z0-9_-]{20,})$/)?.[1];
  if (!token) throw new ApiError(401, "AUTH_REQUIRED", "missing bearer token");
  const { rows } = await db.query<{ account_id: string; kind: "HUMAN" | "AGENT"; expires_at: string }>(
    "SELECT account_id, kind, expires_at FROM sessions WHERE token_hash = $1",
    [hashToken(token)],
  );
  const s = rows[0];
  if (!s || Number(s.expires_at) < now) throw new ApiError(401, "AUTH_REQUIRED", "invalid or expired session");
  return { accountId: s.account_id, kind: s.kind };
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
