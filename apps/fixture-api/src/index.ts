/**
 * A controlled API for demonstrating verification. It has two "deployments" of the same
 * service: `/broken` (a buggy build) and `/fixed` (the corrected build). A worker submits
 * `<host>/broken` first and gets a real FAIL, then submits `<host>/fixed` and gets a real PASS.
 * Responses are static, so results are reproducible for judges.
 */
export const DEMO_PLAN = {
  kind: "HTTP_API",
  version: 1,
  method: "GET",
  path: "/health",
  expectedStatus: 200,
  assertions: [
    { op: "equals", path: "$.status", value: "ok" },
    { op: "type", path: "$.checks", type: "array" },
    { op: "equals", path: "$.checks[0].name", value: "database" },
  ],
  timeoutMs: 5000,
  maxResponseBytes: 65536,
} as const;

const DEPLOYMENTS: Record<string, unknown> = {
  "/broken/health": { status: "degraded", version: "1.0.0", checks: [{ name: "database", ok: false }] },
  "/fixed/health": { status: "ok", version: "1.0.1", checks: [{ name: "database", ok: true }] },
};

/** Returns the fixture response for a path (relative to where the fixture is mounted), or null. */
export function fixtureResponse(method: string, path: string): { status: number; body: string } | null {
  const body = DEPLOYMENTS[path.split("?")[0] ?? ""];
  if (method !== "GET" || body === undefined) return null;
  return { status: 200, body: JSON.stringify(body) };
}
