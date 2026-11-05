import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

/**
 * Minimal NEAR AI Cloud client (OpenAI-compatible API, https://docs.near.ai). It keeps the exact
 * request and response bytes of every completion, because NEAR AI's TEE response signatures are
 * over the SHA-256 of those bytes, and it can read back the exact billed cost of a request.
 */

export const NEAR_AI_BASE = "https://cloud-api.near.ai/v1";
export const DEFAULT_MODEL = "z-ai/glm-5.3-flash";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface Completion {
  /** Response `id`; used to fetch the signature. */
  id: string;
  /** NEAR AI's billing id (the `inference-id` header, or UUIDv5 of `id`); used to read the cost. */
  inferenceId: string;
  model: string;
  content: string;
  usage: { promptTokens: number; completionTokens: number };
  /** Exact bytes sent and received; the response signature covers their SHA-256. */
  requestBody: string;
  responseBody: string;
}

export interface SignatureRecord {
  text: string;
  signature: string;
  signingAddress: string;
  signingAlgo: string;
  signatureKind: string | null;
}

export class NearAiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "NearAiError";
  }
}

export interface NearAiOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class NearAi {
  readonly model: string;
  private readonly base: string;
  private readonly fetcher: typeof fetch;

  constructor(private readonly opts: NearAiOptions) {
    if (!opts.apiKey) throw new Error("a NEAR AI API key is required");
    this.model = opts.model ?? DEFAULT_MODEL;
    this.base = (opts.baseUrl ?? NEAR_AI_BASE).replace(/\/+$/, "");
    this.fetcher = opts.fetch ?? fetch;
  }

  private headers(extra: Record<string, string> = {}) {
    return { authorization: `Bearer ${this.opts.apiKey}`, "content-type": "application/json", ...extra };
  }

  async chat(messages: ChatMessage[], { maxTokens = 1500, temperature = 0.3, model = this.model } = {}): Promise<Completion> {
    const requestBody = JSON.stringify({ model, messages, max_tokens: maxTokens, temperature });
    const res = await this.fetcher(`${this.base}/chat/completions`, {
      method: "POST",
      // No aliasing: the model id is part of the signed text. Identity encoding: the signature covers uncompressed bytes.
      headers: this.headers({ "x-no-aliasing": "true", "accept-encoding": "identity" }),
      body: requestBody,
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 120_000),
    });
    const responseBody = await res.text();
    if (!res.ok) throw new NearAiError(res.status, `NEAR AI answered ${res.status}: ${responseBody.slice(0, 300)}`);
    const json = JSON.parse(responseBody) as {
      id: string;
      model: string;
      choices: { message: { content: string | null } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      id: json.id,
      inferenceId: res.headers.get("inference-id") ?? uuidV5Dns(json.id),
      model: json.model ?? model,
      content: (json.choices[0]?.message.content ?? "").trim(),
      usage: { promptTokens: json.usage?.prompt_tokens ?? 0, completionTokens: json.usage?.completion_tokens ?? 0 },
      requestBody,
      responseBody,
    };
  }

  /** Exact billed cost per request in nano-USD. Missing or not-yet-recorded requests are absent, never guessed. */
  async costs(inferenceIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (inferenceIds.length === 0) return out;
    const res = await this.fetcher(`${this.base}/billing/costs`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ requestIds: inferenceIds }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new NearAiError(res.status, `NEAR AI billing answered ${res.status}`);
    const json = (await res.json()) as { requests?: { requestId: string; costNanoUsd: number }[] };
    // 0 means "no usage record yet" per the API; treat it as unknown so it is retried later.
    for (const r of json.requests ?? []) if (r.costNanoUsd > 0) out.set(r.requestId, r.costNanoUsd);
    return out;
  }

  /** The TEE signature for a completion, or null while it is not available yet. */
  async signature(completionId: string, { model, algo = "ecdsa" }: { model?: string; algo?: "ecdsa" | "ed25519" } = {}): Promise<SignatureRecord | null> {
    const q = new URLSearchParams({ signing_algo: algo, ...(model ? { model } : {}) });
    const res = await this.fetcher(`${this.base}/signature/${encodeURIComponent(completionId)}?${q}`, { headers: this.headers(), signal: AbortSignal.timeout(30_000) });
    if (res.status === 404) return null;
    if (!res.ok) throw new NearAiError(res.status, `NEAR AI signature answered ${res.status}`);
    const j = (await res.json()) as { text: string; signature: string; signing_address: string; signing_algo: string; signature_kind?: string | null };
    return { text: j.text, signature: j.signature, signingAddress: j.signing_address, signingAlgo: j.signing_algo, signatureKind: j.signature_kind ?? null };
  }
}

export interface Pricing {
  /** nano-USD per input token and per output token. */
  inputNanoUsdPerToken: number;
  outputNanoUsdPerToken: number;
}

