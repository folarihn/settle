# Deploying SETTLE to NEAR testnet

Nothing here is deployed yet. This is the exact path, written so that **no private key or recovery phrase ever goes into chat, an issue, or the repo**. Keys go only into GitHub secrets and Render's secret settings.

You will do three things, in this order: deploy the escrow contract (Part A), create the verifier key (Part B), and host the app on Render (Part C). Commands run in a browser terminal: a **GitHub Codespace** on this repository (Code → Codespaces → Create codespace on `docs/settle-build-blueprint`). Nothing runs on your own computer.

## Audit summary (what makes this safe to fund)

- **No init call is needed.** The contract state comes from `Default` on first use, so deploying `without-init-call` is correct. There is no owner, admin or withdraw method: funds move only through agreement rules (exact funding, signed verification, client approval, bounded resolver rulings, mutual settlement, expiry refunds).
- **The real trust point is the contract account's own key.** Whoever holds its full-access key can deploy different code. For the demo, that key lives only in the `SETTLE_CONTRACT_KEY_JSON` GitHub secret (and briefly in the Codespace). Optional, irreversible: after the final deploy, delete the account's full-access key so the code can never change (Part A, step 5).
- **The deploy workflow refuses unsafe runs:**
  - it refuses non-`.testnet` accounts;
  - it refuses accounts with under 3 NEAR (code storage costs about 2.3 NEAR);
  - it refuses to overwrite an existing contract unless you type `REDEPLOY`;
  - it installs pinned tools only after checking their SHA-256;
  - it signs from a key file in the runner's temp dir, mode 600, deleted afterwards, so the key is never a command-line argument;
  - after deploying, it checks that the onchain `code_hash` equals the reproducible build, and that the contract answers.
- **The API refuses unsafe configuration at startup:**
  - the verifier seed on the API process when Postgres is used;
  - a test-only verifier key from the repository;
  - a non-`.testnet` escrow account;
  - no database;
  - a non-HTTPS public URL.

## Part A: contract account and deployment

1. In the Codespace terminal, install the NEAR CLI and create a faucet-funded testnet account. Pick your own name:

   ```bash
   scripts/install-near-tools.sh near-cli && export PATH="$HOME/.local/bin:$PATH"
   near account create-account sponsor-by-faucet-service settle-escrow-<yourname>.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
   ```

   The key pair is written to `~/.near-credentials/testnet/settle-escrow-<yourname>.testnet.json`.

2. Check the balance: `near account view-account-summary settle-escrow-<yourname>.testnet network-config testnet now`. The deploy needs **3 NEAR or more**. If the faucet gave less, send more from your own testnet wallet.

3. Add two **repository secrets** (Settings → Secrets and variables → Actions → New repository secret):
   - `SETTLE_CONTRACT_ACCOUNT_ID`: `settle-escrow-<yourname>.testnet`
   - `SETTLE_CONTRACT_KEY_JSON`: the entire contents of the JSON file from step 1. Open it in the Codespace editor and copy it; don't print it in a terminal that is being recorded.

   Then delete the Codespace, or the credentials file in it.

4. Actions → **Deploy escrow to NEAR testnet** → Run workflow. The run summary shows the WASM SHA-256, the matching onchain `code_hash`, and a testnet.nearblocks.io link.

5. Optional, irreversible: lock the code after the final deploy. In a Codespace that still has the key: `near account list-keys <account> network-config testnet now`, then `near account delete-keys <account> public-keys <that ed25519:... key> network-config testnet sign-with-legacy-keychain send`. After that, nobody can upgrade or fix the contract.

## Part B: verifier key

The verifier signs PASS/FAIL reports. Its seed is a secret held only by the verification worker.

```bash
pnpm install && pnpm build
node services/verifier/dist/cli.js keygen
```

Keep `seedHex` for `SETTLE_VERIFIER_SEED` (worker only). `publicKeyHex` goes into `SETTLE_VERIFIER_PUBLIC_KEY`; it is public, and every new agreement embeds it. The API refuses the fixed test keys used in this repository.

## Part C: hosting on Render (`render.yaml`)

Render dashboard → **New → Blueprint** → select this repository and branch. The Blueprint creates:

| Resource | Runs | Holds |
| --- | --- | --- |
| `settle` (web service) | `node apps/api/dist/main.js`: API, web app, demo fixture at `/fixture/...` | No keys. Health check `/healthz` |
| `settle-verifier` (background worker) | `node apps/api/dist/worker-main.js` | The only holder of `SETTLE_VERIFIER_SEED`; outbound HTTPS only |
| `settle-db` (Postgres 16) | the database for both, wired via `fromDatabase` | Data persists across restarts and deploys |

When asked for the `sync: false` values, enter:

| Variable | Value |
| --- | --- |
| `SETTLE_ESCROW_CONTRACT` | the account from Part A |
| `SETTLE_VERIFIER_ACCOUNT` | a testnet account you control (it may finalize challenge windows) |
| `SETTLE_VERIFIER_PUBLIC_KEY` | `publicKeyHex` from Part B |
| `SETTLE_RESOLVER_ACCOUNT` | the testnet account that will rule on disputes (sign in with it in the web app) |
| `SETTLE_VERIFIER_SEED` (worker only) | `seedHex` from Part B |

Service sizes are a cost choice; the Blueprint leaves Render's defaults. Render has no free background worker. Render sets `RENDER_EXTERNAL_URL` (`https://<service>.onrender.com`), which the API uses as its stable public HTTPS address. The demo fixture is therefore at `https://<service>.onrender.com/fixture/broken` and `/fixture/fixed`, and `/v1/config` reports it as `fixtureBaseUrl`.

After the first deploy, open `https://<service>.onrender.com/readyz`. It must return `{"ok":true,"checks":{"database":"ok","contract":"ok"}}`. Anything else names the failing dependency.

## Any other host

Run the same build (`corepack enable && pnpm install --frozen-lockfile && pnpm build`) as two processes with a shared Postgres. Set the variables above, plus `SETTLE_DATABASE_URL`, `SETTLE_WEB_DIST=apps/web/dist`, `SETTLE_ENABLE_FIXTURE=1`, `SETTLE_TRUST_PROXY=1` (behind a proxy) and `SETTLE_PUBLIC_URL=https://...`.

## After deployment

Send me the public URL and the contract account ID; neither is secret. I will then run the testnet flows in [MANUAL_TESTING.md](MANUAL_TESTING.md) with you, and only then put verified URLs and explorer receipts in the README.
