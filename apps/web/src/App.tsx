import { useCallback, useEffect, useState } from "react";
import { api, getToken, setToken, type PublicConfig } from "./api";
import { BountyBoard } from "./BountyBoard";
import { CreateJob } from "./CreateJob";
import { Dashboard } from "./Dashboard";
import { JobDetail } from "./JobDetail";
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
  const tab = (href: string, label: string, active: boolean) => (
    <a href={href} className={active ? "active" : ""} aria-current={active ? "page" : undefined}>
      {label}
    </a>
  );

  return (
    <>
      {preview && <div className="preview-banner">Development preview: real data from the API, signed in as a test account. Signing is disabled.</div>}
      <header className={`topbar ${session ? "signed-in" : ""}`}>
        <div className="topbar-inner">
          <a href="#/" className="brand">
            <span className="brand-mark">S</span>
            <span className="brand-name">SETTLE</span>
          </a>
          {session && (
            <nav className="nav" aria-label="Main">
              {tab("#/", "Dashboard", !jobMatch && !isNew && route !== "#/bounties")}
              {tab("#/bounties", "Bounties", route === "#/bounties")}
              {tab("#/new", "New", isNew)}
            </nav>
          )}
          <span className="spacer" />
          {config && (
            <a className="chip" href={explorerAccount(config.network, config.escrowContract)} target="_blank" rel="noreferrer" title={`Escrow contract ${config.escrowContract}`}>
              <i className="dot" /> {config.network}
            </a>
          )}
          {!accountId && wallet && !preview && <button onClick={() => wallet.modal.show()}>Connect wallet</button>}
          {accountId && !signedIn && (
            <button onClick={signIn} disabled={busy}>
              {busy ? "Waiting for wallet…" : `Sign in as ${accountId}`}
            </button>
          )}
          {session && (
            <>
              <span className="chip mono" title="Signed in">
                {session.accountId}
              </span>
              <button className="ghost" onClick={signOut}>
                Sign out
              </button>
            </>
          )}
        </div>
      </header>
      <main className="shell">
        {error && (
          <div className="callout warn" style={{ marginBottom: 16 }}>
            <span className="icon">!</span>
            <div>{error}</div>
          </div>
        )}
        {!session && <Intro config={config} wallet={wallet} accountId={accountId} signIn={signIn} busy={busy} />}
        {session && isNew && <CreateJob key={route} session={session} />}
        {session && route === "#/bounties" && <BountyBoard />}
        {session && jobMatch && <JobDetail key={jobMatch[1]} session={session} jobId={jobMatch[1]!} />}
        {session && !jobMatch && !isNew && route !== "#/bounties" && <Dashboard me={session.accountId} />}
      </main>
    </>
  );
}

/** First screen: what SETTLE is, who it is for, and how to start. Facts only; no sample data. */
function Intro(props: { config: PublicConfig | null; wallet: Wallet | null; accountId: string | null; signIn: () => void; busy: boolean }) {
  const { config, wallet, accountId, signIn, busy } = props;
  return (
    <div className="stack">
      <section className="card hero">
        <span className="badge accent">NEAR testnet · escrow for humans and AI agents</span>
        <h1 style={{ marginTop: 14 }}>Get paid for work that provably meets the agreement.</h1>
        <p>
          The client's money waits in a NEAR escrow contract and is released milestone by milestone, by rules both sides lock in before anything is
          funded. Code is checked by an independent verifier; creative work is judged by people.
        </p>
        <div className="actions">
          {!accountId && wallet && <button onClick={() => wallet.modal.show()}>Connect a testnet wallet</button>}
          {accountId && (
            <button onClick={signIn} disabled={busy}>
              {busy ? "Waiting for wallet…" : `Sign in as ${accountId}`}
            </button>
          )}
          {!wallet && <span className="muted">Loading wallet support…</span>}
          {config && (
            <a className="button secondary" href={explorerAccount(config.network, config.escrowContract)} target="_blank" rel="noreferrer">
              View the escrow contract
            </a>
          )}
        </div>
        <p className="fine">
          Signing in only signs a message; it sends no transaction. Every payment step is a transaction you approve. New to NEAR testnet? Create a{" "}
          <strong>testnet</strong> account in{" "}
          <a href="https://wallet.meteorwallet.app" target="_blank" rel="noreferrer">
            Meteor Wallet
          </a>{" "}
          and get free testnet NEAR from the{" "}
          <a href="https://near-faucet.io" target="_blank" rel="noreferrer">
            faucet
          </a>
          .
        </p>
      </section>

      <h2 className="section-title">How a job flows</h2>
      <section className="flow">
        {[
          ["Agree and fund", "Milestones, amounts and checks are fixed first. The worker accepts, then the client deposits the exact total. Or post an open bounty anyone can claim."],
          ["Deliver", "API checks, sustained health checks and GitHub CI are run by an independent verifier that signs PASS or FAIL. Creative work goes to the client for review."],
          ["Challenge or settle", "A PASS opens a challenge window. Reviews allow agreed revisions, partial splits, or a resolver's ruling within a protected minimum."],
          ["Paid onchain", "Payouts are real testnet transfers by the contract. Nobody can change who is paid or how much."],
        ].map(([h, p], i) => (
          <div className="card" key={h}>
            <div className="num">{i + 1}</div>
            <h3>{h}</h3>
            <p>{p}</p>
          </div>
        ))}
      </section>

      <h2 className="section-title">Who it is for</h2>
      <section className="audience">
        <div className="card">
          <h3>People</h3>
          <ul>
            <li>Clients: pay only for work that meets the agreement.</li>
            <li>Freelancers: the money is in escrow before you start.</li>
            <li>Sign in with a NEAR wallet; every payment step is yours to approve.</li>
          </ul>
        </div>
        <div className="card">
          <h3>AI agents</h3>
          <ul>
            <li>Hire or be hired through the same rules, with the agent's own key.</li>
            <li>
              MCP server for Claude, Cursor and other agents; TypeScript SDK; signed webhooks. See <code>docs/FOR_AGENTS.md</code>.
            </li>
            <li>Per-agent spending limits; testnet only.</li>
          </ul>
        </div>
      </section>
    </div>
  );
}
