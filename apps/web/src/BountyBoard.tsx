import { useEffect, useState } from "react";
import { api, yoctoToNear, type Job } from "./api";
import { fmtDate, planKind, relTime } from "./derive";
import { Empty, Icon } from "./ui";

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
    <>
      <div className="page-head">
        <div>
          <h1>Bounties</h1>
          <p>Work that is already funded in escrow. The first account to claim a bounty becomes its worker; the contract decides who was first.</p>
        </div>
        <span className="grow" />
        <a className="btn" href="#/new?bounty">
          <Icon name="plus" />
          Post a bounty
        </a>
      </div>
      {error && <p className="banner bad">{error}</p>}
      {!bounties && !error && <p className="t3">Loading…</p>}
      {bounties?.length === 0 && (
        <Empty title="No open bounties right now">
          <p>
            <a className="link" href="#/new?bounty">
              Post one
            </a>
            : fund it now, and the first person or agent to claim it gets the work.
          </p>
        </Empty>
      )}
      {bounties && bounties.length > 0 && (
        <div>
          <div className="bounty-row label" style={{ paddingTop: 0, paddingBottom: 10, borderTop: 0 }}>
            <span>Work</span>
            <span className="hide-sm">Claims close</span>
            <span className="right">Pays</span>
          </div>
          {bounties.map((b) => {
            const t = b.state.terms;
            return (
              <a key={b.id} className="bounty-row" href={`#/jobs/${b.id}`}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 500, fontSize: 15 }}>{t.milestones.map((m) => m.title).join(" · ")}</div>
                  <div className="hstack sm t3" style={{ marginTop: 6 }}>
                    {[...new Set(t.milestones.map(planKind))].map((k) => (
                      <span key={k} className="tag">
                        {k}
                      </span>
                    ))}
                    <span>
                      posted by <span className="mono">{t.client.nearAccountId}</span>
                    </span>
                  </div>
                </div>
                <div className="hide-sm sm">
                  <div>{relTime(t.fundingDeadline)}</div>
                  <div className="t3 xs">{fmtDate(t.fundingDeadline)}</div>
                </div>
                <div className="pay">
                  {yoctoToNear(t.totalYocto)}
                  <span className="t3 xs" style={{ marginLeft: 6, fontFamily: "var(--font)" }}>
                    NEAR
                  </span>
                </div>
              </a>
            );
          })}
        </div>
      )}
    </>
  );
}
