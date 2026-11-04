import { useEffect, useState } from "react";
import { api, type Job } from "./api";
import { counterparty, isUnclaimedBounty, money, near, nextAction, planKind, title } from "./derive";
import { AgreementBadge, Badge, Empty, Stat } from "./ui";

/** Home after sign-in: money across your agreements, what needs you, and every agreement. */
export function Dashboard({ me }: { me: string }) {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () =>
      api<{ jobs: Job[] }>("GET", "/v1/jobs").then(
        (r) => setJobs(r.jobs),
        (e: Error) => setError(e.message),
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

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Dashboard</h1>
          <p className="muted">Amounts are the escrow contract's records for agreements you are part of.</p>
        </div>
        <span className="spacer" />
        <a className="button secondary" href="#/bounties">
          Find bounties
        </a>
        <a className="button" href="#/new">
          New agreement
        </a>
      </div>

      {error && <p className="error">{error}</p>}

      <div className="stats">
        <Stat label="In escrow now" value={near(totals.escrow)} color="var(--m-locked)" hint="Locked or payable in your active agreements" />
        <Stat label="Paid to you" value={near(totals.toYou)} color="var(--m-paid)" hint="Transfers to you as the worker" />
        <Stat label="Paid from your escrow" value={near(totals.byYou)} color="var(--m-claimable)" hint="Released by the contract to your workers" />
        <Stat label="Refunded to you" value={near(totals.refunded)} color="var(--m-refund)" hint="Returned to you as the client" />
      </div>

      {yourMove.length > 0 && (
        <>
          <h2 className="section-title">Needs your action · {yourMove.length}</h2>
          <section className="card">
            <div className="list">
              {yourMove.map((j) => (
                <a key={j.id} className="list-item" href={`#/jobs/${j.id}`}>
                  <div>
                    <div className="li-title">{title(j)}</div>
                    <div className="li-meta">{nextAction(j, me).text}</div>
                  </div>
                  <div className="li-side">
                    <span className="button">Open</span>
                  </div>
                </a>
              ))}
            </div>
          </section>
        </>
      )}

      <h2 className="section-title">All agreements{jobs ? ` · ${jobs.length}` : ""}</h2>
      <section className="card">
        {!jobs && !error && <p className="muted">Loading…</p>}
        {jobs?.length === 0 && (
          <Empty title="No agreements yet">
            <p>
              <a href="#/new">Create one</a> as the client, <a href="#/bounties">claim a bounty</a>, or ask a client to name your account as the worker.
            </p>
          </Empty>
        )}
        <div className="list">
          {jobs?.map((j) => {
            const m = money(j);
            const paid = j.state.milestones.filter((x) => x.status === "PAID").length;
            const role = j.roles.filter((r) => r !== "verifier").join(", ") || "viewer";
            return (
              <a key={j.id} className="list-item" href={`#/jobs/${j.id}`}>
                <div>
                  <div className="li-title">{title(j)}</div>
                  <div className="li-meta">
                    <AgreementBadge status={j.state.status} />
                    <Badge tone="outline">you: {role}</Badge>
                    <span>{isUnclaimedBounty(j) ? "no worker yet" : `with ${counterparty(j, me)}`}</span>
                    <span>{[...new Set(j.state.terms.milestones.map(planKind))].join(" + ")}</span>
                  </div>
                </div>
                <div className="li-side">
                  <span className="amount">{near(m.total)} NEAR</span>
                  <span className="li-meta">
                    <span className="progress" aria-label={`${paid} of ${j.state.milestones.length} milestones paid`}>
                      <span style={{ width: `${(paid / j.state.milestones.length) * 100}%` }} />
                    </span>
                    {paid}/{j.state.milestones.length} paid
                  </span>
                </div>
              </a>
            );
          })}
        </div>
      </section>
    </div>
  );
}
