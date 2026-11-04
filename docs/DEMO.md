# Judge demo: recording script (about 5 minutes)

Everything shown is the live deployment on NEAR testnet; nothing is simulated or staged. Before recording:

- Have two browser profiles (client and worker) with funded Meteor Wallet testnet accounts (see the README's *Before you start*).
- Open https://settle-9ewd.onrender.com a minute early so the services are awake. Allow pop-ups.
- For scene 7, start the bounty agent in a terminal (command below) with a funded agent testnet account.
- Optional scene 8 needs the MCP server configured in Claude Code ([FOR_AGENTS.md](FOR_AGENTS.md)).

```bash
SETTLE_API_URL=https://settle-9ewd.onrender.com NEAR_ACCOUNT_ID=<agent>.testnet NEAR_PRIVATE_KEY=<from your secret store> node apps/bounty-agent/dist/main.js
```

| # | Time | Show | Say |
| --- | --- | --- | --- |
| 1 | 0:00 | Landing page, then click the **testnet** chip (the contract on nearblocks) | "Freelancers and AI agents get paid only when work provably meets terms agreed up front. The money waits in a NEAR escrow contract; this is it on testnet." |
| 2 | 0:20 | Client: **Connect a testnet wallet** → Meteor → **Sign in as …** → Dashboard | "Signing in signs a message, no transaction. The dashboard shows what's in escrow, what's been paid, and what needs me." |
| 3 | 0:35 | **New**: *API + design* → worker's account → keep the terms → review step → **Create agreement** → approve | "Two milestones: an API that an independent verifier checks, and a design I review. Everything is locked by hash before any money moves." |
| 4 | 1:00 | Worker profile: Dashboard → *Needs your action* → **Accept terms**. Client: **Fund escrow · 0.5 NEAR** | "The worker accepts the exact terms; I deposit exactly the total. The money bar shows it's in escrow." |
| 5 | 1:20 | Worker: submit `…/fixture/broken` → **FAIL** → **Evidence**. Submit `…/fixture/fixed` → **PASS** | "The verifier called the API: `$.status` was `degraded`, so FAIL, and nothing is payable. The fix passes. The signed result goes onchain by itself." |
| 6 | 1:50 | The milestone stepper reaches *Challenge window*, then *Paid* (cut the wait); open **History** | "I get a window to challenge a PASS. After it, the contract pays the worker, with no one clicking anything. The history lists every step." |
| 7 | 2:20 | Client: **New** → *open bounty* → post a 0.02 NEAR API bounty. Cut to the terminal: the agent says `claimed`, `submitted`, `verified PASS`. Back to the dashboard: *Paid* | "Or don't pick a worker at all. A funded bounty goes on the board, and an AI agent finds it. Before claiming, it tests its own service against the locked checks. It claims, delivers, passes, and the contract pays it." |
| 8 | 3:10 | *(optional)* Claude Code with the SETTLE MCP server: "Find a bounty you can do and do it" → `settle_list_bounties`, `settle_claim_bounty`, `settle_submit_work` | "Any MCP agent (Claude, Cursor) can do the same with 18 tools, under a per-agent spending limit, testnet only." |
| 9 | 3:40 | Open run 9's agreement (*Merged commit passes near-sdk-rs CI*): History shows FAIL then PASS | "It also pays for merged code: a GitHub CI bounty fails an unmerged pull request's commit, so a PR can't rewrite its own checks, and pays when the merged commit's CI passes." |
| 10 | 4:05 | Design milestone: worker submits → client **Request revision** → resubmit → worker proposes **0.075** → client accepts | "Creative work is judged by people, with agreed revisions and partial settlements: here half each, as two real transfers." |
| 11 | 4:40 | [TESTNET_RUN.md](TESTNET_RUN.md) | "Every claim here has transaction links on testnet. Same rules for people and agents, enforced by the contract." |

## Screenshot checklist

- [x] First screen, desktop ([01-landing-desktop.jpg](screenshots/01-landing-desktop.jpg), live deployment; taken before the redesign)
- [x] First screen, phone width ([02-landing-mobile.jpg](screenshots/02-landing-mobile.jpg), live deployment; taken before the redesign)
- [ ] Signed in, *Dashboard* (needs a wallet sign-in)
