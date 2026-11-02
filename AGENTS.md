# SETTLE engineering contract for Codex and all coding agents

Read README.md, docs/ARCHITECTURE.md, docs/BUILD_PLAN.md, and docs/MANUAL_TESTING.md before changing code.

## Mission

Ship a **real** narrow end-to-end NEAR testnet workflow before Nov 14, 2026. Both humans and agents must use one agreement/settlement engine. Work is GitHub-first: push code to feature branches and PRs; do not require the owner to run the project on their personal computer.

## Non-negotiable execution rules

1. **Start coding immediately after reading the repository.** Do not endlessly plan, brainstorm or ask decisions the documents resolve. Make the smallest safe assumption and record it in a short ADR only when it changes trust or payment rules.
2. Complete **one vertical slice at a time**: implementation, focused tests, CI check, manual instructions, PR. Never create empty placeholders, fake integration responses, or README claims of unverified functionality.
3. Keep clean small modules, strongly typed interfaces, explicit state transitions, validated inputs and meaningful errors. No giant files, speculative abstractions, dependency sprawl, generated boilerplate, or unused features.
4. Run the tests **you implement** (or have GitHub Actions run them) and examine actual results; never say PASS without output. Do not mask failing checks or skip tests for speed.
5. Test meaningful behavior only: legal/illegal state transitions, escrow accounting, authorization, replay, wrong job/milestone/commit, invalid signatures, timeout, verifier failures, idempotency, human approval and disputed partial compensation. Avoid redundant snapshot tests, fake coverage numbers, and tests that only assert a mock was called.
6. Do not claim sandbox security merely because code runs in Docker/GitHub Actions. Reject arbitrary repositories or code execution until the isolated verifier has bounded CPU/memory/time, no secrets, disabled outbound networking where possible, no privileged execution, immutable test plan, pinned commit, and no access to settlement-signing keys. If a strong sandbox is unavailable, start with a restricted **HTTP API contract verifier** that never executes untrusted code.
7. **Fail closed:** network/verification errors, missing data, and ambiguous outcomes never become PASS or automatically trigger payment.
8. Money safety: use integer yoctoNEAR, explicit authorization, exact escrow accounting, no double settlement/refund, idempotent outcomes, and confirmed onchain transfer outcomes. Keep a bounded recovery mechanism for failed asynchronous transfers.
9. The verifier cannot unilaterally change agreed tests. Each agreement binds test plan hash, payout amounts, roles, deadlines, challenge period, reviewer/dispute authority, and partial-compensation rule before funding.
10. No AI-only decision about payout or design quality. AI may help draft requirements or explain evidence, but human approval and predetermined settlement logic control subjective outcomes.
11. No real mainnet funds in MVP. No secrets, private keys or shared seed phrases in repository, logs, demo screenshots, or README.
12. For each PR report: changed files, actual checks run and results, unresolved risks, deployed URLs if any, and **step-by-step manual owner test**.
13. Use official current NEAR documentation and inspect deployed SDK signatures before writing chain integration. Prefer minimal supported patterns, not remembered APIs.
14. Only update README test statuses when demonstrably true. A judge must be able to follow the documented test path.
15. Never merge a PR with failing critical checks. Avoid force-push to main and destructive actions.

## Build order

1. Shared agreement schema + pure state machine + focused tests.
2. Minimal NEAR contract: create/fund/approve/resolve/claim or settle/refund with authorization, bounded windows and accounting.
3. HTTP contract verifier (safe first), signed evidence with explicit verifier identity and replay prevention; integrate with a trusted adjudication service that submits proofs after challenge policy.
4. Single API layer and Postgres storage for offchain UI, submissions, and evidence.
5. Minimal web UI for human parties plus authenticated API for agents; both map to same services/contract.
6. Real testnet deployment, actual integration tests, documented manual walk-through, demo video.

If the chain contract requires asynchronous transfers, model **pending** payouts and finalize after callback; on failure keep recoverable claimable balances. Avoid doing transfers directly from untrusted submitted URLs or unverified client text.

## Stop and escalate only on real external blockers

Ask the owner only when wallet funding, hosting authorization, GitHub/NEAR secrets, service billing, or deployment approval is genuinely needed. Provide exact 1–3 browser steps. Meanwhile finish independent coding tasks. Do not spend hours polishing the UI while the payment path is missing.
