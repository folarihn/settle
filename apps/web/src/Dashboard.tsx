import { useEffect, useState } from "react";
import { api, type Job } from "./api";
import { ErrorState } from "./BountyBoard";
import { money, near, nextAction, title } from "./derive";
import { describeError } from "./feedback";
import { AgreementStatus, Icon, NextStep } from "./ui";

/** Home after sign-in: your money across agreements, what needs you, and the latest agreements. */
export function Dashboard({ me }: { me: string }) {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () =>
      api<{ jobs: Job[] }>("GET", "/v1/jobs").then(
        (r) => {
          setJobs(r.jobs);
          setError(null);
        },
        (e) => setError(describeError(e)),
      );
    void load();
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 15_000);
    return () => clearInterval(t);
  }, []);

  const totals = { escrow: 0n, toYou: 0n, byYou: 0n, refunded: 0n };
  for (const j of jobs ?? []) {
    const m = money(j);
    const asClient = j.state.terms.client.nearAccountId === me;
    const asWorker = j.state.terms.worker.nearAccountId === me;
    if (asClient || asWorker) totals.escrow += m.locked + m.claimable + m.inFlight;
    if (asWorker) totals.toYou += m.paidToWorker;
    if (asClient) {
      totals.byYou += m.paidToWorker;
      totals.refunded += m.refundedToClient;
    }
  }
  const yourMove = (jobs ?? []).filter((j) => nextAction(j, me).who === "you");
  const recent = (jobs ?? []).slice(0, 5);

  return (
    <>
      <header className="page-hero compact">
        <div>
          <span className="kicker">Signed in as {me}</span>
          <h1 className="headline">Overview</h1>
          <p className="lede">Balances are the escrow contract's records for the agreements you are part of.</p>
        </div>
        <div className="page-actions">
          <a className="btn ghost" href="#/bounties">
            Browse bounties
          </a>
          <a className="btn lime" href="#/new">
            <Icon name="plus" /> New agreement
          </a>
        </div>
      </header>

      {error && <ErrorState message={error} />}

      <div className="gauges">
        <Gauge label="In escrow" value={near(totals.escrow)} hint="Locked or payable in your active agreements" tone="locked" />
        <Gauge label="Paid to you" value={near(totals.toYou)} hint="Released to you as the worker" tone="paid" />
        <Gauge label="Released by you" value={near(totals.byYou)} hint="Released from your escrow to workers" tone="released" />
        <Gauge label="Refunded to you" value={near(totals.refunded)} hint="Returned to you as the client" tone="refund" />
      </div>

      <section className="section">
        <div className="section-head">
          <h2>Needs your attention</h2>
          <span className="count">{yourMove.length}</span>
        </div>
        {jobs && yourMove.length === 0 && <p className="muted">Nothing is waiting on you right now.</p>}
        <div className="attention">
          {yourMove.map((j) => (
            <a key={j.id} className="attention-item" href={`#/jobs/${j.id}`}>
              <strong>{title(j)}</strong>
              <NextStep action={nextAction(j, me)} />
            </a>
          ))}
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>Latest agreements</h2>
          <span className="grow" />
          <a className="link sm" href="#/agreements">
            All agreements →
          </a>
        </div>
        {!jobs && !error && <div className="skeleton tall" />}
        {jobs?.length === 0 && (
          <div className="empty-art compact">
            <h3>No agreements yet.</h3>
            <p>Create one as the client, claim a bounty, or ask a client to name your account as the worker.</p>
            <div className="hero-cta center">
              <a className="btn lime" href="#/new">
                Create an agreement
              </a>
              <a className="btn ghost" href="#/bounties">
                Browse bounties
              </a>
            </div>
          </div>
        )}
        <div className="recent">
          {recent.map((j) => (
            <a key={j.id} className="recent-row" href={`#/jobs/${j.id}`}>
              <span className="recent-title">{title(j)}</span>
              <AgreementStatus status={j.state.status} />
              <span className="num right">
                {near(money(j).total)} <span className="t3 xs">NEAR</span>
              </span>
            </a>
          ))}
        </div>
      </section>
    </>
  );
}

function Gauge({ label, value, hint, tone }: { label: string; value: string; hint: string; tone: string }) {
  return (
    <div className={`gauge ${tone}`} title={hint}>
      <span className="label">{label}</span>
      <strong className="num">
        {value} <small>NEAR</small>
      </strong>
      <span className="gauge-hint">{hint}</span>
    </div>
  );
}
