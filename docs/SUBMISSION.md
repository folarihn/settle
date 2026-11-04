# SETTLE: hackathon submission

**Verifiable work agreements and escrow payments for people and AI agents, on NEAR.**

- **Live app:** https://settle-9ewd.onrender.com (NEAR testnet)
- **Escrow contract:** [`settle-escrow-14f651.testnet`](https://testnet.nearblocks.io/address/settle-escrow-14f651.testnet)
- **Every claim below is backed by testnet transactions:** [TESTNET_RUN.md](TESTNET_RUN.md)
- **How to test it yourself:** the top of the [README](../README.md)

## The problem

Paying for work done by strangers, and more and more by AI agents, needs trust neither side has.
- Clients don't want to pay before the work is done.
- Workers don't want to work without knowing the money exists.
- Agents can't be trusted with discretion over money.
- Escrow services decide disputes behind closed doors.

## What SETTLE does

1. **Agree before funding.** Client and worker lock milestones, amounts, checks, deadlines, a challenge window, a resolver and a protected minimum for creative work. Everything is bound by hash.
2. **Funded escrow.** The NEAR contract holds exactly the total. Nobody can change who is paid or how much.
3. **Objective work is checked by an independent verifier** that signs PASS or FAIL. It never runs the worker's code; it checks from outside:
   - **API checks:** one request to the worker's deployed API, with assertions on the response;
   - **Sustained health:** the same check repeated, and every probe must pass;
   - **GitHub CI:** a commit merged into the client's branch whose named checks succeeded.
4. **The client can challenge a PASS** during an agreed window; after that, payment happens on its own.
5. **Subjective work is judged by people.** The client approves or asks for one of the agreed revisions. Both sides can agree a partial split, or a resolver rules within the protected minimum. No AI decides about money.
6. **Open bounties.** Post funded work with no worker. The first human or agent to claim it becomes the worker, and the contract decides who was first.
7. **Automatic.** A keeper records verifier results onchain, finalizes after the challenge window and pays out. The people involved only do the steps that need them.

## Built for agents as first-class users

- **MCP server** (18 tools): Claude, Cursor or any MCP agent can hire, get hired, claim bounties and get paid, under a per-agent spending limit, testnet only.
- **TypeScript SDK** and **signed webhooks** (HMAC with replay protection) for agent developers.
- **An autonomous bounty agent.** It watches the board and dry-runs each bounty's locked checks against its own service, so it only claims what it can pass. It then claims, delivers and is paid.
- **The same rules for people and agents:** the same API, the same contract and the same domain state machine.

## Evidence (all on NEAR testnet)

| Run | What it shows |
| --- | --- |
| 6 | People in the browser with Meteor Wallet, end to end: FAIL, then PASS, paid; a revision; a partial settlement |
| 7 | Fully automatic record, finalize and payout: 89 s from submission to payment |
| 8 | An AI agent hires another AI agent, using MCP tools only |
| 9 | GitHub CI bounty on `near/near-sdk-rs`: an unmerged PR commit FAILs, the merged commit PASSes and is paid; plus a sustained health check |
| 10 | Open bounties: one claimed and paid; one cancelled and refunded by the contract; the contract upgraded in place without touching existing agreements |
| 11 | The autonomous bounty agent finds, checks, claims, delivers and is paid with no human input; it skips a human-review bounty it cannot do |

## Architecture

| Part | What it is |
| --- | --- |
| `contracts/escrow` | Rust (near-sdk 5.30). Exact-deposit funding, milestone state machine, ed25519 report verification, per-recipient async payouts with recovery, open bounties. Unit tests plus real-node sandbox tests in CI, and reproducible builds. |
| `packages/domain` | The same state machine in TypeScript, the canonical hashing, and the borsh port of the contract's terms hash, pinned by test vectors in both languages. |
| `services/verifier` | SSRF-guarded HTTP runner: pinned DNS, no redirects, size and time limits. Also the GitHub checks runner, signed evidence, and fail-closed outcomes. |
| `apps/api` | Fastify and Postgres. NEP-413 login, job service, verification queue, separate worker process (the only holder of the verifier key), keeper, webhooks. |
| `apps/web` | React app: dashboard, step-by-step agreement builder, agreement pages with history, bounty board. |
| `packages/agent-sdk`, `packages/mcp-server`, `apps/bounty-agent` | The agent tooling. |

The trust decisions are recorded as ADRs in [docs/adr](adr): escrow, verifier, API and agents, GitHub and sustained checks, open bounties.

## Honest limits

- **Testnet only.** Free hosting sleeps when idle, so the first request after a pause takes about a minute.
- **One verifier key signs results.** The client's challenge window and the resolver are the safeguards; multi-verifier quorums are not built.
- **Checks run from outside.** The verifier checks deployed APIs and GitHub CI results; it never executes submitted code. Sustained checks last at most 2 minutes, not hours.
- **The contract account is not locked,** because it is still being developed.
- **No marketplace search, reputation or token,** by design for this scope.
