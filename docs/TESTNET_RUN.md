# Live NEAR testnet run (verified)

Run 2026-11-03T08:01:15.109Z → 2026-11-03T08:03:58.364Z (UTC) with `scripts/testnet-e2e.mjs` at the commit that adds this file. **Result: all checks passed.**

- Escrow contract: [`settle-escrow-14f651.testnet`](https://testnet.nearblocks.io/address/settle-escrow-14f651.testnet), deployed by the *Deploy escrow to NEAR testnet* workflow ([run 41599553504](https://github.com/folarihn/settle/actions/runs/41599553504)), deploy tx [`2aQ9BHof…J6UH`](https://testnet.nearblocks.io/txns/2aQ9BHofYPXFT1zdZWuTZe5zmVuKNzLCZXkzdHwPJ6UH). Onchain `code_hash` `6VgnyMtYhCXyAan91WedKe4AaBSHKombZNzfKxNqLmau` = base58(sha256) of the reproducible build `51a3b0e1…8cb6` from commit `01630ae`.
- Agreement: `job_RA_NwhHhMfVo8HNY`. Client [`settle-client-14f651.testnet`](https://testnet.nearblocks.io/address/settle-client-14f651.testnet); worker is an **AI agent** driven only through the agent SDK: [`settle-agent-14f651.testnet`](https://testnet.nearblocks.io/address/settle-agent-14f651.testnet). Both logged in to the real API with NEP-413 signatures, checked against their testnet access keys.
- Verifier: the real verification worker with a fresh key (public key `a42304d5d9a73416c6050caa2ed88ad43625b063697892d922e1ea16b0f4c723`; the seed is not in the repo). The API ran locally, not on a public host, because Render is not set up yet.
- Automated milestone plan, locked before funding: `GET /` on the submitted base URL must return 200 with a string at `$.current_user_url`. Failing submission: `https://api.github.com/settle-demo-missing` (404). Passing submission: `https://api.github.com`. This is a real public API, used because the hosted demo fixture is not deployed yet.

Milestones: `api` 0.3 NEAR (automated), `design` 0.1 NEAR (revision, then approval), `copy` 0.1 NEAR (agreed 50% partial settlement). Total escrowed 0.5 NEAR.

## Checks

| Check | Result |
| --- | --- |
| contract terms hash equals the agreed terms | ✅ |
| offchain mirror shows FUNDED after the onchain fund | ✅ |
| escrow holds exactly the total (0.5 NEAR) | ✅ |
| failing endpoint produced FAIL (status: expected 200, got 404; $.current_user_url is string: got missing) | ✅ |
| evidence matches the signed report | ✅ |
| FAIL released nothing onchain (onchain status Pending) | ✅ |
| passing endpoint produced PASS (submission #2) | ✅ |
| PASS opens the challenge window, nothing payable yet | ✅ |
| finalizing inside the challenge window is refused (DEADLINE) | ✅ |
| agent balance rose by exactly the API milestone (0.3 NEAR) | ✅ |
| API milestone is Paid onchain | ✅ |
| a second payout of the same milestone is rejected onchain (INVALID_TRANSITION) | ✅ |
| revision keeps design funds locked | ✅ |
| approval paid the full design milestone (0.1 NEAR) | ✅ |
| partial settlement paid the agent exactly the agreed half (0.05 NEAR) | ✅ |
| client refund of the other half confirmed onchain (worker paid 0.05 NEAR, client refunded 0.05 NEAR) | ✅ |
| agreement Completed onchain and offchain | ✅ |
| no divergence between offchain record and contract | ✅ |

## Transactions

| Step | Transaction |
| --- | --- |
| create_agreement (client) | [`CKcomtgndnbZW6XTc9Uj5o6rsq6msTYc8XSaA5dZKpbs`](https://testnet.nearblocks.io/txns/CKcomtgndnbZW6XTc9Uj5o6rsq6msTYc8XSaA5dZKpbs) |
| accept_terms (agent worker) | [`HbFGSKxCsyYuwd5oAE38qmLkDfBr5TPDFopPUDCd5CNt`](https://testnet.nearblocks.io/txns/HbFGSKxCsyYuwd5oAE38qmLkDfBr5TPDFopPUDCd5CNt) |
| fund (client) | [`7KMpmojvAbU2e7A51aPCBWVRm666sUxF6BjD7UZGDKgc`](https://testnet.nearblocks.io/txns/7KMpmojvAbU2e7A51aPCBWVRm666sUxF6BjD7UZGDKgc) |
| submit failing (agent) | [`8wEk8ofDiw2urw8CRresxn1xjPA5ddBDb1MyfV6drGmC`](https://testnet.nearblocks.io/txns/8wEk8ofDiw2urw8CRresxn1xjPA5ddBDb1MyfV6drGmC) |
| record_verification FAIL (agent relays signed report) | [`B2aDouUgybrLVfGJjSF6VVCjaCbnUh5TPZvMQxvD7sDu`](https://testnet.nearblocks.io/txns/B2aDouUgybrLVfGJjSF6VVCjaCbnUh5TPZvMQxvD7sDu) |
| submit passing (agent) | [`EmTUKqPkRikS6keCJMNu7dbYxDxmCeMYERR2ZQsp3LrD`](https://testnet.nearblocks.io/txns/EmTUKqPkRikS6keCJMNu7dbYxDxmCeMYERR2ZQsp3LrD) |
| record_verification PASS (agent relays signed report) | [`DGU6ZBrV3Zay4xFoNKgkQD5daSJmVe4e63Bh97VbNQGJ`](https://testnet.nearblocks.io/txns/DGU6ZBrV3Zay4xFoNKgkQD5daSJmVe4e63Bh97VbNQGJ) |
| finalize_challenge (agent) | [`BvM4MD24MVTNMgZ1buEkRdaSFbynVLwpmZmuzxKETeS2`](https://testnet.nearblocks.io/txns/BvM4MD24MVTNMgZ1buEkRdaSFbynVLwpmZmuzxKETeS2) |
| payout api (client triggers; agent pays no gas) | [`3BQLvCHJdQ72TWAPKe3BKFaeL7xRDmc7KBzr2JrwWVNi`](https://testnet.nearblocks.io/txns/3BQLvCHJdQ72TWAPKe3BKFaeL7xRDmc7KBzr2JrwWVNi) |
| submit design v1 (agent) | [`4FmKXAQ9Hpi14ZWMqYL7VfHfqGbpTJ1E4KsagyLyahsf`](https://testnet.nearblocks.io/txns/4FmKXAQ9Hpi14ZWMqYL7VfHfqGbpTJ1E4KsagyLyahsf) |
| request_revision (client) | [`6gRg9vqaG15Fk5qwSTQJY56LzDDdTo2nbNuUv7G3ByU8`](https://testnet.nearblocks.io/txns/6gRg9vqaG15Fk5qwSTQJY56LzDDdTo2nbNuUv7G3ByU8) |
| submit design v2 (agent) | [`26WBaALHtkfqoTkVeDcdher7yXFV2odTLe7oTBYWwtyi`](https://testnet.nearblocks.io/txns/26WBaALHtkfqoTkVeDcdher7yXFV2odTLe7oTBYWwtyi) |
| approve (client) | [`9QjJVYFj5PRxFS5KpwLt9bqPYAekvXweDnSdSFJDktNs`](https://testnet.nearblocks.io/txns/9QjJVYFj5PRxFS5KpwLt9bqPYAekvXweDnSdSFJDktNs) |
| payout design (client triggers; agent pays no gas) | [`gLMyYBs2uF1xAwiYK5vx4m1JZq4w75C9NwGWUAiWyaP`](https://testnet.nearblocks.io/txns/gLMyYBs2uF1xAwiYK5vx4m1JZq4w75C9NwGWUAiWyaP) |
| submit copy v1 (agent) | [`DWiE1HvSHbDADhZzNE7UZ7qoDktJVJcjfjLFFqVeuABK`](https://testnet.nearblocks.io/txns/DWiE1HvSHbDADhZzNE7UZ7qoDktJVJcjfjLFFqVeuABK) |
| propose_settlement 50% (agent) | [`2M8TuqmtJy4y9XBYUJxCZNmoeXxAf4ZXdMgXWjtvtma6`](https://testnet.nearblocks.io/txns/2M8TuqmtJy4y9XBYUJxCZNmoeXxAf4ZXdMgXWjtvtma6) |
| accept_settlement (client) | [`DS2BcZNj7o3jKH17CoeX2oQjFAZ4NmCXnDvpNUGaBZhP`](https://testnet.nearblocks.io/txns/DS2BcZNj7o3jKH17CoeX2oQjFAZ4NmCXnDvpNUGaBZhP) |
| payout copy (client triggers; agent pays no gas) | [`DZzxMRUare9P3sUoMJdAD8TfLcsLB1nmFYzsFJVbYWFu`](https://testnet.nearblocks.io/txns/DZzxMRUare9P3sUoMJdAD8TfLcsLB1nmFYzsFJVbYWFu) |

Independent check after the run (RPC, `final`): agreement `Completed`; worker paid 0.3 + 0.1 + 0.05 NEAR, client refunded 0.05 NEAR; payout transactions `3BQLvCHJ…`, `DZzxMRUa…` and fund `7KMpmojv…` all `SuccessValue`, with `payout … succeeded` logs for each recipient.

Note: an earlier attempt (`job_2AAbnCXh4UfzfD28`) stopped after funding, because the API synced at `final` finality before the fund transaction was final. That bug is fixed: the web app now waits for finality before syncing. Its 0.5 NEAR stays escrowed until the client calls `expire_milestone` after it expires (24 h); no funds are at risk.
