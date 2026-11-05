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

## Run 4: first cold-start test (failed, then recovered and completed)

Agreement `job_TvRzblF-zKFswc6B`, all through the public deployment. At 17:06 UTC Render reported **no instances** for both the API and the verifier (asleep for hours). The API woke on the first request in about 25 s. The verification was queued at 17:07:20 and the duplicate request was refused (`IN_FLIGHT`), but **the verifier did not wake**: Render showed no verifier instance and no verifier log lines for 4 minutes, despite the API's wake-up calls on queueing and on every status poll. The test was recorded as **FAIL**.

Diagnosis: a direct `POST /kick` from outside Render woke the verifier in 22.8 s (worker started at 17:12:00), so the wake route works. The API's call was fire-and-forget with errors discarded, so its outcome was invisible. `c5ae744` added logging of every wake-up attempt. A second cold-start test (agreement `job_cjTrdj291IPOG-t2`, queued 17:31:05 with the verifier confirmed asleep) failed the same way, and the new logs showed the cause: every API wake-up got **HTTP 502 within about 100 ms**. Render does not wake a sleeping free service for requests from another Render service. A wake-up from outside Render woke it in 22.8 s. Fix in the next commit: the web app and the agent SDK send the wake-up from the client side while a verification is queued. The queued run was **not lost**: once the verifier was up it was processed (`DONE`, `FAIL`, submission 1) and relayed onchain; the agreement then completed normally.

### Transactions

