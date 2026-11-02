# Building the escrow WASM and running it on a real NEAR node

`src/tests.rs` runs against near-sdk's **mocked** blockchain. That is fast and covers the rules, but it cannot show that the compiled contract works on NEAR: promises, callbacks, gas, storage staking and real balances only behave for real on a node. `tests/sandbox.rs` covers that by deploying the compiled WASM to a local NEAR sandbox node (near-workspaces 0.24) and driving it with signed transactions.

## Toolchain

- Rust stable with the `wasm32-unknown-unknown` target. Verified with rustc 1.97.1 (Windows, unit tests) and 1.99.1 (Linux/WSL, WASM build and sandbox).
- cargo-near 0.22.0: `curl --proto '=https' --tlsv1.2 -LsSf https://github.com/near/cargo-near/releases/download/cargo-near-v0.22.0/cargo-near-installer.sh | sh`
- The sandbox node binary is downloaded by near-workspaces on first run. It exists for Linux and macOS only. On Windows, use WSL.

## Commands

```bash
cd contracts/escrow
cargo near build non-reproducible-wasm        # -> target/near/settle_escrow.wasm (~223 KB)
cargo test --features sandbox --test sandbox -- --nocapture
cargo test                                    # unit tests; on Windows set AWS_LC_SYS_PREBUILT_NASM=1
```

`SETTLE_ESCROW_WASM=/path/to.wasm` makes the sandbox tests use a different build.

Reproducible build (NEP-330, needs Docker and a clean, committed tree):

```bash
cargo near build reproducible-wasm
```

It builds inside `sourcescan/cargo-near:0.22.0-rust-1.97.1` pinned by digest `sha256:7467038b...` in `Cargo.toml` (checked against Docker Hub). CI job `escrow-reproducible` runs it and prints the WASM's SHA-256.

## What the sandbox tests prove

1. `automated_milestone_verify_challenge_finalize_payout`:
   - create needs the storage prepayment; funding needs the exact total;
   - a FAIL report is relayed by an unrelated account, and a report signed by the wrong key is rejected;
   - a genuine PASS opens the challenge window, and finalizing before it ends is rejected;
   - payout raises the worker's real balance by exactly the milestone amount;
   - a second payout is rejected and `get_total_held` returns to 0.
2. `human_review_approval_and_partial_settlement_pay_both_parties`:
   - an approved design milestone pays the worker;
   - a mutually agreed partial settlement sends the worker's share and the client's refund as two real transfers, and both balances change by exactly those amounts.

## Bug these tests caught

`payout` used to return `transfer_to_worker.and(transfer_to_client)`. NEAR rejects returning a joint promise ("Returning joint promise is currently prohibited"), so **every payout to two recipients reverted onchain**. The mocked unit tests could not show this. `payout` now detaches one `transfer.then(on_transfer)` chain per recipient and returns nothing. Results are visible through `get_agreement` and the `payout ...` logs.

## CI

`.github/workflows/ci.yml` job `escrow-sandbox` installs cargo-near, builds the WASM, uploads it as an artifact, and runs the sandbox tests on `ubuntu-latest`.
