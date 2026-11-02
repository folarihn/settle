# Deploying SETTLE to NEAR testnet

Nothing here is deployed yet. This is the exact path, written so that **no private key or recovery phrase ever goes into chat, an issue, or the repo**. Keys go only into GitHub secrets and your host's secret settings.

You need three things: the escrow contract account (Part A), the verifier key (Part B), and a host for the API (Part C).

Every command below runs in a browser terminal: a **GitHub Codespace** on this repository (Code → Codespaces → Create codespace on `docs/settle-build-blueprint`). You don't need to run anything on your own computer.

## Part A: contract account and deployment

1. In the Codespace terminal, install the NEAR CLI (near-cli-rs 0.30.1) and create a faucet-funded testnet account for the contract. Pick your own name:

   ```bash
   curl --proto '=https' --tlsv1.2 -LsSf https://github.com/near/near-cli-rs/releases/download/v0.30.1/near-cli-rs-installer.sh | sh
   near account create-account sponsor-by-faucet-service settle-escrow-<yourname>.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
   ```

   The key pair is saved to `~/.near-credentials/testnet/settle-escrow-<yourname>.testnet.json` inside the Codespace.

2. Add three **repository secrets** in GitHub (Settings → Secrets and variables → Actions → New repository secret). Copy the values from that JSON file in the Codespace editor:
   - `SETTLE_CONTRACT_ACCOUNT_ID`: `settle-escrow-<yourname>.testnet`
   - `SETTLE_CONTRACT_PUBLIC_KEY`: the `public_key` value
   - `SETTLE_CONTRACT_PRIVATE_KEY`: the `private_key` value

   Then delete the Codespace, or the credentials file in it.

3. Actions → **Deploy escrow to NEAR testnet** → Run workflow. The job:
   - builds the reproducible WASM (Docker, pinned image);
   - prints its SHA-256;
   - refuses any account that isn't `.testnet`;
   - deploys without an init call;
   - calls `get_total_held` to prove the contract answers.

   The job summary links the account on testnet.nearblocks.io.

## Part B: verifier key

The verifier signs PASS/FAIL reports. Its seed is a secret held only by the verification worker.

```bash
pnpm install && pnpm build
node services/verifier/dist/cli.js keygen
```

Store `seedHex` as the host secret `SETTLE_VERIFIER_SEED`. Store `publicKeyHex` as `SETTLE_VERIFIER_PUBLIC_KEY`; it is public, and every new agreement embeds it.

## Part C: hosting the API, web app and worker

Any Node 22 host with Postgres works. Build once:

```bash
pnpm install --frozen-lockfile && pnpm build
```

Run two processes from the same build, with the same environment:

| Process | Command | Notes |
| --- | --- | --- |
| API + web app + demo fixture | `node apps/api/dist/main.js` | Internet-facing. Holds **no** keys. |
| Verification worker | `node apps/api/dist/worker-main.js` | The only process with `SETTLE_VERIFIER_SEED`. Needs outbound HTTPS only. |

Environment:

| Variable | Value |
| --- | --- |
| `SETTLE_DATABASE_URL` | Postgres connection string (tables are created on start) |
| `PORT` | port to listen on (API only) |
| `NEAR_NETWORK` | `testnet` |
| `NEAR_RPC_URL` | optional; defaults to `https://rpc.testnet.fastnear.com` |
| `SETTLE_ESCROW_CONTRACT` | the account from Part A |
| `SETTLE_VERIFIER_ACCOUNT` | any testnet account you control (it may also finalize challenge windows) |
| `SETTLE_VERIFIER_PUBLIC_KEY` | from Part B |
| `SETTLE_RESOLVER_ACCOUNT` | the testnet account that will rule on disputes (sign in with it in the web app) |
| `SETTLE_WEB_DIST` | absolute path to `apps/web/dist` |
| `SETTLE_ENABLE_FIXTURE` | `1` to serve the controlled demo API at `/fixture/broken/health` and `/fixture/fixed/health` |
| `SETTLE_VERIFIER_SEED` | **worker only**, from Part B |

Single-process demo mode: if `SETTLE_DATABASE_URL` is unset and `SETTLE_VERIFIER_SEED` is set, `main.js` uses in-process PGlite and runs the worker inside the API, with a warning. Use it only for a throwaway demo; data is lost on restart unless `SETTLE_PGLITE_DIR` points to persistent disk.

## After deployment

Put the real URL, contract account and explorer links into the README's HOW TO TEST table, only after you have opened them yourself. Then follow `docs/MANUAL_TESTING.md`.
