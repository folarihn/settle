# SETTLE delivery plan (Nov 2 to Nov 14, 2026)

## Definition of DONE

A judge can use a hosted application and two NEAR testnet accounts to create a job, approve requirements, escrow native NEAR, submit a technical task, observe a genuine test failure and genuine PASS, receive a verifiable onchain payment, and complete a human-reviewed design milestone including revision/partial settlement. An agent can perform equivalent authorized workflow through API. No mocked settlement in the final demo. Link every confirmed onchain transaction and a short walkthrough from README top.

## Execution priorities

### Phase 0: foundation, immediate

- Verify repo, current NEAR SDK/tooling, no unauthorized secrets, default branch, CI settings.
- Create typed monorepo (pnpm workspace) with `apps/web`, `apps/api`, `packages/domain`, `packages/agent-sdk`, `services/verifier`, `contracts/escrow`.
- Add `AGENTS.md`, engineering docs, README judge path, `.gitignore`, minimal CI.
- Implement shared Zod schemas and pure validation: exact nonnegative milestone accounting, deadline, challenge period, approval rules, actor identities, plan hash, immutable after funding.
- Focused tests in same PR. Avoid mock services that appear functional.

### Phase 1: NEAR escrow + contract invariants

- Rust `near-sdk` contract for fixed two milestone modes, native NEAR testnet escrow and explicit role-auth.
- Create agreements, fund, record submitted/verified milestone, resolve client approval/partial settlement, allow dispute resolver decision, apply challenge period, claim/refund.
- Implement transfer callbacks/recovery accounting; duplicate/replay, unauthorized and timeout tests.
- Deploy to NEAR testnet only after contract tests and owner provisioning. Record explorer/account link.

### Phase 2: verifier and binding

- First verifier: agreed HTTP API contract checks, safely network-isolated. Pin test plan hash and exact submission commit/deployment; prevent SSRF. No arbitrary repository execution in first MVP.
- Signed evidence report, one-use submission nonce, reproducible failure outputs with redacted payloads.
- Authorized contract caller/relay checks evidence and submits onchain proof; failures fail closed.
- Verify real deliberate FAIL and PASS paths.

### Phase 3: API, human UI, agent API/SDK

- Thin authenticated API routes for drafts, funding metadata, submissions, verification evidence, human approvals/revisions, disputes and chain state. Idempotency keys and access checks.
- Next.js web app: create job, review terms, fund, submit, verify results, approve/revise, dispute, settle; show chain transaction links.
- Small TypeScript agent SDK using the **same** API; demonstrable agent identity and request signatures. No second workflow implementation.
- Offchain Postgres for indexed non-financial records; contract is authority for payment.

### Phase 4: full demo and hardening

- Actual end-to-end testnet escrow and payout. Failure, success, creative revision/partial settlement and agent flows.
- Host app/API/verifier securely (verifier cannot share privileged process with internet-facing API).
- Add GitHub Actions workflow for typechecks, lint, domain tests, Rust contract tests and targeted integration checks.
- Record a three-minute walkthrough. Put exact test accounts/faucet path, hosted links, explorer links, known limits and copyable commands **above all other README sections**.

## Suggested dates, not permission to delay implementation

- Nov 2–3: foundation + contract core
- Nov 4–6: contract correctness + verification engine
- Nov 7–9: API, UI, agent workflow, deployment
- Nov 10–12: real testnet end-to-end, failures, security fixes
- Nov 13–14: judge usability, README verification, demo, submission

If behind schedule, cut UI polish and optional APIs before cutting payout correctness, real testnet evidence, or judge accessibility. Keep partial-compensation rule narrow and explicit. Do not rush unsafe real-money deployment.

## Minimal endpoint proposal (may adjust after implementation)

`POST /v1/jobs` draft, `POST /v1/jobs/:id/accept`, `POST /v1/jobs/:id/submissions`, `POST /v1/submissions/:id/verify`, `GET /v1/submissions/:id/evidence`, `POST /v1/milestones/:id/review`, `POST /v1/disputes`, `GET /v1/jobs/:id`. Onchain funding/payout authorization must use wallet-signed NEAR transactions, not server-only user claims.

## Acceptance gates

1. **Core:** invalid job specs fail with descriptive errors; totals reconcile; correct immutable hashes.
2. **Chain:** unauthorized payouts/replays cannot change balances; callback failure does not lose escrow accounting.
3. **Verify:** passing/failing controlled APIs are distinguished; SSRF blocked; tampered evidence refused.
4. **Human:** approve/revision/dispute flows respect locked compensation and time constraints.
5. **Demo:** fresh account, testnet funds, actual payment, explorer evidence, and agent API usage are reproducible from the README.

## AI-agent reporting protocol

Every implementation PR must state: what shipped, exact automated commands/CI links, expected manual steps, what remains blocked (and why), and next smallest runnable slice. No lengthy theoretical research unless a safety-critical integration depends on it.
