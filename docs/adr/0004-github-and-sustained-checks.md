# ADR 0004: GitHub CI checks and sustained-health checks

Status: accepted, 2026-11-04. Code: `packages/domain/src/terms.ts`, `services/verifier/src/github.ts`, `services/verifier/src/runner.ts`, `apps/api/src/keeper.ts`.

## Context

Automated milestones could only call a deployed HTTP API once. Two common kinds of objective work did not fit: "fix this, and CI must pass" bounties, and "the service must stay healthy, not just answer once". The contract stores only each plan's hash, so new plan kinds need no contract change. Old agreements keep their exact plan hashes, because the new `repeat` field is optional and absent from them.

## Decisions

1. **`GITHUB_CHECKS` plan: `{repo, branch, requiredChecks}`.** The submission's artifact hash is the full commit SHA. The verifier reads only GitHub's public REST API (compare, check-runs, commit status). It uses the same pinned, redirect-free, size-limited HTTP client as API checks, and never runs the worker's code.
2. **The commit must already be on the agreed branch.** A workflow triggered by a pull request runs from the PR's own files, so an unmerged PR could edit the workflow that judges it. Requiring the commit to be on `branch` (`compare` reports `identical` or `behind`) leaves the decision to the client's own merge rules and branch protection. This is a trust assumption: SETTLE trusts the client's branch, and the named checks are only as strong as the repository's protection settings.
3. **Outcome rules (fail closed).**
   - **FAIL:** the commit is not on the branch, the commit is not in the repo, the SHA is malformed, or a required check (newest run) concluded anything other than `success`.
   - **INCONCLUSIVE:** a required check is queued or running, or has not been reported yet; or GitHub answered 403/429/5xx or could not be reached. Only definitive results move money, and INCONCLUSIVE can be re-run.
   - **PASS:** none of the above.
4. **Sustained health: an optional `repeat {count, intervalMs}` on HTTP plans.** Every probe must pass. The whole run is bounded to 120 s, so one verification never holds the single worker for long. A probe that fails its checks is FAIL; a probe with no answer is INCONCLUSIVE. Uptime over hours or days would need scheduled probes and is not implemented.
5. **The keeper relays only PASS and FAIL reports.** INCONCLUSIVE and RUNNER_ERROR change nothing onchain, and relaying them would burn gas on every tick (a pending CI run makes that common).
6. **GitHub token is optional.** `SETTLE_GITHUB_TOKEN` on the worker raises GitHub's rate limit. Public repositories work without it, at 60 requests per hour per IP. Without a token, a rate limit gives INCONCLUSIVE, never a FAIL.
