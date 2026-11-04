import { useEffect, useState } from "react";
import { api, type Job } from "./api";
import { counterparty, isUnclaimedBounty, money, near, nextAction, planKind, title } from "./derive";
import { AgreementStatus, Empty, Icon, Meter, Metric } from "./ui";

type Filter = "all" | "active" | "completed";

/** Home after sign-in: money across your agreements, what needs you, and every agreement. */
export function Dashboard({ me }: { me: string }) {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

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
  const isActive = (j: Job) => ["DRAFT", "OPEN", "FUNDED"].includes(j.state.status);
  const groups: Record<Filter, Job[]> = {
    all: jobs ?? [],
    active: (jobs ?? []).filter(isActive),
    completed: (jobs ?? []).filter((j) => !isActive(j)),
  };
  const shown = groups[filter];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Overview</h1>
          <p>Balances are the escrow contract's records for the agreements you are part of.</p>
        </div>
        <span className="grow" />
        <a className="btn secondary" href="#/bounties">
          Browse bounties
        </a>
        <a className="btn" href="#/new">
          <Icon name="plus" />
          New agreement
        </a>
      </div>

      {error && <p className="banner bad">{error}</p>}

      <div className="metrics">
        <Metric label="In escrow" value={near(totals.escrow)} color="var(--m-locked)" hint="Locked or payable in your active agreements" />
        <Metric label="Paid to you" value={near(totals.toYou)} color="var(--m-paid)" hint="Released to you as the worker" />
        <Metric label="Released by you" value={near(totals.byYou)} color="var(--m-payable)" hint="Released from your escrow to workers" />
        <Metric label="Refunded" value={near(totals.refunded)} color="var(--m-refund)" hint="Returned to you as the client" />
      </div>

      {yourMove.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2>Needs your attention</h2>
            <span className="count">{yourMove.length}</span>
          </div>
          {yourMove.map((j) => (
            <a key={j.id} className="trow" style={{ gridTemplateColumns: "minmax(0,1fr) auto" }} href={`#/jobs/${j.id}`}>
              <div>
                <div className="primary">{title(j)}</div>
                <div className="secondary">{nextAction(j, me).text}</div>
              </div>
              <span className="t3 sm">Open →</span>
            </a>
          ))}
        </section>
      )}

      <section className="section">
        <div className="section-head">
          <h2>Agreements</h2>
          <span className="grow" />
          <div className="tabs" role="tablist" aria-label="Filter agreements">
            {(["all", "active", "completed"] as Filter[]).map((f) => (
              <button key={f} role="tab" aria-selected={filter === f} className={`tab ${filter === f ? "on" : ""}`} onClick={() => setFilter(f)}>
                {f === "all" ? "All" : f === "active" ? "Active" : "Closed"}
                <span className="n">{groups[f].length}</span>
              </button>
            ))}
          </div>
        </div>

        {!jobs && !error && <p className="t3">Loading…</p>}
        {jobs?.length === 0 && (
          <Empty title="No agreements yet">
            <p>
              <a className="link" href="#/new">
                Create one
              </a>{" "}
              as the client,{" "}
              <a className="link" href="#/bounties">
                claim a bounty
              </a>
              , or ask a client to name your account as the worker.
            </p>
          </Empty>
        )}
        {jobs && jobs.length > 0 && (
          <div className="table">
            <div className="thead label">
              <span>Agreement</span>
              <span>Counterparty</span>
              <span>Status</span>
              <span>Paid</span>
              <span className="right">Amount</span>
            </div>
            {shown.map((j) => {
              const paid = j.state.milestones.filter((x) => x.status === "PAID").length;
              const role = j.roles.filter((r) => r !== "verifier")[0] ?? "viewer";
              return (
                <a key={j.id} className="trow" href={`#/jobs/${j.id}`}>
                  <div style={{ minWidth: 0 }}>
                    <div className="primary">{title(j)}</div>
                    <div className="secondary">
                      {[...new Set(j.state.terms.milestones.map(planKind))].join(" + ")}
                      {j.state.terms.milestones.length > 1 ? ` · ${j.state.terms.milestones.length} milestones` : ""}
                    </div>
                    <div className="show-sm" style={{ marginTop: 6 }}>
                      <AgreementStatus status={j.state.status} />
                    </div>
                  </div>
                  <div className="hide-sm" style={{ minWidth: 0 }}>
                    <div className="mono" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", wordBreak: "normal" }}>
                      {isUnclaimedBounty(j) ? "—" : counterparty(j, me)}
                    </div>
                    <div className="secondary">you are the {role}</div>
                  </div>
                  <div className="hide-sm">
                    <AgreementStatus status={j.state.status} />
                  </div>
                  <div className="hide-sm">
                    <Meter done={paid} total={j.state.milestones.length} />
                  </div>
                  <div className="right">
                    <span className="num">{near(money(j).total)}</span> <span className="t3 xs">NEAR</span>
                  </div>
                </a>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}
