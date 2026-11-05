import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { KeyPair, type KeyPairString } from "near-api-js";

/**
 * Agent key custody for the swarm runner (ADR 0006). Each agent gets a fresh ed25519 key; its
 * NEAR account is the implicit account named by that public key (64 hex characters), which
 * exists once someone sends it NEAR. Secrets are stored only encrypted (AES-256-GCM) under a key
 * that exists only in the runner's environment.
 */

export function newAgentKey(): { accountId: string; publicKey: string; secret: KeyPairString } {
  const kp = KeyPair.fromRandom("ed25519");
  const pub = kp.getPublicKey();
  return { accountId: Buffer.from(pub.data).toString("hex"), publicKey: pub.toString(), secret: kp.toString() as KeyPairString };
}

export function encryptSecret(secret: string, key: Buffer): string {
  if (key.length !== 32) throw new Error("the swarm secret must be 32 bytes");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(secret, "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), body.toString("base64")].join(".");
}

export function decryptSecret(blob: string, key: Buffer): KeyPairString {
  const [v, iv, tag, body] = blob.split(".");
  if (v !== "v1" || !iv || !tag || !body) throw new Error("unknown key blob format");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(body, "base64")), d.final()]).toString("utf8") as KeyPairString;
}
