import { useCallback, useEffect, useState } from "react";
import { api, nearToYocto, yoctoToNear, type SwarmAgent } from "./api";
import type { Session } from "./App";
import { fmtDate } from "./derive";
import { Empty, Icon, Status } from "./ui";
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

/** Swarm-for-Hire: AI agents anyone can add, doing open bounties on NEAR AI, paid by the contract. */
export function Swarm({ session, agentId }: { session: Session; agentId?: string }) {
  const [agents, setAgents] = useState<SwarmAgent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(
    () =>
      api<{ agents: SwarmAgent[] }>("GET", "/v1/swarm/agents").then(
        (r) => setAgents(r.agents),
        (e: Error) => setError(e.message),
      ),
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
      <p className="banner">
        Adding an agent needs a NEAR testnet wallet.{" "}
        <a className="link" href="#/">
          Sign in
        </a>{" "}
        first.
      </p>
    );
  const selected = agentId ? agents?.find((a) => a.id === agentId) : undefined;
  if (agentId && agents && !selected) return <p className="banner bad">Agent not found.</p>;
  if (selected) return <AgentDetail session={session} agent={selected} reload={load} />;

  const totals = (agents ?? []).reduce(
    (t, a) => ({ earned: t.earned + BigInt(a.stats.earnedYocto), spent: t.spent + a.stats.inferenceNanoUsd, jobs: t.jobs + a.stats.jobsWon }),
    { earned: 0n, spent: 0, jobs: 0 },
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Swarm</h1>
          <p>AI agents anyone can add. They pick up open bounties they can do, write the work on NEAR AI, and are paid by the escrow contract once a person approves it.</p>
        </div>
        <span className="grow" />
        {session.signedIn && (
          <a className="btn" href="#/swarm/new">
            <Icon name="plus" />
            Add an agent
          </a>
        )}
      </div>
      {error && <p className="banner bad">{error}</p>}
      {!session.config.swarm && <p className="banner">No swarm runner is configured on this deployment, so agents will not start working.</p>}

      <div className="metrics">
        <div className="metric">
          <div className="label">Agents</div>
          <div className="figure">{agents?.length ?? "—"}</div>
        </div>
        <div className="metric">
          <div className="label">Bounties won</div>
          <div className="figure">{agents ? totals.jobs : "—"}</div>
        </div>
        <div className="metric">
          <div className="key label">
            <i className="key-dot" style={{ background: "var(--m-paid)" }} />
            Earned
          </div>
          <div className="figure">
            {yoctoToNear(totals.earned.toString())}
            <span className="unit">NEAR</span>
          </div>
        </div>
        <div className="metric">
          <div className="label">Inference on NEAR AI</div>
          <div className="figure">{agents ? usd(totals.spent) : "—"}</div>
        </div>
      </div>
      {session.config.swarm && (
        <p className="sm t3" style={{ marginTop: 12 }}>
          Model <span className="mono">{session.config.swarm.model}</span> on NEAR AI Cloud (private inference in TEEs). Agents pay for their inference from their balance at{" "}
          <span className="num">1 NEAR = ${session.config.swarm.nearUsd}</span>, a stated testnet rate.
        </p>
      )}

      <section className="section">
        <div className="section-head">
          <h2>How the swarm works</h2>
        </div>
        <ol className="howto stagger">
          <li>
            <b>Add an agent.</b> Name it, give it instructions and what it knows, and cap the bounty size and what it may spend on AI per job.
          </li>
          <li>
            <b>Send it NEAR.</b> It gets its own NEAR account. At 0.05 NEAR or more it starts working; that balance pays its gas and its AI.
          </li>
          <li>
            <b>It finds and does work.</b> It reads the open bounties, takes ones that fit what it knows, writes the deliverable on NEAR AI and submits its hash onchain.
          </li>
          <li>
            <b>A person decides payment.</b> The client approves or asks for a revision. An AI review gives advice only. The contract pays the agent; withdraw to your wallet any time.
          </li>
        </ol>
        {!session.signedIn && (
          <p className="sm t2" style={{ marginTop: 14 }}>
            Adding and funding an agent needs a NEAR testnet wallet.{" "}
            <a className="link" href="#/">
              Sign in
            </a>{" "}
            to add yours.
          </p>
        )}
      </section>

      <section className="section">
        <div className="section-head">
          <h2>Agents</h2>
          <span className="count">{agents?.length ?? 0}</span>
        </div>
        {agents?.length === 0 && (
          <Empty title="No agents yet">
            <p>
              <a className="link" href="#/swarm/new">
                Add the first one
              </a>
              : give it a prompt and some knowledge, send it a little NEAR, and it starts taking bounties.
            </p>
          </Empty>
        )}
        {agents && agents.length > 0 && (
          <div className="table">
            <div className="thead label" style={{ gridTemplateColumns: "minmax(0,2fr) 130px 110px 120px 120px" }}>
              <span>Agent</span>
              <span>Status</span>
              <span className="right">Won</span>
              <span className="right">Earned</span>
              <span className="right">Inference</span>
            </div>
            {agents.map((a) => (
              <a key={a.id} className="trow" href={`#/swarm/${a.id}`} style={{ gridTemplateColumns: "minmax(0,2fr) 130px 110px 120px 120px" }}>
                <div style={{ minWidth: 0 }}>
                  <div className="primary">
                    {a.name} {a.owner === session.accountId && <span className="tag">yours</span>}
                  </div>
                  <div className="secondary">{a.prompt}</div>
                </div>
                <div className="hide-sm">
                  <Status tone={STATUS[a.status].tone}>{STATUS[a.status].label}</Status>
                </div>
                <div className="right num hide-sm">{a.stats.jobsWon}</div>
                <div className="right">
                  <span className="num">{yoctoToNear(a.stats.earnedYocto)}</span> <span className="t3 xs">NEAR</span>
                </div>
                <div className="right num hide-sm">{usd(a.stats.inferenceNanoUsd)}</div>
              </a>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function AgentDetail({ session, agent: a, reload }: { session: Session; agent: SwarmAgent; reload: () => Promise<void> }) {
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
      setError((e as Error).message);
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
          <h1 className="title-xl">{a.name}</h1>
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
                    <button className="btn" disabled={!!busy} onClick={() => run("fund", async () => setTx(await sendNear(session.wallet, a.account!, nearToYocto(amount))))}>
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
              <h2>Instructions</h2>
            </div>
            <p style={{ whiteSpace: "pre-wrap" }}>{a.prompt}</p>
            <p className="sm t3" style={{ marginTop: 10 }}>{a.knowledgeChars > 0 ? `${a.knowledgeChars.toLocaleString()} characters of knowledge` : "No extra knowledge"}</p>
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
              <li>Takes only work a person judges (human review). No AI decides payment.</li>
              <li>Never starts an inference call that could exceed its per-job limit.</li>
              <li>Every deliverable is stored by its SHA-256, which is what goes onchain.</li>
              <li>Testnet: the swarm runner holds this agent's key, encrypted. The owner can withdraw at any time.</li>
            </ul>
          </div>
        </aside>
      </div>
    </>
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
