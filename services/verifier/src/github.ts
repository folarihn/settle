import type { GithubChecksPlan } from "@settle/domain";
import { sendRequest, TransportError } from "./http.js";
import { buildTargetUrl, DEFAULT_POLICY, resolvePinned, systemResolver, TargetRejected } from "./policy.js";
import type { CheckResult, RunDeps, RunResult } from "./runner.js";

const GITHUB_API = "https://api.github.com";

/** A transient problem talking to GitHub (rate limit, outage, network): never a PASS or a FAIL. */
class GithubUnavailable extends Error {}

interface CheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
}

/**
 * Judges a commit against a GITHUB_CHECKS plan, reading only GitHub's public API:
 * - FAIL: the commit is not on the agreed branch, does not exist in the repo, or a required check failed.
 * - INCONCLUSIVE: a required check has not finished (or not started) yet, or GitHub could not be read. Re-runnable.
 * - PASS: the commit is on the branch and every required check run or commit status succeeded.
 */
export async function runGithubPlan(plan: GithubChecksPlan, commitSha: string, deps: RunDeps = {}): Promise<RunResult> {
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
  const fail = (check: string, detail: string): RunResult => {
    result.checks.push({ check, ok: false, detail });
    result.outcome = "FAIL";
    return result;
  };

  const sha = commitSha.toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) return fail("commit SHA", "the submission's artifact hash must be a full 40-character commit SHA");
  result.targetUrl = `https://github.com/${plan.repo}/commit/${sha}`;
  result.github = { repo: plan.repo, commit: sha, branch: plan.branch, onBranch: null };

  try {
    const get = (path: string) => githubGet(path, deps, result);

    // 1. The commit must already be part of the agreed branch.
    const cmp = await get(`/repos/${plan.repo}/compare/${encodeURI(plan.branch)}...${sha}`);
    if (cmp.status === 404 || cmp.status === 422) return fail(`commit on ${plan.branch}`, `commit or branch not found in ${plan.repo}`);
    if (cmp.status !== 200) throw new GithubUnavailable(`compare answered ${cmp.status}`);
    const relation = (cmp.json as { status?: string }).status;
    const onBranch = relation === "identical" || relation === "behind";
    result.github.onBranch = onBranch;
    result.checks.push({ check: `commit on ${plan.branch}`, ok: onBranch, detail: `commit is ${relation ?? "unknown"} relative to ${plan.branch}` });
    if (!onBranch) {
      result.outcome = "FAIL";
      return result;
    }

    // 2. Every required check, reported either as a check run or as a commit status.
    const runsRes = await get(`/repos/${plan.repo}/commits/${sha}/check-runs?per_page=100`);
    if (runsRes.status !== 200) throw new GithubUnavailable(`check-runs answered ${runsRes.status}`);
    const statusRes = await get(`/repos/${plan.repo}/commits/${sha}/status`);
    if (statusRes.status !== 200) throw new GithubUnavailable(`status answered ${statusRes.status}`);
    result.status = runsRes.status;
    const page = runsRes.json as { total_count?: number; check_runs?: CheckRun[] };
    const runs = [...(page.check_runs ?? [])];
    // Large CI setups report more than one page of check runs: look up missing required checks by name.
    if ((page.total_count ?? 0) > runs.length) {
      for (const name of plan.requiredChecks.filter((n) => !runs.some((r) => r.name === n))) {
        const byName = await get(`/repos/${plan.repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(name)}&filter=all&per_page=100`);
        if (byName.status !== 200) throw new GithubUnavailable(`check-runs answered ${byName.status}`);
        runs.push(...((byName.json as { check_runs?: CheckRun[] }).check_runs ?? []));
      }
    }
    runs.sort((a, b) => b.id - a.id);
    const statuses = (statusRes.json as { statuses?: { context: string; state: string }[] }).statuses ?? [];

    let pending = false;
    for (const name of plan.requiredChecks) {
      const run = runs.find((r) => r.name === name); // newest first, so a re-run counts
      const st = statuses.find((s) => s.context === name);
      let check: CheckResult;
      if (run) {
        if (run.status !== "completed") {
          pending = true;
          check = { check: name, ok: false, detail: `still ${run.status}` };
        } else check = { check: name, ok: run.conclusion === "success", detail: `concluded ${run.conclusion}` };
      } else if (st) {
        if (st.state === "pending") {
          pending = true;
          check = { check: name, ok: false, detail: "still pending" };
        } else check = { check: name, ok: st.state === "success", detail: `status ${st.state}` };
      } else {
        pending = true;
        check = { check: name, ok: false, detail: "not reported for this commit yet" };
      }
      result.checks.push(check);
    }
    const failed = result.checks.some((c) => !c.ok && !/still|not reported/.test(c.detail));
    result.outcome = failed ? "FAIL" : pending ? "INCONCLUSIVE" : "PASS";
    if (result.outcome === "INCONCLUSIVE") result.error = { kind: "PENDING", message: "required checks have not all finished; verify again later" };
    return result;
  } catch (e) {
    if (e instanceof GithubUnavailable || e instanceof TransportError) {
      result.outcome = "INCONCLUSIVE";
      result.error = { kind: "GITHUB_UNAVAILABLE", message: e.message };
      return result;
    }
    if (e instanceof TargetRejected) {
      result.outcome = "RUNNER_ERROR";
      result.error = { kind: "TARGET_REJECTED", message: e.message };
      return result;
    }
    result.outcome = "RUNNER_ERROR";
    result.error = { kind: "RUNNER_ERROR", message: e instanceof Error ? e.message : String(e) };
    return result;
  }
}

/** One GET to GitHub through the same pinned, redirect-free, size-limited client as HTTP plans. */
async function githubGet(path: string, deps: RunDeps, result: RunResult): Promise<{ status: number; json: unknown }> {
  const policy = deps.policy ?? DEFAULT_POLICY;
  const url = buildTargetUrl(deps.githubApiBase ?? GITHUB_API, path, policy);
  const pinned = await resolvePinned(url.hostname, deps.resolve ?? systemResolver, policy).catch((e: unknown) => {
    if (e instanceof TargetRejected) throw e;
    throw new GithubUnavailable(`DNS: ${(e as Error).message}`);
  });
  result.resolvedAddress = pinned.address;
  const res = await sendRequest({
    method: "GET",
    url,
    pinned,
    timeoutMs: 10_000,
    maxResponseBytes: 2 * 1024 * 1024,
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(deps.githubToken ? { authorization: `Bearer ${deps.githubToken}` } : {}),
    },
  });
  // Rate limits and outages are GitHub's state, not the worker's.
  if (res.status === 403 || res.status === 429 || res.status >= 500) throw new GithubUnavailable(`GitHub answered ${res.status}`);
  let json: unknown = null;
  try {
    json = JSON.parse(res.body.toString("utf8"));
  } catch {
    if (res.status === 200) throw new GithubUnavailable("GitHub returned a non-JSON body");
  }
  return { status: res.status, json };
}
