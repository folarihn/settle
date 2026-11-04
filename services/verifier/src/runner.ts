import { createHash } from "node:crypto";
import type { HttpVerificationPlan, JsonAssertion, VerificationOutcome } from "@settle/domain";
import { sendRequest, TransportError, type HttpResponse } from "./http.js";
import { buildTargetUrl, DEFAULT_POLICY, resolvePinned, systemResolver, TargetRejected, type NetworkPolicy, type Resolver } from "./policy.js";

export interface CheckResult {
  check: string;
  ok: boolean;
  detail: string;
}

export interface RunResult {
  outcome: VerificationOutcome;
  targetUrl: string | null;
  resolvedAddress: string | null;
  status: number | null;
  latencyMs: number | null;
  responseBytes: number | null;
  /** The body itself is not kept (it may contain data the worker did not mean to publish). */
  bodySha256: string | null;
  checks: CheckResult[];
  error: { kind: string; message: string } | null;
  /** Sustained-health plans: one entry per probe, in order. */
  probes?: { at: number; outcome: VerificationOutcome; status: number | null; latencyMs: number | null }[];
  /** GitHub plans: what was checked. */
  github?: { repo: string; commit: string; branch: string; onBranch: boolean | null };
}

export interface RunDeps {
  policy?: NetworkPolicy;
  resolve?: Resolver;
  /** Waits between sustained-health probes; tests replace it. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Optional read-only token for the GitHub API (raises its rate limit); never needed for public repos. */
  githubToken?: string;
  /** GitHub API origin; tests point it at a local server. */
  githubApiBase?: string;
}

/**
 * Outcome rules (fail closed; only an explicit PASS can lead to payment):
 * - PASS: a response arrived and every agreed check held.
 * - FAIL: a response arrived and a check failed, or the submitted target is not
 *   allowed (non-HTTPS, private address...). The worker must submit new work.
 * - INCONCLUSIVE: no usable response (DNS failure, refused, timeout). Re-runnable.
 * - RUNNER_ERROR: the verifier itself broke.
 */
export async function runPlan(plan: HttpVerificationPlan, baseUrl: string, deps: RunDeps = {}): Promise<RunResult> {
  const repeat = plan.repeat;
  if (!repeat) return runOnce(plan, baseUrl, deps);
  // Sustained health: every probe must pass. Stops at the first probe that does not, and
  // reports that probe's outcome (FAIL is definitive; no response stays INCONCLUSIVE).
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const probes: NonNullable<RunResult["probes"]> = [];
  const checks: CheckResult[] = [];
  let last!: RunResult;
  for (let i = 1; i <= repeat.count; i++) {
    if (i > 1) await sleep(repeat.intervalMs);
    const at = now();
    last = await runOnce(plan, baseUrl, deps);
    probes.push({ at, outcome: last.outcome, status: last.status, latencyMs: last.latencyMs });
    checks.push(...last.checks.map((c) => ({ ...c, check: `probe ${i}/${repeat.count}: ${c.check}` })));
    if (last.outcome !== "PASS") break;
  }
  return { ...last, checks, probes };
}

