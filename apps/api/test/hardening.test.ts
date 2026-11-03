import { describe, expect, it } from "vitest";
import { buildApp, configFromEnv, createPgliteDb, migrate } from "../src/index.js";
import { config, FakeChain } from "./harness.js";

const base = {
  SETTLE_ESCROW_CONTRACT: "settle-escrow.testnet",
  SETTLE_VERIFIER_ACCOUNT: "verifier.testnet",
  SETTLE_VERIFIER_PUBLIC_KEY: "1".repeat(64),
  SETTLE_RESOLVER_ACCOUNT: "resolver.testnet",
  SETTLE_DATABASE_URL: "postgres://u:p@db.internal:5432/settle",
};

describe("deployment configuration checks", () => {
  it("accepts a production-shaped API environment", () => {
    expect(configFromEnv({ ...base, RENDER_EXTERNAL_URL: "https://settle-demo.onrender.com" }).publicUrl).toBe(
      "https://settle-demo.onrender.com",
    );
  });

  it.each([
    ["the verifier seed on the internet-facing API", { SETTLE_VERIFIER_SEED: "ab".repeat(32) }, "must not be set on the API"],
    ["a test-only verifier key", { SETTLE_VERIFIER_PUBLIC_KEY: "d04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737" }, "test-only"],
    ["a mainnet contract on testnet", { SETTLE_ESCROW_CONTRACT: "settle.near" }, ".testnet"],
    ["no database", { SETTLE_DATABASE_URL: "" }, "SETTLE_DATABASE_URL is required"],
    ["a plain-http public URL", { SETTLE_PUBLIC_URL: "http://settle.example" }, "must be https"],
    ["missing accounts", { SETTLE_RESOLVER_ACCOUNT: "" }, "resolverAccount"],
  ])("refuses %s", (_name, override, message) => {
    expect(() => configFromEnv({ ...base, ...override })).toThrow(message);
  });

  it("lets only the worker hold the verifier seed", () => {
    expect(() => configFromEnv({ ...base, SETTLE_VERIFIER_SEED: "ab".repeat(32) }, "worker")).not.toThrow();
  });
});

describe("rate limiting and readiness", () => {
  it("throttles repeated auth requests from one IP with 429 and Retry-After", async () => {
    const db = createPgliteDb();
    await migrate(db);
    const { app } = buildApp({
      db,
      chain: new FakeChain(),
      config,
      limits: { authPerIp: { max: 3, windowMs: 60_000 }, verificationsPerAccount: { max: 1, windowMs: 60_000 } },
    });
    const challenge = () => app.inject({ method: "POST", url: "/v1/auth/challenge", payload: { accountId: "a.testnet" } });
    for (let i = 0; i < 3; i++) expect((await challenge()).statusCode).toBe(200);
    const limited = await challenge();
    expect([limited.statusCode, limited.json().error.code]).toEqual([429, "RATE_LIMITED"]);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    const other = await app.inject({ method: "POST", url: "/v1/auth/challenge", payload: { accountId: "a.testnet" }, remoteAddress: "10.0.0.9" });
    expect(other.statusCode).toBe(200);

    expect((await app.inject({ method: "GET", url: "/readyz" })).json()).toMatchObject({ ok: true, checks: { database: "ok", contract: "ok" } });
    await app.close();
    await db.close();
  });
});

describe("waking a worker hosted on a sleep-on-idle plan", () => {
  it("exposes only a health check and a no-data kick route", async () => {
    const { startWakeServer } = await import("../src/index.js");
    const server = startWakeServer(0);
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/kick`, { method: "POST" })).status).toBe(202);
    expect((await fetch(`${base}/v1/jobs`)).status).toBe(404);
    server.close();
  });

  it("kicks the worker when a verification is queued, throttled", async () => {
    const { createServer } = await import("node:http");
    const { as, jobInput, login, onchainFunded, WORKER } = await import("./harness.js");
    let kicks = 0;
    const worker = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/kick") kicks += 1;
      res.writeHead(202).end();
    });
    await new Promise<void>((r) => worker.listen(0, "127.0.0.1", r));
    const wakeUrl = `http://127.0.0.1:${(worker.address() as { port: number }).port}`;
    const { startHarness } = await import("./harness.js");
    const h = await startHarness(undefined, { workerWakeUrl: wakeUrl });
    const client = as(h, await login(h, "client.testnet"));
    const agent = as(h, await login(h, WORKER, "AGENT"));
    const job = (await client.post("/v1/jobs", jobInput())).json();
    await agent.post(`/v1/jobs/${job.id}/actions`, { type: "ACCEPT_TERMS", termsHash: job.state.termsHash });
    h.chain.agreements.set(job.id, onchainFunded((await client.get(`/v1/jobs/${job.id}`)).json().job.state));
    await client.post(`/v1/jobs/${job.id}/sync`);
    await agent.post(`/v1/jobs/${job.id}/actions`, { type: "SUBMIT", milestoneId: "api", artifactHash: "c1", uri: `${h.fixtureOrigin}/broken` });
    const queued = await agent.post(`/v1/jobs/${job.id}/milestones/api/verifications`);
    expect(queued.statusCode).toBe(202);
    await agent.get(`/v1/verifications/${queued.json().id}`); // polling within the throttle window
    await new Promise((r) => setTimeout(r, 200));
    expect(kicks).toBe(1);
    await h.close();
    worker.close();
  });
});
