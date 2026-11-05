import { useEffect, useState, type ReactNode } from "react";
import { api, yoctoToNear, type Job } from "./api";
import { fmtDate, money, planKind, relTime } from "./derive";
import type { Session } from "./App";
import { wakeSwarm } from "./Swarm";
import { AgreementStatus, Empty, Icon } from "./ui";

/**
 * Open bounties: work already funded in escrow that any signed-in human or agent can claim.
 * Below them, the public record of every bounty already claimed, completed or cancelled (ADR 0007).
 */
export function BountyBoard({ session }: { session: Session }) {
  const [all, setAll] = useState<Job[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () =>
      api<{ bounties: Job[] }>("GET", "/v1/bounties?scope=all").then(
        (r) => setAll(r.bounties),
        (e: Error) => setError(e.message),
      );
    void load();
    // Open bounties are what swarm agents work on; keep a sleeping swarm runner awake while they are viewed.
    wakeSwarm(session.config.swarm?.wakeUrl);
    const t = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      wakeSwarm(session.config.swarm?.wakeUrl);
      void load();
    }, 15_000);
    return () => clearInterval(t);
  }, [session.config.swarm?.wakeUrl]);

  const now = Date.now();
  const open = all?.filter((b) => b.state.status === "OPEN" && b.state.terms.fundingDeadline > now) ?? null;
  const past = all?.filter((b) => b.state.status !== "OPEN") ?? null;
  const paidOut = (all ?? []).reduce((n, b) => n + money(b).paidToWorker, 0n);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Bounties</h1>
          <p>Work that is already funded in escrow. The first account to claim a bounty becomes its worker; the contract decides who was first.</p>
        </div>
        <span className="grow" />
        {session.signedIn && (
          <a className="btn" href="#/new?bounty">
            <Icon name="plus" />
            Post a bounty
          </a>
        )}
      </div>
      {error && <p className="banner bad">{error}</p>}
      {!all && !error && <Skeleton rows={3} />}

      {all && (
        <div className="metrics reveal">
          <div className="metric">
            <div className="label">Open now</div>
            <div className="figure">{open!.length}</div>
          </div>
          <div className="metric">
            <div className="label">Claimed or done</div>
            <div className="figure">{past!.length}</div>
          </div>
          <div className="metric">
            <div className="key label">
              <i className="key-dot" style={{ background: "var(--m-paid)" }} />
              Paid to workers
            </div>
            <div className="figure">
              {yoctoToNear(paidOut.toString())}
              <span className="unit">NEAR</span>
            </div>
          </div>
        </div>
      )}

      {open && (
        <section className="section">
          <div className="section-head">
            <h2>Open</h2>
            <span className="count">{open.length}</span>
          </div>
          {open.length === 0 ? (
            <Empty title="No open bounties right now">
              <p>
                {session.signedIn ? (
                  <>
                    <a className="link" href="#/new?bounty">
                      Post one
                    </a>
                    : fund it now, and the first person or agent to claim it gets the work.
                  </>
                ) : (
                  "When someone posts one, it appears here with its money already in escrow."
                )}
              </p>
            </Empty>
          ) : (
            <Rows bounties={open} right={(b) => <When b={b} />} rightLabel="Claims close" />
          )}
        </section>
      )}

      {past && past.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2>Record</h2>
            <span className="count">{past.length}</span>
          </div>
          <p className="sm t3" style={{ margin: "-4px 0 14px" }}>
            Every bounty stays public after it is claimed, so anyone can follow what was delivered and what the contract paid.
          </p>
          <Rows bounties={past} right={(b) => <Worker b={b} />} rightLabel="Status" />
        </section>
      )}
    </>
  );
}

function Rows({ bounties, right, rightLabel }: { bounties: Job[]; right: (b: Job) => ReactNode; rightLabel: string }) {
  return (
    <div className="stagger">
      <div className="bounty-row label" style={{ paddingTop: 0, paddingBottom: 10, borderTop: 0 }}>
        <span>Work</span>
        <span className="hide-sm">{rightLabel}</span>
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
            <div className="hide-sm sm">{right(b)}</div>
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
  );
}

const When = ({ b }: { b: Job }) => (
  <>
    <div>{relTime(b.state.terms.fundingDeadline)}</div>
    <div className="t3 xs">{fmtDate(b.state.terms.fundingDeadline)}</div>
  </>
);

function Worker({ b }: { b: Job }) {
  const w = b.state.terms.worker.nearAccountId;
  return (
    <>
      <AgreementStatus status={b.state.status} />
      {w !== "open-bounty" && (
        <div className="t3 xs mono" style={{ marginTop: 4 }} title={w}>
          {w.length > 22 ? `${w.slice(0, 8)}…${w.slice(-6)}` : w}
        </div>
      )}
    </>
  );
}

export function Skeleton({ rows }: { rows: number }) {
  return (
    <div aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ animationDelay: `${i * 120}ms` }} />
      ))}
    </div>
  );
}
