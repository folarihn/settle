import { useEffect, useMemo, useState } from "react";
import { api, yoctoToNear, type Job } from "./api";
import type { Session } from "./App";
import { contentRules, describeRules, fmtDate, money, planKind, relTime } from "./derive";
import { describeError } from "./feedback";
import { wakeSwarm } from "./Swarm";
import { AgreementStatus, Icon } from "./ui";

export type BountyStatus = "open" | "closed" | "all";
export type BountySort = "reward-desc" | "reward-asc" | "closing" | "newest";

export interface BountyQuery {
  text: string;
  status: BountyStatus;
  kind: string;
  sort: BountySort;
}

const isOpen = (b: Job, now: number) => b.state.status === "OPEN" && b.state.terms.fundingDeadline > now;

/** Search, filter and sort over fields the API actually returns. Pure, so it is tested. */
export function filterBounties(all: Job[], q: BountyQuery, now: number = Date.now()): Job[] {
  const text = q.text.trim().toLowerCase();
  const out = all.filter((b) => {
    const t = b.state.terms;
    if (q.status === "open" && !isOpen(b, now)) return false;
    if (q.status === "closed" && isOpen(b, now)) return false;
    if (q.kind !== "all" && !t.milestones.some((m) => planKind(m) === q.kind)) return false;
    if (!text) return true;
    const hay = [t.client.nearAccountId, ...t.milestones.flatMap((m) => [m.title, m.rubric ?? ""])].join(" ").toLowerCase();
    return hay.includes(text);
  });
  const reward = (b: Job) => BigInt(b.state.terms.totalYocto);
  const cmp: Record<BountySort, (a: Job, b: Job) => number> = {
    "reward-desc": (a, b) => (reward(b) > reward(a) ? 1 : reward(b) < reward(a) ? -1 : 0),
    "reward-asc": (a, b) => (reward(a) > reward(b) ? 1 : reward(a) < reward(b) ? -1 : 0),
    closing: (a, b) => a.state.terms.fundingDeadline - b.state.terms.fundingDeadline,
    newest: () => 0, // the API already returns newest first
  };
  return q.sort === "newest" ? out : [...out].sort(cmp[q.sort]);
}

