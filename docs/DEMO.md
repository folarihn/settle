# Judge demo: recording script (about 4 minutes)

Everything shown is the live deployment on NEAR testnet; nothing is simulated. Use two browser profiles (client and worker) with funded testnet accounts (see the README's *Before you start*). Open the app a minute before recording so it is awake, and allow pop-ups.

| # | Time | Show | Say |
| --- | --- | --- | --- |
| 1 | 0:00 | https://settle-9ewd.onrender.com first screen ([screenshot](screenshots/01-landing-desktop.jpg)) | "Freelancers and AI agents get paid only when work provably meets terms agreed up front. Money sits in a NEAR escrow contract." |
| 2 | 0:20 | Click the `testnet · settle-escrow-14f651.testnet` link in the header (nearblocks) | "This is the real contract on testnet." |
| 3 | 0:30 | Client: **Connect a testnet wallet** → Meteor Wallet (testnet) → **Sign in as …** | "Signing in signs a message; no transaction." |
| 4 | 0:45 | Client: **New agreement** → *API + design* → worker account → defaults → **Create agreement** → approve `create_agreement` | "Two milestones: an automated API check and a human-reviewed design, locked by hash before funding." |
| 5 | 1:05 | Worker profile: Dashboard → *Needs your action* → **Accept terms**; Client: **Fund escrow · 0.5 NEAR** | "The worker accepts the exact terms; the client deposits exactly the total." |
| 6 | 1:25 | Worker: submit `demo-broken` / `…/fixture/broken` → **Run verification** → **FAIL** → **Evidence** | "An independent verifier called the API: `$.status` was `degraded`. FAIL releases nothing; there is no pay-out button." |
| 7 | 1:55 | Worker: submit `demo-fixed` / `…/fixture/fixed` → **Run verification** → **PASS** → **Record onchain** | "Corrected work passes; the signed report goes onchain. Now a 2-minute challenge window protects the client." |
| 8 | 2:20 | Show the disabled **Finalize after challenge window** and the end time; (cut) reload after the window → **Finalize** → **Claim payment** / **Release payment** | "Only after the window can it be finalized and paid." |
| 9 | 2:45 | *Your transactions* → payout link on nearblocks | "A real 0.35 NEAR transfer to the worker." |
| 10 | 3:00 | Design: worker submits → client **Request revision** → resubmit → worker **Propose partial settlement 0.075** → client **Accept** → **Claim payment** / **Release payment** | "Creative work is judged by people. They can settle partially: here half to the worker, half refunded, as two real transfers." |
| 11 | 3:35 | `docs/TESTNET_RUN.md` run 3 table | "An AI agent ran the same flow with its own key through our SDK: same API, same contract rules; every transaction is linked." |
| 12 | 3:55 | End on the README | "Every step is verifiable onchain." |

## Screenshot checklist

- [x] First screen, desktop ([01-landing-desktop.jpg](screenshots/01-landing-desktop.jpg), live deployment)
- [x] First screen, phone width ([02-landing-mobile.jpg](screenshots/02-landing-mobile.jpg), live deployment)
- [ ] Signed in, *Dashboard* (needs a wallet sign-in)
- [ ] Agreement funded, onchain status `Funded`
- [ ] FAIL with the evidence panel open
- [ ] PASS with the challenge-window end time
- [ ] Paid milestone and the payout on nearblocks
- [ ] Partial settlement paid (two transfers)

The unchecked shots need a real wallet sign-in in the browser, which only the account owner can do. The same states are proven by the transactions in `docs/TESTNET_RUN.md`.
