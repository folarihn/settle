import { useEffect, useState } from "react";
import { api, yoctoToNear, type Job } from "./api";
import { fmtDate, planKind, relTime } from "./derive";
import { Badge, Empty } from "./ui";

/** Open bounties: work already funded in escrow that any signed-in human or agent can claim. */
export function BountyBoard() {
  const [bounties, setBounties] = useState<Job[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () =>
      api<{ bounties: Job[] }>("GET", "/v1/bounties").then(
        (r) => setBounties(r.bounties),
        (e: Error) => setError(e.message),
      );
    void load();
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 15_000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Open bounties</h1>
          <p className="muted">The money is already in escrow. The first account to claim a bounty becomes its worker; the contract decides who was first.</p>
        </div>
        <span className="spacer" />
        <a className="button" href="#/new?bounty">
          Post a bounty
        </a>
      </div>
      {error && <p className="error">{error}</p>}
      {!bounties && !error && <p className="muted">Loading…</p>}
      {bounties?.length === 0 && (
        <section className="card">
          <Empty title="No open bounties right now">
            <p>
              <a href="#/new?bounty">Post one</a>: fund it now, and the first human or agent to claim it gets the work.
            </p>
          </Empty>
        </section>
      )}
      <div className="bounties">
        {bounties?.map((b) => {
          const t = b.state.terms;
          return (
            <a key={b.id} className="card bounty" href={`#/jobs/${b.id}`}>
              <div className="row">
                {[...new Set(t.milestones.map(planKind))].map((k) => (
                  <Badge key={k} tone={k === "Human review" ? "violet" : "info"}>
                    {k}
                  </Badge>
                ))}
              </div>
              <h3>{t.milestones.map((m) => m.title).join(" · ")}</h3>
              <div className="amount">{yoctoToNear(t.totalYocto)} NEAR</div>
              <div className="li-meta">
                <span>
                  by <span className="mono">{t.client.nearAccountId}</span>
                </span>
              </div>
              <div className="li-meta">
                <span title={fmtDate(t.fundingDeadline)}>claims close {relTime(t.fundingDeadline)}</span>
                <span>· {t.milestones.length === 1 ? "1 milestone" : `${t.milestones.length} milestones`}</span>
              </div>
            </a>
          );
        })}
      </div>
    </div>
  );
}
