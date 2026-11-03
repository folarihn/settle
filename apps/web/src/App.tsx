import { useCallback, useEffect, useState } from "react";
import { api, getToken, setToken, type PublicConfig } from "./api";
import { CreateJob } from "./CreateJob";
import { JobDetail } from "./JobDetail";
import { JobList } from "./JobList";
import { connectedAccount, explorerAccount, initWallet, login, type Wallet } from "./wallet";

export interface Session {
  config: PublicConfig;
  wallet: Wallet;
  accountId: string;
}

function useHashRoute(): string {
  const [hash, setHash] = useState(window.location.hash || "#/");
  useEffect(() => {
    const on = () => setHash(window.location.hash || "#/");
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}

export function App() {
  const route = useHashRoute();
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState(false);
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
    if (wallet) await (await wallet.selector.wallet()).signOut().catch(() => undefined);
  };

  const session: Session | null = config && wallet && accountId && signedIn ? { config, wallet, accountId } : null;
  const jobMatch = route.match(/^#\/jobs\/([A-Za-z0-9_-]+)$/);

  return (
    <div className="shell">
      <header>
        <a href="#/" className="brand">
          SETTLE
        </a>
        {config ? (
          <a className="muted mono" href={explorerAccount(config.network, config.escrowContract)} target="_blank" rel="noreferrer" title="Escrow contract on the NEAR explorer">
            {config.network} · {config.escrowContract}
          </a>
        ) : (
          <span className="muted">connecting…</span>
        )}
        <span className="spacer" />
        {!accountId && wallet && <button onClick={() => wallet.modal.show()}>Connect wallet</button>}
        {accountId && !signedIn && (
          <button onClick={signIn} disabled={busy}>
            {busy ? "Waiting for wallet..." : `Sign in as ${accountId}`}
          </button>
        )}
        {session && (
          <>
            <span className="account">{session.accountId}</span>
            <button className="secondary" onClick={signOut}>
              Sign out
            </button>
          </>
        )}
      </header>
      {error && <p className="error">{error}</p>}
      <main>
        {!session && <Intro config={config} wallet={wallet} accountId={accountId} signIn={signIn} busy={busy} />}
        {session && route === "#/new" && <CreateJob session={session} />}
        {session && jobMatch && <JobDetail session={session} jobId={jobMatch[1]!} />}
        {session && !jobMatch && route !== "#/new" && <JobList />}
      </main>
    </div>
  );
}

/** First screen: what SETTLE is, how a job flows, and how to start. Facts only; no sample data. */
function Intro(props: { config: PublicConfig | null; wallet: Wallet | null; accountId: string | null; signIn: () => void; busy: boolean }) {
  const { config, wallet, accountId, signIn, busy } = props;
  return (
    <>
      <section className="card hero">
        <h1>Get paid for work that provably meets the agreement.</h1>
        <p>
          SETTLE holds a client's payment in a NEAR escrow contract and releases it milestone by milestone. Each milestone has rules that both sides
          lock in before any money moves. Humans and AI agents use the same rules.
        </p>
        <div className="actions">
          {!accountId && wallet && <button onClick={() => wallet.modal.show()}>Connect a testnet wallet</button>}
          {accountId && (
            <button onClick={signIn} disabled={busy}>
              {busy ? "Waiting for wallet…" : `Sign in as ${accountId}`}
            </button>
          )}
          {!wallet && <span className="muted">Loading wallet support…</span>}
        </div>
        <p className="muted small">
          Signing in only signs a message; it sends no transaction. Every payment step is a transaction you approve in your wallet. New to NEAR
          testnet? Create an account at{" "}
          <a href="https://testnet.mynearwallet.com" target="_blank" rel="noreferrer">
            testnet.mynearwallet.com
          </a>{" "}
          and get free testnet NEAR from the{" "}
          <a href="https://near-faucet.io" target="_blank" rel="noreferrer">
            NEAR testnet faucet
          </a>
          .
        </p>
      </section>
      <section className="steps">
        <div className="card">
          <h3>1 · Agree and fund</h3>
          <p>The client sets milestones and amounts, and the worker accepts. The client then deposits the exact total into the escrow contract.</p>
        </div>
        <div className="card">
          <h3>2 · Automated checks</h3>
          <p>
            For code milestones, an independent verifier calls the delivered API and signs <strong>PASS</strong> or <strong>FAIL</strong>. A FAIL releases
            nothing. A PASS opens a challenge window before payment.
          </p>
        </div>
        <div className="card">
          <h3>3 · Human review</h3>
          <p>
            For creative milestones, the client approves or asks for a revision. Both sides can agree a partial payment, or a resolver rules within the
            agreed minimum.
          </p>
        </div>
        <div className="card">
          <h3>4 · Paid onchain</h3>
          <p>
            Payouts are real NEAR testnet transfers, each linked to the explorer.{" "}
            {config && (
              <a href={explorerAccount(config.network, config.escrowContract)} target="_blank" rel="noreferrer">
                View the escrow contract
              </a>
            )}
          </p>
        </div>
      </section>
    </>
  );
}
