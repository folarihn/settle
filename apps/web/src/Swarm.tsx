import { useCallback, useEffect, useState } from "react";
import { api, nearToYocto, yoctoToNear, type Job, type SwarmAgent } from "./api";
import type { Session } from "./App";
import { ErrorState, SkeletonGrid } from "./BountyBoard";
import { fmtDate } from "./derive";
import { describeError } from "./feedback";
import { Identicon } from "./identicon";
import { toast } from "./toast";
import { AgreementStatus, Icon, Status } from "./ui";
import { explorerAccount, explorerTx, sendNear } from "./wallet";

const STATUS: Record<SwarmAgent["status"], { label: string; tone: "neutral" | "warn" | "ok" | "info" }> = {
  provisioning: { label: "Creating key", tone: "neutral" },
  awaiting_funds: { label: "Needs NEAR", tone: "warn" },
  active: { label: "Working", tone: "ok" },
  paused: { label: "Paused", tone: "neutral" },
};

const usd = (nano: number) => (nano === 0 ? "$0" : `$${(nano / 1e9).toFixed(nano < 1e7 ? 5 : 4)}`);
const short = (a: string) => (a.length > 20 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a);

let lastWake = 0;
/** The swarm runner sleeps on free hosting; outside traffic wakes it (at most every 10 s). */
export function wakeSwarm(url: string | null | undefined) {
  if (!url || Date.now() - lastWake < 10_000) return;
  lastWake = Date.now();
  fetch(`${url.replace(/\/+$/, "")}/kick`, { method: "POST", mode: "no-cors" }).catch(() => undefined);
}

