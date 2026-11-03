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

/** Returns a throttled fire-and-forget call to the worker's /kick route (at most once per `everyMs`). */
export function workerWaker(baseUrl: string, everyMs = 10_000, now: () => number = Date.now): () => void {
  let last = -Infinity;
  const url = `${baseUrl.replace(/\/+$/, "")}/kick`;
  return () => {
    if (now() - last < everyMs) return;
    last = now();
    // A sleeping free instance can take about a minute to start; never block the caller.
    fetch(url, { method: "POST", signal: AbortSignal.timeout(90_000) }).catch(() => undefined);
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
