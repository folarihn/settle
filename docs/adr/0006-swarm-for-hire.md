# ADR 0006: Swarm-for-Hire on NEAR AI

Status: accepted, 2026-11-04. Builds on open bounties ([ADR 0005](0005-open-bounties.md)).

## Context

The idea comes from Illia Polosukhin's list for this hackathon: "Put a bid onchain with a description of the work and anyone can add a new agent to the swarm by giving it NEAR (to pay for inference) with a prompt/knowledge base/tools. All agents accept jobs and get NEAR AI LLM inference from their payment for the job." He also asked for guardrails or governance AI review.

SETTLE already had funded, onchain bids (open bounties), agents that claim and get paid, and guardrails (verifier, challenge window, human review, resolver). What was missing:
- agents that do the work with NEAR AI;
- a way for anyone to add one;
- inference paid from the agent's money;
- AI review.

## Decisions

1. **Inference runs on NEAR AI Cloud** (`https://cloud-api.near.ai/v1`, OpenAI-compatible). The default model is `z-ai/glm-5.3-flash`: NEAR-hosted, marked verifiable, and $0.08 in / $0.50 out per million tokens at the time of writing. The model is configurable.

2. **Every inference call is in a ledger.** For each call we record:
   - the agent, job, milestone and purpose;
   - the model and token usage;
   - the NEAR AI `inference-id`;
   - the exact cost, read back from `POST /v1/billing/costs` in nano-USD.
   
   Nothing is estimated. A cost that has not been reported yet shows as pending.

3. **Swarm agents do work a person judges.** An agent takes open bounties whose milestones are all human review. It writes the deliverable with NEAR AI, using its owner's prompt and knowledge, and submits it. The client decides with the existing rules: approve, revisions, partial split, or the resolver. No AI decides about money ([AGENTS.md](../../AGENTS.md) rule 10). An agent first asks the model whether the bounty fits its skills; that answer only decides whether to claim, never whether to pay.

4. **Deliverables are content-addressed.** `POST /v1/deliverables` stores the text (up to 64 KB). Its address is `sha256:<hash of the bytes>`, and that hash is the submission's artifact hash onchain. Anyone can fetch `/d/<hash>` and check that the bytes match what was submitted.

5. **Governance AI review is advisory and signed.** When a human-review milestone is submitted, the verification worker (the independent party, not the agent) asks NEAR AI to review the deliverable against the rubric. The review is a verdict plus reasons, shown to the client and the resolver, and never fed into any transition. We store NEAR AI's response signature: the request hash, the response hash, the signing address and the algorithm. We verify that the signer recovers from the signed text. Checking the enclave attestation that binds that address to the model is left to the reader, using NEAR's verification tools; we do not claim to have checked it.

6. **Anyone can add an agent.** The owner, signed in with their wallet, gives the agent a name, a system prompt, a knowledge text, a maximum bounty size and a maximum inference spend per job.
   - The swarm runner, a separate process and the only holder of agent keys, generates an ed25519 key. The agent's NEAR account is the matching implicit account (64 hex characters), which comes into existence when the owner sends it NEAR from their wallet. That is the "give it NEAR" step.
   - Keys are encrypted at rest (AES-256-GCM, key only in the runner's environment).
   - The internet-facing API never sees an agent key.
   - The owner can pause the agent, or withdraw its balance to their own account.

7. **Inference is paid from the agent's money.** Each agent's ledger accrues its inference cost in USD. On withdrawal, the runner first transfers the accrued cost, converted at the stated rate `SWARM_NEAR_USD`, to the swarm operator, who pays the NEAR AI bill. The rest goes to the owner. The rate is shown on the swarm page; it is a configured testnet rate, not an oracle.

8. **Custody is honest.** On testnet the runner is the custodian of agent keys; this is stated in the UI. A mainnet design would use function-call-only keys on owner-held accounts, or a contract-held budget.

## Not done

- Agents with tools beyond writing text (browsing, code execution).
- Multiple agents bidding on price.
- Funding inference by staking NEAR. NEAR AI supports staking for credits, but not on testnet as far as we could find.
