import { createServer, type Server } from "node:http";
import type { VerifyOptions } from "@settle/verifier";
import type { VerificationService } from "./verifications.js";

/** Processes queued verifications until none remain. Returns how many it ran. */
export async function drainQueue(verifications: VerificationService, opts: VerifyOptions): Promise<number> {
  let processed = 0;
  for (let row = await verifications.claim(); row; row = await verifications.claim()) {
    await verifications.process(row, opts);
    processed += 1;
  }
  return processed;
}

/**
 * Minimal HTTP surface for hosting the worker as a (free, sleep-on-idle) web service:
 * `GET /healthz` for the platform's health check and `POST /kick`, which the API calls
 * after queueing a verification so a sleeping instance wakes up. Neither route reads or
 * returns any data; the worker loop does the actual processing.
 */
export function startWakeServer(port: number): Server {
  const server = createServer((req, res) => {
    const route = `${req.method} ${(req.url ?? "").split("?")[0]}`;
    const status = route === "GET /healthz" ? 200 : route === "POST /kick" ? 202 : 404;
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ ok: status !== 404 }));
  });
  server.listen(port, "0.0.0.0");
  return server;
}

export interface WakeLog {
  info: (o: object, msg: string) => void;
  warn: (o: object, msg: string) => void;
}

/**
 * Returns a throttled, fire-and-forget call to the worker's /kick route (at most one attempt
 * per `everyMs`). Outcomes are logged; a failed attempt is retried a few times with backoff,
 * and queued jobs stay queued meanwhile, so nothing is lost.
 */
export function workerWaker(baseUrl: string, log?: WakeLog, everyMs = 10_000, now: () => number = Date.now): () => void {
  let last = -Infinity;
  const url = `${baseUrl.replace(/\/+$/, "")}/kick`;
  const attempt = async (n: number): Promise<void> => {
    const started = now();
    try {
      // A sleeping free instance can take about a minute to start.
      const res = await fetch(url, { method: "POST", body: "", signal: AbortSignal.timeout(90_000) });
      log?.info({ status: res.status, ms: now() - started, attempt: n }, "worker wake-up answered");
      if (res.status >= 500 && n < 3) setTimeout(() => void attempt(n + 1), 5000 * n);
    } catch (e) {
      log?.warn({ err: e instanceof Error ? e.message : String(e), ms: now() - started, attempt: n }, "worker wake-up failed");
      if (n < 3) setTimeout(() => void attempt(n + 1), 5000 * n);
    }
  };
  return () => {
    if (now() - last < everyMs) return;
    last = now();
    void attempt(1);
  };
}

export async function runWorkerLoop(
  verifications: VerificationService,
  seedHex: string,
  log: { error: (o: unknown, msg?: string) => void },
  idleMs = 1000,
): Promise<never> {
  for (;;) {
    try {
      if ((await drainQueue(verifications, { seedHex })) === 0) await new Promise((r) => setTimeout(r, idleMs));
    } catch (e) {
      log.error(e, "verification worker iteration failed");
      await new Promise((r) => setTimeout(r, idleMs));
    }
  }
}
