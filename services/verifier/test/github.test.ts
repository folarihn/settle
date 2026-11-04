import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { GithubChecksPlan } from "@settle/domain";
import { runGithubPlan, type NetworkPolicy } from "../src/index.js";

const SHA = "a".repeat(40);
const PLAN: GithubChecksPlan = { kind: "GITHUB_CHECKS", version: 1, repo: "acme/widget", branch: "main", requiredChecks: ["test", "lint"] };

/** A stand-in for api.github.com: per-test answers for compare, check-runs and status. */
let gh: {
  compare: { status: number; body: unknown };
  runs: { status: number; body: unknown };
  statuses: { status: number; body: unknown };
  byName: { status: number; body: unknown };
  seen: { url: string; auth: string | undefined }[];
};
let server: Server;
let base: string;
let policy: NetworkPolicy;

const run = (name: string, conclusion: string | null, id = 1, status = "completed") => ({ id, name, status, conclusion });
const ok = (body: unknown) => ({ status: 200, body });

beforeAll(async () => {
  server = createServer((req, res) => {
    gh.seen.push({ url: req.url ?? "", auth: req.headers.authorization });
    const url = req.url ?? "";
    const r = url.includes("/compare/")
      ? gh.compare
      : url.includes("check_name=")
        ? gh.byName
        : url.includes("/check-runs")
          ? gh.runs
          : url.endsWith("/status")
            ? gh.statuses
            : { status: 404, body: {} };
    res.writeHead(r.status, { "content-type": "application/json" }).end(JSON.stringify(r.body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  policy = { insecureTestOrigins: [base], testAddresses: ["127.0.0.1"] };
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  gh = {
    compare: ok({ status: "behind" }),
    runs: ok({ check_runs: [run("test", "success", 1), run("lint", "success", 2)] }),
    statuses: ok({ statuses: [] }),
    byName: ok({ check_runs: [] }),
    seen: [],
  };
});

const verify = (sha = SHA, plan = PLAN, token?: string) => runGithubPlan(plan, sha, { policy, githubApiBase: base, ...(token ? { githubToken: token } : {}) });

describe("GitHub checks runner", () => {
  it("passes when the commit is on the branch and every required check succeeded", async () => {
    const r = await verify();
    expect(r.outcome).toBe("PASS");
    expect(r.github).toEqual({ repo: "acme/widget", commit: SHA, branch: "main", onBranch: true });
    expect(gh.seen[0]!.url).toBe(`/repos/acme/widget/compare/main...${SHA}`);
  });

  it("fails a commit that is not on the agreed branch, without reading its checks", async () => {
    gh.compare = ok({ status: "ahead" }); // e.g. an unmerged pull request whose workflow could have been edited
    const r = await verify();
    expect(r.outcome).toBe("FAIL");
    expect(r.checks[0]).toMatchObject({ check: "commit on main", ok: false });
    expect(gh.seen.some((s) => s.url.includes("check-runs"))).toBe(false);
  });

  it("fails a commit that does not exist in the repo, and a malformed SHA without any request", async () => {
    gh.compare = { status: 404, body: { message: "Not Found" } };
    expect((await verify()).outcome).toBe("FAIL");
    gh.seen = [];
    const short = await verify("abc123");
    expect(short.outcome).toBe("FAIL");
    expect(short.checks[0]!.check).toBe("commit SHA");
    expect(gh.seen).toHaveLength(0);
  });

  it("fails when a required check failed, even if others passed", async () => {
    gh.runs = ok({ check_runs: [run("test", "failure", 1), run("lint", "success", 2)] });
    const r = await verify();
    expect(r.outcome).toBe("FAIL");
    expect(r.checks.find((c) => !c.ok)).toMatchObject({ check: "test", detail: "concluded failure" });
  });

  it.each([
    ["a required check is still running", { check_runs: [run("test", null, 1, "in_progress"), run("lint", "success", 2)] }],
    ["a required check has not been reported", { check_runs: [run("lint", "success", 2)] }],
  ])("is inconclusive, never PASS, when %s", async (_name, body) => {
    gh.runs = ok(body);
    const r = await verify();
    expect(r.outcome).toBe("INCONCLUSIVE");
    expect(r.error?.kind).toBe("PENDING");
  });

  it("uses the newest run of a check, so a successful re-run counts and a later failure does not pass", async () => {
    gh.runs = ok({ check_runs: [run("test", "failure", 1), run("test", "success", 3), run("lint", "success", 2)] });
    expect((await verify()).outcome).toBe("PASS");
    gh.runs = ok({ check_runs: [run("test", "success", 1), run("test", "failure", 3), run("lint", "success", 2)] });
    expect((await verify()).outcome).toBe("FAIL");
  });

  it("looks up a required check by name when it is not on the first page of check runs", async () => {
    gh.runs = ok({ total_count: 250, check_runs: [run("lint", "success", 2)] });
    gh.byName = ok({ check_runs: [run("test", "success", 7)] });
    expect((await verify()).outcome).toBe("PASS");
    expect(gh.seen.some((s) => s.url.includes("check_name=test"))).toBe(true);
    expect(gh.seen.some((s) => s.url.includes("check_name=lint"))).toBe(false);
  });

  it("accepts a required check reported as a commit status", async () => {
    gh.runs = ok({ check_runs: [run("test", "success", 1)] });
    gh.statuses = ok({ statuses: [{ context: "lint", state: "success" }] });
    expect((await verify()).outcome).toBe("PASS");
    gh.statuses = ok({ statuses: [{ context: "lint", state: "error" }] });
    expect((await verify()).outcome).toBe("FAIL");
  });

  it("is inconclusive when GitHub rate-limits or fails, and sends the token only when configured", async () => {
    gh.runs = { status: 403, body: { message: "API rate limit exceeded" } };
    const limited = await verify();
    expect(limited.outcome).toBe("INCONCLUSIVE");
    expect(limited.error?.kind).toBe("GITHUB_UNAVAILABLE");
    expect(gh.seen.every((s) => s.auth === undefined)).toBe(true);

    gh.runs = ok({ check_runs: [run("test", "success", 1), run("lint", "success", 2)] });
    gh.seen = [];
    await verify(SHA, PLAN, "ghp_readonly");
    expect(gh.seen.every((s) => s.auth === "Bearer ghp_readonly")).toBe(true);
  });

  it("never calls a GitHub API base that the network policy blocks", async () => {
    const r = await runGithubPlan(PLAN, SHA, { githubApiBase: base }); // default policy: loopback refused
    expect(r.outcome).toBe("RUNNER_ERROR");
    expect(gh.seen).toHaveLength(0);
  });
});
