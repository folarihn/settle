import { createHash } from "node:crypto";
import { checkContent, type ContentRulesPlan } from "@settle/domain";
import { sendRequest, TransportError } from "./http.js";
import { buildTargetUrl, DEFAULT_POLICY, resolvePinned, systemResolver, TargetRejected } from "./policy.js";
import type { RunDeps, RunResult } from "./runner.js";

const FETCH_TIMEOUT_MS = 15_000;
const SHA256 = /^sha256:([0-9a-f]{64})$/;

/**
 * Written or data deliverables (CONTENT_RULES). Fail closed:
 * - FAIL: the bytes don't match the submitted hash, the deliverable is missing (404), too large,
 *   or any rule fails. The worker must submit new work.
 * - INCONCLUSIVE: the deliverable could not be read (network, 5xx). Re-runnable.
 * - PASS: the exact submitted bytes satisfy every agreed rule.
 * Nothing in the deliverable is executed.
 */
export async function runContentPlan(plan: ContentRulesPlan, submission: { artifactHash: string; uri?: string | undefined }, deps: RunDeps = {}): Promise<RunResult> {
  const result: RunResult = { outcome: "RUNNER_ERROR", targetUrl: null, resolvedAddress: null, status: null, latencyMs: null, responseBytes: null, bodySha256: null, checks: [], error: null };
  const fail = (check: string, detail: string): RunResult => ({ ...result, outcome: "FAIL", checks: [...result.checks, { check, ok: false, detail }] });

  const want = submission.artifactHash.match(SHA256)?.[1];
  if (!want) return fail("artifact hash", "the submission's artifact hash must be sha256:<64 hex>");

  let body: Buffer | null = null;
  try {
    // SETTLE's own content-addressed store first: it holds exactly the bytes for this hash.
    const stored = deps.loadContent ? await deps.loadContent(`sha256:${want}`) : null;
    if (stored !== null) {
      body = Buffer.from(stored, "utf8");
      result.content = { source: "settle-store" };
    } else if (submission.uri) {
      const policy = deps.policy ?? DEFAULT_POLICY;
      // Same rules as API checks: HTTPS, standard ports, no credentials, no private or internal hosts.
      const url = buildTargetUrl(submission.uri, "", policy);
      result.targetUrl = url.toString();
      const pinned = await resolvePinned(url.hostname, deps.resolve ?? systemResolver, policy);
      result.resolvedAddress = pinned.address;
      const res = await sendRequest({ method: "GET", url, pinned, timeoutMs: FETCH_TIMEOUT_MS, maxResponseBytes: plan.maxBytes });
      result.status = res.status;
      result.latencyMs = res.latencyMs;
      if (res.status === 404 || res.status === 410) return fail("deliverable found", `the submitted URL answered ${res.status}`);
      if (res.status !== 200) return { ...result, outcome: "INCONCLUSIVE", error: { kind: "HTTP_STATUS", message: `the submitted URL answered ${res.status}` } };
      body = res.body;
      result.content = { source: "url" };
    } else {
      return fail("deliverable found", "the deliverable is not in SETTLE's store and the submission has no URL");
    }
  } catch (e) {
    if (e instanceof TargetRejected) return { ...fail("target allowed", e.message), error: { kind: "TARGET_REJECTED", message: e.message } };
    if (e instanceof TransportError && e.kind === "BODY_TOO_LARGE") return { ...fail("size", e.message), error: { kind: e.kind, message: e.message } };
    return { ...result, outcome: "INCONCLUSIVE", error: { kind: e instanceof TransportError ? e.kind : "NETWORK", message: e instanceof Error ? e.message : String(e) } };
  }

  result.responseBytes = body.length;
  result.bodySha256 = createHash("sha256").update(body).digest("hex");
  const integrity = { check: "matches the submitted hash", ok: result.bodySha256 === want, detail: result.bodySha256 === want ? "sha256 matches" : `got sha256:${result.bodySha256}` };
  if (!integrity.ok) return { ...result, outcome: "FAIL", checks: [integrity] };
  if (body.length > plan.maxBytes) return { ...result, outcome: "FAIL", checks: [integrity, { check: "size", ok: false, detail: `${body.length} bytes (limit ${plan.maxBytes})` }] };

  const text = new TextDecoder("utf-8", { fatal: false }).decode(body);
  const checks = [integrity, ...checkContent(plan, text)];
  return { ...result, checks, outcome: checks.every((c) => c.ok) ? "PASS" : "FAIL" };
}
