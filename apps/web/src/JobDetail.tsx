import { useCallback, useEffect, useState } from "react";
import { api, nearToYocto, yoctoToNear, type ChainSnapshot, type ContractCall, type Job, type Milestone, type MilestoneTerms, type Verification } from "./api";
import type { Session } from "./App";
import { fmtDate, isUnclaimedBounty, money, nextAction, planKind, title } from "./derive";
import { Timeline } from "./Timeline";
import { AgreementBadge, Badge, MilestoneBadge, MoneyBar, NextStep, Stepper } from "./ui";
import { explorerAccount, explorerTx, sendCall } from "./wallet";

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

  // Right after create_agreement the chain read can trail by a few blocks; re-check briefly.
  const awaitingChain = !!job && job.state.status === "DRAFT" && !chain?.agreement && !chain?.error;
  useEffect(() => {
    if (!awaitingChain) return;
    let tries = 0;
    const t = setInterval(() => {
      tries += 1;
      if (tries > 10) clearInterval(t);
      load().catch(() => undefined);
    }, 3000);
    return () => clearInterval(t);
  }, [awaitingChain, load]);

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
      setError(friendlyError(e instanceof Error ? e.message : String(e)));
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

  const act = (label: string, action: Record<string, unknown>, after?: () => Promise<unknown>) =>
    run(label, async () => {
      const r = await api<{ contractCall: ContractCall | null }>("POST", `/v1/jobs/${jobId}/actions`, action);
      if (r.contractCall) await sign(label, r.contractCall);
      if (after) await after();
    });

  // Keep the page current without reloads: the other party's actions and automatic steps
  // (recorded results, finalize, payout) appear on their own.
  useEffect(() => {
    const t = setInterval(() => {
      if (!busy && document.visibilityState === "visible") load().catch(() => undefined);
    }, 5000);
    return () => clearInterval(t);
  }, [busy, load]);

  // While the verifier service has something to do (verify, record, finalize, pay out), make
  // sure it is awake: on free hosting it sleeps and only wakes for outside traffic.
  const verifierHasWork = !!job?.state.milestones.some((m) => ["SUBMITTED", "VERIFIED_PENDING_CHALLENGE", "CLAIMABLE", "PAYOUT_PENDING"].includes(m.status));
  useEffect(() => {
    if (!verifierHasWork) return;
    wakeVerifier(session.config.workerWakeUrl);
    const t = setInterval(() => wakeVerifier(session.config.workerWakeUrl), 10_000);
    return () => clearInterval(t);
  }, [verifierHasWork, session.config.workerWakeUrl]);

  const signOnly = (label: string, call: ContractCall) => run(label, () => sign(label, call));

  if (error && !job) return <p className="error">{error}</p>;
  if (!job) return <p className="muted">Loading the agreement and reading the escrow contract…</p>;

  const { terms } = job.state;
  const is = (role: string) => job.roles.includes(role);
  const onchain = chain?.agreement;
  const net = session.config.network;
  const me = session.accountId;
  const unclaimed = isUnclaimedBounty(job);
  const you = (account: string) => (account === me ? <Badge tone="accent">you</Badge> : null);

  return (
    <div className="stack">
      <a href="#/" className="small">
        ← Dashboard
      </a>

      <section className="card">
        <div className="card-head">
          <div style={{ minWidth: 0 }}>
            <div className="row">
              <AgreementBadge status={job.state.status} />
              {terms.openBounty && job.state.status !== "OPEN" && <Badge tone="violet">bounty</Badge>}
              <span className="mono faint">{job.id}</span>
            </div>
            <h1 style={{ marginTop: 8, fontSize: "1.5rem" }}>{title(job)}</h1>
          </div>
          <span className="spacer" />
          <div style={{ textAlign: "right" }}>
            <div className="amount" style={{ fontSize: "1.6rem" }}>
              {yoctoToNear(terms.totalYocto)} NEAR
            </div>
            <div className="muted small">{terms.milestones.length === 1 ? "1 milestone" : `${terms.milestones.length} milestones`}</div>
          </div>
        </div>

        <NextStep action={nextAction(job, me)} />

        <div style={{ marginTop: 18 }}>
          <MoneyBar m={money(job)} />
        </div>

        <div className="parties" style={{ marginTop: 18 }}>
          <div className="party">
            <div className="role">Client {you(terms.client.nearAccountId)}</div>
            <div className="mono">{terms.client.nearAccountId}</div>
          </div>
          <div className="party">
            <div className="role">Worker {you(terms.worker.nearAccountId)}</div>
            {unclaimed ? (
              <div className="small">Not claimed yet · claim by {fmtDate(terms.fundingDeadline)}</div>
            ) : (
              <div className="mono">
                {terms.worker.nearAccountId} <span className="faint">({terms.worker.kind.toLowerCase()})</span>
              </div>
            )}
          </div>
          <div className="party">
            <div className="role">Verifier</div>
            <div className="mono">{terms.verifierAuthority}</div>
          </div>
          <div className="party">
            <div className="role">Resolver {you(terms.disputeResolver)}</div>
            <div className="mono">{terms.disputeResolver}</div>
          </div>
        </div>

        {job.state.status === "DRAFT" && job.calls.postBounty && (
          <div className="action-box">
            {is("client") && !onchain && !txs.some((t) => t.label === "post_bounty") && (
              <div className="actions">
                <button disabled={!!busy} onClick={() => signOnly("post_bounty", job.calls.postBounty!)}>
                  Post bounty onchain
                </button>
                <span className="muted small">Deposits {yoctoToNear(terms.totalYocto)} NEAR plus storage; unused storage is refunded.</span>
              </div>
            )}
            {!onchain && txs.some((t) => t.label === "post_bounty") && (
              <span className="muted">Waiting for the network to confirm post_bounty… this page refreshes itself.</span>
            )}
          </div>
        )}
        {job.state.status === "OPEN" && (job.calls.claimBounty || job.calls.cancelBounty) && (
          <div className="action-box">
            <div className="actions">
              {job.calls.claimBounty && (
                <button disabled={!!busy} onClick={() => signOnly("claim_bounty", job.calls.claimBounty!)}>
                  Claim this bounty
                </button>
              )}
              {job.calls.cancelBounty && (
                <button className="danger" disabled={!!busy} onClick={() => signOnly("cancel_bounty", job.calls.cancelBounty!)}>
                  Cancel bounty and refund
                </button>
              )}
            </div>
            <span className="muted small">
              {job.calls.claimBounty
                ? `${yoctoToNear(terms.totalYocto)} NEAR is already in escrow. The first claim the contract executes wins; read the milestones below first.`
                : "You get the whole deposit back. Not possible once someone has claimed it."}
            </span>
          </div>
        )}

        {job.state.status === "DRAFT" && !job.calls.postBounty && (
          <div className="action-box">
            <div className="actions">
              {is("client") && !onchain && job.calls.createAgreement && !txs.some((t) => t.label === "create_agreement") && (
                <button disabled={!!busy} onClick={() => signOnly("create_agreement", job.calls.createAgreement!)}>
                  Create onchain (storage deposit)
                </button>
              )}
              {is("worker") && !job.state.acceptedBy.worker && (
                <button disabled={!!busy || !onchain} onClick={() => act("accept_terms", { type: "ACCEPT_TERMS", termsHash: job.state.termsHash })}>
                  Accept terms
                </button>
              )}
              {is("client") && (
                <button disabled={!!busy || !job.state.acceptedBy.worker || !onchain} onClick={() => signOnly("fund", job.calls.fund!)}>
                  Fund escrow · {yoctoToNear(terms.totalYocto)} NEAR
                </button>
              )}
            </div>
            <span className="muted small">
              {!onchain && txs.some((t) => t.label === "create_agreement")
                ? "Waiting for the network to confirm create_agreement… this page refreshes itself."
                : !onchain
                  ? "The client creates the agreement onchain first; then the worker accepts and the client funds."
                  : !job.state.acceptedBy.worker
                    ? "Waiting for the worker to accept these exact terms before funding."
                    : "Funding deposits exactly the total; the terms are locked from then on."}
            </span>
          </div>
        )}
      </section>

      {busy && (
        <div className="callout warn">
          <span className="icon">⏳</span>
          <div>
            <strong>Working on {busy.replace(/_/g, " ")}…</strong>
            {pendingCall && <span>Approve the transaction in your wallet window.</span>}
          </div>
        </div>
      )}
      {error && (
        <div className="callout warn">
          <span className="icon">!</span>
          <div>{error}</div>
        </div>
      )}
      {chain?.termsMatch === false && (
        <div className="callout warn">
          <span className="icon">!</span>
          <div>
            <strong>The onchain terms do not match this agreement.</strong> Do not fund it.
          </div>
        </div>
      )}
      {chain && chain.divergences.length > 0 && (
        <div className="callout warn">
          <span className="icon">↻</span>
          <div>
            <strong>The website and the chain disagree.</strong>
            <span>
              {chain.divergences.map((d) => `${d.milestoneId}: ${d.offchain.toLowerCase()} here, ${d.onchain.toLowerCase()} onchain`).join("; ")}. Money always follows the
              chain. If a wallet transaction was cancelled, retry it.
            </span>
            {pendingCall && (
              <div className="actions" style={{ marginTop: 8 }}>
                <button disabled={!!busy} onClick={() => signOnly(pendingCall.label, pendingCall.call)}>
                  Retry {pendingCall.label.replace(/_/g, " ")} onchain
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      <h2 className="section-title">Milestones</h2>
      {job.state.milestones.map((m, i) => (
        <MilestoneCard
          key={m.id}
          m={m}
          terms={terms.milestones[i]!}
          onchainStatus={onchain?.milestones[i]?.status}
          onchainSubmissionSeq={onchain?.milestones[i]?.submission?.seq ?? null}
          job={job}
          verifications={verifications.filter((v) => v.milestoneId === m.id)}
          busy={!!busy}
          act={act}
          signOnly={signOnly}
          run={run}
          network={net}
        />
      ))}

      <Timeline job={job} me={me} refreshKey={job.version} />

      <section className="card">
        <div className="card-head">
          <h3>Onchain record</h3>
          <span className="spacer" />
          <button className="secondary" disabled={!!busy} onClick={() => run("sync", () => api("POST", `/v1/jobs/${jobId}/sync`).then(() => undefined))}>
            Refresh from chain
          </button>
        </div>
        <dl className="kv">
          <dt>Contract status</dt>
          <dd>{chain?.error ? <span className="error">chain unavailable: {chain.error}</span> : onchain ? onchain.status : "not onchain yet"}</dd>
          <dt>Escrow contract</dt>
          <dd>
            <a className="mono" href={explorerAccount(net, session.config.escrowContract)} target="_blank" rel="noreferrer">
              {session.config.escrowContract}
            </a>
          </dd>
          <dt>Terms hash</dt>
          <dd className="mono">{job.onchainTermsHash}</dd>
          <dt>Challenge window</dt>
          <dd>{terms.challengePeriodSec >= 3600 ? `${terms.challengePeriodSec / 3600} h` : `${Math.round(terms.challengePeriodSec / 60)} min`} after a PASS</dd>
          <dt>{terms.openBounty ? "Claim deadline" : "Funding deadline"}</dt>
          <dd>{fmtDate(terms.fundingDeadline)}</dd>
          <dt>Expires</dt>
          <dd>{fmtDate(terms.expiresAt)}</dd>
          <dt>Your transactions</dt>
          <dd>
            {txs.length === 0 && <span className="muted">None from this browser yet.</span>}
            {txs.map((t) => (
              <div key={t.hash}>
                {t.label.replace(/_/g, " ")}:{" "}
                <a href={explorerTx(net, t.hash)} target="_blank" rel="noreferrer" className="mono">
                  {t.hash.slice(0, 10)}…
                </a>
              </div>
            ))}
          </dd>
        </dl>
      </section>
    </div>
  );
}

interface CardProps {
  m: Milestone;
  terms: MilestoneTerms;
  onchainStatus: string | undefined;
  /** The submission the contract is waiting on a result for; only its report can be recorded. */
  onchainSubmissionSeq: number | null;
  job: Job;
  verifications: Verification[];
  busy: boolean;
  act: (label: string, action: Record<string, unknown>, after?: () => Promise<unknown>) => Promise<void>;
  signOnly: (label: string, call: ContractCall) => Promise<void>;
  run: (label: string, fn: () => Promise<void>) => Promise<void>;
  network: string;
}

function MilestoneCard({ m, terms, onchainStatus, onchainSubmissionSeq, job, verifications, busy, act, signOnly, run }: CardProps) {
  const [artifact, setArtifact] = useState("");
  const [uri, setUri] = useState("");
  const [text, setText] = useState("");
  const [amount, setAmount] = useState("");
  const [evidence, setEvidence] = useState<EvidenceResponse | null>(null);
  const is = (role: string) => job.roles.includes(role);
  const funded = job.state.status === "FUNDED";
  const human = terms.type === "HUMAN_REVIEW";
  const plan = (terms.verificationPlan ?? {}) as { kind?: string; repo?: string; branch?: string; requiredChecks?: string[]; repeat?: { count: number; intervalMs: number } };
  const github = plan.kind === "GITHUB_CHECKS";
  const ms = { milestoneId: m.id };
  const s = m.status;

  const fixtureBase = `${window.location.origin}/fixture`;

  const kindDetail = human
    ? `${m.revisionsUsed} of ${terms.maxRevisions} revisions used`
    : github
      ? `a commit merged into ${plan.repo} ${plan.branch} whose checks ${plan.requiredChecks?.join(", ")} succeeded`
      : plan.repeat
        ? `${plan.repeat.count} probes ${plan.repeat.intervalMs / 1000} s apart, every one must pass`
        : "one request to the delivered API; every agreed check must pass";

  return (
    <section className="card">
      <div className="card-head" style={{ marginBottom: 4 }}>
        <div style={{ minWidth: 0 }}>
          <h3>{terms.title}</h3>
          <div className="li-meta" style={{ marginTop: 4 }}>
            <Badge tone={human ? "violet" : "info"}>{planKind(terms)}</Badge>
            <MilestoneBadge status={s} />
            <span className="faint mono">{terms.id}</span>
          </div>
        </div>
        <span className="spacer" />
        <span className="amount">{yoctoToNear(terms.amountYocto)} NEAR</span>
      </div>
      <Stepper m={m} terms={terms} />

      <dl className="kv" style={{ marginTop: 12 }}>
        <dt>How it is judged</dt>
        <dd>{kindDetail}</dd>
        {human && terms.rubric && (
          <>
            <dt>Rubric</dt>
            <dd>{terms.rubric}</dd>
          </>
        )}
        <dt>Status</dt>
        <dd>
          {STATUS_TEXT[s] ?? s} <span className="faint small">· onchain {onchainStatus ?? "—"}</span>
        </dd>
        {m.submission && (
          <>
            <dt>Submission #{m.submission.seq}</dt>
            <dd className="mono">
              {m.submission.artifactHash}
              {m.submission.uri && (
                <>
                  {" · "}
                  {/^https?:\/\//.test(m.submission.uri) ? (
                    <a href={m.submission.uri} target="_blank" rel="noreferrer">
                      {m.submission.uri}
                    </a>
                  ) : (
                    m.submission.uri
                  )}
                </>
              )}
            </dd>
          </>
        )}
        {m.challengeEndsAt && (
          <>
            <dt>Challenge window ends</dt>
            <dd>{fmtDate(m.challengeEndsAt)}</dd>
          </>
        )}
        {m.settlementProposal && (
          <>
            <dt>Settlement proposal</dt>
            <dd>
              {yoctoToNear(m.settlementProposal.workerYocto)} NEAR to the worker, proposed by {m.settlementProposal.proposer}
            </dd>
          </>
        )}
        {m.allocation && (
          <>
            <dt>Split</dt>
            <dd>
              {yoctoToNear(m.allocation.workerYocto)} NEAR to the worker · {yoctoToNear(m.allocation.clientYocto)} NEAR back to the client
            </dd>
          </>
        )}
        {human && terms.partialCompensation && (
          <>
            <dt>Protected minimum</dt>
            <dd>{yoctoToNear(terms.partialCompensation.floorYocto)} NEAR once a deliverable is submitted</dd>
          </>
        )}
      </dl>

      {funded && (
        <div className="actions" style={{ marginTop: 14 }}>
          {is("worker") && (s === "PENDING" || s === "REVISION_REQUESTED") && (
            <div className="inline-form">
              <input
                placeholder={human ? "content hash of the deliverable" : github ? `full commit SHA merged into ${plan.branch}` : "git commit SHA"}
                value={artifact}
                onChange={(e) => setArtifact(e.target.value)}
              />
              <input
                placeholder={human ? "link to the deliverable (optional)" : github ? "pull request link (optional)" : `deployment base URL, e.g. ${fixtureBase}/broken`}
                value={uri}
                onChange={(e) => setUri(e.target.value)}
              />
              <button
                disabled={busy || !artifact}
                onClick={() =>
                  act("submit", { type: "SUBMIT", ...ms, artifactHash: artifact, ...(uri ? { uri } : {}) }, human || (!github && !uri) ? undefined : () => api("POST", `/v1/jobs/${job.id}/milestones/${m.id}/verifications`))
                }
              >
                {human ? "Submit work" : "Submit and verify"}
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
              {is("worker") ? "Claim payment" : "Release payment"} (onchain transfer)
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
        <div className="table-wrap">
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
                <td className="mono">{v.id.slice(0, 12)}…</td>
                <td>#{v.submissionSeq}</td>
                <td>
                  <Badge tone={v.outcome === "PASS" ? "ok" : v.outcome === "FAIL" ? "bad" : v.outcome ? "warn" : "neutral"}>{v.outcome ?? v.status.toLowerCase()}</Badge>
                  {v.error && <div className="small muted">{v.error}</div>}
                </td>
                <td>
                  {v.status === "DONE" && (
                    <>
                      <button className="secondary" onClick={() => api<EvidenceResponse>("GET", `/v1/verifications/${v.id}/evidence`).then(setEvidence)}>
                        Evidence
                      </button>
                      {v.contractCall && onchainStatus === "Submitted" && onchainSubmissionSeq === v.submissionSeq && (
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
        </div>
      )}
      {evidence !== null && <EvidenceView data={evidence} onClose={() => setEvidence(null)} />}
    </section>
  );
}

/** Turns raw contract/wallet errors into something a person can act on. */
function friendlyError(message: string): string {
  if (/agreement id already exists/i.test(message)) {
    return "This agreement is already created onchain (your earlier transaction went through). Reload the page to continue.";
  }
  if (/expected one of \[Submitted\]/i.test(message)) {
    return "Nothing to record: the contract is not waiting on this result (it was probably recorded already). Reload the page.";
  }
  if (/challenge period has not ended/i.test(message)) return "The challenge window is still open. Wait until the end time shown, then reload and try again.";
  if (/User closed the window|User rejected|rejected/i.test(message)) return "The wallet request was cancelled. Nothing was sent.";
  return message;
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
