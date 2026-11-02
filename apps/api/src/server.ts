import { existsSync } from "node:fs";
import { join } from "node:path";
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
import { VerificationService } from "./verifications.js";

export interface AppDeps {
  db: Db;
  chain: ChainReader;
  config: Config;
  now?: () => number;
  logger?: boolean;
}

const IdParams = z.object({ id: z.string().min(1).max(80) });
const MilestoneParams = IdParams.extend({ milestoneId: z.string().min(1).max(64) });

export function buildApp({ db, chain, config, now = Date.now, logger = false }: AppDeps) {
  const app = Fastify({ logger, bodyLimit: 256 * 1024 });
  const jobs = new JobService(db, chain, config, now);
  const verifications = new VerificationService(db, jobs, config, now);

  app.setErrorHandler((err, req, reply) => {
    const { status, body } = toErrorResponse(err);
    if (status === 500) req.log.error(err);
    // Fastify's own errors (bad JSON, body too large) carry a statusCode.
    const fastifyStatus = (err as { statusCode?: number }).statusCode;
    if (status === 500 && fastifyStatus && fastifyStatus < 500) {
      return reply.code(fastifyStatus).send({ error: { code: "BAD_REQUEST", message: (err as Error).message } });
    }
    return reply.code(status).send(body);
  });

  const auth = (req: FastifyRequest): Promise<Principal> => principalFromToken(db, req.headers.authorization, now());

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

  app.get("/healthz", async () => ({ ok: true }));

  app.get("/v1/config", async () => ({
    network: config.network,
    rpcUrl: config.rpcUrl,
    escrowContract: config.escrowContract,
    verifierAccount: config.verifierAccount,
    verifierPublicKey: config.verifierPublicKey,
    resolverAccount: config.resolverAccount,
    authRecipient: config.authRecipient,
    demoPlan: DEMO_PLAN,
    fixturePath: config.enableFixture ? "/fixture" : null,
  }));

  // ---- auth (identical for humans and agents) ----
  app.post("/v1/auth/challenge", async (req) => {
    const { accountId } = ChallengeRequest.parse(req.body);
    return createChallenge(db, accountId, config.authRecipient, now());
  });
  app.post("/v1/auth/verify", async (req) => verifyChallenge(db, chain, VerifyRequest.parse(req.body), config.authRecipient, now()));
  app.get("/v1/me", async (req) => auth(req));

  // ---- jobs ----
  app.post("/v1/jobs", async (req, reply) => {
    const p = await auth(req);
    return idempotent(p, req, reply, 201, () => jobs.create(p, req.body));
  });
  app.get("/v1/jobs", async (req) => ({ jobs: await jobs.list(await auth(req)) }));
  app.get("/v1/jobs/:id", async (req) => {
    const p = await auth(req);
    const job = await jobs.get(p, IdParams.parse(req.params).id);
    return { job, chain: await jobs.chainSnapshot(job.state) };
  });
  app.get("/v1/jobs/:id/events", async (req) => ({ events: await jobs.events(await auth(req), IdParams.parse(req.params).id) }));
  app.post("/v1/jobs/:id/actions", async (req, reply) => {
    const p = await auth(req);
    return idempotent(p, req, reply, 200, () => jobs.act(p, IdParams.parse(req.params).id, req.body));
  });
  app.post("/v1/jobs/:id/sync", async (req) => jobs.syncFromChain(await auth(req), IdParams.parse(req.params).id));

  // ---- verification ----
  app.post("/v1/jobs/:id/milestones/:milestoneId/verifications", async (req, reply) => {
    const p = await auth(req);
    const { id, milestoneId } = MilestoneParams.parse(req.params);
    return idempotent(p, req, reply, 202, () => verifications.request(p, id, milestoneId));
  });
  app.get("/v1/jobs/:id/verifications", async (req) => ({
    verifications: await verifications.listForJob(await auth(req), IdParams.parse(req.params).id),
  }));
  app.get("/v1/verifications/:id", async (req) => verifications.get(await auth(req), IdParams.parse(req.params).id));
  app.get("/v1/verifications/:id/evidence", async (req) => verifications.evidence(await auth(req), IdParams.parse(req.params).id));

  // ---- controlled demo API and web app ----
  if (config.enableFixture) {
    app.get("/fixture/*", async (req, reply) => {
      const r = fixtureResponse("GET", `/${(req.params as { "*": string })["*"]}`);
      return reply.code(r?.status ?? 404).type("application/json").send(r?.body ?? '{"error":"not found"}');
    });
  }
  if (config.webDist && existsSync(join(config.webDist, "index.html"))) {
    app.register(fastifyStatic, { root: config.webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) =>
      req.method === "GET" && !req.url.startsWith("/v1/")
        ? reply.sendFile("index.html")
        : reply.code(404).send({ error: { code: "NOT_FOUND", message: "route not found" } }),
    );
  }

  return { app, jobs, verifications };
}
