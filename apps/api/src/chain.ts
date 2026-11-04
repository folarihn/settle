import type { ContractAgreement } from "@settle/domain";

/**
 * Read-only access to NEAR. The API never signs transactions or holds keys: parties
 * sign their own contract calls, and the API only reads chain state to authenticate
 * keys and to mirror monetary outcomes from the contract.
 */
export interface ChainReader {
  /** Permission of `publicKey` ("ed25519:<base58>") on `accountId`, or null if it is not a key of that account. */
  accessKeyPermission(accountId: string, publicKey: string): Promise<"FullAccess" | "FunctionCall" | null>;
  /** The escrow contract's view of an agreement, or null if it does not exist onchain. */
  getAgreement(agreementId: string): Promise<ContractAgreement | null>;
}

export class ChainUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChainUnavailable";
  }
}

export class RpcChainReader implements ChainReader {
  constructor(
    private readonly rpcUrl: string,
    private readonly contractId: string,
    private readonly timeoutMs = 8000,
  ) {}

  private async query(params: Record<string, unknown>): Promise<{ result?: Record<string, unknown>; error?: unknown }> {
    let res: Response;
    try {
      res = await fetch(this.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "settle", method: "query", params: { finality: "final", ...params } }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new ChainUnavailable(`NEAR RPC request failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) throw new ChainUnavailable(`NEAR RPC returned HTTP ${res.status}`);
    return (await res.json()) as { result?: Record<string, unknown>; error?: unknown };
  }

  async accessKeyPermission(accountId: string, publicKey: string) {
    const r = await this.query({ request_type: "view_access_key", account_id: accountId, public_key: publicKey });
    // Unknown keys/accounts come back as an RPC error (or, on older nodes, result.error).
    if (r.error || !r.result || "error" in r.result) return null;
    return r.result.permission === "FullAccess" ? "FullAccess" : "FunctionCall";
  }

  async getAgreement(agreementId: string): Promise<ContractAgreement | null> {
    const r = await this.query({
      request_type: "call_function",
      account_id: this.contractId,
      method_name: "get_agreement",
      args_base64: Buffer.from(JSON.stringify({ agreement_id: agreementId })).toString("base64"),
    });
    if (r.error || !r.result || !Array.isArray(r.result.result)) {
      throw new ChainUnavailable(`get_agreement failed: ${JSON.stringify(r.error ?? r.result)}`);
    }
    return JSON.parse(Buffer.from(r.result.result as number[]).toString("utf8")) as ContractAgreement | null;
  }
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Decode(s: string): Buffer {
  let n = 0n;
  for (const ch of s) {
    const v = B58.indexOf(ch);
    if (v < 0) throw new Error("invalid base58");
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const ch of s) {
    if (ch !== "1") break;
    bytes.unshift(0);
  }
  return Buffer.from(bytes);
}

export function base58Encode(b: Uint8Array): string {
  let n = 0n;
  for (const byte of b) n = (n << 8n) + BigInt(byte);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const byte of b) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out;
}
