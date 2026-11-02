import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { HttpVerificationPlan } from "@settle/domain";
import type { NetworkPolicy } from "../src/index.js";

/**
 * A controlled API with one deployment per path prefix, e.g. `${origin}/good/health`.
 * The tests reach it through an explicit test policy; the default policy blocks it.
 */
export interface Fixture {
  origin: string;
  policy: NetworkPolicy;
  hits: () => number;
  close: () => Promise<void>;
}

export const PLAN: HttpVerificationPlan = {
  kind: "HTTP_API",
  version: 1,
  method: "GET",
  path: "/health",
  expectedStatus: 200,
  assertions: [
    { op: "equals", path: "$.status", value: "ok" },
    { op: "type", path: "$.items", type: "array" },
    { op: "exists", path: "$.items[1]" },
  ],
  timeoutMs: 500,
  maxResponseBytes: 1024,
};

const json = (body: unknown) => ({ status: 200, body: JSON.stringify(body) });

const ROUTES: Record<string, { status: number; body: string; headers?: Record<string, string> } | "hang"> = {
  "/good/health": json({ status: "ok", items: [1, 2] }),
  "/wrong-value/health": json({ status: "degraded", items: [1, 2] }),
  "/wrong-type/health": json({ status: "ok", items: "1,2" }),
  "/missing/health": json({ status: "ok", items: [1] }),
  "/proto/health": { status: 200, body: '{"status":"ok","__proto__":{"items":[1,2]}}' },
  "/error/health": { status: 500, body: "{}" },
  "/html/health": { status: 200, body: "<html>ok</html>" },
  "/big/health": json({ status: "ok", items: [1, 2], pad: "x".repeat(4096) }),
  "/redirect/health": { status: 302, body: "", headers: { location: "http://169.254.169.254/latest/meta-data/" } },
  "/hang/health": "hang",
};

export async function startFixture(): Promise<Fixture> {
  let hits = 0;
  const server: Server = createServer((req, res) => {
    hits += 1;
    const route = ROUTES[req.url ?? ""];
    if (route === "hang") return; // never respond
    if (!route) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(route.status, { "content-type": "application/json", ...route.headers }).end(route.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    policy: { insecureTestOrigins: [origin], testAddresses: ["127.0.0.1"] },
    hits: () => hits,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