async function runOnce(plan: HttpVerificationPlan, baseUrl: string, deps: RunDeps): Promise<RunResult> {
  const policy = deps.policy ?? DEFAULT_POLICY;
  const result: RunResult = {
    outcome: "RUNNER_ERROR",
    targetUrl: null,
    resolvedAddress: null,
    status: null,
    latencyMs: null,
    responseBytes: null,
    bodySha256: null,
    checks: [],
    error: null,
  };

  try {
    const url = buildTargetUrl(baseUrl, plan.path, policy);
    result.targetUrl = url.toString();
    let pinned;
    try {
      pinned = await resolvePinned(url.hostname, deps.resolve ?? systemResolver, policy);
    } catch (e) {
      if (e instanceof TargetRejected) throw e;
      return inconclusive(result, "DNS", e);
    }
    result.resolvedAddress = pinned.address;

    let res: HttpResponse;
    try {
      res = await sendRequest({
        method: plan.method,
        url,
        pinned,
        ...(plan.requestBody !== undefined ? { body: JSON.stringify(plan.requestBody) } : {}),
        timeoutMs: plan.timeoutMs,
        maxResponseBytes: plan.maxResponseBytes,
      });
    } catch (e) {
      if (e instanceof TransportError && e.kind === "BODY_TOO_LARGE") {
        result.checks.push({ check: "response size", ok: false, detail: e.message });
        result.error = { kind: e.kind, message: e.message };
        result.outcome = "FAIL";
        return result;
      }
      return inconclusive(result, e instanceof TransportError ? e.kind : "NETWORK", e);
    }

    result.status = res.status;
    result.latencyMs = res.latencyMs;
    result.responseBytes = res.body.length;
    result.bodySha256 = createHash("sha256").update(res.body).digest("hex");
    result.checks = evaluate(plan, res);
    result.outcome = result.checks.every((c) => c.ok) ? "PASS" : "FAIL";
    return result;
  } catch (e) {
    if (e instanceof TargetRejected) {
      result.outcome = "FAIL";
      result.error = { kind: "TARGET_REJECTED", message: e.message };
      result.checks.push({ check: "target allowed", ok: false, detail: e.message });
      return result;
    }
    result.outcome = "RUNNER_ERROR";
    result.error = { kind: "RUNNER_ERROR", message: e instanceof Error ? e.message : String(e) };
    return result;
  }
}

function inconclusive(result: RunResult, kind: string, e: unknown): RunResult {
  result.outcome = "INCONCLUSIVE";
  result.error = { kind, message: e instanceof Error ? e.message : String(e) };
  return result;
}

function evaluate(plan: HttpVerificationPlan, res: HttpResponse): CheckResult[] {
  const checks: CheckResult[] = [
    { check: "status", ok: res.status === plan.expectedStatus, detail: `expected ${plan.expectedStatus}, got ${res.status}` },
  ];
  if (plan.maxLatencyMs !== undefined) {
    checks.push({
      check: "latency",
      ok: res.latencyMs <= plan.maxLatencyMs,
      detail: `${res.latencyMs} ms (limit ${plan.maxLatencyMs} ms)`,
    });
  }
  if (plan.assertions.length === 0) return checks;

  let json: unknown;
  try {
    json = JSON.parse(res.body.toString("utf8"));
  } catch {
    checks.push({ check: "json body", ok: false, detail: "response body is not valid JSON" });
    return checks;
  }
  for (const a of plan.assertions) checks.push(checkAssertion(a, json));
  return checks;
}

function checkAssertion(a: JsonAssertion, root: unknown): CheckResult {
  const found = readPath(root, a.path);
  const actual = found.exists ? preview(found.value) : "missing";
  switch (a.op) {
    case "exists":
      return { check: `${a.path} exists`, ok: found.exists, detail: actual };
    case "equals":
      return { check: `${a.path} == ${preview(a.value)}`, ok: found.exists && found.value === a.value, detail: `got ${actual}` };
    case "type":
      return { check: `${a.path} is ${a.type}`, ok: found.exists && typeOf(found.value) === a.type, detail: `got ${found.exists ? typeOf(found.value) : "missing"}` };
  }
}

/** Evaluates `$`, `$.field`, `$.list[0].field` (the only forms plans may use). Own properties only. */
export function readPath(root: unknown, path: string): { exists: boolean; value?: unknown } {
  let current: unknown = root;
  for (const [, key, index] of path.slice(1).matchAll(/\.([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]/g)) {
    if (key !== undefined) {
      if (current === null || typeof current !== "object" || Array.isArray(current) || !Object.hasOwn(current, key)) {
        return { exists: false };
      }
      current = (current as Record<string, unknown>)[key];
    } else {
      const i = Number(index);
      if (!Array.isArray(current) || i >= current.length) return { exists: false };
      current = current[i];
    }
  }
  return { exists: true, value: current };
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function preview(v: unknown): string {
  const s = JSON.stringify(v) ?? String(v);
  return s.length > 200 ? `${s.slice(0, 200)}...` : s;
}
