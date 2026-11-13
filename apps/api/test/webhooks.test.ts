import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_ATTEMPTS, WebhookService } from "../src/index.js";
import { as, CLIENT, jobInput, login, STRANGER, startHarness, WORKER, type Harness } from "./harness.js";

/** Independent check of the documented scheme: v1 = HMAC-SHA256(secret, "<t>.<body>"). */
function verifyWebhookSignature(secret: string, header: string, body: string, { now = Date.now() } = {}) {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header);
  if (!m || Math.abs(now - Number(m[1])) > 5 * 60_000) return false;
  return createHmac("sha256", secret).update(`${m[1]}.${body}`).digest("hex") === m[2];
}

interface Received {
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

let h: Harness;
let receiver: Server;
let origin: string;
let received: Received[] = [];
let answer = 200;
beforeAll(async () => {
  h = await startHarness();
  receiver = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ url: req.url ?? "", headers: req.headers, body });
      res.writeHead(answer).end();
    });
  });
  await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
  h.policy.insecureTestOrigins.push(origin);
});
afterAll(async () => {
  receiver.closeAllConnections();
  await new Promise((r) => receiver.close(r));
  await h.close();
});

/** The delivery for one job. Other test files may share the database and the client account, so a webhook can also hold their jobs' deliveries. */
interface Delivery { jobId: string; attempts: number; deliveredAt: number | null; lastStatus: number | null; lastError: string | null }
const deliveryFor = (deliveries: Delivery[], jobId: string): Delivery | undefined => deliveries.find((d) => d.jobId === jobId);

describe("webhooks", () => {
  it("rejects URLs the worker must never call", async () => {
    const client = as(h, await login(h, CLIENT));
    for (const url of ["http://example.com/hook", "https://10.0.0.5/hook", "https://localhost/hook", "https://user:pw@example.com/hook", "ftp://example.com"]) {
      const res = await client.post("/v1/webhooks", { url });
      expect(res.statusCode, url).toBe(400);
    }
  });

  it("delivers signed events only to the job's parties, and the signature verifies", async () => {
    received = [];
    const client = as(h, await login(h, CLIENT));
    const worker = as(h, await login(h, WORKER, "AGENT"));
    const stranger = as(h, await login(h, STRANGER));
    const hook = (await worker.post("/v1/webhooks", { url: `${origin}/worker` })).json();
    expect(hook.secret).toMatch(/^whsec_[0-9a-f]{64}$/);
    await stranger.post("/v1/webhooks", { url: `${origin}/stranger` });
    expect(JSON.stringify((await worker.get("/v1/webhooks")).json())).not.toContain(hook.secret);

    const job = (await client.post("/v1/jobs", jobInput())).json();
    await worker.post(`/v1/jobs/${job.id}/actions`, { type: "ACCEPT_TERMS", termsHash: job.state.termsHash });

    const sender = new WebhookService(h.db, Date.now, h.policy);
    await sender.deliverDue(500);
    // Only this job's events count: parallel test files may share the database and these accounts.
    const mine = () => received.filter((r) => JSON.parse(r.body).jobId === job.id);
    expect(mine().map((r) => [r.url, JSON.parse(r.body).event.type])).toEqual([
      ["/worker", "ACCEPT_TERMS"], // the client's acceptance at creation
      ["/worker", "ACCEPT_TERMS"], // then the worker's
    ]);
    expect(received.some((r) => r.url === "/stranger" && JSON.parse(r.body).jobId === job.id)).toBe(false);
    for (const r of mine()) {
      expect(JSON.parse(r.body).jobId).toBe(job.id);
      expect(verifyWebhookSignature(hook.secret, r.headers["settle-signature"] as string, r.body)).toBe(true);
      // Any change to the body, or a different secret, fails verification.
      expect(verifyWebhookSignature(hook.secret, r.headers["settle-signature"] as string, r.body.replace("ACCEPT", "APPROVE"))).toBe(false);
      expect(verifyWebhookSignature(`whsec_${"0".repeat(64)}`, r.headers["settle-signature"] as string, r.body)).toBe(false);
    }
    // A stale signature is refused, so a captured delivery cannot be replayed later.
    const first = mine()[0]!;
    expect(verifyWebhookSignature(hook.secret, first.headers["settle-signature"] as string, first.body, { now: Date.now() + 10 * 60_000 })).toBe(false);

    const log = ((await worker.get(`/v1/webhooks/${hook.id}/deliveries`)).json().deliveries as Delivery[]).filter((d) => d.jobId === job.id);
    expect(log).toHaveLength(2);
    expect(log.every((d) => d.deliveredAt !== null && d.lastStatus === 200)).toBe(true);
    await sender.deliverDue(500);
    expect(mine()).toHaveLength(2); // nothing is sent twice
    expect((await client.get(`/v1/webhooks/${hook.id}/deliveries`)).statusCode).toBe(404); // not the client's webhook
  });

  it("retries a failing receiver with backoff, gives up after the limit, and never touches the job", async () => {
    received = [];
    answer = 500;
    const client = as(h, await login(h, CLIENT));
    const hook = (await client.post("/v1/webhooks", { url: `${origin}/flaky` })).json();
    const job = (await client.post("/v1/jobs", jobInput())).json();

    let now = Date.now();
    const sender = new WebhookService(h.db, () => now, h.policy);
    const attempts = () => received.filter((r) => r.url === "/flaky" && r.body.includes(job.id)).length;
    expect(await sender.deliverDue()).toBeGreaterThan(0);
    expect(attempts()).toBe(1);
    await sender.deliverDue();
    expect(attempts()).toBe(1); // backing off: not due yet
    for (let i = 0; i < MAX_ATTEMPTS + 2; i++) {
      now += 24 * 60 * 60_000;
      await sender.deliverDue();
    }
    expect(attempts()).toBe(MAX_ATTEMPTS);
    const d = deliveryFor((await client.get(`/v1/webhooks/${hook.id}/deliveries`)).json().deliveries, job.id);
    expect(d).toMatchObject({ attempts: MAX_ATTEMPTS, deliveredAt: null, lastStatus: 500, lastError: "receiver answered 500" });
    expect((await client.get(`/v1/jobs/${job.id}`)).json().job.state.status).toBe("DRAFT");

    expect((await client.delete(`/v1/webhooks/${hook.id}`)).statusCode).toBe(204);
    answer = 200;
  });

  it("refuses to deliver to a hostname that resolves to a private address", async () => {
    const client = as(h, await login(h, CLIENT));
    const hook = (await client.post("/v1/webhooks", { url: "https://hooks.example.test/settle" })).json();
    const job = (await client.post("/v1/jobs", jobInput())).json();
    const sender = new WebhookService(h.db, Date.now, undefined, async () => [{ address: "10.1.2.3", family: 4 }]);
    await sender.deliverDue(500);
    const d = deliveryFor((await client.get(`/v1/webhooks/${hook.id}/deliveries`)).json().deliveries, job.id);
    expect(d?.deliveredAt).toBeNull();
    expect(d?.lastError).toContain("blocked address");
  });
});
