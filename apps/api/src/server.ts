import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import { DEMO_PLAN, fixtureResponse } from "@settle/fixture-api";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { ChallengeRequest, createChallenge, principalFromToken, verifyChallenge, VerifyRequest, type Principal } from "./auth.js";
import type { ChainReader } from "./chain.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { ApiError, toErrorResponse } from "./errors.js";
import { JobService } from "./jobs.js";
import { LIMITS, RateLimiter, type Limits } from "./rate-limit.js";
import { VerificationService } from "./verifications.js";
import { DeliverableService, reviewsForJob, SwarmService } from "./swarm.js";
import { WebhookService } from "./webhooks.js";
import { workerWaker } from "./worker.js";
import type { NetworkPolicy } from "@settle/verifier";

export interface AppDeps {
  db: Db;
  chain: ChainReader;
  config: Config;
  now?: () => number;
  logger?: boolean;
  limits?: Limits;
  /** Outbound network policy for webhook URLs; tests open loopback for a local receiver. */
  networkPolicy?: NetworkPolicy;
}

const IdParams = z.object({ id: z.string().min(1).max(80) });
const MilestoneParams = IdParams.extend({ milestoneId: z.string().min(1).max(64) });

export function buildApp({ db, chain, config, now = Date.now, logger = false, limits = LIMITS, networkPolicy }: AppDeps) {
  // Behind a reverse proxy (any hosted deployment), trust X-Forwarded-For for client IPs.
  const app = Fastify({ logger, bodyLimit: 256 * 1024, trustProxy: config.trustProxy });
  const limiter = new RateLimiter(now);
  const jobs = new JobService(db, chain, config, now);
  const webhooks = new WebhookService(db, now, networkPolicy);
  const swarm = new SwarmService(db, now);
  const deliverables = new DeliverableService(db, now);
  const verifications = new VerificationService(db, jobs, config, now, config.workerWakeUrl ? workerWaker(config.workerWakeUrl, app.log) : undefined);

  app.setErrorHandler((err, req, reply) => {
    const { status, body } = toErrorResponse(err);
    if (status === 500) req.log.error(err);
    // Fastify's own errors (bad JSON, body too large) carry a statusCode.
    const fastifyStatus = (err as { statusCode?: number }).statusCode;
    if (status === 500 && fastifyStatus && fastifyStatus < 500) {
      return reply.code(fastifyStatus).send({ error: { code: "BAD_REQUEST", message: (err as Error).message } });
    }
    if (err instanceof ApiError && err.retryAfterSec !== undefined) reply.header("retry-after", String(err.retryAfterSec));
    return reply.code(status).send(body);
  });

  const limitIp = (req: FastifyRequest) => limiter.hit(`auth:${req.ip}`, limits.authPerIp.max, limits.authPerIp.windowMs);

  const auth = (req: FastifyRequest): Promise<Principal> => principalFromToken(db, req.headers.authorization, now());
  /**
   * Public reads (ADR 0007): a session when one is sent (an invalid one is still a 401), otherwise
   * an anonymous viewer, rate limited per IP. Services decide what an anonymous viewer may read.
   */
  const viewer = async (req: FastifyRequest): Promise<Principal | null> => {
    if (req.headers.authorization) return auth(req);
    limiter.hit(`read:${req.ip}`, limits.publicReadsPerIp.max, limits.publicReadsPerIp.windowMs);
    return null;
  };

  /** Replays the stored response when a client retries with the same Idempotency-Key. */
  async function idempotent(p: Principal, req: FastifyRequest, reply: FastifyReply, status: number, fn: () => Promise<unknown>) {
    const key = req.headers["idempotency-key"];
    if (key === undefined) return reply.code(status).send(await fn());
    if (typeof key !== "string" || !/^[A-Za-z0-9_.:-]{8,100}$/.test(key)) {
      throw new ApiError(400, "VALIDATION", "Idempotency-Key must be 8-100 URL-safe characters");
    }
    const scoped = `${req.method} ${req.routeOptions.url} ${key}`;
    const { rows } = await db.query<{ status: number; body: unknown }>(
      "SELECT status, body FROM idempotency WHERE account_id = $1 AND key = $2",
      [p.accountId, scoped],
    );
    if (rows[0]) return reply.code(rows[0].status).header("idempotent-replay", "true").send(rows[0].body);
    const body = await fn();
    await db.query(
      "INSERT INTO idempotency (account_id, key, status, body, created_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING",
      [p.accountId, scoped, status, JSON.stringify(body), now()],
    );
    return reply.code(status).send(body);
  }

  // Liveness: the process is up.
  app.get("/healthz", async () => ({ ok: true }));
  // Readiness: the database answers and the escrow contract is deployed and answering.
  app.get("/readyz", async (_req, reply) => {
    const checks: Record<string, string> = {};
    try {
      await db.query("SELECT 1");
      checks.database = "ok";
    } catch (e) {
      checks.database = `error: ${(e as Error).message}`;
    }
    try {
      await chain.getAgreement("readyz-probe");
      checks.contract = "ok";
    } catch (e) {
      checks.contract = `error: ${(e as Error).message}`;
    }
    const ok = Object.values(checks).every((v) => v === "ok");
    return reply.code(ok ? 200 : 503).send({ ok, checks, escrowContract: config.escrowContract, network: config.network });
  });

  app.get("/v1/config", async () => ({
    network: config.network,
    rpcUrl: config.rpcUrl,
    escrowContract: config.escrowContract,
    verifierAccount: config.verifierAccount,
    verifierPublicKey: config.verifierPublicKey,
    resolverAccount: config.resolverAccount,
    authRecipient: config.authRecipient,
    /** The deployment's public HTTPS origin, for instructions shown to people and agents (never localhost). */
    publicUrl: config.publicUrl ? config.publicUrl.replace(/\/+$/, "") : null,
    demoPlan: DEMO_PLAN,
    fixturePath: config.enableFixture ? "/fixture" : null,
    /** Stable public HTTPS base of the demo fixture, for agents and judges. */
    fixtureBaseUrl: config.enableFixture && config.publicUrl ? `${config.publicUrl.replace(/\/+$/, "")}/fixture` : null,
    /**
     * Public wake-up URL of a verifier on a sleep-on-idle host. Render does not wake a sleeping
     * free service for requests from its other services (they get 502), only for outside
     * traffic, so clients (web app, agent SDK) also send POST {workerWakeUrl}/kick while a
     * verification is queued. The route returns no data and does no work itself.
     */
    workerWakeUrl: config.workerWakeUrl ?? null,
    /** Swarm-for-Hire settings, when a swarm runner is deployed. */
    swarm: config.swarm ?? null,
  }));

  // ---- auth (identical for humans and agents) ----
  app.post("/v1/auth/challenge", async (req) => {
    limitIp(req);
    const { accountId } = ChallengeRequest.parse(req.body);
    return createChallenge(db, accountId, config.authRecipient, now());
  });
  app.post("/v1/auth/verify", async (req) => {
    limitIp(req);
    return verifyChallenge(db, chain, VerifyRequest.parse(req.body), config.authRecipient, now());
  });
  app.get("/v1/me", async (req) => auth(req));

  // ---- jobs ----
  app.post("/v1/jobs", async (req, reply) => {
    const p = await auth(req);
    return idempotent(p, req, reply, 201, () => jobs.create(p, req.body));
  });
  app.get("/v1/jobs", async (req) => ({ jobs: await jobs.list(await auth(req)) }));
  app.get("/v1/bounties", async (req) => {
    const p = await viewer(req);
    const { scope } = z.object({ scope: z.enum(["open", "all"]).default("open") }).parse(req.query);
    return { bounties: scope === "all" ? await jobs.allBounties(p) : await jobs.openBounties(p) };
  });
  app.get("/v1/jobs/:id", async (req) => {
    const p = await viewer(req);
    const job = await jobs.get(p, IdParams.parse(req.params).id);
    return { job, chain: await jobs.chainSnapshot(job.state) };
  });
  app.get("/v1/activity", async (req) => {
    await viewer(req);
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) }).parse(req.query);
    return { items: await jobs.activity(limit) };
  });
  app.get("/v1/jobs/:id/events", async (req) => ({ events: await jobs.events(await viewer(req), IdParams.parse(req.params).id) }));
  app.post("/v1/jobs/:id/actions", async (req, reply) => {
    const p = await auth(req);
    return idempotent(p, req, reply, 200, () => jobs.act(p, IdParams.parse(req.params).id, req.body));
  });
  app.post("/v1/jobs/:id/sync", async (req) => jobs.syncFromChain(await auth(req), IdParams.parse(req.params).id));

  // ---- verification ----
  app.post("/v1/jobs/:id/milestones/:milestoneId/verifications", async (req, reply) => {
    const p = await auth(req);
    const { id, milestoneId } = MilestoneParams.parse(req.params);
    const { max, windowMs } = limits.verificationsPerAccount;
    limiter.hit(`verify:${p.accountId}`, max, windowMs);
    return idempotent(p, req, reply, 202, () => verifications.request(p, id, milestoneId));
  });
  app.get("/v1/jobs/:id/verifications", async (req) => ({
    verifications: await verifications.listForJob(await viewer(req), IdParams.parse(req.params).id),
  }));
  app.get("/v1/verifications/:id", async (req) => verifications.get(await viewer(req), IdParams.parse(req.params).id));
  app.get("/v1/verifications/:id/evidence", async (req) => verifications.evidence(await viewer(req), IdParams.parse(req.params).id));

  // ---- swarm-for-hire (ADR 0006) ----
  app.get("/v1/swarm/agents", async (req) => ({ agents: await swarm.list(await viewer(req)) }));
  app.post("/v1/swarm/agents", async (req, reply) => reply.code(201).send(await swarm.createAgent(await auth(req), req.body)));
  app.get("/v1/swarm/agents/:id", async (req) => {
    await viewer(req);
    return swarm.get(IdParams.parse(req.params).id);
  });
  app.post("/v1/swarm/agents/:id/edit", async (req) => swarm.updateAgent(await auth(req), IdParams.parse(req.params).id, req.body));
  app.get("/v1/swarm/agents/:id/settings", async (req) => swarm.settings(await auth(req), IdParams.parse(req.params).id));
  app.post("/v1/swarm/agents/:id/pause", async (req) => swarm.setPaused(await auth(req), IdParams.parse(req.params).id, true));
  app.post("/v1/swarm/agents/:id/resume", async (req) => swarm.setPaused(await auth(req), IdParams.parse(req.params).id, false));
  app.post("/v1/swarm/agents/:id/withdraw", async (req) => swarm.requestWithdrawal(await auth(req), IdParams.parse(req.params).id));

  // Content-addressed deliverables. The hash is also the onchain artifact hash, so anyone can
  // check the bytes they read are the bytes that were submitted.
  app.post("/v1/deliverables", async (req, reply) => {
    const d = await deliverables.create(await auth(req), req.body);
    return reply.code(201).send({ ...d, url: `/d/${d.hash.slice(7)}` });
  });
  app.get("/d/:hex", async (req, reply) => {
    const { hex } = z.object({ hex: z.string().regex(/^[0-9a-f]{64}$/) }).parse(req.params);
    const d = await deliverables.get(`sha256:${hex}`);
    if (!d) return reply.code(404).type("text/plain").send("not found");
    // Plain text only, never rendered as HTML by the browser.
    return reply
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'; sandbox")
      .header("x-settle-author", d.author)
      .type("text/plain; charset=utf-8")
      .send(d.content);
  });
  app.get("/v1/jobs/:id/reviews", async (req) => {
    const p = await viewer(req);
    const { id } = IdParams.parse(req.params);
    await jobs.get(p, id); // parties, or anyone for a posted bounty
    return { reviews: await reviewsForJob(db, id) };
  });

  // ---- webhooks (sent by the worker process, never from here) ----
  app.post("/v1/webhooks", async (req, reply) => reply.code(201).send(await webhooks.create(await auth(req), req.body)));
  app.get("/v1/webhooks", async (req) => ({ webhooks: await webhooks.list(await auth(req)) }));
  app.delete("/v1/webhooks/:id", async (req, reply) => {
    await webhooks.remove(await auth(req), IdParams.parse(req.params).id);
    return reply.code(204).send();
  });
  app.get("/v1/webhooks/:id/deliveries", async (req) => ({ deliveries: await webhooks.deliveries(await auth(req), IdParams.parse(req.params).id) }));

  // ---- controlled demo API and web app ----
  if (config.enableFixture) {
    app.get("/fixture/*", async (req, reply) => {
      const r = fixtureResponse("GET", `/${(req.params as { "*": string })["*"]}`);
      return reply.code(r?.status ?? 404).type("application/json").send(r?.body ?? '{"error":"not found"}');
    });
  }
  const webRoot = config.webDist ? resolve(config.webDist) : null;
  if (webRoot && existsSync(join(webRoot, "index.html"))) {
    app.register(fastifyStatic, { root: webRoot, wildcard: false });
    app.setNotFoundHandler((req, reply) =>
      req.method === "GET" && !req.url.startsWith("/v1/")
        ? reply.sendFile("index.html")
        : reply.code(404).send({ error: { code: "NOT_FOUND", message: "route not found" } }),
    );
  }

  return { app, jobs, verifications, webhooks };
}
