import { useCallback, useEffect, useState } from "react";
import { api, nearToYocto, yoctoToNear, type AiReview, type ChainSnapshot, type ContractCall, type Job, type Milestone, type MilestoneTerms, type Verification } from "./api";
import type { Session } from "./App";
import { fmtDate, isUnclaimedBounty, money, nextAction, planKind, title } from "./derive";
import { Timeline } from "./Timeline";
import { AgreementStatus, Icon, MilestoneStatus, MoneyLedger, NextStep, Status, Track } from "./ui";
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
  const [reviews, setReviews] = useState<AiReview[]>([]);
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
    const [j, v, r] = await Promise.all([
      api<{ job: Job; chain: ChainSnapshot }>("GET", `/v1/jobs/${jobId}`),
      api<{ verifications: Verification[] }>("GET", `/v1/jobs/${jobId}/verifications`),
      api<{ reviews: AiReview[] }>("GET", `/v1/jobs/${jobId}/reviews`).catch(() => ({ reviews: [] as AiReview[] })),
    ]);
    setJob(j.job);
    setChain(j.chain);
    setVerifications(v.verifications);
    setReviews(r.reviews);
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

  if (error && !job) return <p className="banner bad">{error}</p>;
  if (!job) return <p className="t3">Loading the agreement and reading the escrow contract…</p>;

  const { terms } = job.state;
  const is = (role: string) => job.roles.includes(role);
  const onchain = chain?.agreement;
  const net = session.config.network;
  const me = session.accountId;
  const unclaimed = isUnclaimedBounty(job);
  const you = (account: string) => (account === me ? <span className="tag">you</span> : null);
  const party = (k: string, account: string, extra?: string) => (
    <div className="fact">
      <div className="k hstack" style={{ gap: 6 }}>
        {k} {you(account)}
      </div>
      <div className="v mono">
        {account}
        {extra && <span className="t3"> · {extra}</span>}
      </div>
    </div>
  );

  return (
    <>
      <a href="#/" className="crumb">
        <Icon name="back" /> Overview
      </a>
      <div className="split">
        <div style={{ minWidth: 0 }}>
          <div className="hstack">
            <AgreementStatus status={job.state.status} />
            {terms.openBounty && job.state.status !== "OPEN" && <span className="tag">bounty</span>}
            <span className="mono t3 xs">{job.id}</span>
          </div>
          <h1 className="title-xl">{title(job)}</h1>
          <div className="hero-amount" style={{ marginTop: 22 }}>
            {yoctoToNear(terms.totalYocto)}
            <span className="unit">NEAR</span>
          </div>
          <div style={{ marginTop: 22 }}>
            <MoneyLedger m={money(job)} />
          </div>
          <div style={{ marginTop: 28 }}>
            <NextStep action={nextAction(job, me)} />
          </div>

          {job.state.status === "DRAFT" && job.calls.postBounty && is("client") && !onchain && (
            <div className="act">
              {!txs.some((t) => t.label === "post_bounty") ? (
                <div className="hstack">
                  <button className="btn" disabled={!!busy} onClick={() => signOnly("post_bounty", job.calls.postBounty!)}>
                    Post bounty onchain
                  </button>
                  <span className="sm t3">Deposits {yoctoToNear(terms.totalYocto)} NEAR plus storage; unused storage is refunded.</span>
                </div>
              ) : (
                <span className="sm t3">Waiting for the network to confirm post_bounty… this page refreshes itself.</span>
              )}
            </div>
          )}
          {job.state.status === "OPEN" && (job.calls.claimBounty || job.calls.cancelBounty) && (
            <div className="act">
              <div className="hstack">
                {job.calls.claimBounty && !session.signedIn && (
                  <a className="btn" href="#/">
                    Sign in to claim
                  </a>
                )}
                {job.calls.claimBounty && session.signedIn && (
                  <button className="btn" disabled={!!busy} onClick={() => signOnly("claim_bounty", job.calls.claimBounty!)}>
                    Claim this bounty
                  </button>
                )}
                {job.calls.cancelBounty && (
                  <button className="btn danger" disabled={!!busy} onClick={() => signOnly("cancel_bounty", job.calls.cancelBounty!)}>
                    Cancel and refund
                  </button>
                )}
              </div>
              <span className="sm t3">
                {job.calls.claimBounty
                  ? `${yoctoToNear(terms.totalYocto)} NEAR is already in escrow. The first claim the contract executes wins; read the milestones below first.`
                  : "You get the whole deposit back. Not possible once someone has claimed it."}
              </span>
            </div>
          )}
          {job.state.status === "DRAFT" && !job.calls.postBounty && (is("client") || is("worker")) && (
            <div className="act">
              <div className="hstack">
                {is("client") && !onchain && job.calls.createAgreement && !txs.some((t) => t.label === "create_agreement") && (
                  <button className="btn" disabled={!!busy} onClick={() => signOnly("create_agreement", job.calls.createAgreement!)}>
                    Create onchain
                  </button>
                )}
                {is("worker") && !job.state.acceptedBy.worker && (
                  <button className="btn" disabled={!!busy || !onchain} onClick={() => act("accept_terms", { type: "ACCEPT_TERMS", termsHash: job.state.termsHash })}>
                    Accept terms
                  </button>
                )}
                {is("client") && (
                  <button className="btn" disabled={!!busy || !job.state.acceptedBy.worker || !onchain} onClick={() => signOnly("fund", job.calls.fund!)}>
                    Fund escrow · {yoctoToNear(terms.totalYocto)} NEAR
                  </button>
                )}
              </div>
              <span className="sm t3">
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

          <div className="vstack" style={{ gap: 10, marginTop: 20 }}>
            {busy && (
              <p className="banner">
                Working on {busy.replace(/_/g, " ")}…{pendingCall && " Approve the transaction in your wallet window."}
              </p>
            )}
            {error && <p className="banner bad">{error}</p>}
            {chain?.termsMatch === false && <p className="banner bad">The onchain terms do not match this agreement. Do not fund it.</p>}
            {chain && chain.divergences.length > 0 && (
              <div className="banner">
                The record here and the chain disagree:{" "}
                {chain.divergences.map((d) => `${d.milestoneId} is ${d.offchain.toLowerCase()} here, ${d.onchain.toLowerCase()} onchain`).join("; ")}. Money always
                follows the chain; if a wallet request was cancelled, retry it.
                {pendingCall && (
                  <div style={{ marginTop: 8 }}>
                    <button className="btn secondary" disabled={!!busy} onClick={() => signOnly(pendingCall.label, pendingCall.call)}>
                      Retry {pendingCall.label.replace(/_/g, " ")} onchain
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          <section className="section">
            <div className="section-head">
              <h2>Milestones</h2>
              <span className="count">{terms.milestones.length}</span>
            </div>
            <div>
              {job.state.milestones.map((m, i) => (
                <MilestoneCard
                  key={m.id}
                  index={i + 1}
                  m={m}
                  terms={terms.milestones[i]!}
                  onchainStatus={onchain?.milestones[i]?.status}
                  onchainSubmissionSeq={onchain?.milestones[i]?.submission?.seq ?? null}
                  job={job}
                  verifications={verifications.filter((v) => v.milestoneId === m.id)}
                  review={reviews.find((r) => r.milestoneId === m.id && r.submissionSeq === m.submission?.seq) ?? null}
                  busy={!!busy}
                  act={act}
                  signOnly={signOnly}
                  run={run}
                  network={net}
                />
              ))}
            </div>
          </section>
        </div>

        <aside className="aside">
          <div className="block">
            <div className="label">Parties</div>
            <div className="facts">
              {party("Client", terms.client.nearAccountId, terms.client.kind === "AGENT" ? "AI agent" : "person")}
              {unclaimed ? (
                <div className="fact">
                  <div className="k">Worker</div>
                  <div className="v">Not claimed yet · claims close {fmtDate(terms.fundingDeadline)}</div>
                </div>
              ) : (
                party("Worker", terms.worker.nearAccountId, terms.worker.kind === "AGENT" ? "AI agent" : "person")
              )}
              {party("Verifier", terms.verifierAuthority)}
              {party("Resolver", terms.disputeResolver)}
            </div>
          </div>

          <div className="block">
            <div className="label">Terms</div>
            <div className="facts">
              <div className="fact">
                <div className="k">Challenge window</div>
                <div className="v">{terms.challengePeriodSec >= 3600 ? `${terms.challengePeriodSec / 3600} h` : `${Math.round(terms.challengePeriodSec / 60)} min`} after a PASS</div>
              </div>
              <div className="fact">
                <div className="k">{terms.openBounty ? "Claim deadline" : "Funding deadline"}</div>
                <div className="v">{fmtDate(terms.fundingDeadline)}</div>
              </div>
              <div className="fact">
                <div className="k">Expires</div>
                <div className="v">{fmtDate(terms.expiresAt)}</div>
              </div>
            </div>
          </div>

          <div className="block">
            <div className="hstack">
              <div className="label grow">Onchain</div>
              {session.signedIn && (
                <button className="btn ghost" style={{ height: 26, padding: "0 8px", fontSize: 12.5 }} disabled={!!busy} onClick={() => run("sync", () => api("POST", `/v1/jobs/${jobId}/sync`).then(() => undefined))}>
                  Refresh
                </button>
              )}
            </div>
            <div className="facts">
              <div className="fact">
                <div className="k">Contract status</div>
                <div className="v">{chain?.error ? <span className="error">unavailable: {chain.error}</span> : onchain ? onchain.status : "Not onchain yet"}</div>
              </div>
              <div className="fact">
                <div className="k">Escrow contract</div>
                <a className="v mono link" href={explorerAccount(net, session.config.escrowContract)} target="_blank" rel="noreferrer">
                  {session.config.escrowContract}
                </a>
              </div>
              <div className="fact">
                <div className="k">Terms hash</div>
                <div className="v mono t2">{job.onchainTermsHash}</div>
              </div>
              {txs.length > 0 && (
                <div className="fact">
                  <div className="k">Your transactions</div>
                  {txs.map((t) => (
                    <div key={t.hash} className="v sm">
                      {t.label.replace(/_/g, " ")} ·{" "}
                      <a href={explorerTx(net, t.hash)} target="_blank" rel="noreferrer" className="mono link">
                        {t.hash.slice(0, 10)}…
                      </a>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <Timeline job={job} me={me} refreshKey={job.version} />
        </aside>
      </div>
    </>
  );
}

interface CardProps {
  index: number;
  review: AiReview | null;
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

function MilestoneCard({ index, review, m, terms, onchainStatus, onchainSubmissionSeq, job, verifications, busy, act, signOnly, run }: CardProps) {
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
      ? `A commit merged into ${plan.repo} ${plan.branch} whose checks ${plan.requiredChecks?.join(", ")} succeeded`
      : plan.repeat
        ? `${plan.repeat.count} probes ${plan.repeat.intervalMs / 1000} s apart; every one must pass`
        : "One request to the delivered API; every agreed check must pass";

  return (
    <article className="ms">
      <div className="ms-head">
        <span className="ms-index">{String(index).padStart(2, "0")}</span>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="ms-title">{terms.title}</div>
          <div className="hstack" style={{ marginTop: 6, gap: 12 }}>
            <MilestoneStatus status={s} />
            <span className="tag">{planKind(terms)}</span>
          </div>
        </div>
        <span className="num" style={{ fontSize: 16 }}>
          {yoctoToNear(terms.amountYocto)} <span className="t3 xs">NEAR</span>
        </span>
      </div>

      <div className="ms-body">
        <Track m={m} terms={terms} />

        <dl className="dl">
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
            {STATUS_TEXT[s] ?? s} <span className="t3 sm">· onchain {onchainStatus ?? "—"}</span>
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
                      <a className="link" href={m.submission.uri} target="_blank" rel="noreferrer">
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
              <dt>Proposed split</dt>
              <dd>
                <span className="num">{yoctoToNear(m.settlementProposal.workerYocto)}</span> NEAR to the worker, proposed by{" "}
                <span className="mono">{m.settlementProposal.proposer}</span>
              </dd>
            </>
          )}
          {m.allocation && (
            <>
              <dt>Split</dt>
              <dd>
                <span className="num">{yoctoToNear(m.allocation.workerYocto)}</span> NEAR to the worker · <span className="num">{yoctoToNear(m.allocation.clientYocto)}</span> NEAR back to the client
              </dd>
            </>
          )}
          {human && terms.partialCompensation && (
            <>
              <dt>Protected minimum</dt>
              <dd>
                <span className="num">{yoctoToNear(terms.partialCompensation.floorYocto)}</span> NEAR once a deliverable is submitted
              </dd>
            </>
          )}
        </dl>

        {funded && (
          <div className="act">
            {is("worker") && (s === "PENDING" || s === "REVISION_REQUESTED") && (
              <div className="inline">
                <input
                  aria-label="Artifact"
                  placeholder={human ? "Content hash of the deliverable" : github ? `Full commit SHA merged into ${plan.branch}` : "Git commit SHA"}
                  value={artifact}
                  onChange={(e) => setArtifact(e.target.value)}
                />
                <input
                  aria-label="Link"
                  placeholder={human ? "Link to the deliverable (optional)" : github ? "Pull request link (optional)" : `Deployment URL, e.g. ${fixtureBase}/broken`}
                  value={uri}
                  onChange={(e) => setUri(e.target.value)}
                />
                <button
                  className="btn"
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
              <div className="hstack">
                <button
                  className="btn secondary"
                  disabled={busy || verifications.some((v) => v.status === "QUEUED" || v.status === "RUNNING")}
                  onClick={() => run("verification", () => api("POST", `/v1/jobs/${job.id}/milestones/${m.id}/verifications`).then(() => undefined))}
                >
                  Run verification
                </button>
              </div>
            )}

            {human && s === "SUBMITTED" && is("client") && (
              <div className="inline">
                <button className="btn" disabled={busy} onClick={() => act("approve", { type: "APPROVE", ...ms })}>
                  Approve and release
                </button>
                <input aria-label="Feedback" placeholder="Feedback or reason" value={text} onChange={(e) => setText(e.target.value)} />
                <button className="btn secondary" disabled={busy || !text || m.revisionsUsed >= (terms.maxRevisions ?? 0)} onClick={() => act("request_revision", { type: "REQUEST_REVISION", ...ms, feedback: text })}>
                  Request revision
                </button>
              </div>
            )}

            {human && (s === "SUBMITTED" || s === "REVISION_REQUESTED") && (is("client") || is("worker")) && (
              <div className="inline">
                {!(s === "SUBMITTED" && is("client")) && <input aria-label="Reason" placeholder="Reason" value={text} onChange={(e) => setText(e.target.value)} />}
                <button className="btn danger" disabled={busy || !text} onClick={() => act("open_dispute", { type: "OPEN_DISPUTE", ...ms, reason: text })}>
                  Open dispute
                </button>
              </div>
            )}

            {human && ["SUBMITTED", "REVISION_REQUESTED", "DISPUTED"].includes(s) && (is("client") || is("worker")) && (
              <div className="inline">
                <input aria-label="Worker share" placeholder="Worker's share in NEAR" value={amount} onChange={(e) => setAmount(e.target.value)} />
                <button className="btn secondary" disabled={busy || !amount} onClick={() => act("propose_settlement", { type: "PROPOSE_SETTLEMENT", ...ms, workerYocto: nearToYocto(amount) })}>
                  Propose a split
                </button>
                {m.settlementProposal && !job.roles.includes(roleOf(job, m.settlementProposal.proposer)) && (
                  <button className="btn" disabled={busy} onClick={() => act("accept_settlement", { type: "ACCEPT_SETTLEMENT", ...ms, workerYocto: m.settlementProposal!.workerYocto })}>
                    Accept {yoctoToNear(m.settlementProposal.workerYocto)} NEAR split
                  </button>
                )}
              </div>
            )}

            {!human && s === "VERIFIED_PENDING_CHALLENGE" && (
              <div className="inline">
                {is("client") && (
                  <>
                    <input aria-label="Challenge reason" placeholder="Why the PASS is wrong" value={text} onChange={(e) => setText(e.target.value)} />
                    <button className="btn danger" disabled={busy || !text} onClick={() => act("challenge", { type: "CHALLENGE", ...ms, reason: text })}>
                      Challenge PASS
                    </button>
                  </>
                )}
                <button className="btn secondary" disabled={busy || (m.challengeEndsAt ?? 0) > Date.now()} onClick={() => act("finalize_challenge", { type: "FINALIZE_CHALLENGE", ...ms })}>
                  Finalize after the window
                </button>
              </div>
            )}

            {s === "DISPUTED" && is("resolver") && (
              <div className="inline">
                <input aria-label="Award" placeholder="Award to the worker in NEAR" value={amount} onChange={(e) => setAmount(e.target.value)} />
                <button className="btn" disabled={busy || !amount} onClick={() => act("resolve_dispute", { type: "RESOLVE_DISPUTE", ...ms, workerYocto: nearToYocto(amount) })}>
                  Resolve dispute
                </button>
              </div>
            )}

            {s === "CLAIMABLE" && job.calls.payout[m.id] && (is("client") || is("worker")) && (
              <div className="hstack">
                <button className="btn" disabled={busy} onClick={() => signOnly("payout", job.calls.payout[m.id]!)}>
                  {is("worker") ? "Claim payment" : "Release payment"}
                </button>
                <span className="sm t3">The contract sends the fixed split.</span>
              </div>
            )}

            {(s === "PENDING" || s === "REVISION_REQUESTED") && Date.now() >= job.state.terms.expiresAt && (is("client") || is("worker")) && (
              <div className="hstack">
                <button className="btn secondary" disabled={busy} onClick={() => act("expire_milestone", { type: "EXPIRE_MILESTONE", ...ms })}>
                  Expire and refund the client
                </button>
              </div>
            )}
          </div>
        )}

        {verifications.length > 0 && (
          <div className="runs">
            {verifications.map((v) => (
              <div className="run" key={v.id}>
                <span className="mono t3 hide-sm">{v.id.slice(0, 14)}</span>
                <span className="sm t2 hide-sm">Submission #{v.submissionSeq}</span>
                <span>
                  <Status tone={v.outcome === "PASS" ? "ok" : v.outcome === "FAIL" ? "bad" : v.outcome ? "warn" : "neutral"}>{v.outcome ?? v.status.toLowerCase()}</Status>
                  {v.error && <span className="xs t3"> · {v.error}</span>}
                </span>
                <span className="hstack" style={{ gap: 4 }}>
                  {v.status === "DONE" && (
                    <button className="btn ghost" style={{ height: 28 }} onClick={() => api<EvidenceResponse>("GET", `/v1/verifications/${v.id}/evidence`).then(setEvidence)}>
                      Evidence
                    </button>
                  )}
                  {v.status === "DONE" && v.contractCall && onchainStatus === "Submitted" && onchainSubmissionSeq === v.submissionSeq && (
                    <button className="btn secondary" style={{ height: 28 }} disabled={busy} onClick={() => signOnly("record_verification", v.contractCall!)}>
                      Record onchain
                    </button>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
        {evidence !== null && <EvidenceView data={evidence} onClose={() => setEvidence(null)} />}
        {human && review && <ReviewView review={review} />}
      </div>
    </article>
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
  SUBMITTED: "Submitted; awaiting verification or review",
  VERIFIED_PENDING_CHALLENGE: "Passed; challenge window open, not payable yet",
  REVISION_REQUESTED: "Revision requested; funds stay locked",
  DISPUTED: "In dispute; the resolver decides within the agreed bounds",
  CLAIMABLE: "Payable; the payout can be sent",
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
      <div className="hstack">
        <Status tone={report.outcome === "PASS" ? "ok" : "bad"}>
          <b style={{ color: "var(--text)" }}>{report.outcome}</b>
        </Status>
        <span className="xs t3 grow">
          Submission #{report.submissionSeq} · {report.artifactHash} · signed {fmtDate(report.issuedAt)}
        </span>
        <button className="btn ghost" style={{ height: 26 }} onClick={onClose}>
          Close
        </button>
      </div>
      <p className="t2">
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
              <td>
                <Status tone={c.ok ? "ok" : "bad"}>{c.ok ? "Pass" : "Fail"}</Status>
              </td>
              <td className="mono t2">{c.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="xs t2">
        {matchesReport
          ? "This evidence hashes to the digest inside the verifier's signed report, so it has not been altered."
          : "This evidence does not match the signed report's digest. Do not trust it."}{" "}
        <span className="mono t3">{report.evidenceDigest}</span>
      </p>
      <details>
        <summary className="xs t3" style={{ cursor: "pointer" }}>
          Raw evidence JSON
        </summary>
        <pre>{JSON.stringify(data, null, 2)}</pre>
      </details>
    </div>
  );
}

const VERDICT: Record<AiReview["verdict"], { label: string; tone: "ok" | "warn" | "bad" | "neutral" }> = {
  meets: { label: "Meets the rubric", tone: "ok" },
  partly: { label: "Partly meets the rubric", tone: "warn" },
  does_not_meet: { label: "Does not meet the rubric", tone: "bad" },
  cannot_review: { label: "Could not review", tone: "neutral" },
};

/** Governance AI review: advisory only, with NEAR AI's TEE signature status. People decide. */
function ReviewView({ review: r }: { review: AiReview }) {
  const v = VERDICT[r.verdict];
  return (
    <div className="evidence" style={{ marginTop: 18 }}>
      <div className="hstack">
        <span className="label grow">AI review · advisory</span>
        <span className="xs t3 mono">{r.model}</span>
      </div>
      <div>
        <Status tone={v.tone}>
          <b style={{ color: "var(--text)" }}>{v.label}</b>
        </Status>
      </div>
      <p>{r.summary}</p>
      {r.points.length > 0 && (
        <ul className="t2" style={{ listStyle: "disc", paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 }}>
          {r.points.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      )}
      <p className="xs t3">
        {r.signature
          ? `Signed by NEAR AI (${r.signature.kind ?? "unknown kind"}, ${r.signature.algo}) · ${r.signatureCheck ?? "not checked yet"} · signer ${r.signature.address}`
          : r.verdict === "cannot_review"
            ? "No model call was made."
            : "Waiting for NEAR AI's response signature."}{" "}
        This review informs the client and the resolver; it never approves, rejects or pays anything.
      </p>
    </div>
  );
}

function roleOf(job: Job, account: string): string {
  return account === job.state.terms.client.nearAccountId ? "client" : account === job.state.terms.worker.nearAccountId ? "worker" : "";
}
