import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/**
 * Outbound network policy. Submission URLs are attacker-controlled, so every target
 * is treated as an SSRF attempt until proven to be a public HTTPS endpoint.
 * The exceptions exist only so tests can reach a local fixture server; production
 * code (cli.ts) always uses DEFAULT_POLICY and nothing reads them from the environment.
 */
export interface NetworkPolicy {
  /** Exact origins (e.g. "http://127.0.0.1:4010") allowed over plain HTTP. */
  insecureTestOrigins: readonly string[];
  /** Exact IP addresses exempt from the private-range block. */
  testAddresses: readonly string[];
}

export const DEFAULT_POLICY: NetworkPolicy = Object.freeze({ insecureTestOrigins: [], testAddresses: [] });

const ALLOWED_HTTPS_PORTS = new Set(["", "443", "8443"]);

// Separate lists: Node's BlockList also matches IPv4 addresses against IPv6 rules
// (via ::ffff:0:0/96), which would make the mapped-address rule block all of IPv4.
const blockedV4 = new BlockList();
const blockedV6 = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, incl. cloud metadata 169.254.169.254
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
] as const) {
  blockedV4.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["::ffff:0:0", 96], // IPv4-mapped: could smuggle any v4 address
  ["64:ff9b::", 96], // NAT64
  ["100::", 64], // discard
  ["2001::", 32], // Teredo
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
] as const) {
  blockedV6.addSubnet(net, prefix, "ipv6");
}

export function isBlockedAddress(address: string, policy: NetworkPolicy = DEFAULT_POLICY): boolean {
  if (policy.testAddresses.includes(address)) return false;
  const family = isIP(address);
  if (family === 4) return blockedV4.check(address, "ipv4");
  if (family === 6) {
    // Only global unicast (2000::/3) is reachable; everything else is blocked.
    const first = parseInt(address.split(":")[0] || "0", 16);
    if ((first & 0xe000) !== 0x2000) return true;
    return blockedV6.check(address, "ipv6");
  }
  return true;
}

export class TargetRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TargetRejected";
  }
}

/** Builds the request URL from the submitted base URL and the agreed plan path. */
export function buildTargetUrl(baseUrl: string, planPath: string, policy: NetworkPolicy = DEFAULT_POLICY): URL {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new TargetRejected("submission URL is not a valid absolute URL");
  }
  if (base.username || base.password) throw new TargetRejected("credentials in URLs are not allowed");
  if (base.search || base.hash) throw new TargetRejected("submission URL must not contain a query or fragment");

  if (base.protocol === "http:") {
    if (!policy.insecureTestOrigins.includes(base.origin)) throw new TargetRejected("only https URLs are allowed");
  } else if (base.protocol !== "https:") {
    throw new TargetRejected(`protocol ${base.protocol} is not allowed`);
  } else if (!ALLOWED_HTTPS_PORTS.has(base.port)) {
    throw new TargetRejected(`port ${base.port} is not allowed`);
  }

  const hostname = base.hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname) && isBlockedAddress(hostname, policy)) {
    throw new TargetRejected("target address is private, loopback, link-local or reserved");
  }
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".internal")) {
    throw new TargetRejected("internal hostnames are not allowed");
  }

  const prefix = base.pathname.replace(/\/+$/, "");
  return new URL(`${base.origin}${prefix}${planPath}`);
}

export type Resolver = (hostname: string) => Promise<{ address: string; family: number }[]>;

export const systemResolver: Resolver = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

/**
 * Resolves once and returns a single vetted address. Every returned address must be
 * public, so a hostname that mixes public and private answers is rejected outright.
 * The caller connects to this exact address, which defeats DNS rebinding.
 */
export async function resolvePinned(
  hostname: string,
  resolve: Resolver,
  policy: NetworkPolicy = DEFAULT_POLICY,
): Promise<{ address: string; family: 4 | 6 }> {
  const bare = hostname.replace(/^\[|\]$/g, "");
  const literal = isIP(bare);
  const answers = literal ? [{ address: bare, family: literal }] : await resolve(bare);
  if (answers.length === 0) throw new TargetRejected("hostname did not resolve");
  const bad = answers.find((a) => isBlockedAddress(a.address, policy));
  if (bad) throw new TargetRejected(`hostname resolves to a blocked address (${bad.address})`);
  const first = answers[0]!;
  return { address: first.address, family: first.family === 6 ? 6 : 4 };
}
