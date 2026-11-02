# ADR 0002: HTTP API verifier and signed reports

Status: accepted (Phase 2), 2026-11-02. Code: `services/verifier`, `packages/domain/src/signing.ts`, `contracts/escrow` (`record_verification`).

## Decisions

1. **The verifier only makes HTTP requests; it never runs submitted code.** A submission gives a base URL. The verifier sends exactly one request (method, path and body from the locked plan) and checks the status, an optional latency bound, and JSON assertions (`exists`, `equals`, `type` on `$.a.b[0]` paths, own properties only). Running arbitrary repositories needs a real sandbox and stays out of scope.

2. **Every target is treated as an SSRF attempt.** Only `https` on ports 443/8443 is allowed, with no credentials, query or fragment in the URL. `localhost`, `*.localhost` and `*.internal` are refused. The hostname is resolved once, and **every** answer must be a public address. Private, loopback, link-local (including cloud metadata `169.254.169.254`), CGNAT, documentation, multicast, IPv4-mapped/NAT64/6to4/Teredo IPv6, unique-local and anything outside global unicast `2000::/3` are all blocked. The socket then connects to that vetted address (defeats DNS rebinding) while TLS still validates the certificate against the hostname. Redirects are never followed. Total time and response size are capped by the plan. The only exceptions are explicit test origins/addresses passed in code by the tests; nothing reads them from the environment, and the CLI always uses the default policy.

3. **Outcomes fail closed.** `PASS` means a response arrived and every check held. `FAIL` means a response arrived and a check failed, or the submitted target is not allowed; the worker must resubmit. `INCONCLUSIVE` means no usable response (DNS failure, refused connection, timeout) and can be re-run. `RUNNER_ERROR` means the verifier itself broke. Only PASS can lead to payment, and only after the challenge window.

4. **Evidence is committed, not published.** The evidence record holds the target, the resolved address, status, latency, response size, a SHA-256 of the body (never the body itself), each check with a truncated actual value, and the full binding (agreement, milestone, submission seq, artifact, plan hash). Its canonical hash is the report's `evidenceDigest`. `evidenceMatchesReport` detects any later edit.

5. **Reports are signed with ed25519 over a borsh layout the contract re-derives.** The signed bytes are `borsh(("settle-report-v1", escrow_contract_account, report))`. Both the domain state machine and the contract verify the same signature. A pinned test vector (fixed seed, report, public key and signature) appears in both `packages/domain/test/automated.test.ts` and `contracts/escrow/src/tests.rs`. The Rust test verifies the TypeScript-produced signature, which proves both sides sign identical bytes. Including the contract account stops a signature being reused on another deployment.

6. **Key separation.** The verifier holds only its ed25519 seed (`SETTLE_VERIFIER_SEED`), never a NEAR account key or settlement authority. Any party (the worker, the API) relays the signed report onchain and pays the gas, but cannot alter it.

## Known limits

- One request per plan. Multi-step API scenarios (create, then read back) need a plan format extension.
- A verifier that signs a false PASS is caught only by the client's challenge. Multiple independent verifiers are future work.
- The verifier is a library plus CLI today. The queue and service that run it next to the API come in Phase 3, deployed in a separate process with no settlement keys.
