import { useCallback, useEffect, useState } from "react";
import { api, getToken, setToken, type PublicConfig } from "./api";
import { CreateJob } from "./CreateJob";
import { JobDetail } from "./JobDetail";
import { JobList } from "./JobList";
import { connectedAccount, initWallet, login, type Wallet } from "./wallet";

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
        <span className="muted">{config ? `${config.network} · ${config.escrowContract}` : "loading..."}</span>
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
        {!session && (
          <section className="card">
            <h2>Verifiable work agreements on NEAR testnet</h2>
            <p>
              Connect a NEAR <strong>testnet</strong> wallet, then sign in. Signing in signs a message with your wallet; it does not
              send a transaction or move funds. Every payment step is a transaction you approve in your wallet.
            </p>
          </section>
        )}
        {session && route === "#/new" && <CreateJob session={session} />}
        {session && jobMatch && <JobDetail session={session} jobId={jobMatch[1]!} />}
        {session && !jobMatch && route !== "#/new" && <JobList />}
      </main>
    </div>
  );
}
