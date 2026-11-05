import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Agreements } from "./Agreements";
import { api, getToken, SESSION_EXPIRED, setToken, yoctoToNear, type PublicConfig } from "./api";
import { BountyBoard } from "./BountyBoard";
import { CreateJob } from "./CreateJob";
import { Dashboard } from "./Dashboard";
import { describeError, walletState } from "./feedback";
import { ForAgents } from "./ForAgents";
import { JobDetail } from "./JobDetail";
import { Home } from "./Landing";
import { Swarm } from "./Swarm";
import { toast, ToastHost } from "./toast";
import { Icon, Mark } from "./ui";
import { connectedAccount, explorerAccount, initWallet, login, type Wallet } from "./wallet";

export interface Session {
  config: PublicConfig;
  wallet: Wallet;
  /** Empty when signed out: a public visitor, who has no role in anything. */
  accountId: string;
  signedIn: boolean;
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

/** Signed-out visitors browse public pages (ADR 0007); anything that would sign refuses with a clear message. */
function signedOutWallet(real: Wallet | null): Wallet {
  const refuse = async () => {
    throw new Error("Sign in with a NEAR testnet wallet first.");
  };
  return { ...(real ?? {}), selector: { ...(real?.selector ?? {}), wallet: refuse } } as unknown as Wallet;
}

type Page = "overview" | "agreements" | "bounties" | "swarm" | "agents" | "job" | "new" | "home";

function pageOf(route: string, signedIn: boolean): Page {
  if (/^#\/jobs\//.test(route)) return "job";
  if (route.startsWith("#/new")) return "new";
  if (route === "#/agreements") return "agreements";
  if (route === "#/bounties") return "bounties";
  if (/^#\/swarm/.test(route)) return "swarm";
  if (route === "#/agents") return "agents";
  if (route === "#/home") return "home";
  return signedIn ? "overview" : "home";
}

const TITLES: Record<Page, string> = {
  overview: "Overview",
  agreements: "Agreements",
  bounties: "Bounties",
  swarm: "Swarm",
  agents: "For agents",
  job: "Agreement",
  new: "New agreement",
  home: "Home",
};

export function App() {
  const route = useHashRoute();
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [preview, setPreview] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [drawer, setDrawer] = useState(false);

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
        setBootError(describeError(e));
      }
    })();
  }, [checkSession]);

  // A session that expires mid-visit drops back to the public view with a notice, not an error page.
  useEffect(() => {
    const on = () => {
      setSignedIn(false);
      toast({ tone: "info", title: "Your session ended", body: "Sign in again to act on your agreements. Public pages still work." });
    };
    window.addEventListener(SESSION_EXPIRED, on);
    return () => window.removeEventListener(SESSION_EXPIRED, on);
  }, []);

  useEffect(() => setDrawer(false), [route]);

  const signIn = async () => {
    if (!wallet || !accountId) return;
    setBusy(true);
    try {
      await login(wallet, accountId);
      await checkSession();
      toast({ tone: "ok", title: `Signed in as ${accountId}`, body: "You signed a message. No transaction was sent." });
    } catch (e) {
      toast({ tone: "bad", title: "Not signed in", body: describeError(e) });
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    setToken(null);
    setSignedIn(false);
    if (wallet && !preview) await (await wallet.selector.wallet()).signOut().catch(() => undefined);
    toast({ tone: "info", title: "Signed out" });
  };

  const session: Session | null = config && wallet && accountId && signedIn ? { config, wallet, accountId, signedIn: true } : null;
  const visitor: Session | null = session ?? (config ? { config, wallet: signedOutWallet(wallet), accountId: "", signedIn: false } : null);
  const page = pageOf(route, !!session);
  const state = walletState({ walletReady: !!wallet, accountId, signedIn: !!session });
  const connect = () => wallet?.modal.show();

  const account = <AccountChip state={state} accountId={accountId} busy={busy} connect={connect} signIn={signIn} />;

  if (page === "home") {
    return (
      <>
        <Home config={config} signedIn={!!session} account={session ? <a className="btn lime sm" href="#/">Open the app →</a> : account} />
        <ToastHost />
      </>
    );
  }

  const nav = (href: string, label: string, icon: Parameters<typeof Icon>[0]["name"], on: boolean) => (
    <a href={href} className={`nav-item ${on ? "active" : ""}`} aria-current={on ? "page" : undefined}>
      <Icon name={icon} />
      <span>{label}</span>
    </a>
  );

  return (
    <div className={`app ${drawer ? "drawer-open" : ""}`}>
      <aside className="side" aria-label="Main navigation">
        <a href={session ? "#/home" : "#/"} className="brand">
          <Mark /> SETTLE
        </a>
        <nav className="nav">
          {nav("#/", "Overview", "overview", page === "overview")}
          {nav("#/agreements", "Agreements", "list", page === "agreements" || page === "job" || page === "new")}
          {nav("#/bounties", "Bounties", "bounty", page === "bounties")}
          {nav("#/swarm", "Swarm", "swarm", page === "swarm")}
          {nav("#/agents", "For agents", "code", page === "agents")}
        </nav>
        <WalletPanel state={state} config={config} accountId={accountId} busy={busy} preview={preview} connect={connect} signIn={signIn} signOut={signOut} />
      </aside>
      <button className="scrim" aria-label="Close menu" onClick={() => setDrawer(false)} tabIndex={drawer ? 0 : -1} />

      <div className="main">
        <header className="statusbar">
          <button className="menu-btn" aria-label="Open menu" aria-expanded={drawer} onClick={() => setDrawer(true)}>
            <Icon name="menu" />
          </button>
          <span className="crumbs">
            <span className="t3">SETTLE /</span> {TITLES[page]}
          </span>
          <span className="grow" />
          {config && (
            <a className="net-pill" href={explorerAccount(config.network, config.escrowContract)} target="_blank" rel="noreferrer" title={`Escrow contract ${config.escrowContract}`}>
              <i /> NEAR {config.network}
            </a>
          )}
          <span className="statusbar-account">{account}</span>
        </header>
        {preview && <div className="preview-note">Development preview: live data from the API as a test account. Signing is disabled.</div>}
        <main className="page" key={page === "job" || page === "swarm" ? route : page}>
          {bootError && <p className="banner bad">{bootError}</p>}
          {!visitor && !bootError && <div className="skeleton tall" />}
          {visitor && (
            <>
              {page === "overview" && session && <Dashboard me={session.accountId} />}
              {page === "agreements" && (session ? <Agreements me={session.accountId} /> : <SignInRequired what="see your agreements" state={state} connect={connect} signIn={signIn} busy={busy} />)}
              {page === "new" && (session ? <CreateJob key={route} session={session} /> : <SignInRequired what="create an agreement or a bounty" state={state} connect={connect} signIn={signIn} busy={busy} />)}
              {page === "bounties" && <BountyBoard session={visitor} />}
              {page === "job" && <JobDetail key={route} session={visitor} jobId={route.slice("#/jobs/".length)} />}
              {page === "swarm" && <Swarm key={route} session={visitor} {...(route.match(/^#\/swarm\/([A-Za-z0-9_-]+)$/) ? { agentId: route.slice("#/swarm/".length) } : {})} />}
              {page === "agents" && <ForAgents session={visitor} />}
            </>
          )}
        </main>
      </div>
      <ToastHost />
    </div>
  );
}

/** The compact account control: what state you are in, and the one next step. */
function AccountChip({ state, accountId, busy, connect, signIn }: { state: ReturnType<typeof walletState>; accountId: string | null; busy: boolean; connect: () => void; signIn: () => void }) {
  if (state === "loading") return <span className="chip muted">Loading wallet…</span>;
  if (state === "disconnected")
    return (
      <button className="btn lime sm" onClick={connect}>
        Connect wallet
      </button>
    );
  if (state === "connected")
    return (
      <button className="btn lime sm" onClick={signIn} disabled={busy} title="Signs a message to prove you own this account. Sends no transaction.">
        {busy ? "Check your wallet…" : `Sign in as ${short(accountId!)}`}
      </button>
    );
  return (
    <span className="chip on" title={accountId!}>
      <i /> {short(accountId!)}
    </span>
  );
}

const short = (a: string) => (a.length > 22 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a);

/** The wallet area: connection, network, account, sign-in and balance, kept distinct. */
function WalletPanel(props: {
  state: ReturnType<typeof walletState>;
  config: PublicConfig | null;
  accountId: string | null;
  busy: boolean;
  preview: boolean;
  connect: () => void;
  signIn: () => void;
  signOut: () => void;
}) {
  const { state, config, accountId, busy, preview, connect, signIn, signOut } = props;
  const balance = useBalance(config, state === "disconnected" || state === "loading" ? null : accountId);
  return (
    <div className="wallet">
      <div className="wallet-row">
        <span className="label">Network</span>
        <span className="mono">NEAR {config?.network ?? "…"}</span>
      </div>
      <div className="wallet-row">
        <span className="label">Wallet</span>
        <span className={`wstate ${state}`}>{state === "loading" ? "Loading…" : state === "disconnected" ? "Not connected" : "Connected"}</span>
      </div>
      {accountId && state !== "disconnected" && (
        <div className="wallet-account">
          <span className="mono" title={accountId}>
            {accountId}
          </span>
          {balance !== null && <span className="t3 mono">{balance} NEAR</span>}
        </div>
      )}
      <div className="wallet-row">
        <span className="label">Session</span>
        <span className={`wstate ${state === "signed-in" ? "signed-in" : ""}`}>{state === "signed-in" ? "Signed in" : "Not signed in"}</span>
      </div>
      {state === "disconnected" && (
        <button className="btn lime full" onClick={connect}>
          Connect wallet
        </button>
      )}
      {state === "connected" && (
        <>
          <button className="btn lime full" onClick={signIn} disabled={busy}>
            {busy ? "Check your wallet…" : "Sign in"}
          </button>
          <p className="wallet-note">Signing in signs a message to prove the account is yours. It sends no transaction.</p>
          <button className="btn ghost-light full" onClick={connect}>
            Switch account
          </button>
        </>
      )}
      {state === "signed-in" && (
        <div className="wallet-actions">
          {!preview && (
            <button className="btn ghost-light" onClick={connect}>
              Switch
            </button>
          )}
          <button className="btn ghost-light" onClick={signOut}>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

/** The connected account's balance, read from NEAR RPC (finality "final"). Null until known. */
function useBalance(config: PublicConfig | null, accountId: string | null): string | null {
  const [bal, setBal] = useState<string | null>(null);
  useEffect(() => {
    setBal(null);
    if (!config || !accountId) return;
    let alive = true;
    fetch(config.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_account", finality: "final", account_id: accountId } }),
    })
      .then((r) => r.json())
      .then((j: { result?: { amount?: string } }) => {
        if (!alive || !j.result?.amount) return;
        const n = yoctoToNear(j.result.amount);
        const [w, f = ""] = n.split(".");
        setBal(f ? `${w}.${f.slice(0, 3)}` : w!);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [config, accountId]);
  return bal;
}

/** Shown in place of pages that need a signed-in account. */
function SignInRequired({ what, state, connect, signIn, busy }: { what: string; state: ReturnType<typeof walletState>; connect: () => void; signIn: () => void; busy: boolean }): ReactNode {
  return (
    <div className="gate">
      <svg viewBox="0 0 120 120" aria-hidden className="gate-art">
        <rect x="30" y="50" width="60" height="48" />
        <path d="M42 50 V38 a18 18 0 0 1 36 0 V50" />
        <rect className="gate-key" x="56" y="66" width="8" height="16" />
      </svg>
      <span className="kicker">Sign-in required</span>
      <h1 className="headline">This needs your account.</h1>
      <p className="lede">
        Sign in to {what}. Agreements are private to the people in them, so SETTLE needs to know which NEAR account is yours. Signing in signs a message; it sends no
        transaction and moves no money.
      </p>
      <div className="hero-cta">
        {state === "connected" ? (
          <button className="btn lime lg" onClick={signIn} disabled={busy}>
            {busy ? "Check your wallet…" : "Sign in with your wallet"}
          </button>
        ) : (
          <button className="btn lime lg" onClick={connect} disabled={state === "loading"}>
            Connect a testnet wallet
          </button>
        )}
        <a className="btn ghost lg" href="#/bounties">
          Browse public bounties
        </a>
      </div>
      <p className="fine">
        New to NEAR testnet? Create an account in{" "}
        <a className="link" href="https://wallet.meteorwallet.app" target="_blank" rel="noreferrer">
          Meteor Wallet
        </a>{" "}
        and get free testnet NEAR from the{" "}
        <a className="link" href="https://near-faucet.io" target="_blank" rel="noreferrer">
          faucet
        </a>
        .
      </p>
    </div>
  );
}
