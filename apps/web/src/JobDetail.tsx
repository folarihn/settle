import { useCallback, useEffect, useState } from "react";
import { api, nearToYocto, yoctoToNear, type ChainSnapshot, type ContractCall, type Job, type Milestone, type MilestoneTerms, type Verification } from "./api";
import type { Session } from "./App";
import { explorerTx, sendCall } from "./wallet";

interface TxRecord {
  label: string;
  hash: string;
}

/**
 * One job, every role. Each button records the action through the API (domain rules),
 * then asks the wallet to sign the matching contract call, then syncs from the chain.
 * Money (funding, payouts) is only ever shown as the contract reports it.
 */
export function JobDetail({ session, jobId }: { session: Session; jobId: string }) {
  const [job, setJob] = useState<Job | null>(null);
  const [chain, setChain] = useState<ChainSnapshot | null>(null);
  const [verifications, setVerifications] = useState<Verification[]>([]);
  const [txs, setTxs] = useState<TxRecord[]>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(`settle.tx.${jobId}`) ?? "[]");
    } catch {
      return [];
    }
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingCall, setPendingCall] = useState<{ label: string; call: ContractCall } | null>(null);

  const load = useCallback(async () => {
    const [j, v] = await Promise.all([
      api<{ job: Job; chain: ChainSnapshot }>("GET", `/v1/jobs/${jobId}`),
      api<{ verifications: Verification[] }>("GET", `/v1/jobs/${jobId}/verifications`),
    ]);
    setJob(j.job);
    setChain(j.chain);
    setVerifications(v.verifications);
  }, [jobId]);

  useEffect(() => {
    load().catch((e: Error) => setError(e.message));
  }, [load]);

  // While a verification is queued or running, poll for its result.
  useEffect(() => {
    if (!verifications.some((v) => v.status === "QUEUED" || v.status === "RUNNING")) return;
    wakeVerifier(session.config.workerWakeUrl);
    const t = setInterval(() => {
      wakeVerifier(session.config.workerWakeUrl);
      load().catch(() => undefined);
    }, 2000);
    return () => clearInterval(t);
  }, [verifications, load, session.config.workerWakeUrl]);

  const recordTx = (label: string, hash: string) => {
    setTxs((prev) => {
      const next = [{ label, hash }, ...prev].slice(0, 30);
      try {
        sessionStorage.setItem(`settle.tx.${jobId}`, JSON.stringify(next));
      } catch {
        // storage unavailable: keep in memory
      }
      return next;
    });
  };

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      await load().catch(() => undefined);
    }
  };

  const sign = async (label: string, call: ContractCall) => {
    setPendingCall({ label, call });
    const hash = await sendCall(session.wallet, call);
    setPendingCall(null);
    recordTx(label, hash);
    // The API reads the contract at "final" finality, which trails inclusion by a few blocks.
    await new Promise((r) => setTimeout(r, 3000));
    await api("POST", `/v1/jobs/${jobId}/sync`);
  };

  const act = (label: string, action: Record<string, unknown>) =>
    run(label, async () => {
      const r = await api<{ contractCall: ContractCall | null }>("POST", `/v1/jobs/${jobId}/actions`, action);
      if (r.contractCall) await sign(label, r.contractCall);
    });

  const signOnly = (label: string, call: ContractCall) => run(label, () => sign(label, call));

  if (error && !job) return <p className="error">{error}</p>;
  if (!job) return <p className="muted">Loading...</p>;

  const { terms } = job.state;
  const is = (role: string) => job.roles.includes(role);
  const onchain = chain?.agreement;
  const net = session.config.network;

  return (
    <div className="stack">
      <section className="card">
        <div className="row">
          <h2>{job.id}</h2>
          <span className="spacer" />
          <button className="secondary" disabled={!!busy} onClick={() => run("sync", () => api("POST", `/v1/jobs/${jobId}/sync`).then(() => undefined))}>
            Refresh from chain
          </button>
        </div>
        <dl className="grid">
          <dt>Your role</dt>
          <dd>{job.roles.join(", ")}</dd>
          <dt>Client</dt>
          <dd>{terms.client.nearAccountId}</dd>
          <dt>Worker</dt>
          <dd>
            {terms.worker.nearAccountId} ({terms.worker.kind.toLowerCase()})
          </dd>
          <dt>Resolver</dt>
          <dd>{terms.disputeResolver}</dd>
          <dt>Total</dt>
          <dd>{yoctoToNear(terms.totalYocto)} NEAR</dd>
          <dt>Offchain status</dt>
          <dd>{job.state.status}</dd>
          <dt>Onchain status</dt>
          <dd>
            {chain?.error ? <span className="error">chain unavailable: {chain.error}</span> : onchain ? onchain.status : "not created onchain yet"}
            {chain?.termsMatch === false && <span className="error"> — onchain terms do not match; do not fund</span>}
          </dd>
          <dt>Terms hash (onchain)</dt>
          <dd className="mono">{job.onchainTermsHash}</dd>
        </dl>

        {job.state.status === "DRAFT" && (
          <div className="actions">
            {is("client") && !onchain && job.calls.createAgreement && (
              <button disabled={!!busy} onClick={() => signOnly("create_agreement", job.calls.createAgreement!)}>
                Create onchain (storage deposit)
              </button>
            )}
            {is("worker") && !job.state.acceptedBy.worker && (
              <button disabled={!!busy || !onchain} onClick={() => act("accept_terms", { type: "ACCEPT_TERMS", termsHash: job.state.termsHash })}>
                Accept terms {onchain ? "" : "(waiting for client to create onchain)"}
              </button>
            )}
            {is("client") && (
              <button disabled={!!busy || !job.state.acceptedBy.worker || !onchain} onClick={() => signOnly("fund", job.calls.fund!)}>
                Fund escrow ({yoctoToNear(terms.totalYocto)} NEAR) {job.state.acceptedBy.worker ? "" : "— waiting for worker to accept"}
              </button>
            )}
          </div>
        )}
      </section>

      {busy && <p className="notice">Working on {busy}... {pendingCall && "Approve the transaction in your wallet popup."}</p>}
      {error && <p className="error">{error}</p>}
      {chain && chain.divergences.length > 0 && (
        <p className="notice">
          Onchain and offchain records differ: {chain.divergences.map((d) => `${d.milestoneId} ${d.offchain} vs ${d.onchain}`).join("; ")}. If a wallet
          transaction was rejected, retry it below; money always follows the onchain status.
          {pendingCall && (
            <button disabled={!!busy} onClick={() => signOnly(pendingCall.label, pendingCall.call)}>
              Retry {pendingCall.label} onchain
            </button>
          )}
        </p>
      )}

      {job.state.milestones.map((m, i) => (
        <MilestoneCard
          key={m.id}
          m={m}
          terms={terms.milestones[i]!}
          onchainStatus={onchain?.milestones[i]?.status}
          job={job}
          verifications={verifications.filter((v) => v.milestoneId === m.id)}
          busy={!!busy}
          act={act}
          signOnly={signOnly}
          run={run}
          network={net}
        />
      ))}

      <section className="card">
        <h3>Your transactions</h3>
        {txs.length === 0 && <p className="muted">None yet from this browser.</p>}
        <ul>
          {txs.map((t) => (
            <li key={t.hash}>
              {t.label}:{" "}
              <a href={explorerTx(net, t.hash)} target="_blank" rel="noreferrer" className="mono">
                {t.hash}
              </a>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

interface CardProps {
  m: Milestone;
  terms: MilestoneTerms;
  onchainStatus: string | undefined;
  job: Job;
  verifications: Verification[];
  busy: boolean;
  act: (label: string, action: Record<string, unknown>) => Promise<void>;
  signOnly: (label: string, call: ContractCall) => Promise<void>;
  run: (label: string, fn: () => Promise<void>) => Promise<void>;
  network: string;
}

function MilestoneCard({ m, terms, onchainStatus, job, verifications, busy, act, signOnly, run }: CardProps) {
  const [artifact, setArtifact] = useState("");
  const [uri, setUri] = useState("");
  const [text, setText] = useState("");
  const [amount, setAmount] = useState("");
  const [evidence, setEvidence] = useState<EvidenceResponse | null>(null);
  const is = (role: string) => job.roles.includes(role);
  const funded = job.state.status === "FUNDED";
  const human = terms.type === "HUMAN_REVIEW";
  const ms = { milestoneId: m.id };
  const s = m.status;

  const fixtureBase = `${window.location.origin}/fixture`;

  return (
    <section className="card">
      <div className="row">
        <h3>
          {terms.title} <span className="muted">({terms.id})</span>
        </h3>
        <span className="spacer" />
        <span className="pill">{yoctoToNear(terms.amountYocto)} NEAR</span>
      </div>
      <dl className="grid">
        <dt>Type</dt>
        <dd>
          <span className={`pill ${human ? "kind-human" : "kind-auto"}`}>{human ? "Human review" : "Automated verification"}</span>{" "}
          {human ? `${m.revisionsUsed}/${terms.maxRevisions} revisions used` : "an independent verifier signs PASS or FAIL"}
        </dd>
        <dt>Status</dt>
        <dd>
          <strong>{STATUS_TEXT[s] ?? s}</strong>
          <div className="muted small">
            offchain {s} · onchain {onchainStatus ?? "—"}
          </div>
        </dd>
        {m.submission && (
          <>
            <dt>Current submission</dt>
            <dd className="mono">
              #{m.submission.seq} {m.submission.artifactHash} {m.submission.uri ?? ""}
            </dd>
          </>
        )}
        {m.challengeEndsAt && (
          <>
            <dt>Challenge window ends</dt>
            <dd>{new Date(m.challengeEndsAt).toLocaleString()}</dd>
          </>
        )}
        {m.settlementProposal && (
          <>
            <dt>Settlement proposal</dt>
            <dd>
              {yoctoToNear(m.settlementProposal.workerYocto)} NEAR to worker, proposed by {m.settlementProposal.proposer}
            </dd>
          </>
        )}
        {m.allocation && (
          <>
            <dt>Allocated</dt>
            <dd>
              worker {yoctoToNear(m.allocation.workerYocto)} NEAR · client refund {yoctoToNear(m.allocation.clientYocto)} NEAR
            </dd>
          </>
        )}
        {human && terms.partialCompensation && (
          <>
            <dt>Protected floor</dt>
            <dd>{yoctoToNear(terms.partialCompensation.floorYocto)} NEAR once a deliverable is submitted</dd>
          </>
        )}
      </dl>

      {funded && (
        <div className="actions">
          {is("worker") && (s === "PENDING" || s === "REVISION_REQUESTED") && (
            <div className="inline-form">
              <input placeholder={human ? "content hash of the deliverable" : "git commit SHA"} value={artifact} onChange={(e) => setArtifact(e.target.value)} />
              <input placeholder={human ? "link to the deliverable (optional)" : `deployment base URL, e.g. ${fixtureBase}/broken`} value={uri} onChange={(e) => setUri(e.target.value)} />
              <button disabled={busy || !artifact} onClick={() => act("submit", { type: "SUBMIT", ...ms, artifactHash: artifact, ...(uri ? { uri } : {}) })}>
                Submit work
              </button>
            </div>
          )}

          {!human && s === "SUBMITTED" && (is("client") || is("worker")) && (
            <button
              disabled={busy || verifications.some((v) => v.status === "QUEUED" || v.status === "RUNNING")}
              onClick={() => run("verification", () => api("POST", `/v1/jobs/${job.id}/milestones/${m.id}/verifications`).then(() => undefined))}
            >
              Run verification
            </button>
          )}

          {human && s === "SUBMITTED" && is("client") && (
            <>
              <button disabled={busy} onClick={() => act("approve", { type: "APPROVE", ...ms })}>
                Approve and release
              </button>
              <input placeholder="feedback / reason" value={text} onChange={(e) => setText(e.target.value)} />
              <button disabled={busy || !text || m.revisionsUsed >= (terms.maxRevisions ?? 0)} onClick={() => act("request_revision", { type: "REQUEST_REVISION", ...ms, feedback: text })}>
                Request revision
              </button>
            </>
          )}

          {human && (s === "SUBMITTED" || s === "REVISION_REQUESTED") && (is("client") || is("worker")) && (
            <>
              {!(s === "SUBMITTED" && is("client")) && <input placeholder="reason" value={text} onChange={(e) => setText(e.target.value)} />}
              <button className="secondary" disabled={busy || !text} onClick={() => act("open_dispute", { type: "OPEN_DISPUTE", ...ms, reason: text })}>
                Open dispute
              </button>
            </>
          )}

          {human && ["SUBMITTED", "REVISION_REQUESTED", "DISPUTED"].includes(s) && (is("client") || is("worker")) && (
            <div className="inline-form">
              <input placeholder="worker share in NEAR" value={amount} onChange={(e) => setAmount(e.target.value)} />
              <button className="secondary" disabled={busy || !amount} onClick={() => act("propose_settlement", { type: "PROPOSE_SETTLEMENT", ...ms, workerYocto: nearToYocto(amount) })}>
                Propose partial settlement
              </button>
              {m.settlementProposal && !job.roles.includes(roleOf(job, m.settlementProposal.proposer)) && (
                <button disabled={busy} onClick={() => act("accept_settlement", { type: "ACCEPT_SETTLEMENT", ...ms, workerYocto: m.settlementProposal!.workerYocto })}>
                  Accept {yoctoToNear(m.settlementProposal.workerYocto)} NEAR settlement
                </button>
              )}
            </div>
          )}

          {!human && s === "VERIFIED_PENDING_CHALLENGE" && (
            <>
              {is("client") && (
                <>
                  <input placeholder="why the PASS is wrong" value={text} onChange={(e) => setText(e.target.value)} />
                  <button className="secondary" disabled={busy || !text} onClick={() => act("challenge", { type: "CHALLENGE", ...ms, reason: text })}>
                    Challenge PASS
                  </button>
                </>
              )}
              <button disabled={busy || (m.challengeEndsAt ?? 0) > Date.now()} onClick={() => act("finalize_challenge", { type: "FINALIZE_CHALLENGE", ...ms })}>
                Finalize after challenge window
              </button>
            </>
          )}

          {s === "DISPUTED" && is("resolver") && (
            <div className="inline-form">
              <input placeholder="award to worker in NEAR" value={amount} onChange={(e) => setAmount(e.target.value)} />
              <button disabled={busy || !amount} onClick={() => act("resolve_dispute", { type: "RESOLVE_DISPUTE", ...ms, workerYocto: nearToYocto(amount) })}>
                Resolve dispute
              </button>
            </div>
          )}

          {s === "CLAIMABLE" && job.calls.payout[m.id] && (is("client") || is("worker")) && (
            <button disabled={busy} onClick={() => signOnly("payout", job.calls.payout[m.id]!)}>
              Pay out (onchain transfer)
            </button>
          )}

          {(s === "PENDING" || s === "REVISION_REQUESTED") && Date.now() >= job.state.terms.expiresAt && (is("client") || is("worker")) && (
            <button className="secondary" disabled={busy} onClick={() => act("expire_milestone", { type: "EXPIRE_MILESTONE", ...ms })}>
              Expire and refund client
            </button>
          )}
        </div>
      )}

      {verifications.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Run</th>
              <th>Submission</th>
              <th>Result</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {verifications.map((v) => (
              <tr key={v.id}>
                <td className="mono">{v.id}</td>
                <td>#{v.submissionSeq}</td>
                <td className={v.outcome === "PASS" ? "ok" : v.outcome ? "bad" : ""}>
                  {v.outcome ?? v.status}
                  {v.error ? ` (${v.error})` : ""}
                </td>
                <td>
                  {v.status === "DONE" && (
                    <>
                      <button className="secondary" onClick={() => api<EvidenceResponse>("GET", `/v1/verifications/${v.id}/evidence`).then(setEvidence)}>
                        Evidence
                      </button>
                      {v.contractCall && (
                        <button className="secondary" disabled={busy} onClick={() => signOnly("record_verification", v.contractCall!)}>
                          Record onchain
                        </button>
                      )}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {evidence !== null && <EvidenceView data={evidence} onClose={() => setEvidence(null)} />}
    </section>
  );
}

let lastWake = 0;
/**
 * The verifier sleeps when idle on free hosting and only wakes for traffic from outside the
 * host, so the browser nudges it while a verification is queued (at most every 10 s).
 * `no-cors`: the response is not needed, and the route returns no data anyway.
 */
function wakeVerifier(url: string | null) {
  if (!url || Date.now() - lastWake < 10_000) return;
  lastWake = Date.now();
  fetch(`${url.replace(/\/+$/, "")}/kick`, { method: "POST", mode: "no-cors" }).catch(() => undefined);
}

const STATUS_TEXT: Record<string, string> = {
  PENDING: "Waiting for the worker to submit",
  SUBMITTED: "Submitted — awaiting verification or review",
  VERIFIED_PENDING_CHALLENGE: "PASS — challenge window open; not payable yet",
  REVISION_REQUESTED: "Revision requested — funds stay locked",
  DISPUTED: "In dispute — the resolver decides within the agreed bounds",
  CLAIMABLE: "Payable — client or worker can trigger the payout",
  PAYOUT_PENDING: "Payout transfer in progress",
  PAID: "Paid onchain",
};

interface EvidenceResponse {
  matchesReport: boolean;
  report: { outcome: string; submissionSeq: number; artifactHash: string; evidenceDigest: string; issuedAt: number };
  evidence: {
    targetUrl: string | null;
    status: number | null;
    latencyMs: number | null;
    responseBytes: number | null;
    checks: { check: string; ok: boolean; detail: string }[];
    error: { kind: string; message: string } | null;
  };
}

/** Human-readable evidence: what was called, each agreed check, and whether it matches the signed report. */
function EvidenceView({ data, onClose }: { data: EvidenceResponse; onClose: () => void }) {
  const { report, evidence, matchesReport } = data;
  return (
    <div className="evidence">
      <div className="row">
        <strong className={report.outcome === "PASS" ? "ok" : "bad"}>{report.outcome}</strong>
        <span className="muted small">
          submission #{report.submissionSeq} · {report.artifactHash} · signed {new Date(report.issuedAt).toLocaleString()}
        </span>
        <span className="spacer" />
        <button className="secondary" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="small">
        Called <span className="mono">{evidence.targetUrl ?? "—"}</span>
        {evidence.status !== null && ` → HTTP ${evidence.status}`}
        {evidence.latencyMs !== null && ` in ${evidence.latencyMs} ms`}
        {evidence.error && ` · ${evidence.error.kind}: ${evidence.error.message}`}
      </p>
      <table>
        <thead>
          <tr>
            <th>Agreed check</th>
            <th>Result</th>
            <th>Observed</th>
          </tr>
        </thead>
        <tbody>
          {evidence.checks.map((c) => (
            <tr key={c.check}>
              <td className="mono">{c.check}</td>
              <td className={c.ok ? "ok" : "bad"}>{c.ok ? "PASS" : "FAIL"}</td>
              <td className="mono">{c.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="small">
        {matchesReport
          ? "✓ This evidence hashes to the digest inside the verifier's signed report, so it has not been altered."
          : "✗ This evidence does not match the signed report's digest — do not trust it."}{" "}
        <span className="muted mono">{report.evidenceDigest}</span>
      </p>
      <details>
        <summary className="small">Raw evidence JSON</summary>
        <pre>{JSON.stringify(data, null, 2)}</pre>
      </details>
    </div>
  );
}

function roleOf(job: Job, account: string): string {
  return account === job.state.terms.client.nearAccountId ? "client" : account === job.state.terms.worker.nearAccountId ? "worker" : "";
}
