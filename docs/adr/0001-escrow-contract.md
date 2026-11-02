# ADR 0001: NEAR escrow contract trust and payment rules

Status: accepted (Phase 1), 2026-11-02. Contract: `contracts/escrow` (near-sdk 5.30.0). Not yet deployed.

## Decisions

1. **The contract is the money authority; the domain package is the offchain mirror.** State names and error codes (`UNAUTHORIZED`, `HASH_MISMATCH`, `DEADLINE`, ...) match `packages/domain` so the API and UI can treat both the same. Payment rules are enforced onchain even when the offchain service is bypassed.

2. **Two terms hashes.** The contract stores only settlement-relevant terms (roles, amounts, milestone kinds, plan hashes, deadlines). Its onchain hash is `sha256(borsh(AgreementTerms))`. That struct also carries `offchain_terms_hash`, the domain package's canonical-JSON hash of the full document (HTTP plan details, rubric). The worker accepts the onchain hash, so they accept exactly what the contract will enforce, plus the full offchain document.

3. **Creating an agreement is the client's acceptance.** Only the account named as client can create. The worker then calls `accept_terms` with the hash, and only then can the client `fund` with exactly the total attached.

4. **Submissions are numbered by the contract.** `submit` returns a sequence number (1, 2, ...). A verification report must cite that number, the artifact hash and the plan hash. A report written for an earlier submission therefore cannot pay a later one. The last report nonce is also stored, so the same report cannot be applied twice to an inconclusive run.

5. **The verifier is trusted by account, not yet by signature.** `record_verification` accepts reports only from the `verifier` account fixed in the terms. Verifying an ed25519 report signature onchain is deferred to Phase 2, when the verifier service and its key exist. Until then the contract does not claim trustless verification. A dishonest verifier could report PASS, but the client still has the challenge window to dispute it with the resolver.

6. **Fail closed.** `FAIL` returns the milestone to Pending. `INCONCLUSIVE` and `RUNNER_ERROR` leave it Submitted. None of them allocates funds.

7. **Allocation happens once; payouts are per recipient.** A milestone's split (worker/client) is fixed once, when it becomes Claimable. Each share moves `due -> pending -> paid` in its own transfer and callback. A failed transfer moves `pending -> due` and can be retried. While any share is pending, `payout` is rejected, so the same funds cannot be sent twice. The callback is `#[private]` and runs no validation checks that could panic. Its only lookups are of the agreement and milestone that `payout` just used, and the contract never deletes agreements, so a failed transfer always ends with the share back in due rather than stuck in pending.

8. **Protected floor bounds disputes only.** A human-review milestone's `floor` is never paid automatically. The resolver's award must be between the floor (once a deliverable was submitted) and the milestone amount. A mutual settlement may be any split both parties sign.

9. **Silence is not approval.** After `expires_at_ms`, a milestone with no live submission refunds the client in full. Submitted work never expires, so the worker can always open a dispute if the client disappears.

10. **Storage is prepaid by the client.** `create_agreement` charges for the bytes it writes plus 600 bytes per milestone of worst-case growth (tested), and refunds any excess. Later calls by the worker, verifier or resolver therefore never consume escrowed funds for storage. In the MVP this storage deposit is not refunded when the agreement completes.

## Not yet done

- Testnet deployment and a reproducible wasm build (`cargo near build`), which need a funded testnet account.
- Integration tests against a sandbox node (near-workspaces).
- Onchain verifier signature checks (Phase 2).
