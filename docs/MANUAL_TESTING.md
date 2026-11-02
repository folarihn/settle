# Owner manual testing guide (update alongside implementation)

## Safety and setup

All examples use **NEAR testnet** only. Use a fresh client testnet wallet and a different worker testnet wallet. Never upload or paste mnemonics, recovery phrases, or private keys into chat, issues, README, or screenshots. Use current NEAR wallet/faucet documentation, verified by the agent when setup is available.

There is **no deployed app yet**. This guide describes the checks the implementation must make runnable; do not present it as proof of current behavior.

## Manual test 1: job creation and funding

1. Open the deployed application URL, connect client testnet wallet.
2. Create two milestones: API checks 70%; creative design review 30%, total e.g. 0.5 testnet NEAR.
3. Verify the preview lists exact amount, client, worker, acceptance test plan hash, reviewer/resolver, deadline, revision count, partial-compensation rule and challenge window.
4. Attempt to fund without approving the plan: must refuse. Approve and fund.
5. Open provided explorer link to confirm deposited amount and contract account.

## Manual test 2: automatic failure and success

1. Worker connects a separate wallet and submits a known failing API target or reference fixture. Record exact version/commit.
2. Start verification and inspect evidence report. Expected FAIL, **no payment**.
3. Resubmit the known passing fixture. Confirm test plan hash did not change, view PASS, wait for configured challenge/settlement rules.
4. Claim/settle testnet funds; verify client and worker onchain balances and explorer transaction hash.
5. Reuse the old evidence or click claim twice: no double payment.

## Manual test 3: subjective milestones

1. Submit a design artifact or URL. Client requests a revision with written feedback.
2. Verify design payout remains locked while revision is pending.
3. Approve revised artifact; after any agreed period, worker receives exactly the design milestone amount.
4. In a second job choose a pre-agreed partial-compensation scenario (example: agreed $150 equivalent from a $300 creative milestone). Trigger mutual settlement or pre-authorized dispute decision; check developer receives only the authorized share and refund goes to client.
5. A client rejection alone should not confiscate technical milestones already earned.

## Manual test 4: human and agent parity

1. Execute job submission from a documented agent API example using an agent-controlled testnet identity.
2. Compare evidence, stage transitions and settlement with the same action from human web UI.
3. Confirm wrong role, expired agent signature, or invalid nonce is rejected.

## Manual test 5: common failures

- Browser refresh leaves correct job state.
- Failing verifier, timeout, wrong signature and invalid submission show a clear error and **do not** result in PASS.
- Wrong account cannot approve or withdraw.
- Partial payments + refunds never exceed escrowed sum.
- Mobile UI displays job status and test evidence.

## Per-PR manual feedback template

```
PR URL:
Hosted preview URL (if available):
Wallet/network:
Steps performed:
Expected:
Observed:
Explorer transaction:
Screenshot or error:
PASS / FAIL / BLOCKED:
```

Agent must keep these instructions updated as screens/routes change, with exact buttons and test fixture URL once deployed. Do not ask owner to run localhost-only commands.