/** A model's published per-token prices from NEAR AI's public model list. */
export async function modelPricing(model: string, { baseUrl = NEAR_AI_BASE, fetcher = fetch }: { baseUrl?: string; fetcher?: typeof fetch } = {}): Promise<Pricing> {
  const res = await fetcher(`${baseUrl.replace(/\/+$/, "")}/model/list?limit=100`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new NearAiError(res.status, `NEAR AI model list answered ${res.status}`);
  type Price = { amount: number; scale: number };
  const j = (await res.json()) as { models: { modelId: string; inputCostPerToken: Price; outputCostPerToken: Price }[] };
  const m = j.models.find((x) => x.modelId === model);
  if (!m) throw new Error(`model ${model} is not in NEAR AI's model list`);
  const nano = (p: Price) => (p.amount / 10 ** p.scale) * 1e9;
  return { inputNanoUsdPerToken: nano(m.inputCostPerToken), outputNanoUsdPerToken: nano(m.outputCostPerToken) };
}

/** Upper bound for one call: generous prompt-token estimate (3 chars/token) and the full output allowance. */
export function worstCaseNanoUsd(p: Pricing, promptChars: number, maxTokens: number): number {
  return Math.ceil(Math.ceil(promptChars / 3) * p.inputNanoUsdPerToken + maxTokens * p.outputNanoUsdPerToken);
}

const sha256Hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

export type SignatureCheck = { ok: true; kind: string } | { ok: false; reason: string };

/**
 * Checks that a NEAR AI response signature covers exactly these request and response bytes and
 * that the claimed signing address produced it. This does not check the TEE attestation that ties
 * the signing address to an enclave; that is a separate step with NEAR's verification tools.
 */
export function verifyResponseSignature(sig: SignatureRecord, requestBody: string, responseBody: string, model: string): SignatureCheck {
  const hashes = `${sha256Hex(requestBody)}:${sha256Hex(responseBody)}`;
  const expected = sig.signatureKind === "gateway" ? hashes : sig.signatureKind === "provider_tee" ? `${model}:${hashes}` : null;
  if (expected === null) return { ok: false, reason: `unknown signature kind ${sig.signatureKind ?? "(missing)"}` };
  if (sig.text !== expected) return { ok: false, reason: "signed text does not match these request and response bytes" };
  const sigBytes = hexBytes(sig.signature);
  const signer = hexBytes(sig.signingAddress);
  try {
    if (sig.signingAlgo === "ecdsa") {
      if (sigBytes.length !== 65 || signer.length !== 20) return { ok: false, reason: "malformed ecdsa signature or address" };
      return eqBytes(recoverEthAddress(sig.text, sigBytes), signer) ? { ok: true, kind: sig.signatureKind! } : { ok: false, reason: "signature was not made by the signing address" };
    }
    if (sig.signingAlgo === "ed25519") {
      if (sigBytes.length !== 64 || signer.length !== 32) return { ok: false, reason: "malformed ed25519 signature or key" };
      return ed25519.verify(sigBytes, new TextEncoder().encode(sig.text), signer) ? { ok: true, kind: sig.signatureKind! } : { ok: false, reason: "invalid ed25519 signature" };
    }
  } catch (e) {
    return { ok: false, reason: `verification failed: ${(e as Error).message}` };
  }
  return { ok: false, reason: `unsupported algorithm ${sig.signingAlgo}` };
}

/** EIP-191 personal_sign recovery: the address that signed `text` with a 65-byte r||s||v signature. */
export function recoverEthAddress(text: string, rsv: Uint8Array): Uint8Array {
  const msg = new TextEncoder().encode(text);
  const prefixed = new Uint8Array([...new TextEncoder().encode(`\x19Ethereum Signed Message:\n${msg.length}`), ...msg]);
  const v = rsv[64]!;
  const recid = v >= 27 ? v - 27 : v;
  const recovered = new Uint8Array([recid, ...rsv.subarray(0, 64)]);
  const point = secp256k1.Signature.fromBytes(recovered, "recovered").recoverPublicKey(keccak_256(prefixed));
  return keccak_256(point.toBytes(false).subarray(1)).subarray(12);
}

function hexBytes(h: string): Uint8Array {
  const s = h.startsWith("0x") ? h.slice(2) : h;
  if (!/^([0-9a-fA-F]{2})*$/.test(s)) throw new Error("not hex");
  return Uint8Array.from(Buffer.from(s, "hex"));
}

const eqBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** RFC 4122 UUIDv5 in the DNS namespace (how NEAR AI derives a billing id from a response id). */
export function uuidV5Dns(name: string): string {
  const ns = Buffer.from("6ba7b8109dad11d180b400c04fd430c8", "hex");
  const h = createHash("sha1").update(Buffer.concat([ns, Buffer.from(name, "utf8")])).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

export const sha256Text = sha256Hex;
