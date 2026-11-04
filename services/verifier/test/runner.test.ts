import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_POLICY, runPlan } from "../src/index.js";
import { PLAN, startFixture, type Fixture } from "./fixture-server.js";

let fx: Fixture;
beforeAll(async () => {
  fx = await startFixture();
});
afterAll(() => fx.close());

const run = (deployment: string, plan = PLAN) => runPlan(plan, `${fx.origin}/${deployment}`, { policy: fx.policy });

describe("HTTP plan runner", () => {
  it("passes only when status and every assertion hold", async () => {
    const r = await run("good");
    expect(r.outcome).toBe("PASS");
    expect(r.checks.every((c) => c.ok)).toBe(true);
    expect(r.status).toBe(200);
    expect(r.bodySha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ["a wrong value", "wrong-value", "$.status == \"ok\""],
    ["a wrong type", "wrong-type", "$.items is array"],
    ["a missing element", "missing", "$.items[1] exists"],
    ["inherited instead of own properties", "proto", "$.items is array"],
    ["an error status", "error", "status"],
    ["a non-JSON body", "html", "json body"],
    ["an oversized body", "big", "response size"],
    ["a redirect (never followed)", "redirect", "status"],
  ])("fails on %s", async (_name, deployment, failedCheck) => {
    const r = await run(deployment);
    expect(r.outcome).toBe("FAIL");
    expect(r.checks.find((c) => !c.ok)?.check).toBe(failedCheck);
  });

  it("is inconclusive, never PASS, when the target times out or is unreachable", async () => {
    expect((await run("hang")).outcome).toBe("INCONCLUSIVE");
    const closed = await runPlan(PLAN, "http://127.0.0.1:1/good", {
      policy: { insecureTestOrigins: ["http://127.0.0.1:1"], testAddresses: ["127.0.0.1"] },
    });
    expect(closed.outcome).toBe("INCONCLUSIVE");
  });

  it("fails without sending a request when the default policy blocks the target", async () => {
    const before = fx.hits();
    const r = await runPlan(PLAN, `${fx.origin}/good`, { policy: DEFAULT_POLICY });
    expect(r.outcome).toBe("FAIL");
    expect(r.error?.kind).toBe("TARGET_REJECTED");
    expect(fx.hits()).toBe(before);
  });

  it("rejects a hostname that resolves to a private address before connecting", async () => {
    const before = fx.hits();
    const https = `https://rebind.example/good`;
    const r = await runPlan(PLAN, https, { resolve: async () => [{ address: "127.0.0.1", family: 4 }] });
    expect(r.outcome).toBe("FAIL");
    expect(r.error?.message).toContain("blocked address");
    expect(fx.hits()).toBe(before);
  });

  it("sustained health passes only when every probe passes, spaced by the agreed interval", async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => void waits.push(ms);
    const plan = { ...PLAN, repeat: { count: 4, intervalMs: 15_000 } };
    const good = await runPlan(plan, `${fx.origin}/good`, { policy: fx.policy, sleep });
    expect(good.outcome).toBe("PASS");
    expect(good.probes).toHaveLength(4);
    expect(waits).toEqual([15_000, 15_000, 15_000]);

    const flaky = await runPlan(plan, `${fx.origin}/flaky`, { policy: fx.policy, sleep });
    expect(flaky.outcome).toBe("FAIL");
    expect(flaky.probes?.map((p) => p.outcome)).toEqual(["PASS", "FAIL"]);
    expect(flaky.checks.find((c) => !c.ok)?.check).toBe("probe 2/4: status");
  });

  it("sustained health never passes when a probe gets no answer", async () => {
    const r = await runPlan({ ...PLAN, repeat: { count: 3, intervalMs: 1000 } }, `${fx.origin}/hang`, { policy: fx.policy, sleep: async () => undefined });
    expect(r.outcome).toBe("INCONCLUSIVE");
    expect(r.probes).toHaveLength(1);
  });
});