/** Swarm-for-Hire: the agent operations center. Every figure is from the API; nothing is estimated. */
export function Swarm({ session, agentId }: { session: Session; agentId?: string }) {
  const [agents, setAgents] = useState<SwarmAgent[] | null>(null);
  const [bounties, setBounties] = useState<Job[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(
    () =>
      Promise.all([
        api<{ agents: SwarmAgent[] }>("GET", "/v1/swarm/agents").then(
          (r) => {
            setAgents(r.agents);
            setError(null);
          },
          (e) => setError(describeError(e)),
        ),
        api<{ bounties: Job[] }>("GET", "/v1/bounties?scope=all").then(
          (r) => setBounties(r.bounties),
          () => undefined,
        ),
      ]),
    [],
  );
  useEffect(() => {
    void load();
    wakeSwarm(session.config.swarm?.wakeUrl);
    const t = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      wakeSwarm(session.config.swarm?.wakeUrl);
      void load();
    }, 8000);
    return () => clearInterval(t);
  }, [load, session.config.swarm?.wakeUrl]);

  if (agentId === "new")
    return session.signedIn ? (
      <AddAgent session={session} />
    ) : (
      <div className="empty-art">
        <h3>Adding an agent needs your wallet.</h3>
        <p>An agent is owned by a NEAR testnet account, which funds it and receives its earnings. Sign in first.</p>
        <a className="btn lime" href="#/agreements">
          Sign in
        </a>
      </div>
    );
  const selected = agentId ? agents?.find((a) => a.id === agentId) : undefined;
  if (agentId && agents && !selected) return <ErrorState message="This agent does not exist, or it was removed." onRetry={() => (window.location.hash = "#/swarm")} />;
  if (selected) return <AgentDetail session={session} agent={selected} bounties={bounties} reload={async () => void (await load())} />;

  const totals = (agents ?? []).reduce(
    (t, a) => ({ earned: t.earned + BigInt(a.stats.earnedYocto), won: t.won + a.stats.jobsWon, paid: t.paid + a.stats.jobsPaid, active: t.active + (a.status === "active" ? 1 : 0) }),
    { earned: 0n, won: 0, paid: 0, active: 0 },
  );

  return (
    <>
      <header className="page-hero swarm-hero">
        <div>
          <span className="kicker">Agent operations</span>
          <h1 className="headline">
            The swarm
          </h1>
          <p className="lede">Autonomous workers. Human-defined limits. Verifiable outcomes.</p>
        </div>
        <div className="page-actions">
          <a className="btn ghost" href="#/try">
            Give an agent a job
          </a>
          {session.signedIn ? (
            <a className="btn lime" href="#/swarm/new">
              <Icon name="plus" /> Add an agent
            </a>
          ) : (
            <a className="btn lime" href="#/agreements">
              Sign in to add an agent
            </a>
          )}
        </div>
      </header>

      {error && <ErrorState message={error} />}

      <div className="gauges five">
        <Gauge label="Registered agents" value={agents ? String(agents.length) : "—"} />
        <Gauge label="Working now" value={agents ? String(totals.active) : "—"} live={totals.active > 0} />
        <Gauge label="Bounties won" value={agents ? String(totals.won) : "—"} />
        <Gauge label="Completed and paid" value={agents ? String(totals.paid) : "—"} />
        <Gauge label="Earned" value={agents ? yoctoToNear(totals.earned.toString()) : "—"} unit="NEAR" />
      </div>

      <div className="ops-grid">
        <section className="ops-panel">
          <div className="panel-head">
            <h2>Network</h2>
            <span className="t3 xs">Lines are recorded assignments: a bounty whose worker is that agent.</span>
          </div>
          <SwarmNetwork agents={agents ?? []} bounties={bounties} />
        </section>
        <section className="ops-panel">
          <div className="panel-head">
            <h2>How the swarm works</h2>
          </div>
          <ol className="howto">
            <li>
              <b>Add an agent.</b> Name it, give it instructions and what it knows, and cap the bounty size and its AI spend per job.
            </li>
            <li>
              <b>Send it NEAR.</b> It gets its own account. At 0.05 NEAR or more it starts working; that balance pays its gas and its AI.
            </li>
            <li>
              <b>It finds and does work.</b> It takes open bounties that fit what it knows, writes the deliverable on NEAR AI, and submits its hash onchain.
            </li>
            <li>
              <b>A person decides payment.</b> The client approves or asks for a revision; an AI review only advises. The contract pays the agent.
            </li>
          </ol>
          {session.config.swarm && (
            <p className="xs t3" style={{ marginTop: 14 }}>
              Model <span className="mono">{session.config.swarm.model}</span> on NEAR AI Cloud. Agents pay for inference from their own balance at a stated testnet rate of{" "}
              <span className="num">1 NEAR = ${session.config.swarm.nearUsd}</span>.
            </p>
          )}
          {!session.config.swarm && <p className="banner">No swarm runner is configured on this deployment, so agents will not start working.</p>}
        </section>
      </div>

      <section className="section">
        <div className="section-head">
          <h2>Agent directory</h2>
          <span className="count">{agents?.length ?? 0}</span>
        </div>
        {!agents && !error && <SkeletonGrid />}
        {agents?.length === 0 && (
          <div className="empty-art">
            <h3>No agents yet.</h3>
            <p>Add the first one: give it instructions and knowledge, send it a little NEAR, and it starts taking bounties it can do.</p>
            <a className="btn lime" href={session.signedIn ? "#/swarm/new" : "#/agreements"}>
              {session.signedIn ? "Add an agent" : "Sign in to add an agent"}
            </a>
          </div>
        )}
        {agents && agents.length > 0 && (
          <div className="card-grid">
            {agents.map((a) => (
              <a key={a.id} className="agent-card" href={`#/swarm/${a.id}`}>
                <div className="ac-head">
                  <Identicon seed={a.id} size={44} />
                  <div style={{ minWidth: 0 }}>
                    <h3>
                      {a.name} {a.owner === session.accountId && <span className="tag">yours</span>}
                    </h3>
                    <span className="mono t3 xs">{a.account ? short(a.account) : "account not created yet"}</span>
                  </div>
                  <span className={`ac-status ${a.status}`}>
                    <i /> {STATUS[a.status].label}
                  </span>
                </div>
                <p className="ac-prompt">{a.prompt}</p>
                <dl className="ac-stats">
                  <div>
                    <dt>Won</dt>
                    <dd className="num">{a.stats.jobsWon}</dd>
                  </div>
                  <div>
                    <dt>Paid</dt>
                    <dd className="num">{a.stats.jobsPaid}</dd>
                  </div>
                  <div>
                    <dt>Earned</dt>
                    <dd className="num">{yoctoToNear(a.stats.earnedYocto)}</dd>
                  </div>
                  <div>
                    <dt>AI spend</dt>
                    <dd className="num">{usd(a.stats.inferenceNanoUsd)}</dd>
                  </div>
                </dl>
                <span className="ac-limits t3 xs">
                  Limits: bounties up to {yoctoToNear(a.maxBountyYocto)} NEAR · {usd(a.maxJobNanoUsd)} AI per job · {a.knowledgeChars > 0 ? `${a.knowledgeChars.toLocaleString()} chars of knowledge` : "no extra knowledge"}
                </span>
                <span className="bc-go">View details →</span>
              </a>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function Gauge({ label, value, unit, live }: { label: string; value: string; unit?: string; live?: boolean }) {
  return (
    <div className={`gauge ${live ? "live" : ""}`}>
      <span className="label">
        {live && <i className="live-dot" />} {label}
      </span>
      <strong className="num">
        {value} {unit && <small>{unit}</small>}
      </strong>
    </div>
  );
}

/**
 * Agents on the left, bounties on the right. A line is drawn only where the record says the
 * bounty's worker is that agent's account. Open bounties nobody has claimed appear unlinked.
 */
function SwarmNetwork({ agents, bounties }: { agents: SwarmAgent[]; bounties: Job[] }) {
  const accounts = new Map(agents.filter((a) => a.account).map((a) => [a.account!, a]));
  const linked = bounties.filter((b) => accounts.has(b.state.terms.worker.nearAccountId));
  const open = bounties.filter((b) => b.state.status === "OPEN" && b.state.terms.fundingDeadline > Date.now());
  const nodes = [...linked, ...open.filter((b) => !linked.includes(b))].slice(0, 6);
  const shownAgents = agents.slice(0, 6);
  if (shownAgents.length === 0)
    return (
      <div className="net-empty">
        <svg viewBox="0 0 200 90" aria-hidden>
          <rect className="ne-node" x="20" y="30" width="30" height="30" />
          <path className="ne-wire" d="M50 45 H150" />
          <rect className="ne-node dim" x="150" y="30" width="30" height="30" />
        </svg>
        <p className="t3 sm">When agents are added and take bounties, their assignments appear here.</p>
      </div>
    );
  const H = Math.max(shownAgents.length, nodes.length, 2) * 46 + 20;
  const ay = (i: number) => 30 + i * 46;
  const by = (i: number) => 30 + i * 46;
  return (
    <svg className="net" viewBox={`0 0 420 ${H}`} role="img" aria-label={`${shownAgents.length} agents, ${linked.length} recorded assignments`}>
      {nodes.map((b, j) => {
        const i = shownAgents.findIndex((a) => a.account === b.state.terms.worker.nearAccountId);
        if (i < 0) return null;
        const paid = b.state.status === "COMPLETED";
        const active = shownAgents[i]!.status === "active" && b.state.status === "FUNDED";
        return <path key={b.id} className={`net-edge ${paid ? "paid" : ""} ${active ? "active" : ""}`} d={`M150 ${ay(i)} C 210 ${ay(i)}, 210 ${by(j)}, 270 ${by(j)}`} />;
      })}
      {shownAgents.map((a, i) => (
        <g key={a.id} className={`net-agent ${a.status}`}>
          <rect x="10" y={ay(i) - 15} width="140" height="30" />
          <rect className="net-led" x="18" y={ay(i) - 3} width="6" height="6" />
          <text x="32" y={ay(i) + 4}>
            {a.name.length > 15 ? `${a.name.slice(0, 14)}…` : a.name}
          </text>
        </g>
      ))}
      {nodes.map((b, j) => (
        <g key={b.id} className={`net-bounty ${b.state.status.toLowerCase()}`}>
          <rect x="270" y={by(j) - 15} width="140" height="30" />
          <text x="280" y={by(j) + 4}>
            {yoctoToNear(b.state.terms.totalYocto)} NEAR · {b.state.status === "OPEN" ? "open" : b.state.status === "COMPLETED" ? "paid" : "in work"}
          </text>
        </g>
      ))}
    </svg>
  );
}

function AgentDetail({ session, agent: a, bounties, reload }: { session: Session; agent: SwarmAgent; bounties: Job[]; reload: () => Promise<void> }) {
  const history = a.account ? bounties.filter((b) => b.state.terms.worker.nearAccountId === a.account) : [];
  const successRate = a.stats.jobsWon > 0 ? Math.round((a.stats.jobsPaid / a.stats.jobsWon) * 100) : null;
  const [amount, setAmount] = useState("0.1");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tx, setTx] = useState<string | null>(null);
  const mine = a.owner === session.accountId;
  const net = session.config.network;

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <a href="#/swarm" className="crumb">
        <Icon name="back" /> Swarm
      </a>
      <div className="split">
        <div style={{ minWidth: 0 }}>
          <div className="hstack">
            <Status tone={STATUS[a.status].tone}>{STATUS[a.status].label}</Status>
            <span className="mono t3 xs">{a.id}</span>
          </div>
          <div className="agent-title">
            <Identicon seed={a.id} size={56} />
            <h1 className="title-xl">{a.name}</h1>
          </div>
          <div className="hero-amount" style={{ marginTop: 22 }}>
            {yoctoToNear(a.stats.earnedYocto)}
            <span className="unit">NEAR earned</span>
          </div>
          <div className="ledger" style={{ marginTop: 18 }}>
            <div className="row">
              Bounties won <span className="num">{a.stats.jobsWon}</span>
            </div>
            <div className="row">
              Completed <span className="num">{a.stats.jobsPaid}</span>
            </div>
            <div className="row">
              NEAR AI calls <span className="num">{a.stats.inferenceCalls}</span>
            </div>
            <div className="row">
              Inference cost <span className="num">{usd(a.stats.inferenceNanoUsd)}</span>
            </div>
          </div>
          {a.stats.pendingCostCalls > 0 && <p className="xs t3" style={{ marginTop: 8 }}>{a.stats.pendingCostCalls} call(s) not billed by NEAR AI yet; costs are read back exactly, never estimated.</p>}

          {a.status === "awaiting_funds" && a.account && (
            <div className="note you" style={{ marginTop: 28 }}>
              <svg className="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
                <path d="M5 12h14M13 6l6 6-6 6" />
              </svg>
              <span className="label">Give it NEAR to start</span>
              <span className="body">
                This agent's account is the implicit account <span className="mono">{a.account}</span>. It exists once it receives NEAR. Send at least 0.05 NEAR; it pays for its gas and its NEAR AI
                inference from this balance.
                {mine && (
                  <span className="inline" style={{ marginTop: 10, display: "flex" }}>
                    <input aria-label="Amount in NEAR" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ maxWidth: 120 }} />
                    <button className="btn" disabled={!!busy} onClick={() => run("fund", async () => {
                      const hash = await sendNear(session.wallet, a.account!, nearToYocto(amount));
                      setTx(hash);
                      toast({ tone: "ok", title: `Sent ${amount} NEAR to the agent`, body: "The agent starts once the transfer is final.", href: explorerTx(net, hash), linkText: "View transaction" });
                    })}>
                      Send {amount} NEAR from your wallet
                    </button>
                  </span>
                )}
              </span>
            </div>
          )}
          {a.status === "provisioning" && <p className="banner" style={{ marginTop: 28 }}>The swarm runner is creating this agent's key. This page refreshes itself.</p>}

          {mine && a.status !== "provisioning" && a.status !== "awaiting_funds" && (
            <div className="act">
              <div className="hstack">
                {a.status === "active" && (
                  <button className="btn secondary" disabled={!!busy} onClick={() => run("pause", () => api("POST", `/v1/swarm/agents/${a.id}/pause`))}>
                    Pause
                  </button>
                )}
                {a.status === "paused" && (
                  <button className="btn secondary" disabled={!!busy} onClick={() => run("resume", () => api("POST", `/v1/swarm/agents/${a.id}/resume`))}>
                    Resume
                  </button>
                )}
                <button className="btn danger" disabled={!!busy || a.withdrawal?.status === "requested"} onClick={() => run("withdraw", () => api("POST", `/v1/swarm/agents/${a.id}/withdraw`))}>
                  Withdraw balance
                </button>
              </div>
              <span className="sm t3">Withdrawing pauses the agent, pays its inference bill to the swarm operator, and sends the rest to your account.</span>
            </div>
          )}
          {a.withdrawal && (
            <p className={`banner ${a.withdrawal.status === "failed" ? "bad" : ""}`} style={{ marginTop: 16 }}>
              Withdrawal {a.withdrawal.status}
              {a.withdrawal.paidYocto && ` · ${yoctoToNear(a.withdrawal.paidYocto)} NEAR to the owner`}
              {a.withdrawal.feeYocto && ` · ${yoctoToNear(a.withdrawal.feeYocto)} NEAR inference bill to the operator`}
              {a.withdrawal.error && ` · ${a.withdrawal.error}`}
              {[a.withdrawal.feeTx, a.withdrawal.payoutTx].filter(Boolean).map((h) => (
                <span key={h}>
                  {" · "}
                  <a className="mono link" href={explorerTx(net, h!)} target="_blank" rel="noreferrer">
                    {h!.slice(0, 10)}…
                  </a>
                </span>
              ))}
            </p>
          )}
          {busy && <p className="banner" style={{ marginTop: 16 }}>Working on {busy}…</p>}
          {error && <p className="banner bad" style={{ marginTop: 16 }}>{error}</p>}
          {tx && (
            <p className="sm t2" style={{ marginTop: 12 }}>
              Sent:{" "}
              <a className="mono link" href={explorerTx(net, tx)} target="_blank" rel="noreferrer">
                {tx.slice(0, 12)}…
              </a>
            </p>
          )}

          <section className="section">
            <div className="section-head">
              <h2>Track record</h2>
            </div>
            <dl className="profile-stats">
              <div>
                <dt>Bounties won</dt>
                <dd className="num">{a.stats.jobsWon}</dd>
              </div>
              <div>
                <dt>Completed and paid</dt>
                <dd className="num">{a.stats.jobsPaid}</dd>
              </div>
              <div>
                <dt>Paid rate</dt>
                <dd className="num">{successRate === null ? "—" : `${successRate}%`}</dd>
              </div>
              <div>
                <dt>Active since</dt>
                <dd>{fmtDate(a.createdAt)}</dd>
              </div>
            </dl>
            {history.length === 0 ? (
              <p className="muted">No bounties yet. Its work will be listed here as it takes them.</p>
            ) : (
              <div className="history">
                {history.map((b) => {
                  const paid = b.state.milestones.reduce((n, m) => n + (m.status === "PAID" && m.allocation ? BigInt(m.allocation.workerYocto) : 0n), 0n);
                  return (
                    <a key={b.id} className="history-row" href={`#/jobs/${b.id}`}>
                      <span className="history-title">{b.state.terms.milestones.map((m) => m.title).join(" · ")}</span>
                      <AgreementStatus status={b.state.status} />
                      <span className="num right">{paid > 0n ? `+${yoctoToNear(paid.toString())} NEAR` : `${yoctoToNear(b.state.terms.totalYocto)} NEAR in escrow`}</span>
                    </a>
                  );
                })}
              </div>
            )}
          </section>

          <section className="section">
            <div className="section-head">
              <h2>Instructions</h2>
            </div>
            {mine ? (
              <EditAgent agent={a} reload={reload} />
            ) : (
              <>
                <p style={{ whiteSpace: "pre-wrap" }}>{a.prompt}</p>
                <p className="sm t3" style={{ marginTop: 10 }}>{a.knowledgeChars > 0 ? `${a.knowledgeChars.toLocaleString()} characters of knowledge (private to the owner)` : "No extra knowledge"}</p>
              </>
            )}
          </section>
        </div>

        <aside className="aside">
          <div className="block">
            <div className="label">Agent</div>
            <div className="facts">
              <div className="fact">
                <div className="k">Owner</div>
                <div className="v mono">
                  {a.owner} {mine && <span className="tag">you</span>}
                </div>
              </div>
              <div className="fact">
                <div className="k">Account</div>
                <div className="v">
                  {a.account ? (
                    <a className="mono link" href={explorerAccount(net, a.account)} target="_blank" rel="noreferrer">
                      {short(a.account)}
                    </a>
                  ) : (
                    "Not created yet"
                  )}
                </div>
              </div>
              <div className="fact">
                <div className="k">Takes bounties up to</div>
                <div className="v num">{yoctoToNear(a.maxBountyYocto)} NEAR</div>
              </div>
              <div className="fact">
                <div className="k">Inference limit per job</div>
                <div className="v num">{usd(a.maxJobNanoUsd)}</div>
              </div>
              <div className="fact">
                <div className="k">Added</div>
                <div className="v">{fmtDate(a.createdAt)}</div>
              </div>
            </div>
          </div>
          <div className="block">
            <div className="label">Guardrails</div>
            <ul className="sm t2" style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
              <li>Takes only written work: judged by a person, or checked by machine against agreed rules. No AI decides payment.</li>
              <li>Never starts an inference call that could exceed its per-job limit.</li>
              <li>Writes in a plain, human voice: no em dashes, no asterisk bold, no filler.</li>
              <li>Every deliverable is stored by its SHA-256, which is what goes onchain.</li>
              <li>Testnet: the swarm runner holds this agent's key, encrypted. The owner can withdraw at any time.</li>
            </ul>
          </div>
        </aside>
      </div>
    </>
  );
}

/** Owner-only: change what the agent works from. Takes effect on its next pass; its account and balance stay. */
function EditAgent({ agent: a, reload }: { agent: SwarmAgent; reload: () => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [prompt, setPrompt] = useState(a.prompt);
  const [knowledge, setKnowledge] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = async () => {
    setError(null);
    setBusy(true);
    try {
      const s = await api<{ prompt: string; knowledge: string }>("GET", `/v1/swarm/agents/${a.id}/settings`);
      setPrompt(s.prompt);
      setKnowledge(s.knowledge);
      setEditing(true);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    setError(null);
    setBusy(true);
    try {
      await api("POST", `/v1/swarm/agents/${a.id}/edit`, { prompt, knowledge: knowledge ?? "" });
      await reload();
      setEditing(false);
      toast({ tone: "ok", title: "Agent updated", body: "It works from the new instructions and knowledge on its next pass." });
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  if (!editing)
    return (
      <>
        <p style={{ whiteSpace: "pre-wrap" }}>{a.prompt}</p>
        <p className="sm t3" style={{ marginTop: 10 }}>{a.knowledgeChars > 0 ? `${a.knowledgeChars.toLocaleString()} characters of knowledge` : "No extra knowledge"}</p>
        <button className="btn secondary" style={{ marginTop: 14 }} disabled={busy} onClick={open}>
          {busy ? "Loading…" : "Edit instructions and knowledge"}
        </button>
        {error && <p className="banner bad" style={{ marginTop: 12 }}>{error}</p>}
      </>
    );
  return (
    <div className="edit-agent">
      <label className="field">
        <span>Instructions</span>
        <textarea rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={4000} />
        <span className="hint">Who the agent is and how it writes. 10 to 4,000 characters.</span>
      </label>
      <label className="field">
        <span>Knowledge</span>
        <textarea rows={10} value={knowledge ?? ""} onChange={(e) => setKnowledge(e.target.value)} maxLength={20_000} />
        <span className="hint">Facts it may rely on: current URLs, button names, how payment works. Keep it up to date; it writes from this. Private to you.</span>
      </label>
      <div className="hstack">
        <button className="btn lime" disabled={busy || prompt.trim().length < 10} onClick={save}>
          {busy ? "Saving…" : "Save changes"}
        </button>
        <button className="btn ghost" disabled={busy} onClick={() => setEditing(false)}>
          Cancel
        </button>
      </div>
      {error && <p className="banner bad" style={{ marginTop: 12 }}>{error}</p>}
    </div>
  );
}

function AddAgent({ session }: { session: Session }) {
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("You are a careful technical writer. You write clear, correct, well-structured Markdown for developers.");
  const [knowledge, setKnowledge] = useState("");
  const [maxBounty, setMaxBounty] = useState("0.1");
  const [maxUsd, setMaxUsd] = useState("0.02");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const a = await api<SwarmAgent>("POST", "/v1/swarm/agents", { name, prompt, knowledge, maxBountyNear: maxBounty, maxJobUsd: maxUsd });
      wakeSwarm(session.config.swarm?.wakeUrl);
      window.location.hash = `#/swarm/${a.id}`;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <a href="#/swarm" className="crumb">
        <Icon name="back" /> Swarm
      </a>
      <div className="page-head">
        <div>
          <h1>Add an agent to the swarm</h1>
          <p>Give it instructions and knowledge. After you send it NEAR, it takes open writing bounties it can do, using NEAR AI, and you can withdraw its earnings.</p>
        </div>
      </div>
      <div style={{ maxWidth: 720 }}>
        <label className="field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Docs writer" maxLength={40} />
        </label>
        <label className="field">
          <span>Instructions (system prompt)</span>
          <textarea rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value)} style={{ fontFamily: "var(--font)", fontSize: 14 }} />
          <span className="hint">Who the agent is and how it works. It also uses this to decide which bounties to take.</span>
        </label>
        <label className="field">
          <span>Knowledge (optional)</span>
          <textarea rows={6} value={knowledge} onChange={(e) => setKnowledge(e.target.value)} placeholder="Facts, style guides or reference material it may rely on." style={{ fontFamily: "var(--font)", fontSize: 14 }} />
          <span className="hint">Up to 20,000 characters.</span>
        </label>
        <div className="fields">
          <label className="field">
            <span>Takes bounties up to (NEAR)</span>
            <input inputMode="decimal" value={maxBounty} onChange={(e) => setMaxBounty(e.target.value)} />
          </label>
          <label className="field">
            <span>Inference limit per job (USD)</span>
            <input inputMode="decimal" value={maxUsd} onChange={(e) => setMaxUsd(e.target.value)} />
            <span className="hint">It never starts a NEAR AI call that could go over this.</span>
          </label>
        </div>
        {error && <p className="banner bad">{error}</p>}
        <div className="wizard-foot">
          <a className="btn secondary" href="#/swarm">
            Cancel
          </a>
          <span className="grow" />
          <button className="btn" disabled={busy || name.trim().length < 2} onClick={create}>
            {busy ? "Adding…" : "Add agent"}
          </button>
        </div>
      </div>
    </>
  );
}
