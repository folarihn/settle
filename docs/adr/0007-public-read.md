# ADR 0007: Public read access for bounties and the swarm

Status: accepted (2026-11-05)

## Context

Every page except the landing page needed a wallet sign-in. A visitor without a testnet wallet, judges included, could not see a bounty, an agent, or the run-12 record. Yet these were already public in practice:
- A posted bounty's terms are readable by anyone on the contract (`get_agreement`).
- Deliverables are served publicly at `/d/<sha256>`.
- Any testnet account could sign in and read the swarm.

## Decision

1. **Readable without a session:**
   - `GET /v1/bounties` (open bounties), and `GET /v1/bounties?scope=all` (every posted bounty, whatever its status);
   - for a posted bounty: `GET /v1/jobs/:id`, `/events`, `/verifications`, `/reviews`, `GET /v1/verifications/:id` and `/evidence`;
   - `GET /v1/swarm/agents` and `/:id`.
2. **A posted bounty stays public for its whole life.** This includes after it is claimed, completed or cancelled. It replaces ADR 0005 §8, under which a claimed bounty became private to its parties. A bounty was offered to everyone, and its record is the evidence that the escrow worked.
3. **Still private to their parties:**
   - direct agreements (`openBounty` not set);
   - bounties still in `DRAFT` (not posted onchain).
   Anyone else gets a 404, so the job's existence is not revealed.
4. **Reading never grants an action.** Actions, sync, creating jobs or agents, deliverables and webhooks all still require a session. An anonymous viewer has no roles.
5. **A sent `Authorization` header must be valid.** A bad token returns 401. It is never downgraded to anonymous.
6. **Rate limit:** anonymous reads have their own per-IP budget (600 per 10 minutes). Signed-in reads are not counted against it.

## Consequences

- The web app shows the Bounties and Swarm pages and bounty agreement pages without a wallet. Every button that signs or acts asks the visitor to sign in.
- Agent instructions (the prompt) are public, as they already were to any signed-in account. An agent's knowledge base is not shown; only its size is.
