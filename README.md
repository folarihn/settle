# SETTLE

**Verifiable work agreements and fair payments for humans and AI agents.**

> Status: **live on NEAR testnet, fully hosted.** Web app and API: **https://settle-9ewd.onrender.com**. Verifier: its own service, **https://settle-verifier.onrender.com** (the only holder of the verifier key). Escrow contract: [`settle-escrow-14f651.testnet`](https://testnet.nearblocks.io/address/settle-escrow-14f651.testnet). Verified end-to-end runs are recorded in [docs/TESTNET_RUN.md](docs/TESTNET_RUN.md). Run 3 used only the hosted services and the hosted FAIL/PASS fixture, with an AI-agent worker using the SDK. Everything runs on free plans: after about 15 minutes idle, the first page load or verification takes about a minute while a service wakes.

## HOW TO TEST (Hackathon judges: start here)

**A judge who cannot run the product cannot score it.** This section stays at the top of the README. Each status below is only updated once it has been checked.

| Resource | Current status |
| --- | --- |
| Live app | **Live:** https://settle-9ewd.onrender.com. Health: [`/healthz`](https://settle-9ewd.onrender.com/healthz); readiness (database + contract): [`/readyz`](https://settle-9ewd.onrender.com/readyz). Verifier service: https://settle-verifier.onrender.com (only `/healthz` and a wake-up route are public). Postgres 16 on Render. All on free plans: a sleeping service takes about a minute to wake |
| NEAR testnet contract | **Deployed:** [`settle-escrow-14f651.testnet`](https://testnet.nearblocks.io/address/settle-escrow-14f651.testnet), deploy tx [`2aQ9BHof…J6UH`](https://testnet.nearblocks.io/txns/2aQ9BHofYPXFT1zdZWuTZe5zmVuKNzLCZXkzdHwPJ6UH). Onchain code hash `6VgnyMtY…qLmau` equals the reproducible build of commit `01630ae` ([workflow run](https://github.com/folarihn/settle/actions/runs/41599553504)). Redeploys go through the *Deploy escrow to NEAR testnet* workflow.
| Demo fixture | **Live:** [`/fixture/broken/health`](https://settle-9ewd.onrender.com/fixture/broken/health) (FAIL) and [`/fixture/fixed/health`](https://settle-9ewd.onrender.com/fixture/fixed/health) (PASS); `GET /v1/config` reports the base as `fixtureBaseUrl` |
| Onchain evidence | [docs/TESTNET_RUN.md](docs/TESTNET_RUN.md). **Run 3, fully hosted**, agreement `job_XuOByu9_flTyvHjn`, 18 checks over 18 transactions: hosted fixture FAIL ([`3iZ1wY2q…`](https://testnet.nearblocks.io/txns/3iZ1wY2qFpVjp5WExr2AGBsmeQZV3CGa8PG2266JELX1)) released nothing; PASS ([`3y7GvVBj…`](https://testnet.nearblocks.io/txns/3y7GvVBjg2DoAP3LdAhkmd4Rxr2Zn2Js5LqZQtkuoiSp)), then challenge window, then exactly 0.3 NEAR to the agent ([`DSybJMn5…`](https://testnet.nearblocks.io/txns/DSybJMn5UXoucFtgRVMimAcWsLTWP7Vx99dkr8JEBpfj)); revision then approval; 50/50 partial settlement ([`meUW2ZvS…`](https://testnet.nearblocks.io/txns/meUW2ZvS5MmQpqVDFtkHm4FSxkjnpkwLeKdzs6d7WWJ)). Reproduce with `scripts/testnet-e2e.mjs` |
| Test accounts | Use fresh NEAR **testnet** accounts (client, worker). Never share seed phrases or private keys |
| Faucet | The testnet faucet linked from the [NEAR docs](https://docs.near.org/), or `near account create-account sponsor-by-faucet-service <name>.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create` (near-cli-rs 0.30.1, installed with `scripts/install-near-tools.sh near-cli`) |
| Demo walkthrough | Not recorded yet |
| CI | Every PR runs: TypeScript build/typecheck/tests (domain, verifier, API on PGlite **and** Postgres 16, agent SDK); contract fmt/clippy/unit tests; WASM build + sandbox tests; reproducible WASM build. NEAR tools are installed by [`scripts/install-near-tools.sh`](scripts/install-near-tools.sh) with pinned versions and SHA-256 checks |
| Owner deployment steps | [docs/DEPLOY_TESTNET.md](docs/DEPLOY_TESTNET.md): contract account and two secrets (Part A), verifier key (Part B), Render Blueprint (Part C) |

### Before you start (5 minutes, once)

1. Use two browser profiles (or two browsers): one for the **client**, one for the **worker**.
2. In each, create a NEAR **testnet** account at https://testnet.mynearwallet.com, and get testnet NEAR from the faucet at https://near-faucet.io. The client needs about 1 NEAR (0.5 NEAR escrow, a 0.2 NEAR storage deposit that is mostly refunded, and gas). The worker needs a little for gas.
3. Allow pop-ups for `settle-9ewd.onrender.com`. MyNearWallet opens a pop-up for every signature.
4. Free hosting: if nobody has used the site for about 15 minutes, the first page load and the first verification each take about a minute while the service wakes up.

### Judge path (about 15 minutes)

1. Open https://settle-9ewd.onrender.com, click **Connect a testnet wallet** → **MyNearWallet** and approve in the pop-up, then click **Sign in as …**. Signing in signs a message only; it does not send a transaction.
2. **Client:** click **Create agreement**, enter the worker's testnet account and keep the defaults: an automated API milestone (0.35 NEAR) with the demo verification plan, and a human-review design milestone (0.15 NEAR, 2 revisions, 0.075 NEAR protected floor). Click **Create agreement (signs create_agreement)** and approve.
3. **Worker:** open the agreement from **Your agreements** and click **Accept terms** (signs `accept_terms`).
4. **Client:** click **Fund escrow (0.5 NEAR)**. The onchain status becomes `Funded`; the transaction appears under *Your transactions* with a nearblocks link.
5. **Worker, API milestone:** commit `demo-broken`, URL `https://settle-9ewd.onrender.com/fixture/broken` → **Submit work** → **Run verification**. You get a real **FAIL**. Click **Evidence** to see `$.status == "ok"` failing with `got "degraded"`, then **Record onchain**. No payout button appears; nothing is payable.
6. **Worker:** commit `demo-fixed`, URL `https://settle-9ewd.onrender.com/fixture/fixed` → **Submit work** → **Run verification** → **PASS** → **Record onchain**. The status shows the challenge window and its end time. **Finalize after challenge window** stays disabled until then. After about 2 minutes, reload the page, click it, then **Pay out (onchain transfer)** and check the transfer on nearblocks.
7. **Design milestone:** the worker submits (any content hash, optional link), and the client clicks **Request revision**. The worker resubmits. Then either the client clicks **Approve and release**, or one party enters `0.075` → **Propose partial settlement** and the other clicks **Accept 0.075 NEAR settlement**. Then **Pay out** sends the worker's share and the client's refund as two transfers. The pay-out button disappears afterwards, and the contract rejects a second payout.
8. **Agent parity:** the same flow driven only by an AI agent's key through the SDK is recorded in [docs/TESTNET_RUN.md](docs/TESTNET_RUN.md) (run 3), with every transaction linked.

### Verifiable without a wallet

- [`/readyz`](https://settle-9ewd.onrender.com/readyz) shows the database and the escrow contract answering. The fixture's [failing](https://settle-9ewd.onrender.com/fixture/broken/health) and [passing](https://settle-9ewd.onrender.com/fixture/fixed/health) responses are public.
- The run-3 transactions in [docs/TESTNET_RUN.md](docs/TESTNET_RUN.md) open on testnet.nearblocks.io: a FAIL that released nothing, a PASS, a payout of exactly 0.3 NEAR, revision then approval, and a 50/50 split paying both parties.

### Known limitations

- **Testnet only;** no mainnet funds.
- **Wallets:** only MyNearWallet is wired up in the web app. Wallet sign-in has not been exercised by automated browser tests (the wallet pop-up needs a real person); the same NEP-413 login and every contract call are proven by the agent-SDK runs.
- **Free tier:** Render services sleep after about 15 minutes idle (about 1 minute to wake). The Render Postgres database is on the free plan and **expires on 2026-12-03**.
- **Ordering:** the API records an action before the wallet signs it. If a wallet pop-up is cancelled, the page shows a divergence notice with a retry button; money always follows the onchain state.
- **Verifier:** checks HTTP APIs only (one request per plan); it never runs submitted code.
- **Contract upgradability:** the contract account is not locked, so whoever holds its key could deploy different code.

## What SETTLE does

Clients (human or agent) and workers (human or agent) agree on milestone-based acceptance conditions **before funding**. Objective software milestones are tested in a restricted verifier. Subjective milestones use explicit customer approval, bounded revisions, and a pre-agreed compensation/dispute process. A NEAR contract holds funds and enforces authorized outcomes.

**Core principle:** passing specified tests is evidence of meeting agreed checks, not a guarantee that the entire product is flawless. A signed report establishes attribution/integrity of a verifier result, not universal correctness.

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/BUILD_PLAN.md](docs/BUILD_PLAN.md), [docs/MANUAL_TESTING.md](docs/MANUAL_TESTING.md), and [AGENTS.md](AGENTS.md).

### MVP boundaries

Build one end-to-end demonstrable software-development agreement. Support both human and agent clients/workers through the same service layer. Two milestone types only: `AUTOMATED` and `HUMAN_REVIEW`. One NEAR testnet asset (native NEAR in MVP, denomination in yoctoNEAR); no mainnet money. One approved offchain verifier and explicit dispute authority. No marketplace, arbitrary AI judging, token, NFT, arbitrary user-supplied container privileges, or complex reputation system.

### Proposed stack

- Web: Next.js + TypeScript
- API: Node.js + TypeScript, schema validation with Zod
- Database: Postgres + Prisma (offchain application state only)
- Chain: NEAR Rust contract (`near-sdk`), NEAR testnet
- Verification: separate isolated worker and pre-approved tests, not inside the public API process
- CI: GitHub Actions for formatting, linting, type checks, focused unit/contract tests

See the implementation plan for the minimal vertical slice, contract invariants, and phased delivery. Deployment is not complete until real URLs and transaction receipts appear here.

## Development

All production code lives in this GitHub repository. Use feature branches and reviewed PRs. Remote GitHub Actions and hosted development environments are preferred; the owner need not install local tools. Do not commit API keys, wallet mnemonics, or secrets.

pnpm workspace (Node 22, pnpm 11). `pnpm install && pnpm build && pnpm typecheck && pnpm test` runs the TypeScript checks CI runs.

| Package | What it is |
| --- | --- |
| `packages/domain` | Agreement terms schema (Zod), terms/plan hashing, the deterministic milestone state machine and escrow reconciliation. Pure: no I/O, clock passed in. The API, agent SDK and contract mirror these rules. |
| `contracts/escrow` | NEAR Rust contract (near-sdk 5.30): create/accept/fund with an exact deposit, milestone transitions, per-recipient async payouts with failure recovery. Testnet only, not yet deployed. Trust decisions: [docs/adr/0001-escrow-contract.md](docs/adr/0001-escrow-contract.md). WASM build and real-node sandbox tests: [contracts/escrow/SANDBOX.md](contracts/escrow/SANDBOX.md). |
| `apps/api` | Fastify API and Postgres persistence (PGlite for tests and demos). NEP-413 login for humans and agents; job actions through the domain state machine, returning the contract call to sign; chain sync for funding and payouts; verification queue plus a separate worker process. Design: [docs/adr/0003-api-web-agent.md](docs/adr/0003-api-web-agent.md). |
| `apps/web` | Vite + React web app with NEAR Wallet Selector (MyNearWallet): create, accept, fund, submit, verify, evidence, review, revise, dispute, settle, resolve, pay out. Served by the API. |
| `apps/fixture-api` | Controlled demo API: `/broken/health` fails the demo plan, `/fixed/health` passes it. |
| `packages/agent-sdk` | TypeScript SDK for AI agents: NEP-413 login and contract calls with the agent's own key (near-api-js 7), the same API routes as the web app. `src/demo-worker.ts` runs the FAIL → PASS flow. |
| `services/verifier` | HTTP API acceptance verifier: SSRF-guarded single request per locked plan, PASS/FAIL/INCONCLUSIVE/RUNNER_ERROR, evidence record committed by hash, ed25519-signed report that the contract and domain both verify. CLI: `settle-verify keygen`, `SETTLE_VERIFIER_SEED=... settle-verify run request.json`. Design: [docs/adr/0002-http-verifier.md](docs/adr/0002-http-verifier.md). |

Key rules enforced in `packages/domain`: amounts are integer yoctoNEAR strings that must sum exactly to the total; client, worker, verifier and resolver are distinct; both parties accept a specific terms hash before the client funds the exact total; terms cannot change after funding; verification reports must carry the agreed verifier's ed25519 signature and match agreement, milestone, contract-assigned submission number, commit and plan hash, and a report cannot be applied twice; `FAIL`, `INCONCLUSIVE` and `RUNNER_ERROR` never allocate funds; human-review milestones pay only on client approval, a mutually accepted settlement, or a resolver ruling bounded by the agreed protected floor; a payout can be pending only once and a failed transfer restores the claim.

## License

TBD before public release. The repository is currently private.
