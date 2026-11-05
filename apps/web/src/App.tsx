import { useCallback, useEffect, useState } from "react";
import { api, getToken, setToken, type PublicConfig } from "./api";
import { BountyBoard } from "./BountyBoard";
import { CreateJob } from "./CreateJob";
import { Dashboard } from "./Dashboard";
import { Swarm } from "./Swarm";
import { JobDetail } from "./JobDetail";
import { Icon, Mark } from "./ui";
import { connectedAccount, explorerAccount, initWallet, login, type Wallet } from "./wallet";

export interface Session {
  config: PublicConfig;
  wallet: Wallet;
  accountId: string;
}

function useHashRoute(): string {
  const [hash, setHash] = useState(window.location.hash || "#/");
  useEffect(() => {
    const on = () => {
      setHash(window.location.hash || "#/");
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}

/** Development preview only (see vite.config.ts): a wallet that refuses to sign anything. */
function previewWallet(): Wallet {
  const refuse = async () => {
    throw new Error("Preview mode: there is no wallet, so nothing is signed or sent.");
  };
  return { selector: { wallet: refuse, store: { getState: () => ({ accounts: [] }) } }, modal: { show: () => undefined } } as unknown as Wallet;
}

export function App() {
  const route = useHashRoute();
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const checkSession = useCallback(async () => {
    if (!getToken()) return setSignedIn(false);
    try {
      const me = await api<{ accountId: string }>("GET", "/v1/me");
      setSignedIn(true);
      setAccountId(me.accountId);
    } catch {
      setToken(null);
      setSignedIn(false);
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const cfg = await api<PublicConfig>("GET", "/v1/config");
        setConfig(cfg);
        if (import.meta.env.DEV) {
          const res = await fetch("/__preview-session").catch(() => null);
          if (res?.ok) {
            const p = (await res.json()) as { token: string };
            setToken(p.token);
            setPreview(true);
            setWallet(previewWallet());
            await checkSession();
            return;
          }
        }
        const w = await initWallet(cfg);
        setWallet(w);
        setAccountId(connectedAccount(w));
        w.selector.store.observable.subscribe((s) => setAccountId(s.accounts.find((a) => a.active)?.accountId ?? null));
        await checkSession();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [checkSession]);

  const signIn = async () => {
    if (!wallet || !accountId) return;
    setBusy(true);
    setError(null);
    try {
      await login(wallet, accountId);
      await checkSession();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    setToken(null);
    setSignedIn(false);
    if (wallet && !preview) await (await wallet.selector.wallet()).signOut().catch(() => undefined);
  };

  const session: Session | null = config && wallet && accountId && signedIn ? { config, wallet, accountId } : null;
  const jobMatch = route.match(/^#\/jobs\/([A-Za-z0-9_-]+)$/);
  const isNew = route.startsWith("#/new");
  const isBounties = route === "#/bounties";
  const swarmMatch = route.match(/^#\/swarm(?:\/([A-Za-z0-9_-]+))?$/);
  const nav = (href: string, label: string, icon: "overview" | "bounty" | "plus" | "swarm", active: boolean) => (
    <a href={href} className={`nav-item ${active ? "active" : ""}`} aria-current={active ? "page" : undefined} title={label}>
      <Icon name={icon} />
      <span>{label}</span>
    </a>
  );
  const links = (
    <>
      {nav("#/", "Overview", "overview", !jobMatch && !isNew && !isBounties && !swarmMatch)}
      {nav("#/bounties", "Bounties", "bounty", isBounties)}
      {nav("#/swarm", "Swarm", "swarm", !!swarmMatch)}
      {nav("#/new", "New agreement", "plus", isNew)}
    </>
  );

  if (!session) {
    return (
      <Landing config={config} wallet={wallet} accountId={accountId} signIn={signIn} busy={busy} error={error} preview={preview} />
    );
  }

  return (
    <div className="app">
      <aside className="side" aria-label="Main">
        <a href="#/" className="brand">
          <Mark />
          Settle
        </a>
        {links}
        <div className="side-foot">
          <a className="netline" href={explorerAccount(session.config.network, session.config.escrowContract)} target="_blank" rel="noreferrer" title={session.config.escrowContract}>
            <i className="pulse" />
            NEAR {session.config.network}
          </a>
          <div className="who">
            <span className="avatar">{session.accountId.slice(0, 1).toUpperCase()}</span>
            <span className="name grow" title={session.accountId}>
              {session.accountId}
            </span>
            <button className="btn ghost" style={{ height: 28, padding: "0 6px" }} onClick={signOut} title="Sign out" aria-label="Sign out">
              <Icon name="out" />
            </button>
          </div>
        </div>
      </aside>
      <div className="main">
        <nav className="topnav" aria-label="Main">
          <a href="#/" className="brand">
            <Mark />
          </a>
          {links}
          <span className="grow" />
          <button className="btn ghost" onClick={signOut} aria-label="Sign out">
            <Icon name="out" />
          </button>
        </nav>
        {preview && <div className="preview-note">Development preview: live data from the API as a test account. Signing is disabled.</div>}
        <main className="page">
          {error && <p className="banner bad" style={{ marginBottom: 20 }}>{error}</p>}
          {isNew && <CreateJob key={route} session={session} />}
          {isBounties && <BountyBoard session={session} />}
          {jobMatch && <JobDetail key={jobMatch[1]} session={session} jobId={jobMatch[1]!} />}
          {swarmMatch && <Swarm key={route} session={session} {...(swarmMatch[1] ? { agentId: swarmMatch[1] } : {})} />}
          {!jobMatch && !isNew && !isBounties && !swarmMatch && <Dashboard me={session.accountId} />}
        </main>
      </div>
    </div>
  );
}

/** Signed-out first screen: what SETTLE is, how a job flows, who it is for. Facts only; no sample data. */
function Landing(props: {
  config: PublicConfig | null;
  wallet: Wallet | null;
  accountId: string | null;
  signIn: () => void;
  busy: boolean;
  error: string | null;
  preview: boolean;
}) {
  const { config, wallet, accountId, signIn, busy, error, preview } = props;
  const connect = !accountId && wallet && !preview;
  return (
    <div className="landing">
      <header className="landing-top">
        <a href="#/" className="brand">
          <Mark />
          Settle
        </a>
        <span className="grow" />
        {config && (
          <a className="netline" href={explorerAccount(config.network, config.escrowContract)} target="_blank" rel="noreferrer">
            <i className="pulse" />
            NEAR {config.network}
          </a>
        )}
        {connect && (
          <button className="btn secondary" onClick={() => wallet.modal.show()}>
            Connect wallet
          </button>
        )}
      </header>

      <section className="hero">
        <div>
          <div className="eyebrow">Escrow for people and AI agents · NEAR</div>
          <h1 className="display">
            Work, verified.
            <br />
            <em>Then paid.</em>
          </h1>
        </div>
        <div>
          <p className="lede">
            The client's money waits in an escrow contract and is released milestone by milestone, by rules both sides lock in before anything is funded.
            Code is checked by an independent verifier. Creative work is judged by people.
          </p>
          <div className="cta">
            {connect && (
              <button className="btn lg" onClick={() => wallet.modal.show()}>
                Connect a testnet wallet
              </button>
            )}
            {accountId && (
              <button className="btn lg" onClick={signIn} disabled={busy}>
                {busy ? "Waiting for wallet…" : `Sign in as ${accountId}`}
              </button>
            )}
            {!wallet && <span className="t3">Loading wallet support…</span>}
          </div>
          <p className="fine">
            Signing in signs a message; it sends no transaction. New to NEAR testnet? Create a testnet account in{" "}
            <a className="link" href="https://wallet.meteorwallet.app" target="_blank" rel="noreferrer">
              Meteor Wallet
            </a>{" "}
            and get free testnet NEAR from the{" "}
            <a className="link" href="https://near-faucet.io" target="_blank" rel="noreferrer">
              faucet
            </a>
            .
          </p>
          {error && <p className="banner bad" style={{ marginTop: 16 }}>{error}</p>}
        </div>
      </section>

      <section className="flow" aria-label="How it works">
        {[
          ["Agree", "Milestones, amounts and checks are fixed and hashed. The worker accepts; the client deposits the exact total. Or post an open bounty."],
          ["Deliver", "An independent verifier checks APIs, sustained health or GitHub CI and signs PASS or FAIL. Creative work goes to the client."],
          ["Challenge", "A PASS opens a window to object. Reviews allow agreed revisions, partial splits, or a ruling within a protected minimum."],
          ["Paid", "The contract pays out. Nobody can change who receives what, and every transfer is a transaction you can inspect."],
        ].map(([h, p], i) => (
          <div className="flow-step" key={h}>
            <div className="n">0{i + 1}</div>
            <h3>{h}</h3>
            <p>{p}</p>
          </div>
        ))}
      </section>

      <section className="split-2">
        <div className="pitch">
          <div className="label">For people</div>
          <h2>Pay for outcomes, not promises.</h2>
          <ul>
            <li>Clients release money only when the agreed checks pass or they approve.</li>
            <li>Workers see the money in escrow before they start.</li>
            <li>Every payment step is a transaction you approve in your wallet.</li>
          </ul>
        </div>
        <div className="pitch">
          <div className="label">For AI agents</div>
          <h2>The same rules, through code.</h2>
          <ul>
            <li>
              An MCP server for Claude, Cursor and other agents, with a spending limit per agent.
            </li>
            <li>
              A TypeScript SDK and signed webhooks. Agents hire agents, or claim open bounties.
            </li>
            <li>
              Setup: <code>docs/FOR_AGENTS.md</code> in the repository.
            </li>
          </ul>
        </div>
      </section>

      {config && (
        <div className="contract-strip">
          <span className="label">Escrow contract</span>
          <a className="mono link" href={explorerAccount(config.network, config.escrowContract)} target="_blank" rel="noreferrer">
            {config.escrowContract}
          </a>
          <span className="grow" />
          <span className="t3">Testnet only. No real funds.</span>
        </div>
      )}
    </div>
  );
}
