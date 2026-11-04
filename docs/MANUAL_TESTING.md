# Owner manual testing guide

All steps use **NEAR testnet**. Use two fresh testnet wallets: one client, one worker. Use two browser profiles so each can stay signed in. Never paste a recovery phrase or private key into chat, issues, the README or screenshots.

Live deployment: `<app>` = **https://settle-9ewd.onrender.com** (contract `settle-escrow-14f651.testnet`). Allow pop-ups for the site; MyNearWallet signs in a pop-up. If the site was idle for about 15 minutes, the first load and the first verification each take about a minute (free hosting). Labels in **bold** are the exact button texts in the web app.

## 1. Sign in and create a job (client)

1. Open `<app>` → **Connect a testnet wallet** → Meteor Wallet, on testnet (approve in the pop-up) → **Sign in as `<you>.testnet`**. The wallet popup asks you to sign a message. Expected: your account appears in the header. No transaction is sent.
2. **New agreement**. Step 1: **API + design**. Step 2: a specific worker; enter the worker's account. Step 3: keep the defaults (API milestone 0.35 NEAR with the demo plan; design milestone 0.15 NEAR, 2 revisions, 0.075 NEAR protected minimum; challenge window 2 minutes). Step 4 shows a summary.
3. **Create agreement**, then approve in the wallet (about 0.2 NEAR attached; the unused storage deposit is refunded). Expected: the agreement page shows contract status `Draft` under *Onchain record*, and the transaction appears there under *Your transactions* with a nearblocks link.

## 2. Accept and fund

1. Worker profile: open the agreement from the **Dashboard** (*Needs your action*) → **Accept terms** → approve `accept_terms`.
2. Client: **Fund escrow · 0.5 NEAR**. This button stays disabled until the worker has accepted. Expected: onchain status `Funded`, and the nearblocks link shows 0.5 NEAR sent to the contract.
3. Refresh the page. The state persists.

## 3. Automated milestone: real FAIL, then real PASS

1. Worker: commit `demo-broken`, URL `<app>/fixture/broken` → **Submit work** → approve `submit`.
2. **Run verification**. Within a few seconds the run shows **FAIL**. **Evidence** shows each agreed check with PASS/FAIL (here `$.status == "ok"` FAIL, observed `got "degraded"`) and confirms the evidence matches the verifier's signed report. **Record onchain** relays the signed report. Expected: the milestone goes back to `PENDING`; nothing is allocated.
3. Worker: commit `demo-fixed`, URL `<app>/fixture/fixed` → **Submit work** → **Run verification** → **PASS** → **Record onchain**. Expected: `VERIFIED_PENDING_CHALLENGE` with a challenge end time shown.
4. Client (optional): before that time, **Challenge PASS** with a reason, which sends the milestone to the resolver.
5. Otherwise, after the window (reload the page): **Finalize after challenge window**, then **Claim payment** (worker) or **Release payment** (client). Expected: `PAID`. The nearblocks link shows 0.35 NEAR transferred to the worker.
6. **Claim payment** / **Release payment** no longer appears, and calling `payout` again onchain fails with `INVALID_TRANSITION`. No double payment.

## 4. Design milestone: revision, then approval or partial settlement

1. Worker: content hash `design-v1` (optionally a link) → **Submit work**.
2. Client: type feedback → **Request revision**. Expected: `REVISION_REQUESTED`, **Claim payment** / **Release payment** is not available, and funds stay locked.
3. Worker submits `design-v2`. Then either:
   - Client: **Approve and release** → **Claim payment** / **Release payment**. The worker receives 0.15 NEAR; or
   - Worker: enter `0.075` → **Propose partial settlement**; client: **Accept 0.075 NEAR settlement** → **Claim payment** / **Release payment**. Two transfers: 0.075 NEAR to the worker and 0.075 NEAR back to the client.
4. Dispute variant: **Open dispute** with a reason. Sign in as the resolver account and try an award below 0.075 NEAR. Expected: rejected (`ACCOUNTING`, below the agreed floor). An award between 0.075 and 0.15 NEAR is accepted.
5. Rejecting the design never changes the API milestone's allocation.

## 5. Agent parity

Run `packages/agent-sdk/dist/demo-worker.js` with the variables documented at the top of that file. The agent's own testnet key comes from your secret store as `NEAR_PRIVATE_KEY`. Expected: the same FAIL → PASS sequence and relayed reports as section 3, under the agent's account. In the job's evidence and status, agent actions look the same as human ones.

## 6. Failure checks

- An unrelated account opens the job URL: "job not found".
- The worker cannot approve their own design, and the client cannot submit work. Both are rejected with `UNAUTHORIZED`.
- A submission URL like `https://169.254.169.254` or `http://...` produces a **FAIL** with `TARGET_REJECTED`. It never PASSes, and nothing is requested from that address.
- Blocked pop-ups show *"Popup window blocked. Please allow popups for this site."* in the wallet modal (verified in the live site).
- Declining a wallet popup shows a divergence notice ("Onchain and offchain records differ"), with a retry button for the same call. Money still follows the onchain status only.
- Refresh during any step: the state is preserved.

## Per-PR feedback template

```
PR URL:
Hosted URL:
Wallet/network:
Steps performed:
Expected:
Observed:
Explorer transaction:
Screenshot or error:
PASS / FAIL / BLOCKED:
```
