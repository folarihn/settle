# SETTLE

**Verifiable work agreements and fair payments for humans and AI agents.**

> Status: Phase 0 (agreement engine) and Phase 1 (escrow contract, unit-tested, not deployed) implemented; no verifier, API or UI yet. No live deployment, faucet address, funded job, or passing integration is claimed until independently verified.

## HOW TO TEST (Hackathon judges: start here)

**A judge who cannot run the product cannot score it.** This section stays at the top of the README throughout development. Codex must replace placeholders with verified URLs and exact reproducible steps before submission.

| Resource | Current status |
| --- | --- |
| Live app | Not deployed yet |
| NEAR network | Testnet planned; deployment not yet performed |
| Test account | Create a fresh NEAR testnet wallet; do not share seed phrases |
| Faucet | See [NEAR testnet account and faucet documentation](https://docs.near.org/) and validate current instructions before publishing |
| Demo walkthrough | Not recorded yet |
| CI | GitHub Actions on every PR: domain typecheck/tests/build; contract fmt, clippy (wasm32) and unit tests (`.github/workflows/ci.yml`) |

### Intended hands-on test (implement and verify before claiming it works)

1. Open the verified live SETTLE URL (to be added).
2. Connect a fresh NEAR testnet wallet. Fund it through the current documented faucet.
3. Create a sample job with two milestones: **API contract test (70%)** and **human design review (30%)**.
4. Examine the immutable milestone rules and amounts, then fund escrow with testnet funds.
5. Use a second testnet account as the worker, or the documented agent demo identity.
6. Submit an exact Git commit for the technical milestone. Launch a real isolated verification run.
7. View PASS/FAIL evidence and confirm a failing test does **not** release the technical milestone payment.
8. Resubmit a passing commit; after the agreed challenge window, claim/settle the earned milestone and check the onchain transfer.
9. Submit a visual-design deliverable. Approve it, request a revision, or enter the pre-agreed dispute/partial-compensation workflow.
10. Inspect the activity log, transaction links, remaining escrow balance, and final resolution.
11. Repeat using the agent API for job creation or submission; verify both human and agent workflows share the same core.

### Before final submission

Replace the placeholder URLs/statuses above with: exact hosted app URL, usable funded **testnet-only** demo accounts or faucet instructions, contract account ID, explorer links, demo video, API examples with redacted credentials, and a three-minute judge path. Never publish real private keys or a shared wallet recovery phrase. Keep private credentials in GitHub Actions/hosting secrets.

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

pnpm workspace (Node 22, pnpm 11). `pnpm install && pnpm typecheck && pnpm test` runs everything CI runs.

| Package | What it is |
| --- | --- |
| `packages/domain` | Agreement terms schema (Zod), terms/plan hashing, the deterministic milestone state machine and escrow reconciliation. Pure: no I/O, clock passed in. The API, agent SDK and contract mirror these rules. |
| `contracts/escrow` | NEAR Rust contract (near-sdk 5.30): create/accept/fund with an exact deposit, milestone transitions, per-recipient async payouts with failure recovery. Testnet only, not yet deployed. Trust decisions: [docs/adr/0001-escrow-contract.md](docs/adr/0001-escrow-contract.md). `cd contracts/escrow && cargo test` (on Windows, set `AWS_LC_SYS_PREBUILT_NASM=1`). |

Key rules enforced in `packages/domain`: amounts are integer yoctoNEAR strings that must sum exactly to the total; client, worker, verifier and resolver are distinct; both parties accept a specific terms hash before the client funds the exact total; terms cannot change after funding; verification reports must match agreement, milestone, submission, commit and plan hash, and each nonce is single-use; `FAIL`, `INCONCLUSIVE` and `RUNNER_ERROR` never allocate funds; human-review milestones pay only on client approval, a mutually accepted settlement, or a resolver ruling bounded by the agreed protected floor; a payout can be pending only once and a failed transfer restores the claim.

## License

TBD before public release. The repository is currently private.
