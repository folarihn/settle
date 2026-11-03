# SETTLE

**Verifiable work agreements and fair payments for humans and AI agents.**

> Status: **live on NEAR testnet.** Web app and API: **https://settle-9ewd.onrender.com**. Escrow contract: [`settle-escrow-14f651.testnet`](https://testnet.nearblocks.io/address/settle-escrow-14f651.testnet). Two verified end-to-end runs are recorded in [docs/TESTNET_RUN.md](docs/TESTNET_RUN.md); the second went through the public deployment and its hosted FAIL/PASS fixture, with an AI-agent worker using the SDK. **Pending:** the always-on Render verification worker, which needs a payment card on the Render account. Until it runs, **Run verification** requests stay queued.

## HOW TO TEST (Hackathon judges: start here)

**A judge who cannot run the product cannot score it.** This section stays at the top of the README. Each status below is only updated once it has been checked.

| Resource | Current status |
| --- | --- |
| Live app | **Live:** https://settle-9ewd.onrender.com (Render web service; free plan, so the first visit after about 15 minutes idle takes about a minute to wake). Health: [`/healthz`](https://settle-9ewd.onrender.com/healthz), readiness (database + contract): [`/readyz`](https://settle-9ewd.onrender.com/readyz). Postgres 16 on Render. **Verification worker not running yet** (needs a payment card on Render); verification requests queue until it starts |
| NEAR testnet contract | **Deployed:** [`settle-escrow-14f651.testnet`](https://testnet.nearblocks.io/address/settle-escrow-14f651.testnet), deploy tx [`2aQ9BHof…J6UH`](https://testnet.nearblocks.io/txns/2aQ9BHofYPXFT1zdZWuTZe5zmVuKNzLCZXkzdHwPJ6UH). Onchain code hash `6VgnyMtY…qLmau` equals the reproducible build of commit `01630ae` ([workflow run](https://github.com/folarihn/settle/actions/runs/41599553504)). Redeploys go through the *Deploy escrow to NEAR testnet* workflow.
| Demo fixture | **Live:** [`/fixture/broken/health`](https://settle-9ewd.onrender.com/fixture/broken/health) (FAIL) and [`/fixture/fixed/health`](https://settle-9ewd.onrender.com/fixture/fixed/health) (PASS); `GET /v1/config` reports the base as `fixtureBaseUrl` |
| Onchain evidence | [docs/TESTNET_RUN.md](docs/TESTNET_RUN.md). Run 2, **through the public deployment**, agreement `job_djswNSwMkwPIfNhF`: hosted fixture FAIL ([`7Zy8iEqy…`](https://testnet.nearblocks.io/txns/7Zy8iEqyJXXcyJqA2G8gee68KrorjF7iGHbxJ4VMJ7Kv)) released nothing; PASS ([`7AGHC9zx…`](https://testnet.nearblocks.io/txns/7AGHC9zxwQeAazP7sihtbxkxSnP9UtzFuNiXnRqZqK9T)), then challenge window, then 0.3 NEAR paid to the agent ([`7Wypge71…`](https://testnet.nearblocks.io/txns/7Wypge712BQWcPZYZY2vCdpmQNdaQZvXJZfL2G6Qvaz7)); revision then approval; 50/50 partial settlement ([`DCLFuiMv…`](https://testnet.nearblocks.io/txns/DCLFuiMvrdGouvLtY8WJWuVBV7kidayZHYha3qViChA2)). Run 1 used a local API. Reproduce with `scripts/testnet-e2e.mjs` |
| Test accounts | Use fresh NEAR **testnet** accounts (client, worker). Never share seed phrases or private keys |
| Faucet | The testnet faucet linked from the [NEAR docs](https://docs.near.org/), or `near account create-account sponsor-by-faucet-service <name>.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create` (near-cli-rs 0.30.1, installed with `scripts/install-near-tools.sh near-cli`) |
| Demo walkthrough | Not recorded yet |
| CI | Every PR runs: TypeScript build/typecheck/tests (domain, verifier, API on PGlite **and** Postgres 16, agent SDK); contract fmt/clippy/unit tests; WASM build + sandbox tests; reproducible WASM build. NEAR tools are installed by [`scripts/install-near-tools.sh`](scripts/install-near-tools.sh) with pinned versions and SHA-256 checks |
| Owner deployment steps | [docs/DEPLOY_TESTNET.md](docs/DEPLOY_TESTNET.md): contract account and two secrets (Part A), verifier key (Part B), Render Blueprint (Part C) |

### Judge path (about 10 minutes, two browser profiles)

1. Open https://settle-9ewd.onrender.com. **Connect wallet** (MyNearWallet, testnet), then **Sign in as …**. Signing in signs a message only; it does not send a transaction.
2. As the **client**: **New job**. Enter the worker's testnet account and keep the defaults: an API milestone (0.35 NEAR) using the demo verification plan, and a design milestone (0.15 NEAR) with 2 revisions and a 0.075 NEAR protected floor. **Create job and sign create_agreement** (storage deposit; the unused part is refunded).
3. As the **worker** (second profile or wallet): open the job and click **Accept terms** (signs `accept_terms`).
4. As the client: **Fund escrow (0.5 NEAR)**. The onchain status becomes `Funded`.
5. Worker, API milestone: enter commit `demo-broken` and URL `https://settle-9ewd.onrender.com/fixture/broken`, then click **Submit work** (signs `submit`). Click **Run verification**. The result is a real **FAIL** (`$.status == "ok"` fails). Open **Evidence**, then **Record onchain**. Nothing becomes payable.
6. Worker: submit `demo-fixed` with `https://settle-9ewd.onrender.com/fixture/fixed`, run verification again, and get a real **PASS**. Click **Record onchain**. After the challenge window (2 minutes by default), click **Finalize after challenge window**, then **Pay out (onchain transfer)**. Check the transfer on testnet.nearblocks.io from the transaction list.
7. Design milestone: the worker submits, and the client clicks **Request revision**. The worker resubmits. Then either the client clicks **Approve and release**, or one party uses **Propose partial settlement** (e.g. 0.075 NEAR) and the other clicks **Accept … settlement**. Pay out and check both transfers.
8. Agent parity: run `packages/agent-sdk/dist/demo-worker.js` as the worker (instructions are in that file). It uses the same API, does the same FAIL then PASS sequence, and relays the reports with the agent's own key.

### Also verifiable without a wallet

Open the latest **CI** run on the PR. The `escrow-sandbox` job log shows the deployed WASM's payout raising the worker's real balance by exactly the milestone amount, and a second payout being rejected. The `typescript` job runs the API → verifier → fixture flow and shows a real FAIL, then a real PASS.

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
