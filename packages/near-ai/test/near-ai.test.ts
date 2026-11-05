import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { NearAi, recoverEthAddress, uuidV5Dns, verifyResponseSignature, type SignatureRecord } from "../src/index.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Signs like NEAR AI's TEE: EIP-191 personal_sign, 65-byte r||s||v. */
function teeSign(text: string, secret: Uint8Array) {
  const msg = new TextEncoder().encode(text);
  const digest = keccak_256(new Uint8Array([...new TextEncoder().encode(`\x19Ethereum Signed Message:\n${msg.length}`), ...msg]));
  const rec = secp256k1.sign(digest, secret, { prehash: false, format: "recovered" });
  const rsv = new Uint8Array([...rec.subarray(1), rec[0]! + 27]);
  const address = keccak_256(secp256k1.getPublicKey(secret, false).subarray(1)).subarray(12);
  return { signature: `0x${Buffer.from(rsv).toString("hex")}`, address: `0x${Buffer.from(address).toString("hex")}` };
}

describe("NEAR AI response signatures", () => {
  const secret = secp256k1.utils.randomSecretKey();
  const req = '{"model":"z-ai/glm-5.3-flash","messages":[]}';
  const res = '{"id":"chatcmpl-1","choices":[]}';
  const model = "z-ai/glm-5.3-flash";

  it("accepts a TEE signature over exactly these bytes, and recovers the signer like ethers.verifyMessage", () => {
    const text = `${model}:${sha(req)}:${sha(res)}`;
    const s = teeSign(text, secret);
    const record: SignatureRecord = { text, signature: s.signature, signingAddress: s.address, signingAlgo: "ecdsa", signatureKind: "provider_tee" };
    expect(verifyResponseSignature(record, req, res, model)).toEqual({ ok: true, kind: "provider_tee" });
    expect(`0x${Buffer.from(recoverEthAddress(text, Buffer.from(s.signature.slice(2), "hex"))).toString("hex")}`).toBe(s.address);
  });

  it("matches the standard EIP-191 recovery (web3.js accounts.sign documentation vector)", () => {
    const sig = Buffer.from("b91467e570a6466aa9e9876cbcd013baba02900b8979d43fe208a4a4f339f5fd6007e74cd82e037b800186422fc2da167c747ef045e5d18a5f5d4300f8e1a0291c", "hex");
    expect(Buffer.from(recoverEthAddress("Some data", sig)).toString("hex")).toBe("2c7536e3605d9c16a7a3d7b1898e529396a65c23");
  });

  it("rejects altered bytes, a different signer, the wrong text format and unknown kinds", () => {
    const text = `${model}:${sha(req)}:${sha(res)}`;
    const s = teeSign(text, secret);
    const record: SignatureRecord = { text, signature: s.signature, signingAddress: s.address, signingAlgo: "ecdsa", signatureKind: "provider_tee" };
    expect(verifyResponseSignature(record, req, res.replace("1", "2"), model)).toMatchObject({ ok: false, reason: expect.stringMatching(/does not match/) });
    const other = teeSign(text, secp256k1.utils.randomSecretKey());
    expect(verifyResponseSignature({ ...record, signingAddress: other.address }, req, res, model)).toMatchObject({ ok: false });
    expect(verifyResponseSignature({ ...record, signatureKind: "gateway" }, req, res, model)).toMatchObject({ ok: false }); // gateway text has no model prefix
    expect(verifyResponseSignature({ ...record, signatureKind: null }, req, res, model)).toMatchObject({ ok: false, reason: expect.stringMatching(/unknown/) });
    expect(verifyResponseSignature({ ...record, signingAlgo: "rsa" }, req, res, model)).toMatchObject({ ok: false });
  });
});

describe("NEAR AI client", () => {
  it("keeps exact request/response bytes, sends no-aliasing, and reads billing ids and exact costs", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const body = JSON.stringify({ id: "chatcmpl-abc", model: "z-ai/glm-5.3-flash", choices: [{ message: { content: " Hello " } }], usage: { prompt_tokens: 12, completion_tokens: 3 } });
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/chat/completions")) return new Response(body, { status: 200 });
      if (url.endsWith("/billing/costs")) return Response.json({ requests: [{ requestId: "a", costNanoUsd: 1234 }, { requestId: "b", costNanoUsd: 0 }] });
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
    const ai = new NearAi({ apiKey: "sk-test", fetch: fake });
    const c = await ai.chat([{ role: "user", content: "hi" }]);
    expect(c).toMatchObject({ id: "chatcmpl-abc", content: "Hello", usage: { promptTokens: 12, completionTokens: 3 }, responseBody: body });
    expect(c.inferenceId).toBe(uuidV5Dns("chatcmpl-abc")); // no inference-id header: derived like NEAR AI does
    expect(JSON.parse(c.requestBody)).toMatchObject({ model: "z-ai/glm-5.3-flash" });
    expect((calls[0]!.init.headers as Record<string, string>)["x-no-aliasing"]).toBe("true");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer sk-test");

    const costs = await ai.costs(["a", "b"]);
    expect([...costs]).toEqual([["a", 1234]]); // 0 = not recorded yet, so not reported as free
    expect(await ai.signature("chatcmpl-abc")).toBeNull();
  });

  it("derives UUIDv5 ids exactly (RFC 4122 test vector)", () => {
    expect(uuidV5Dns("www.example.com")).toBe("2ed6657d-e927-568b-95e1-2665a8aea6a2");
  });
});
