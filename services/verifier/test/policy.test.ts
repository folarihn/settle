import { describe, expect, it } from "vitest";
import { buildTargetUrl, isBlockedAddress, resolvePinned, TargetRejected, type Resolver } from "../src/index.js";

const resolveTo =
  (...addresses: string[]): Resolver =>
  async () =>
    addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

describe("network policy", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.20.0.1",
    "192.168.1.1",
    "100.64.0.1",
    "169.254.169.254",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::",
    "fe80::1",
    "fd00::1",
    "::ffff:127.0.0.1",
    "64:ff9b::7f00:1",
  ])("blocks %s", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])("allows public %s", (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });

  it.each([
    ["plain http", "http://api.example.com"],
    ["other protocols", "ftp://api.example.com"],
    ["credentials", "https://user:pw@api.example.com"],
    ["non-web ports", "https://api.example.com:22"],
    ["loopback literals", "https://127.0.0.1"],
    ["IPv6 loopback", "https://[::1]"],
    ["cloud metadata", "https://169.254.169.254"],
    ["localhost", "https://localhost"],
    ["query strings", "https://api.example.com/?debug=1"],
    ["garbage", "not a url"],
  ])("rejects %s", (_name, url) => {
    expect(() => buildTargetUrl(url, "/health")).toThrow(TargetRejected);
  });

  it("appends the agreed path to the submitted base URL", () => {
    expect(buildTargetUrl("https://api.example.com/v1/", "/health").toString()).toBe("https://api.example.com/v1/health");
  });

  it("rejects hostnames that resolve to private addresses, even alongside public ones", async () => {
    await expect(resolvePinned("evil.example", resolveTo("10.0.0.5"))).rejects.toThrow(TargetRejected);
    await expect(resolvePinned("evil.example", resolveTo("93.184.216.34", "127.0.0.1"))).rejects.toThrow(TargetRejected);
    await expect(resolvePinned("ok.example", resolveTo("93.184.216.34"))).resolves.toEqual({ address: "93.184.216.34", family: 4 });
  });
});
