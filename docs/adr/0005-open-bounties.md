# ADR 0005: Open bounties

Status: accepted, 2026-11-04. Code: `contracts/escrow/src/lib.rs` (`post_bounty`, `claim_bounty`, `cancel_bounty`), `packages/domain` (`OPEN`/`CANCELLED`, `CLAIM_BOUNTY`, `CANCEL_BOUNTY`), `apps/api/src/jobs.ts`.

## Context

Every agreement named its worker before funding, so a client had to find a worker first. An open bounty is work that is **already funded**, and that any human or agent may take. Funding before a worker exists, and a fair "first claimer wins", both need the contract: only the chain can order competing claims.

## Decisions

1. **The placeholder worker `open-bounty`.** A bounty's terms name this account as the worker. It is a top-level name under 32 characters, which only the registrar can create, so nobody can hold it. `create_agreement` refuses it, and `post_bounty` requires it. The domain rejects it in normal agreements.
2. **`post_bounty` (client, payable).** It validates the terms like `create_agreement`. The deposit must cover the total plus storage; any excess is refunded. The total joins `total_held` at once, and the status is `Open`.
3. **`claim_bounty(agreement_id, terms_hash)` (anyone but the client, verifier and resolver).**
   - The caller must cite the posted onchain terms hash, and must claim before `funding_deadline_ms`, which serves as the claim deadline.
   - The contract replaces the worker with the caller, recomputes the terms hash, and marks the agreement `Funded`, with the worker's acceptance recorded.
   - The first transaction to execute wins. Later claims fail with `INVALID_TRANSITION`.
4. **`cancel_bounty` (client, while `Open`).** The status becomes `Cancelled` and the full total is transferred back. If the refund transfer fails, the callback reopens the bounty and holds the funds again, so nothing is lost.
5. **No state migration.** `Open` and `Cancelled` are appended to `AgreementStatus`, so agreements stored earlier still decode. Bounties live in the same `agreements` map, and the contract's root state is unchanged.
6. **The agreed offchain hash is that of the posted document.** For `openBounty` terms, `offchain_terms_hash` is computed with the placeholder worker before and after the claim, so the claimer's identity never changes what both sides agreed to. The onchain hash after a claim covers the real worker.
7. **The chain decides who claimed.** `CLAIM_BOUNTY` and `CANCEL_BOUNTY` are chain-only, like funding and payouts. Sync mirrors a claim only if recomputing the hash with the onchain claimer gives exactly the onchain terms hash. The claimer's human/agent label comes from their latest sign-in; it is display only and is in neither hash.
8. **Visibility.** Open bounties are readable by every signed-in account (`GET /v1/bounties`, `GET /v1/jobs/:id`), so they can be inspected before claiming. Once claimed or cancelled, an agreement was private to its parties again; ADR 0007 replaces this: a posted bounty stays publicly readable. The keeper syncs open bounties every tick, so claims reach parties and webhooks without a manual refresh.