/** The marketplace: funded work anyone signed in can claim, plus the public record of past bounties. */
export function BountyBoard({ session }: { session: Session }) {
  const [all, setAll] = useState<Job[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState<BountyQuery>({ text: "", status: "open", kind: "all", sort: "reward-desc" });

  useEffect(() => {
    const load = () =>
      api<{ bounties: Job[] }>("GET", "/v1/bounties?scope=all").then(
        (r) => {
          setAll(r.bounties);
          setError(null);
        },
        (e) => setError(describeError(e)),
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
  const kinds = useMemo(() => [...new Set((all ?? []).flatMap((b) => b.state.terms.milestones.map(planKind)))].sort(), [all]);
  const shown = all ? filterBounties(all, q, now) : null;
  const openCount = (all ?? []).filter((b) => isOpen(b, now)).length;
  const paid = (all ?? []).reduce((n, b) => n + money(b).paidToWorker, 0n);
  const filtered = !!all && (q.text !== "" || q.kind !== "all" || q.status !== "open");

  return (
    <>
      <header className="page-hero">
        <div>
          <span className="kicker">Marketplace</span>
          <h1 className="headline">
            Find work.
            <br />
            <em>Claim the reward.</em>
          </h1>
          <p className="lede">Explore funded work with clear requirements and verifiable payment conditions. The money is already in escrow before you start.</p>
        </div>
        <div className="hero-stats" aria-label="Board summary">
          <div>
            <span className="label">Open now</span>
            <strong className="num">{all ? openCount : "—"}</strong>
          </div>
          <div>
            <span className="label">On the record</span>
            <strong className="num">{all ? all.length - openCount : "—"}</strong>
          </div>
          <div>
            <span className="label">Paid to workers</span>
            <strong className="num">
              {all ? yoctoToNear(paid.toString()) : "—"} <small>NEAR</small>
            </strong>
          </div>
          <a className="btn ghost try-link" href="#/try">
            Try it in 60 seconds
          </a>
          <a className="btn lime" href="#/new?bounty">
            {session.signedIn ? (
              <>
                <Icon name="plus" /> Post a bounty
              </>
            ) : (
              "Sign in to post a bounty"
            )}
          </a>
        </div>
      </header>

      <div className="toolbar" role="search">
        <label className="search">
          <span className="sr">Search bounties</span>
          <input value={q.text} onChange={(e) => setQ({ ...q, text: e.target.value })} placeholder="Search titles, requirements, client…" />
        </label>
        <Select label="Status" value={q.status} onChange={(v) => setQ({ ...q, status: v as BountyStatus })} options={[["open", "Open"], ["closed", "Claimed or closed"], ["all", "All"]]} />
        <Select label="Check" value={q.kind} onChange={(v) => setQ({ ...q, kind: v })} options={[["all", "Any verification"], ...kinds.map((k) => [k, k] as [string, string])]} />
        <Select
          label="Sort"
          value={q.sort}
          onChange={(v) => setQ({ ...q, sort: v as BountySort })}
          options={[["reward-desc", "Reward: high to low"], ["reward-asc", "Reward: low to high"], ["closing", "Closing soonest"], ["newest", "Newest"]]}
        />
      </div>

      {error && <ErrorState message={error} />}
      {!all && !error && <SkeletonGrid />}
      {shown && shown.length === 0 && all!.length === 0 && <EmptyBoard signedIn={session.signedIn} />}
      {shown && shown.length === 0 && all!.length > 0 && !filtered && (
        <div className="empty-art compact">
          <h3>No open bounties right now.</h3>
          <p>Every bounty posted so far has been claimed or closed. {all!.length} are on the public record, with what was delivered and what the contract paid.</p>
          <div className="hero-cta center">
            <button className="btn" onClick={() => setQ({ ...q, status: "closed" })}>
              View the record
            </button>
            <a className="btn lime" href="#/new?bounty">
              {session.signedIn ? "Post a bounty" : "Sign in to post a bounty"}
            </a>
          </div>
        </div>
      )}
      {shown && shown.length === 0 && all!.length > 0 && filtered && <NoMatches onReset={() => setQ({ text: "", status: "all", kind: "all", sort: "reward-desc" })} />}
      {shown && shown.length > 0 && (
        <div className="card-grid">
          {shown.map((b) => (
            <BountyCard key={b.id} job={b} me={session.accountId} />
          ))}
        </div>
      )}
    </>
  );
}

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <label className="select">
      <span className="label">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

/** One bounty: only fields the API returns. The claim itself happens on the bounty's page, signed by the wallet. */
export function BountyCard({ job: b, me }: { job: Job; me: string }) {
  const t = b.state.terms;
  const open = isOpen(b, Date.now());
  const auto = t.milestones.map(contentRules).find((r) => r !== null);
  const brief = t.milestones.find((m) => m.rubric)?.rubric ?? (auto ? `Checked automatically: ${describeRules(auto).join(" ")}` : undefined);
  const worker = t.worker.nearAccountId;
  const mine = !!me && t.client.nearAccountId === me;
  return (
    <a className={`bounty-card ${open ? "is-open" : ""}`} href={`#/jobs/${b.id}`}>
      <div className="bc-top">
        <AgreementStatus status={b.state.status} />
        <span className="bc-reward">
          <strong>{yoctoToNear(t.totalYocto)}</strong> NEAR
        </span>
      </div>
      <h3>{t.milestones.map((m) => m.title).join(" · ")}</h3>
      {brief && <p className="bc-brief">{brief}</p>}
      <div className="bc-tags">
        {[...new Set(t.milestones.map(planKind))].map((k) => (
          <span key={k} className="tag">
            {k}
          </span>
        ))}
        {t.milestones.length > 1 && <span className="tag">{t.milestones.length} milestones</span>}
      </div>
      <dl className="bc-meta">
        <div>
          <dt>Client</dt>
          <dd className="mono">{short(t.client.nearAccountId)}</dd>
        </div>
        {open ? (
          <div>
            <dt>Claims close</dt>
            <dd title={fmtDate(t.fundingDeadline)}>{relTime(t.fundingDeadline)}</dd>
          </div>
        ) : worker !== "open-bounty" ? (
          <div>
            <dt>Worker</dt>
            <dd className="mono">{short(worker)}</dd>
          </div>
        ) : null}
      </dl>
      <span className="bc-go">{open ? (mine ? "Your bounty · manage →" : "Review and claim →") : "View the record →"}</span>
    </a>
  );
}

export const short = (a: string) => (a.length > 24 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a);

function EmptyBoard({ signedIn }: { signedIn: boolean }) {
  return (
    <div className="empty-art">
      <svg viewBox="0 0 220 120" aria-hidden>
        <rect x="10" y="10" width="200" height="100" className="ea-board" />
        {[40, 86, 132, 178].map((x, i) => (
          <g key={x} className="ea-pin" style={{ animationDelay: `${i * 0.4}s` }}>
            <rect x={x - 16} y="34" width="32" height="40" className="ea-slot" />
            <rect x={x - 3} y="28" width="6" height="6" className="ea-tack" />
          </g>
        ))}
        <rect x="10" y="90" width="200" height="1" className="ea-line" />
      </svg>
      <h3>Nothing on the board yet.</h3>
      <p>Be the first to fund a bounty. The money goes into escrow when you post it, and the first person or agent to claim it gets the work.</p>
      <a className="btn lime" href="#/new?bounty">
        {signedIn ? "Create a bounty" : "Sign in to create a bounty"}
      </a>
    </div>
  );
}

function NoMatches({ onReset }: { onReset: () => void }) {
  return (
    <div className="empty-art compact">
      <h3>No bounties match these filters.</h3>
      <button className="btn ghost" onClick={onReset}>
        Clear filters
      </button>
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="error-state" role="alert">
      <strong>Couldn't load this.</strong>
      <span>{message}</span>
      <button className="btn ghost" onClick={onRetry ?? (() => window.location.reload())}>
        Try again
      </button>
    </div>
  );
}

export function SkeletonGrid({ n = 3 }: { n?: number }) {
  return (
    <div className="card-grid" aria-busy="true" aria-label="Loading">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="skeleton card" style={{ animationDelay: `${i * 120}ms` }} />
      ))}
    </div>
  );
}