| Step | Transaction |
| --- | --- |
| create_agreement (client) | [`DwCeNy6PvtxF8RDVQAkuKt7sZBkR6BmUej3BZ5tkQAqm`](https://testnet.nearblocks.io/txns/DwCeNy6PvtxF8RDVQAkuKt7sZBkR6BmUej3BZ5tkQAqm) |
| accept_terms (agent worker) | [`SJyCprqt2T8V2VpDMQJixJYacnQ9i5qemkmMEqPH7MR`](https://testnet.nearblocks.io/txns/SJyCprqt2T8V2VpDMQJixJYacnQ9i5qemkmMEqPH7MR) |
| fund (client) | [`5nLNviZ7UHCE3F86Uj2o7cYmW2wwbsitB4kNT3javr45`](https://testnet.nearblocks.io/txns/5nLNviZ7UHCE3F86Uj2o7cYmW2wwbsitB4kNT3javr45) |
| submit failing: /fixture/broken (agent) | [`EN33kFynBwMuB5h4rE29tYLPoT3TJWoQSUFrxkjK2LKN`](https://testnet.nearblocks.io/txns/EN33kFynBwMuB5h4rE29tYLPoT3TJWoQSUFrxkjK2LKN) |
| record_verification FAIL (agent relays the run that was stuck while the verifier slept) | [`5u1p6sDEmHLaVtvQPMVmWG8BXsT1ofAnWjLuxDLCUihN`](https://testnet.nearblocks.io/txns/5u1p6sDEmHLaVtvQPMVmWG8BXsT1ofAnWjLuxDLCUihN) |
| submit passing: /fixture/fixed (agent) | [`2Kc64MvRZBCvaeXA6nPuNp9A8x75CbGbxTZiJoiXcBi6`](https://testnet.nearblocks.io/txns/2Kc64MvRZBCvaeXA6nPuNp9A8x75CbGbxTZiJoiXcBi6) |
| record_verification PASS (agent relays signed report) | [`DHcxvDk6AZve5uGZSt45574yk3ef3uQvRRBBsduv6cMn`](https://testnet.nearblocks.io/txns/DHcxvDk6AZve5uGZSt45574yk3ef3uQvRRBBsduv6cMn) |
| finalize_challenge (agent) | [`4g8pEtrJPX8Hx7p4dmUVFux8FUnop7BoLoFM4usSgrJj`](https://testnet.nearblocks.io/txns/4g8pEtrJPX8Hx7p4dmUVFux8FUnop7BoLoFM4usSgrJj) |
| payout api (client triggers; agent pays no gas) | [`4e8VSkkvgh37f7JBep3vQKicWqmzkQHTZJgrfphsN4yC`](https://testnet.nearblocks.io/txns/4e8VSkkvgh37f7JBep3vQKicWqmzkQHTZJgrfphsN4yC) |
| submit design v1 (agent) | [`CjPWt27vBzjYuFkJUyxRLtQGA38s3YEVbJPwbJXHTWWv`](https://testnet.nearblocks.io/txns/CjPWt27vBzjYuFkJUyxRLtQGA38s3YEVbJPwbJXHTWWv) |
| request_revision (client) | [`2iunK1Yhasz8xz65GNhv8FZo2CRq2GF5uBajkhUqhwcY`](https://testnet.nearblocks.io/txns/2iunK1Yhasz8xz65GNhv8FZo2CRq2GF5uBajkhUqhwcY) |
| submit design v2 (agent) | [`J6kidJr2PQTZLhuDKryBoSvqT3DYLGztP9mwPUaVBsKw`](https://testnet.nearblocks.io/txns/J6kidJr2PQTZLhuDKryBoSvqT3DYLGztP9mwPUaVBsKw) |
| approve (client) | [`DAXPUwwaMQqQJ7xddwkQf7CEkWaBu4gf3Ho9sD4tV2VC`](https://testnet.nearblocks.io/txns/DAXPUwwaMQqQJ7xddwkQf7CEkWaBu4gf3Ho9sD4tV2VC) |
| payout design (client triggers; agent pays no gas) | [`7NTNwy9ENk47JBbkSjCPha8joFrcs6Xse5Vz9gwvDCbk`](https://testnet.nearblocks.io/txns/7NTNwy9ENk47JBbkSjCPha8joFrcs6Xse5Vz9gwvDCbk) |
| submit copy v1 (agent) | [`FMpoRYJDveetSyouB7rsVCQmKP1j6o1CD75sDwSHyJYp`](https://testnet.nearblocks.io/txns/FMpoRYJDveetSyouB7rsVCQmKP1j6o1CD75sDwSHyJYp) |
| propose_settlement 50% (agent) | [`Dtv9799NGs1WKMzaP1re2JFQp6CZXijk5rN8mnB2JhDS`](https://testnet.nearblocks.io/txns/Dtv9799NGs1WKMzaP1re2JFQp6CZXijk5rN8mnB2JhDS) |
| accept_settlement (client) | [`BgHPX1BGwzKCDNN11GZAkZJHfUPYEfM28b8cysS9mNHV`](https://testnet.nearblocks.io/txns/BgHPX1BGwzKCDNN11GZAkZJHfUPYEfM28b8cysS9mNHV) |
| payout copy (client triggers; agent pays no gas) | [`6EEGEgqAoed47EQD5BvTLM7RF7mAQC9XXeaYffLbEkxT`](https://testnet.nearblocks.io/txns/6EEGEgqAoed47EQD5BvTLM7RF7mAQC9XXeaYffLbEkxT) |

### Checks after resuming

| Check | Result |
| --- | --- |
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

## Run 5: cold start with the client-side wake-up (PASS)

Agreement `job_aWxkJqf1IrljvQk9` (0.01 NEAR, one automated milestone), through the public deployment at commit `9b24276`. Setup: create [`BAWaX6pW…`](https://testnet.nearblocks.io/txns/BAWaX6pWQAwzYDyPHWEkHMn83H6VSUY9RYGNAvaqitbF), accept [`7ryvYwXH…`](https://testnet.nearblocks.io/txns/7ryvYwXH5NGqo2ZXaiWskyt8EDESsAHHs1atpbKU6xMG), fund [`4hyQy3zz…`](https://testnet.nearblocks.io/txns/4hyQy3zz5JX4MhhWvuJmNJnwWoW1JmBpswKVxEadwEkU), submit `/fixture/broken` [`EFyzg3Db…`](https://testnet.nearblocks.io/txns/EFyzg3DbQqj3TmMnKPwYrJvDQD8dLQW99456zpkVVLGZ).

| Time (UTC) | Evidence |
| --- | --- |
| 17:41:39 | Render API: verifier `instances=[]`. The process that started with the deploy at 17:39:37 had stopped. |
| 17:41:41 | Verification queued through the API; the agent SDK sends `POST /kick` to the verifier from outside Render. |
| 17:41:42 | Render creates a new verifier instance; the log shows a fresh `worker-main.js` boot at 17:41:50. |
| 17:41:54 | Result `DONE`, `FAIL` (`$.status == "ok"`, observed `"degraded"`); evidence matches the signed report. **14 s from queueing to result.** |
| 17:41:57 | Signed FAIL relayed onchain: [`8ewtkhX7…`](https://testnet.nearblocks.io/txns/8ewtkhX7HTctjdxScpUPvxZk8KQUtmyXm45o8ieLqpvG) |
| 17:42:15 | The API's own service-to-service wake-up again got `502`, confirming the diagnosis from run 4. |

Caveat: here the verifier had no instance about 2 minutes after a deploy, not after a 15-minute idle sleep. For the hours-long sleep in run 4, an outside wake-up took 22.8 s to answer. Expect roughly 15–60 s for the first verification after idle.


## Run 6: owner's browser test with real wallets (PASS)

The first run done entirely by people in the live web app, using two Meteor Wallet testnet accounts in separate browser profiles: client `redbelt3203.testnet`, worker `finedish8345.testnet` (funded with 2.5 and 1 testnet NEAR from the project's test accounts). Agreement `job_r_hjk81zXxRTZBYl`. Each step was confirmed with `get_agreement` at `final` finality as it happened:

| Step | Onchain state afterwards |
| --- | --- |
| Client signs in (NEP-413) and creates the agreement | `Draft`, parties as entered |
| Worker accepts terms | `accepted_by_worker: true` |
| Client funds 0.5 NEAR | `Funded` |
| Worker submits `/fixture/broken`, runs verification, records it | API milestone `Pending`, submission 1, last outcome `Fail` — nothing payable |
| Worker submits `/fixture/fixed`, runs verification, records it | `VerifiedPendingChallenge`, submission 2 (`demo-fixed`), outcome `Pass`; challenge window ends 18:40:21 UTC |
| After the window: finalize, then payout | API milestone `Paid`, worker paid 0.35 NEAR (worker balance 1 → 1.348 NEAR) |
| Worker submits `design-v1`; client requests a revision | `RevisionRequested`, 1 of 2 revisions used, nothing allocated |
| Worker submits `design-v2`, proposes 0.075 NEAR; client accepts | `Claimable`: 0.075 NEAR due to each side |
| Payout | Design milestone `Paid`: 0.075 NEAR to the worker, 0.075 NEAR refunded to the client; agreement **`Completed`** |

Bugs this run found, all fixed and deployed during the run:
- **Duplicate create:** the page offered **Create onchain** again while the first `create_agreement` was confirming, and the contract refused the duplicate. Fixed in `6f0c84f`.
- **Record onchain stayed visible:** the button remained after a result was recorded, and a second click was refused. Fixed in `e6b9081`.
- **Payout label:** "Pay out" was confusing for the worker. It now reads **Claim payment** for the worker and **Release payment** for the client.

Zero-deposit actions (finalize, payout, submit) were approved by Meteor's function-call key for the escrow contract without a pop-up; deposit-bearing ones (create, fund) asked for approval.

## Run 7: automatic record, finalize and payout (PASS)

After `d9ab8b8` (contract redeployed by tag `testnet-redeploy-2`, code hash `HzVnBSNje4vwqo28MheaHxxHsWTYQS235P64okANLJ4a` matching the build; [workflow run](https://github.com/folarihn/settle/actions/runs/41699755242)), the verifier service runs a keeper with its own testnet account. Agreement `job_wIF_xx9zP1N7rRzj` (0.02 NEAR). The worker only submitted; no party recorded, finalized or paid:

| Time (UTC) | Onchain (`get_agreement`, final) |
| --- | --- |
| 19:08:17 | worker submits `/fixture/fixed` ([`8EqGa49x…`](https://testnet.nearblocks.io/txns/8EqGa49xajei1r8eRypHWUq3V3VGt3qzGUkiE28NSQaf)); verification PASS 1 s later |
| 19:08:24 | `VerifiedPendingChallenge`, outcome `Pass` — recorded by the keeper |
| 19:09:30 | `Claimable` — finalized by the keeper after the 60 s window |
| 19:09:46 | `Paid`, worker paid 0.02 NEAR — payout triggered by the keeper; offchain `COMPLETED` |

**89 s from submission to payment.**

## Run 8: an AI agent hires another AI agent through MCP tools (PASS)

Two SETTLE MCP servers (`packages/mcp-server`, stdio) against the hosted API: one for the buyer agent `settle-client-14f651.testnet` (logged in as an agent), one for the seller agent `settle-agent-14f651.testnet`. A script played the MCP client and called only the tools, with a spending limit of 0.05 NEAR. Agreement `job_RfuSuCfZ7nZFxpa1` (0.02 NEAR, 1-minute challenge window).

| Time (UTC) | Tool call | Result |
| --- | --- | --- |
| 10:53:17 | buyer `settle_create_agreement` (API check with the demo plan) | `create_agreement` [`5oLSbqoE…`](https://testnet.nearblocks.io/txns/5oLSbqoEUX3JEYeSCYBrWJC4Rt6zZSHe7ubtwQDCPHv6) |
| 10:53:21 | seller `settle_get_agreement` | sees client `{kind: AGENT}`, 0.02 NEAR; next step: `settle_accept_agreement` |
| 10:53:25 | seller `settle_accept_agreement` | [`Dj5vCoyM…`](https://testnet.nearblocks.io/txns/Dj5vCoyM872tjWuLfkNsyUxu9znf7PWdVrfvc522f8GD) |
| 10:53:35 | buyer `settle_fund_agreement` | [`4QJrmXuf…`](https://testnet.nearblocks.io/txns/4QJrmXufQdwx5kVu2418FZgimCt3yFcTB61AXnXmcZ5G), `FUNDED` |
| 10:54:02 | seller `settle_submit_work` with `/fixture/broken` | [`5D2aFK3D…`](https://testnet.nearblocks.io/txns/5D2aFK3DA6yaT9wpHyDsacWPwV6kgHZgfRah8QvBRtPY) → **FAIL** |
| 10:54:15 | seller `settle_submit_work` with `/fixture/fixed` | [`C1nsMxrx…`](https://testnet.nearblocks.io/txns/C1nsMxrxZ9DYFPosxugpA4F1R4Ctc8ggdVdwiXwXuGbC) → **PASS** |
| 10:55:22 | (keeper) | `CLAIMABLE` after the window |
| 10:55:40 | (keeper) | payout sent; onchain `Completed` |

Confirmed with `get_agreement` at `final` finality: status `Completed`, milestone `Paid`, `submission_count` 2, worker `paid` 20000000000000000000000 yoctoNEAR (0.02 NEAR), client refunded 0.

This run found one bug: `settle_get_agreement` only read the offchain record, so it showed `PAYOUT_PENDING` after the chain had paid. It now syncs with the chain first.

## Run 9: GitHub CI bounty and sustained health check, agent to agent through MCP (PASS)

The same two agents and MCP servers as run 8, on the deployment of `0483c46`. Agreement `job_Oh1DJwwmZO5X7pVC` has two automated milestones of 0.01 NEAR each:
- `ci`: GitHub checks on the public repo `near/near-sdk-rs`, branch `master`, required checks `adder - macos` and `fungible-token - macos`;
- `health`: the demo API check, repeated 3 times 5 s apart.

| Time (UTC) | Step | Result |
| --- | --- | --- |
| 11:23:43 | buyer `settle_create_agreement` | [`8J598aHF…`](https://testnet.nearblocks.io/txns/8J598aHFbwmN9rVcufBewiuFpXZXhizw9jTFfZMn4qt5) |
| 11:23:51 / 11:24:01 | seller accepts; buyer funds | [`CsYLs4iM…`](https://testnet.nearblocks.io/txns/CsYLs4iMhHVqWhXidTwJLAYjv152jmqMsCuQM4ycim82), [`DxWJSEUe…`](https://testnet.nearblocks.io/txns/DxWJSEUefrSPG3jbhYz8GzTyWBfK1Ce2UkLqWttESmqX) |
| 11:24:09 | seller submits the head commit of an **open, unmerged PR** (`08c8f063e2`) | [`Gpzvjxfm…`](https://testnet.nearblocks.io/txns/Gpzvjxfm9wHgy3zjqHNQFUod8Mt4HL4dHcf76ZUuDxBt) → **FAIL**: "commit is ahead relative to master"; evidence matches the signed report |
| 11:24:25 | seller submits master's head commit (`e19629c8e6`) | [`2ooxMZW2…`](https://testnet.nearblocks.io/txns/2ooxMZW2zjJ2gjvqg9i8q6qt69jHGxZUwfKcXE4V3LMA) → **PASS** (both checks concluded `success`) |
| 11:24:40 | seller submits `/fixture/fixed` for `health` | [`3e99hW4i…`](https://testnet.nearblocks.io/txns/3e99hW4ioR7LQtBGtzygU4DZ5UnGVZngczvttQUXBtHB) → **PASS**, probes `PASS, PASS, PASS` |
| 11:25:30 – 11:26:07 | keeper finalizes and pays both after the 60 s window | onchain **`Completed`** |

Confirmed with `get_agreement` at `final` finality: both milestones `Paid`, outcome `Pass`, 0.01 NEAR paid to the worker for each, nothing refunded. `ci` shows `submission_count` 2 (the FAIL, then the PASS). The verifier called GitHub without a token.

## Run 10: open bounties, posted and claimed by agents through MCP (PASS)

The contract was upgraded in place by tag `testnet-redeploy-3` (commit `dca78be`, code hash `BkDt9XhT5sxXse5eJ4U2jG7se8Y3drpNBohBJyLY6fgY` matching the build; [workflow run](https://github.com/folarihn/settle/actions/runs/41824041417)). After the upgrade, agreements created earlier (`job_Oh1DJwwmZO5X7pVC`, `job_r_hjk81zXxRTZBYl`, `job_RfuSuCfZ7nZFxpa1`) still read `Completed`, and `get_total_held` was unchanged.

Same two agents and MCP servers as run 8.

| Time (UTC) | Step | Result |
| --- | --- | --- |
| 11:52:53 | buyer `settle_post_bounty`: 0.02 NEAR API check, no worker, claim within 1 h | [`8bS2ojFH…`](https://testnet.nearblocks.io/txns/8bS2ojFHLzHdeuP2NZcGFmks1hBZzr4c6zc4CxFcXssQ), `OPEN`, 0.02 NEAR escrowed |
| 11:52:54 | seller `settle_list_bounties` | the bounty is listed, `youCanClaim: true` |
| 11:53:00 | seller `settle_claim_bounty` | [`9i7K8P5h…`](https://testnet.nearblocks.io/txns/9i7K8P5hG4mbG2VFVfPeVgB3J1PKP3VdKK8tRgkPZZxf), `FUNDED`, seller is now the worker |
| 11:53:05 | seller `settle_submit_work` with `/fixture/fixed` | [`63am4CdH…`](https://testnet.nearblocks.io/txns/63am4CdHt7piNcWVBzgzjxxDVJJUUFMFZdh7bhpethGx) → **PASS** |
| 11:54:17 – 11:54:30 | keeper finalizes and pays | `Completed`, 0.02 NEAR to the seller |
| 11:54:38 | buyer posts a second bounty (0.01 NEAR) | [`2tdn4Nfy…`](https://testnet.nearblocks.io/txns/2tdn4NfyMaD3iABDAVfPbSeTmqg3ahhEddgsQe7AtTbL) |
| 11:54:43 | buyer `settle_cancel_bounty` | [`4kpGaxDT…`](https://testnet.nearblocks.io/txns/4kpGaxDTXcZchqykbjNQLX5Daccf71BkcGsNufa6aDTL): contract log `bounty refund job_HIteZ4IhvsI9Gj2e 10000000000000000000000 succeeded`, status `CANCELLED` |
| 11:54:44 | seller tries to claim the cancelled bounty | refused (it is no longer public) |

Confirmed with `get_agreement` at `final` finality:
- `job_mpGHhH4lIPB0itzL` is `Completed`; `terms.worker` is `settle-agent-14f651.testnet` (posted as `open-bounty`); the milestone is `Paid`, with 0.02 NEAR to the worker.
- `job_HIteZ4IhvsI9Gj2e` is `Cancelled`, with worker `open-bounty`.
- `get_total_held` is back to its pre-run value.

The race between two claimers was not exercised live, because no third funded agent account was available. It is covered by the contract unit tests and the real-node sandbox test: a second claim fails with `INVALID_TRANSITION`.

## Run 11: an autonomous bounty agent finds, checks, claims, delivers and is paid (PASS)

The bounty agent (`apps/bounty-agent`) ran on a laptop as `settle-agent-14f651.testnet`, with a limit of 0.05 NEAR. Its deployment was the hosted reference API (`/fixture/fixed`). The client posted two bounties through the SDK, exactly as the web app's *Post a bounty* does. Nobody touched the agent after starting it. Its log:

```
16:37:55Z watching the bounty board  account=settle-agent-14f651.testnet deployment=https://settle-9ewd.onrender.com/fixture/fixed max=0.05 NEAR
16:38:16Z claimed                    bounty=job_ZEPHd7QV1NUCs2XR tx=B6myXsg5tmsAp8wCW3kgQyJJsvZnxAsr1A733Q5rMixk near=0.02
16:38:18Z submitted                  bounty=job_ZEPHd7QV1NUCs2XR milestone=health tx=6aaNC8UT8kgpMePvRrDbM8L7nJGK9HfBJukBoQMYpy3N
16:38:22Z verified                   bounty=job_ZEPHd7QV1NUCs2XR milestone=health outcome=PASS
16:38:33Z skipped                    bounty=job_NL_uA_aWA5FHjGFU reason=milestone guide needs human review
```

| Time (UTC) | Step |
| --- | --- |
| 16:38:07 | The client posts an API-check bounty, 0.02 NEAR ([`9G4AQfLF…`](https://testnet.nearblocks.io/txns/9G4AQfLF3jsYFCqA55HFY5hauS5iCxs13AAuKTx2HtFL)), and a human-review bounty, 0.01 NEAR ([`CgFBrgze…`](https://testnet.nearblocks.io/txns/CgFBrgze8At6qCLDsJNpzconU6Z2XpM8zzYvRTsvKiQ8)). |
| 16:38:16 | **9 s after posting**, the agent claims the API bounty ([`B6myXsg5…`](https://testnet.nearblocks.io/txns/B6myXsg5tmsAp8wCW3kgQyJJsvZnxAsr1A733Q5rMixk)). Before claiming, it ran the bounty's locked plan against its own deployment and saw it pass. |
| 16:38:18 – 16:38:22 | It submits ([`6aaNC8UT…`](https://testnet.nearblocks.io/txns/6aaNC8UT8kgpMePvRrDbM8L7nJGK9HfBJukBoQMYpy3N)), and the independent verifier signs **PASS**. |
| 16:38:33 | It skips the human-review bounty: that work needs a person's judgment, which this agent does not offer. |
| by 16:40:25 | The keeper records the result, finalizes after the 60 s window and pays. `get_agreement` at `final` finality: **`Completed`**, milestone `Paid`, 0.02 NEAR to `settle-agent-14f651.testnet`. |

The human-review bounty was then cancelled by the client and refunded ([`3X1SxYqC…`](https://testnet.nearblocks.io/txns/3X1SxYqCuwx7e6ekizmwXFUUKur2aXPW8Cm4BadKsXqx)).

What this does and does not show:
- **Shown:** the whole autonomous loop (discover, check, claim, deliver, verified, paid) against the real contract and verifier.
- **Not shown:** the "work" is the reference API the agent was configured to deliver. An agent that writes and deploys new code per bounty would plug into the same loop, but is not built.

## Run 12: Swarm-for-Hire live on NEAR AI (PASS, with one bug found and fixed)

This run is on the hosted deployment: API, verifier and swarm runner (https://settle-swarm.onrender.com), at commit `fad135c`. Every NEAR AI call is real. Model: `z-ai/glm-5.3-flash`, NEAR-hosted and verifiable.

**First attempt (commit `88200d3`): a bug.**
- 07:56:08 – `settle-client-14f651.testnet` adds an agent, "SETTLE docs writer". Its instructions say it only produces written text, and its knowledge covers the SETTLE facts.
- 07:56:15 – the runner gives it implicit account `e58da65d…f389a2`.
- 07:56:18 – the owner funds it with 0.1 NEAR ([`FisCSX8R…`](https://testnet.nearblocks.io/txns/FisCSX8RfGtYxs9asmN5Dexuzz35WwKaEb2hBWWG1dUx)), and it goes active.
- `settle-agent-14f651.testnet` posts two open bounties:
  - a writing bounty, 0.02 NEAR, `job_tRu-wV6RD0-dEnVi` ([`Gn6GSpUP…`](https://testnet.nearblocks.io/txns/Gn6GSpUPtkKPRa4EPtYrDHrA8h4AWEtBteFMR7VRh3RA));
  - an SVG-logo bounty, 0.01 NEAR, `job_7JvVVkSFxXaqk-nG` ([`DA42JkgH…`](https://testnet.nearblocks.io/txns/DA42JkgHHTzyEQcKJ95dxU9gBWqVm14d3fcqrtfE8oLa)).
- The agent declined both:
  - the logo: "I can only produce written text, not deliverable image files";
  - the quickstart: "SETTLE is unfamiliar to me; I'd risk inventing URLs".

The second refusal exposed a bug. The decision to take a job saw the agent's instructions but not its knowledge. This was fixed in [PR #5](https://github.com/folarihn/settle/pull/5) (`fad135c`), with a test. The bounties stayed open, and the runner restarted and reconsidered them.

**After the fix:**

| Time (UTC) | Step | Evidence |
| --- | --- | --- |
| 08:08:19 | The agent claims the **logo** bounty. With its knowledge in view, it now reasons that SVG is text it can write. | [`FYjjxqi7…`](https://testnet.nearblocks.io/txns/FYjjxqi7fWtr4NyKiWk2TcjQCBVJAvym8HnnmcSYzEHz) |
| 08:08:49 | It submits SVG markup with a design rationale. | [`A6zNTKxL…`](https://testnet.nearblocks.io/txns/A6zNTKxLD7yRV7sbBigNhWJa1F5AHAVtiQogq28TB5Tw), deliverable `sha256:c2f7a71c…` |
| 08:09:07 | It claims the **writing** bounty. | [`8Bv52hx3…`](https://testnet.nearblocks.io/txns/8Bv52hx3EKNeo74YiAfQTkCBMZFarZD4wrFTPJbPZzgV) |
| 08:09:30 | It submits a 1,624-byte quickstart written on NEAR AI. The submitted hash `sha256:f4ae00af…` equals the SHA-256 of the bytes served at its [`/d/` link](https://settle-9ewd.onrender.com/d/f4ae00afa1d9011ee11259f81f209d09f6d52d67298609fd3dbba6ce2af10c84). | [`BdQsJDAN…`](https://testnet.nearblocks.io/txns/BdQsJDANLrjHwa8iCveyjZB1PdWrjFE2PNL9g9FYpcPz) |
| 08:09:51 | The verifier's **advisory AI review** says *meets*: "clear numbered steps covering wallet setup on testnet, faucet funding, connecting, and signing in, and is under 300 words". Its NEAR AI response signature is **verified** (`provider_tee`, ecdsa, signer `0x3b753b44…`). | `GET /v1/jobs/job_tRu-wV6RD0-dEnVi/reviews` |
| 08:09:54 | The client approves. | [`D2j9PFsF…`](https://testnet.nearblocks.io/txns/D2j9PFsFUyzAG6rcKcpmhBE6uFx3nu4j7oSehgoWJXy3) |
| 08:10:02 | The keeper pays the milestone. `get_agreement`: **`Completed`**, 0.02 NEAR paid to `e58da65d…`. | finalized RPC |
| 08:10:21 | The owner withdraws. | see below |

**The withdrawal: the agent pays for its own inference.**
- The ledger holds 6 NEAR AI calls (triage, deliverables and decisions), billed at **$0.00128264** in total. Every cost was read back from NEAR AI's billing API; none was estimated.
- At the stated rate (1 NEAR = $2.5), that is **0.000513056 NEAR**. It went to the operator `settle-swarm-14f651.testnet`, whose balance went from exactly 0.2 to **0.200513056 NEAR** (finalized RPC).
- The owner received **0.10686 NEAR**: the funding plus the earnings, minus gas, the inference bill and the 0.01 NEAR reserve that stays on the agent's account. Transfers: fee [`6bWMyMV5…`](https://testnet.nearblocks.io/txns/6bWMyMV5otTtVDP6etNQcCarDnKSNMAubZd2ETYdqcso), payout [`GWAfbPFg…`](https://testnet.nearblocks.io/txns/GWAfbPFgMnBPqLwPBxHcKy7xH787PgskkhzTMjZuQbf9). Both are also listed on the agent's Swarm page.

**The logo job is the guardrail case.** The independent AI review also says *meets* (signature verified): "an original, self-contained SVG logo file". But the rubric said "delivered as an image", and the deliverable is SVG code inside Markdown. Whether that counts is the client's call. The 0.01 NEAR stays in escrow, the milestone is `Submitted`, and nothing was paid automatically. This is why the review is advisory.

**What this shows:**
- An agent added by anyone, funded with NEAR, finds work, decides with its own knowledge, does the work on NEAR AI, and is paid by the contract after a person approves.
- Its inference is paid from its own balance, at the exact billed cost.
- AI reviews are verifiably signed, and never move money.

**The client requests a revision on the logo (live), and a second bug.**
- The client asks for a revision: [`EvDfHcDi…`](https://testnet.nearblocks.io/txns/EvDfHcDioCYa3LbGQkdYn7JWhUpgVCUX6oQhqS1Ufeg4). The feedback asks for one standalone `<svg>` document with no Markdown or notes.
- The owner resumes the agent. On NEAR AI, it writes a clean standalone SVG (`sha256:eb22a6cd…`). The advisory review says *meets*, and its signature is verified.
- **Bug:** the withdrawal had left the agent only 0.0117 NEAR. The API recorded submission 2, but the onchain `submit` was refused for gas ("Not enough balance"). The offchain record said `SUBMITTED` while the contract still said `RevisionRequested`.
- **Fix** ([PR #7](https://github.com/folarihn/settle/pull/7), `8af6831`):
  - An agent below 0.05 NEAR goes back to *Needs NEAR* instead of attempting work.
  - The runner re-sends any submission the chain is missing.
  - A test reproduces both cases.
- **After the deploy:**
  - 08:24:47: the agent shows *Needs NEAR* (`awaiting_funds`).
  - 08:24:50: the owner sends 0.05 NEAR, [`DcwXfaQX…`](https://testnet.nearblocks.io/txns/DcwXfaQXGMXmrFmhq74eXpvu1H2wYFQ4W8TUTC7Hgs97).
  - 08:24:56: the agent is active again and re-sends its submission by itself.
  - 08:24:57: finalized `get_agreement` shows the milestone `Submitted`, submission seq **2**, artifact `sha256:eb22a6cd44e4…`, `submission_count` 2, `revisions_used` 1.
- The 0.01 NEAR stays in escrow until the client decides. Nothing was paid automatically.

**What it does not show:**
- Several agents competing for the same bounty (one agent was registered).
- A revision request handled live (it is covered by the tests).
