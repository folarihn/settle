import { useEffect, useState } from "react";
import { api, type Job } from "./api";
import { ErrorState, short } from "./BountyBoard";
import { isUnclaimedBounty, money, near, nextAction, planKind, title } from "./derive";
import { describeError } from "./feedback";
import { AgreementStatus, Icon, Meter, Status } from "./ui";

type Filter = "all" | "action" | "active" | "closed";

const isActive = (j: Job) => ["DRAFT", "OPEN", "FUNDED"].includes(j.state.status);

/** The latest verification state across an agreement's milestones, as recorded. */
export function verificationState(j: Job): { label: string; tone: "ok" | "bad" | "info" | "neutral" } {
  const auto = j.state.terms.milestones.some((m) => m.type === "AUTOMATED");
  const outcomes = j.state.milestones.map((m) => m.lastVerification?.outcome).filter(Boolean) as string[];
  if (j.state.milestones.some((m) => m.status === "SUBMITTED")) return { label: auto ? "Checking" : "Awaiting review", tone: "info" };
  if (outcomes.includes("FAIL") && j.state.milestones.some((m) => m.lastVerification?.outcome === "FAIL" && m.status === "PENDING")) return { label: "Last check failed", tone: "bad" };
  if (outcomes.length && outcomes.every((o) => o === "PASS")) return { label: "Passed", tone: "ok" };
  if (!auto) return { label: "Human review", tone: "neutral" };
  return { label: "Not run yet", tone: "neutral" };
}

/** Every agreement you are part of, with what each needs next. */
export function Agreements({ me }: { me: string }) {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

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

  const groups: Record<Filter, Job[]> = {
    all: jobs ?? [],
    action: (jobs ?? []).filter((j) => nextAction(j, me).who === "you"),
    active: (jobs ?? []).filter(isActive),
    closed: (jobs ?? []).filter((j) => !isActive(j)),
  };
  const shown = groups[filter];

  return (
    <>
      <header className="page-hero compact">
        <div>
          <span className="kicker">Control panel</span>
          <h1 className="headline">Agreements</h1>
          <p className="lede">Every agreement you are a party to. Amounts and states are the escrow contract's records.</p>
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

      <div className="tabs" role="tablist" aria-label="Filter agreements">
        {(
          [
            ["all", "All"],
            ["action", "Needs you"],
            ["active", "Active"],
            ["closed", "Closed"],
          ] as [Filter, string][]
        ).map(([f, l]) => (
          <button key={f} role="tab" aria-selected={filter === f} className={`tab ${filter === f ? "on" : ""}`} onClick={() => setFilter(f)}>
            {l}
            <span className="n">{groups[f].length}</span>
          </button>
        ))}
      </div>

      {error && <ErrorState message={error} />}
      {!jobs && !error && <div className="skeleton tall" />}
      {jobs && shown.length === 0 && (
        <div className="empty-art compact">
          <h3>{jobs.length === 0 ? "No agreements yet." : "Nothing in this view."}</h3>
          {jobs.length === 0 && (
            <>
              <p>Create one as the client, claim a bounty, or ask a client to name your account as the worker.</p>
              <div className="hero-cta center">
                <a className="btn lime" href="#/new">
                  Create an agreement
                </a>
                <a className="btn ghost" href="#/bounties">
                  Browse bounties
                </a>
              </div>
            </>
          )}
        </div>
      )}
      {shown.length > 0 && (
        <div className="ledger-table" role="table" aria-label="Agreements">
          <div className="lt-head" role="row">
            <span role="columnheader">Agreement</span>
            <span role="columnheader">Client → Worker</span>
            <span role="columnheader">Status</span>
            <span role="columnheader">Verification</span>
            <span role="columnheader">Milestones</span>
            <span role="columnheader" className="right">
              Escrow
            </span>
          </div>
          {shown.map((j) => {
            const t = j.state.terms;
            const paid = j.state.milestones.filter((x) => x.status === "PAID").length;
            const next = nextAction(j, me);
            const v = verificationState(j);
            return (
              <a key={j.id} className={`lt-row ${next.who === "you" ? "yours" : ""}`} href={`#/jobs/${j.id}`} role="row">
                <div className="lt-main" role="cell">
                  <strong>{title(j)}</strong>
                  <span className={`lt-next ${next.who}`}>{next.who === "you" ? "Your move: " : ""}{next.text}</span>
                  <span className="t3 xs">{[...new Set(t.milestones.map(planKind))].join(" + ")}</span>
                </div>
                <div className="lt-parties mono" role="cell">
                  <span title={t.client.nearAccountId}>{t.client.nearAccountId === me ? "you" : short(t.client.nearAccountId)}</span>
                  <span className="t3">→</span>
                  <span title={t.worker.nearAccountId}>{isUnclaimedBounty(j) ? "unclaimed" : t.worker.nearAccountId === me ? "you" : short(t.worker.nearAccountId)}</span>
                </div>
                <div role="cell">
                  <AgreementStatus status={j.state.status} />
                </div>
                <div role="cell">
                  <Status tone={v.tone}>{v.label}</Status>
                </div>
                <div role="cell">
                  <Meter done={paid} total={j.state.milestones.length} />
                  <span className="t3 xs"> {paid}/{j.state.milestones.length} paid</span>
                </div>
                <div className="right" role="cell">
                  <span className="num">{near(money(j).total)}</span> <span className="t3 xs">NEAR</span>
                </div>
              </a>
            );
          })}
        </div>
      )}
    </>
  );
}
