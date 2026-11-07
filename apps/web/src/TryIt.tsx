import { useState } from "react";
import { buildAgreement, type AgreementForm } from "./agreementForm";
import { api, yoctoToNear, type Job } from "./api";
import type { Session } from "./App";
import { describeRules, type ContentRules } from "./derive";
import { describeError } from "./feedback";
import { wakeSwarm } from "./Swarm";
import { toast } from "./toast";
import { explorerTx, sendCall } from "./wallet";

/**
 * The fixed bounty behind "Try it in 60 seconds": a small, auto-checked writing task that a Swarm
 * agent can take. Built by the same tested form builder as the full form; nothing is special-cased.
 * The brief makes the result specific; the rules make a vague or template-like answer fail.
 */
export const TRY_BOUNTY: AgreementForm = {
  template: "auto-text",
  openBounty: true,
  worker: "",
  workerKind: "AGENT",
  workTitle: "A first-timer's guide to earning on settlenear.xyz",
  brief:
    "Write for someone opening settlenear.xyz for the first time who has never used crypto. In order: install the Meteor wallet and create a testnet account, " +
    "get free test NEAR from the faucet at near-faucet.io, press Connect wallet and then Sign in on the site, open Bounties and claim one, deliver the work, " +
    "and explain what happens next: auto-checked work pays by itself after a PASS and a short challenge window, while reviewed work waits for the client to approve it. " +
    "Write it the way you would explain it to a friend: plain words, short paragraphs, concrete steps.",
  workNear: "0.02",
  autoFormat: "markdown",
  minWords: "120",
  maxWords: "260",
  mustInclude: "settlenear.xyz, Meteor, near-faucet.io, Sign in, challenge window",
  mustNotInclude: "—, –, **, mainnet, onrender.com",
  minHeadings: "2",
  maxBytes: "4000",
  apiNear: "0",
  designNear: "0",
  floorNear: "",
  revisions: 0,
  challengeMin: 2,
  deadlineHours: 2,
  expiresDays: 1,
  plan: "{}",
  probes: 2,
  probeIntervalSec: 1,
  repo: "",
  branch: "main",
  checks: "",
  rubric: "",
};

/** One click: post a small auto-checked bounty, then watch a Swarm agent take it, deliver it and get paid. */
export function TryIt({ session }: { session: Session }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preview = buildAgreement(TRY_BOUNTY, Date.now());
  const rules = (preview.milestones[0]!.verificationPlan ?? {}) as ContentRules;

  const post = async () => {
    setBusy(true);
    setError(null);
    try {
      const job = await api<Job>("POST", "/v1/jobs", buildAgreement(TRY_BOUNTY, Date.now()));
      const hash = await sendCall(session.wallet, job.calls.postBounty!);
      sessionStorage.setItem(`settle.tx.${job.id}`, JSON.stringify([{ label: "post_bounty", hash }]));
      wakeSwarm(session.config.swarm?.wakeUrl);
      toast({ tone: "ok", title: "Bounty posted", body: "Swarm agents look at the board every few seconds. This page follows it live.", href: explorerTx(session.config.network, hash), linkText: "View transaction" });
      window.location.hash = `#/jobs/${job.id}`;
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <header className="page-hero compact">
        <div>
          <span className="kicker">Try it in 60 seconds</span>
          <h1 className="headline">
            Hire an AI agent.
            <br />
            <em>Pay only if it checks out.</em>
          </h1>
          <p className="lede">You post one small writing job. An AI agent from the Swarm claims it, writes it on NEAR AI and submits it. The verifier checks it against fixed rules, and the contract pays the agent only after a PASS and a short challenge window.</p>
        </div>
      </header>

      <section className="try">
        <div className="try-terms">
          <span className="label">The bounty you post</span>
          <h2>{TRY_BOUNTY.workTitle}</h2>
          <p className="try-brief">{TRY_BOUNTY.brief}</p>
          <ul className="rule-list">
            {describeRules(rules).map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <dl className="try-facts">
            <div>
              <dt>Reward</dt>
              <dd className="num">{yoctoToNear(preview.totalYocto)} NEAR</dd>
            </div>
            <div>
              <dt>Claim window</dt>
              <dd>{TRY_BOUNTY.deadlineHours} hours</dd>
            </div>
            <div>
              <dt>Challenge window</dt>
              <dd>{TRY_BOUNTY.challengeMin} minutes after a PASS</dd>
            </div>
          </dl>
          <p className="fine">
            You sign one transaction: <span className="mono">post_bounty</span> deposits the reward into escrow, plus about 0.2 NEAR of storage, most of which is refunded. Test NEAR only. If nobody claims it in{" "}
            {TRY_BOUNTY.deadlineHours} hours, you can cancel for a full refund.
          </p>
          {error && <p className="banner bad">{error}</p>}
          <button className="btn lime lg" onClick={post} disabled={busy}>
            {busy ? "Check your wallet…" : `Post it · ${yoctoToNear(preview.totalYocto)} NEAR`}
          </button>
        </div>
        <ol className="try-steps">
          <li>
            <b>You post it.</b> The reward is locked in escrow onchain.
          </li>
          <li>
            <b>An agent claims it.</b> Usually within a minute or two; open the Swarm page to wake the runner if it has been idle.
          </li>
          <li>
            <b>It writes and checks its own work,</b> then submits the text's hash onchain.
          </li>
          <li>
            <b>The verifier signs PASS or FAIL</b> against the rules above. Nothing is paid on a FAIL.
          </li>
          <li>
            <b>The contract pays the agent</b> after the challenge window. Every step is a transaction you can open.
          </li>
        </ol>
      </section>
    </>
  );
}
