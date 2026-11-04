# ADR 0003: API, persistence, web app and agent SDK

Status: accepted (Phase 3), 2026-11-02. Code: `apps/api`, `apps/web`, `apps/fixture-api`, `packages/agent-sdk`, `packages/domain/src/contract.ts`.

## Decisions

1. **One service layer.** `apps/api` `JobService.apply` is the only way the offchain record changes, and it always goes through `applyEvent` from `packages/domain`. The web app and the agent SDK call the same HTTP routes. There is no agent-specific logic.

2. **The contract decides money; the API mirrors it.** The API holds no NEAR keys and never signs a transaction. Each accepted action returns the exact `contractCall` (method, args, deposit, gas) that the acting party signs with their own key: the browser wallet for humans, the agent's key in the SDK. Funding and payouts cannot be posted to the API at all (`CHAIN_ONLY`). They reach the offchain record only through `POST /sync`, which reads `get_agreement` over NEAR RPC. Sync only acts when the onchain terms hash equals `computeOnchainTermsHash` of the agreed terms. That function is a TypeScript port of the contract's borsh hash, pinned by a test vector in both languages. Every job view shows both the offchain and onchain status and lists any divergence.

3. **The API records the action first, then the party signs it onchain.** The domain rules match the contract, so a rejected action fails before the user spends gas. If the user then declines the wallet transaction, the offchain record runs ahead of the chain. The UI flags that divergence and offers to retry the same call, and money still follows only the chain. Confirming each offchain event against its transaction hash is a known follow-up.

4. **Login is the same for humans and agents: NEP-413.** The client signs a server challenge (32-byte nonce, 5-minute expiry, single use) with a full-access key of its NEAR account. The server checks the ed25519 signature and asks the chain (`view_access_key`) that the key belongs to the account. It then issues a 12-hour bearer session, stored hashed. Some wallets include their callback URL in the signed payload, so the server also accepts that variant.

5. **Postgres, with PGlite for tests and demos.** Tables: sessions, challenges, jobs (domain state as JSONB plus a version for optimistic concurrency), an append-only `job_events` log, verifications, and idempotency records. The same SQL runs on Postgres (`pg`) and on in-process PGlite. CI runs the API and SDK tests on both. `Idempotency-Key` on POST routes replays the stored response instead of applying an action twice.

6. **Verification runs in a separate worker.** The API only enqueues runs (one in flight per submission, enforced by a partial unique index). `worker-main.ts`, a separate process and the only holder of `SETTLE_VERIFIER_SEED`, claims runs with `FOR UPDATE SKIP LOCKED` and runs the Phase 2 verifier. It stores the signed report and evidence, and applies `RECORD_VERIFICATION` through the same job service. Any party relays the signed report onchain. Single-process PGlite demo mode runs the worker in the API process and logs a warning; it is not for production.

7. **Controlled demo API.** `apps/fixture-api` serves `/broken/health` (a real FAIL against the demo plan) and `/fixed/health` (a real PASS) with static responses, so the demo is reproducible. The API can mount it at `/fixture`. It is reached over the public network like any other target, so the SSRF policy is unchanged.

8. **Vite + React instead of Next.js.** The web app is a static SPA served by the API process, so there is one deployable service and no server rendering to secure. Wallet: NEAR Wallet Selector 10 with MyNearWallet (popup signing). Meteor was dropped because its SDK requires near-api-js 6, while the agent SDK uses near-api-js 7.

## Known limits

- No rate limiting yet. Put the API behind the host's rate limiter.
- Offchain actions are not yet tied to their confirmed transaction hash (see 3).
- Only MyNearWallet is wired up in the web app.
