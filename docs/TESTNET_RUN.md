# Live NEAR testnet runs (verified)

## Run 1: local API, public GitHub API as the target

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

## Run 2: through the public deployment (2026-11-03)

API and web app: **https://settle-9ewd.onrender.com** (Render web service, Postgres 16 on Render). Plan: the demo plan, locked before funding. Targets: the **hosted demo fixture** `https://settle-9ewd.onrender.com/fixture/broken` (FAIL) and `/fixture/fixed` (PASS). Agreement `job_djswNSwMkwPIfNhF`; same parties and amounts as run 1.

The Render verification worker could not be created yet (Render requires a payment card for the paid worker). For this run, the same worker code ran on the owner's machine against the Render database, through a temporary `/32` IP allowlist entry that was removed afterwards; the seed stayed local. The run was interrupted by a network change after the PASS, then completed with the script's resume mode, which needs no database access.

### Checks

| Check | Result |
| --- | --- |
| contract terms hash equals the agreed terms | ✅ |
| offchain mirror shows FUNDED after the onchain fund | ✅ |
| escrow holds exactly the total (0.5 NEAR) | ✅ |
| failing endpoint produced FAIL ($.status == "ok": got "degraded") | ✅ |
| evidence matches the signed report | ✅ |
| FAIL released nothing onchain (onchain status Pending) | ✅ |
| passing endpoint produced PASS (submission #2) | ✅ |
| PASS opens the challenge window, nothing payable yet | ✅ |
| finalizing inside the challenge window is refused (DEADLINE) | ✅ |
| resumed agreement is in its challenge window after a real PASS (onchain status VerifiedPendingChallenge) | ✅ |
| agent balance rose by exactly the API milestone (0.3 NEAR) | ✅ |
| API milestone is Paid onchain | ✅ |
| a second payout of the same milestone is rejected onchain (INVALID_TRANSITION) | ✅ |
| revision keeps design funds locked | ✅ |
| approval paid the full design milestone (0.1 NEAR) | ✅ |
| partial settlement paid the agent exactly the agreed half (0.05 NEAR) | ✅ |
| client refund of the other half confirmed onchain (worker paid 0.05 NEAR, client refunded 0.05 NEAR) | ✅ |
| agreement Completed onchain and offchain | ✅ |
| no divergence between offchain record and contract | ✅ |

### Transactions

| Step | Transaction |
| --- | --- |
| create_agreement (client) | [`FjWTo4HFWUFXAyoHuxYyjZybFJBRXm4R1WDyd84msF9U`](https://testnet.nearblocks.io/txns/FjWTo4HFWUFXAyoHuxYyjZybFJBRXm4R1WDyd84msF9U) |
| accept_terms (agent worker) | [`96k2u3mcqYfhwMXjf9wJ6Ns4nmavNPzoZUtUB52mEcSF`](https://testnet.nearblocks.io/txns/96k2u3mcqYfhwMXjf9wJ6Ns4nmavNPzoZUtUB52mEcSF) |
| fund (client) | [`3jVyKLx2q1pFQzyw3NQPvCqeJdnQU4gTbWhZ4QDtgwZE`](https://testnet.nearblocks.io/txns/3jVyKLx2q1pFQzyw3NQPvCqeJdnQU4gTbWhZ4QDtgwZE) |
| submit failing: https://settle-9ewd.onrender.com/fixture/broken (agent) | [`AadHYpTUuGEaAufXTTyJatk3Jb8vhSAhwNZF47Sf9ARz`](https://testnet.nearblocks.io/txns/AadHYpTUuGEaAufXTTyJatk3Jb8vhSAhwNZF47Sf9ARz) |
| record_verification FAIL (agent relays signed report) | [`7Zy8iEqyJXXcyJqA2G8gee68KrorjF7iGHbxJ4VMJ7Kv`](https://testnet.nearblocks.io/txns/7Zy8iEqyJXXcyJqA2G8gee68KrorjF7iGHbxJ4VMJ7Kv) |
| submit passing: https://settle-9ewd.onrender.com/fixture/fixed (agent) | [`EDfjFkmNiVYpbiMxaniXw7Ar5TKgA2cfuiEPKCtuCpkJ`](https://testnet.nearblocks.io/txns/EDfjFkmNiVYpbiMxaniXw7Ar5TKgA2cfuiEPKCtuCpkJ) |
| record_verification PASS (agent relays signed report) | [`7AGHC9zxwQeAazP7sihtbxkxSnP9UtzFuNiXnRqZqK9T`](https://testnet.nearblocks.io/txns/7AGHC9zxwQeAazP7sihtbxkxSnP9UtzFuNiXnRqZqK9T) |
| finalize_challenge (agent) | [`3vcaAZgv3P4igX1TxNNqbF1zWtUoVqGoAaeaLRDPTHcY`](https://testnet.nearblocks.io/txns/3vcaAZgv3P4igX1TxNNqbF1zWtUoVqGoAaeaLRDPTHcY) |
| payout api (client triggers; agent pays no gas) | [`7Wypge712BQWcPZYZY2vCdpmQNdaQZvXJZfL2G6Qvaz7`](https://testnet.nearblocks.io/txns/7Wypge712BQWcPZYZY2vCdpmQNdaQZvXJZfL2G6Qvaz7) |
| submit design v1 (agent) | [`E55vzqpD8bjD7AzuGNdsXgYj98SpPvtK5rrPsCGYmRxE`](https://testnet.nearblocks.io/txns/E55vzqpD8bjD7AzuGNdsXgYj98SpPvtK5rrPsCGYmRxE) |
| request_revision (client) | [`BVQstz6sUNA8UNAVWR5XBKTZ8mTDBHX7Mkfy9LWeR5zp`](https://testnet.nearblocks.io/txns/BVQstz6sUNA8UNAVWR5XBKTZ8mTDBHX7Mkfy9LWeR5zp) |
| submit design v2 (agent) | [`AsT28ogXjjfs7boBgnxXRAyRMGhwQBGGnetcKzrCr8qz`](https://testnet.nearblocks.io/txns/AsT28ogXjjfs7boBgnxXRAyRMGhwQBGGnetcKzrCr8qz) |
| approve (client) | [`HssX3zPjBKAonJ5GorwAjRtugQDEaKX2m77jrFF8d11S`](https://testnet.nearblocks.io/txns/HssX3zPjBKAonJ5GorwAjRtugQDEaKX2m77jrFF8d11S) |
| payout design (client triggers; agent pays no gas) | [`EjxMsRE6DxErk26yt2hwrJ6u6yP6mFspB53Dj91Mubvi`](https://testnet.nearblocks.io/txns/EjxMsRE6DxErk26yt2hwrJ6u6yP6mFspB53Dj91Mubvi) |
| submit copy v1 (agent) | [`BWuRzAuKQSVE1Vp3ePAZ1Ni5zEpyF776yrvdDPsreVLG`](https://testnet.nearblocks.io/txns/BWuRzAuKQSVE1Vp3ePAZ1Ni5zEpyF776yrvdDPsreVLG) |
| propose_settlement 50% (agent) | [`8mscLogjq4jPpADzshTLo6vhuw5oFJ9EMzcnSFE7fqVE`](https://testnet.nearblocks.io/txns/8mscLogjq4jPpADzshTLo6vhuw5oFJ9EMzcnSFE7fqVE) |
| accept_settlement (client) | [`ttjHxybjAMtHvKdCdeQb3EJkN36HW8YvX1egQrjwmKz`](https://testnet.nearblocks.io/txns/ttjHxybjAMtHvKdCdeQb3EJkN36HW8YvX1egQrjwmKz) |
| payout copy (client triggers; agent pays no gas) | [`DCLFuiMvrdGouvLtY8WJWuVBV7kidayZHYha3qViChA2`](https://testnet.nearblocks.io/txns/DCLFuiMvrdGouvLtY8WJWuVBV7kidayZHYha3qViChA2) |

Independent check after the run (RPC, `final`): agreement `Completed`; the onchain reports are `Fail` for `commit-failing` (submission 1) and `Pass` for `commit-passing` (submission 2), both `SuccessValue`; worker paid 0.3 + 0.1 + 0.05 NEAR, client refunded 0.05 NEAR.

## Run 3: fully hosted (the recommended evidence)

Everything on the deployment: API and web app at **https://settle-9ewd.onrender.com**, the verifier on its own Render service **https://settle-verifier.onrender.com** (the only holder of the verifier seed; free plan, woken by the API when a verification is queued), Postgres on Render. Plan: the demo plan. Targets: the hosted fixture `/fixture/broken` then `/fixture/fixed`. Agreement `job_XuOByu9_flTyvHjn`. The hosted worker returned each result about 4 s after queueing (it was already awake; a cold start takes about a minute).

### Checks

| Check | Result |
| --- | --- |
| contract terms hash equals the agreed terms | ✅ |
| offchain mirror shows FUNDED after the onchain fund | ✅ |
| escrow holds exactly the total (0.5 NEAR) | ✅ |
| failing endpoint produced FAIL ($.status == "ok": got "degraded") | ✅ |
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

### Transactions

| Step | Transaction |
| --- | --- |
| create_agreement (client) | [`9uaHYpsRdnN9N23hmfxurbhL35y5pz5xR8wHkLwDs6D`](https://testnet.nearblocks.io/txns/9uaHYpsRdnN9N23hmfxurbhL35y5pz5xR8wHkLwDs6D) |
| accept_terms (agent worker) | [`AZYyoVbszB5sWBFvdktn5qMbhNqUgahkt9nesdmSSoyj`](https://testnet.nearblocks.io/txns/AZYyoVbszB5sWBFvdktn5qMbhNqUgahkt9nesdmSSoyj) |
| fund (client) | [`As3X2zGWoBxigTzZCjPYDiUAKYiJLQKkDt9PwMQfupkY`](https://testnet.nearblocks.io/txns/As3X2zGWoBxigTzZCjPYDiUAKYiJLQKkDt9PwMQfupkY) |
| submit failing (agent) | [`KVucRtBAz4uyyrk5N4r5d1NDDCKKcZGX4Z574UPDBqj`](https://testnet.nearblocks.io/txns/KVucRtBAz4uyyrk5N4r5d1NDDCKKcZGX4Z574UPDBqj) |
| record_verification FAIL (agent relays signed report) | [`3iZ1wY2qFpVjp5WExr2AGBsmeQZV3CGa8PG2266JELX1`](https://testnet.nearblocks.io/txns/3iZ1wY2qFpVjp5WExr2AGBsmeQZV3CGa8PG2266JELX1) |
| submit passing (agent) | [`Dxrf1QtTwNLVQJAyaHJxjMEMD3g9P7EbEdvdfYCXgfFQ`](https://testnet.nearblocks.io/txns/Dxrf1QtTwNLVQJAyaHJxjMEMD3g9P7EbEdvdfYCXgfFQ) |
| record_verification PASS (agent relays signed report) | [`3y7GvVBjg2DoAP3LdAhkmd4Rxr2Zn2Js5LqZQtkuoiSp`](https://testnet.nearblocks.io/txns/3y7GvVBjg2DoAP3LdAhkmd4Rxr2Zn2Js5LqZQtkuoiSp) |
| finalize_challenge (agent) | [`AA8YoGXF8QbYpe8SZSew96wiD23uEshASYzHZr5xFL9c`](https://testnet.nearblocks.io/txns/AA8YoGXF8QbYpe8SZSew96wiD23uEshASYzHZr5xFL9c) |
| payout api (client triggers; agent pays no gas) | [`DSybJMn5UXoucFtgRVMimAcWsLTWP7Vx99dkr8JEBpfj`](https://testnet.nearblocks.io/txns/DSybJMn5UXoucFtgRVMimAcWsLTWP7Vx99dkr8JEBpfj) |
| submit design v1 (agent) | [`XT4qcn5FF8DpBomrXKCMbST9yceiq3dbA6cWKtPmDNT`](https://testnet.nearblocks.io/txns/XT4qcn5FF8DpBomrXKCMbST9yceiq3dbA6cWKtPmDNT) |
| request_revision (client) | [`4mNrFgtw4dDH2bCpQrVHXAZNW5GJzfosFgapieg8XMcu`](https://testnet.nearblocks.io/txns/4mNrFgtw4dDH2bCpQrVHXAZNW5GJzfosFgapieg8XMcu) |
| submit design v2 (agent) | [`5nJbpyU6CNt8ktQtfJ5LxnT1vQP5T5VhrXCGrTzeoCvi`](https://testnet.nearblocks.io/txns/5nJbpyU6CNt8ktQtfJ5LxnT1vQP5T5VhrXCGrTzeoCvi) |
| approve (client) | [`DhTLouERb2to4U5rJtucekbWMrpFi1iw7DiUgc9Z4e16`](https://testnet.nearblocks.io/txns/DhTLouERb2to4U5rJtucekbWMrpFi1iw7DiUgc9Z4e16) |
| payout design (client triggers; agent pays no gas) | [`3kiVYjqrLVpyvUbiriUJ5hKF9LUerhGgk9o1jg6XgijG`](https://testnet.nearblocks.io/txns/3kiVYjqrLVpyvUbiriUJ5hKF9LUerhGgk9o1jg6XgijG) |
| submit copy v1 (agent) | [`3Gr8NGb3JDQzwKCM5yfYhCrM4JLX1zMETXMtFctjQJ8m`](https://testnet.nearblocks.io/txns/3Gr8NGb3JDQzwKCM5yfYhCrM4JLX1zMETXMtFctjQJ8m) |
| propose_settlement 50% (agent) | [`2GLgcrYQLa9ThL1bWPjvyLfuTiptSJkHhq253qae2DZg`](https://testnet.nearblocks.io/txns/2GLgcrYQLa9ThL1bWPjvyLfuTiptSJkHhq253qae2DZg) |
| accept_settlement (client) | [`29jL9U7ToW74CznZ7avto8Eoj4Pfz3h9WyQtvJ5NhwYG`](https://testnet.nearblocks.io/txns/29jL9U7ToW74CznZ7avto8Eoj4Pfz3h9WyQtvJ5NhwYG) |
| payout copy (client triggers; agent pays no gas) | [`meUW2ZvS5MmQpqVDFtkHm4FSxkjnpkwLeKdzs6d7WWJ`](https://testnet.nearblocks.io/txns/meUW2ZvS5MmQpqVDFtkHm4FSxkjnpkwLeKdzs6d7WWJ) |

Independent check after the run (RPC, `final`): agreement `Completed`; the onchain reports are `Fail` for `commit-failing` (submission 1) and `Pass` for `commit-passing` (submission 2), both `SuccessValue`; payout logs show 0.3 NEAR to the worker for `api`, and 0.05 NEAR each to the worker and client for `copy`.
