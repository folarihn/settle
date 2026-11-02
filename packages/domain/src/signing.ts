import { createPrivateKey, createPublicKey, randomBytes, sign, verify } from "node:crypto";
import type { VerificationReport } from "./events.js";

/**
 * Reports are signed over a borsh encoding so the NEAR contract can verify the exact
 * same bytes with `env::ed25519_verify`. Layout (must match contracts/escrow):
 *   string tag, string escrowContract, string agreementId, string milestoneId,
 *   u32 submissionSeq, string artifactHash, string planHash, u8 outcome,
 *   string evidenceDigest, string nonce, u64 issuedAt, u64 expiresAt
 * Strings are u32-LE length + UTF-8; integers little-endian.
 */
export const REPORT_SIGNING_TAG = "settle-report-v1";

const OUTCOME_INDEX = { PASS: 0, FAIL: 1, INCONCLUSIVE: 2, RUNNER_ERROR: 3 } as const;

class BorshWriter {
  private parts: Buffer[] = [];
  string(s: string): this {
    const bytes = Buffer.from(s, "utf8");
    return this.u32(bytes.length).raw(bytes);
  }
  u8(n: number): this {
    return this.raw(Buffer.from([n]));
  }
  u32(n: number): this {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return this.raw(b);
  }
  u64(n: number): this {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(n));
    return this.raw(b);
  }
  private raw(b: Buffer): this {
    this.parts.push(b);
    return this;
  }
  bytes(): Buffer {
    return Buffer.concat(this.parts);
  }
}

export function reportSigningBytes(escrowContract: string, r: VerificationReport): Buffer {
  return new BorshWriter()
    .string(REPORT_SIGNING_TAG)
    .string(escrowContract)
    .string(r.agreementId)
    .string(r.milestoneId)
    .u32(r.submissionSeq)
    .string(r.artifactHash)
    .string(r.planHash)
    .u8(OUTCOME_INDEX[r.outcome])
    .string(r.evidenceDigest)
    .string(r.nonce)
    .u64(r.issuedAt)
    .u64(r.expiresAt)
    .bytes();
}

// DER wrappers for raw 32-byte ed25519 keys (RFC 8410).
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const privateKeyFromSeed = (seedHex: string) =>
  createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, Buffer.from(seedHex, "hex")]), format: "der", type: "pkcs8" });

export interface VerifierKeyPair {
  /** 32-byte ed25519 seed, hex. Secret: lives only in the verifier's environment. */
  seedHex: string;
  /** 32-byte raw ed25519 public key, hex. Goes into the agreement terms. */
  publicKeyHex: string;
}

export function publicKeyFromSeed(seedHex: string): string {
  const der = createPublicKey(privateKeyFromSeed(seedHex)).export({ format: "der", type: "spki" });
  return der.subarray(SPKI_PREFIX.length).toString("hex");
}

export function generateVerifierKeyPair(): VerifierKeyPair {
  const seedHex = randomBytes(32).toString("hex");
  return { seedHex, publicKeyHex: publicKeyFromSeed(seedHex) };
}

/** Returns the 64-byte signature as hex. */
export function signReport(escrowContract: string, r: VerificationReport, seedHex: string): string {
  return sign(null, reportSigningBytes(escrowContract, r), privateKeyFromSeed(seedHex)).toString("hex");
}

export function verifyReportSignature(
  escrowContract: string,
  r: VerificationReport,
  signatureHex: string,
  publicKeyHex: string,
): boolean {
  if (!/^[0-9a-f]{128}$/.test(signatureHex) || !/^[0-9a-f]{64}$/.test(publicKeyHex)) return false;
  const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(publicKeyHex, "hex")]), format: "der", type: "spki" });
  return verify(null, reportSigningBytes(escrowContract, r), key, Buffer.from(signatureHex, "hex"));
}
