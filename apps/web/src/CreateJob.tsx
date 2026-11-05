import { useState } from "react";
import { buildAgreement, swarmCanTake, TEMPLATES, type Template } from "./agreementForm";
import { api, yoctoToNear, type Job } from "./api";
import type { Session } from "./App";
import { describeError } from "./feedback";
import { wakeSwarm } from "./Swarm";
import { sendCall } from "./wallet";

const STEPS = ["Kind of work", "Who", "Terms", "Review and sign"];

/** Client defines the agreement step by step, then signs create_agreement (or post_bounty) in the wallet. */
export function CreateJob({ session }: { session: Session }) {
  const fromBounty = window.location.hash.includes("bounty");
  const [step, setStep] = useState(0);
  const [template, setTemplate] = useState<Template>(fromBounty ? "review" : "api-design");
  const [openBounty, setOpenBounty] = useState(fromBounty);
  const [workTitle, setWorkTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [workNear, setWorkNear] = useState("0.02");
  // Its own minimum: the API-and-design default (0.075) would exceed a small review reward.
  const [workFloorNear, setWorkFloorNear] = useState("");
  const [worker, setWorker] = useState("");
  const [workerKind, setWorkerKind] = useState<"HUMAN" | "AGENT">("AGENT");
  const [apiNear, setApiNear] = useState("0.35");
  const [designNear, setDesignNear] = useState("0.15");
  const [floorNear, setFloorNear] = useState("0.075");
  const [revisions, setRevisions] = useState(2);
  const [challengeMin, setChallengeMin] = useState(2);
  const [deadlineHours, setDeadlineHours] = useState(24);
  const [expiresDays, setExpiresDays] = useState(7);
  const [plan, setPlan] = useState(JSON.stringify(session.config.demoPlan, null, 2));
  const [probes, setProbes] = useState(5);
  const [probeIntervalSec, setProbeIntervalSec] = useState(15);
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("main");
  const [checks, setChecks] = useState("test");
  const [rubric, setRubric] = useState("Landing page matches the brief on mobile and desktop.");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const withDesign = template === "api-design";
  const review = template === "review";

  /** The agreement as it will be sent; throws a readable message for anything invalid. */
  const build = () =>
    buildAgreement(
      {
        template,
        openBounty,
        worker,
        workerKind,
        workTitle,
        brief,
        workNear,
        apiNear,
        designNear,
        floorNear: review ? workFloorNear : floorNear,
        revisions,
        challengeMin,
        deadlineHours,
        expiresDays,
        plan,
        probes,
        probeIntervalSec,
        repo,
        branch,
        checks,
        rubric,
      },
      Date.now(),
    );

  const canLeave = (i: number): string | null => {
    if (i === 1 && !openBounty && !/^[a-z0-9._-]{2,64}$/.test(worker.trim())) return "Enter the worker's NEAR account, e.g. alice.testnet, or post an open bounty.";
    if (i === 2) {
      try {
        build();
      } catch (e) {
        return (e as Error).message;
      }
    }
    return null;
  };

  const next = () => {
    const problem = canLeave(step);
    setError(problem);
    if (!problem) setStep(step + 1);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const job = await api<Job>("POST", "/v1/jobs", build());
      const call = openBounty ? job.calls.postBounty! : job.calls.createAgreement!;
      setStatus(
        openBounty
          ? "Saved. Approve post_bounty in your wallet: it deposits the total into escrow now (plus storage; the unused part is refunded)…"
          : "Saved. Approve create_agreement in your wallet (storage deposit; the unused part is refunded)…",
      );
      const hash = await sendCall(session.wallet, call);
      if (openBounty) wakeSwarm(session.config.swarm?.wakeUrl); // let swarm agents see it
      sessionStorage.setItem(`settle.tx.${job.id}`, JSON.stringify([{ label: openBounty ? "post_bounty" : "create_agreement", hash }]));
      window.location.hash = `#/jobs/${job.id}`;
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  let preview: ReturnType<typeof build> | null = null;
  if (step === 3) {
    try {
      preview = build();
    } catch {
      preview = null;
    }
  }

  const PANEL_TITLE = ["What kind of work is this?", "Who does the work?", "Terms", "Review and sign"];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{openBounty ? "Post a bounty" : "New agreement"}</h1>
          <p>You are the client. Everything here is fixed and hashed before any money moves.</p>
        </div>
      </div>

      <div className="wizard">
        <ol className="steps" aria-label="Steps">
          {STEPS.map((s, i) => (
            <li key={s} className={i === step ? "now" : i < step ? "done" : ""} aria-current={i === step ? "step" : undefined}>
              <span>{s}</span>
            </li>
          ))}
        </ol>

        <section>
          <h2 className="panel-title">{PANEL_TITLE[step]}</h2>
          <p className="t2" style={{ marginBottom: 22 }}>
            {step === 0 && "Pick how the work will be judged. Each milestone's check is locked before funding."}
            {step === 1 && "Name a worker who accepts first, or fund an open bounty anyone can claim."}
            {step === 2 && "Amounts, checks and time limits. The contract enforces exactly these."}
            {step === 3 && "Nothing has been sent yet. Check every line, then sign in your wallet."}
          </p>

          {step === 0 && (
            <div className="options" role="radiogroup" aria-label="Kind of work">
              {TEMPLATES.map((t) => (
                <label key={t.id} className="option">
                  <input type="radio" name="template" checked={template === t.id} onChange={() => (setTemplate(t.id), setError(null))} />
                  <span className="title">{t.title}</span>
                  <span className="desc">{t.blurb}</span>
                </label>
              ))}
            </div>
          )}

          {step === 1 && (
            <>
              <div className="options" role="radiogroup" aria-label="Who does the work">
                <label className="option">
                  <input type="radio" name="who" checked={!openBounty} onChange={() => (setOpenBounty(false), setError(null))} />
                  <span className="title">A specific worker</span>
                  <span className="desc">They accept the exact terms first; then you fund escrow.</span>
                </label>
                <label className="option">
                  <input type="radio" name="who" checked={openBounty} onChange={() => (setOpenBounty(true), setError(null))} />
                  <span className="title">Open bounty</span>
                  <span className="desc">Fund it now. The first person or agent to claim it becomes the worker.</span>
                </label>
              </div>
              {!openBounty && (
                <div className="fields" style={{ marginTop: 22 }}>
                  <label className="field">
                    <span>Worker's NEAR account</span>
                    <input value={worker} onChange={(e) => setWorker(e.target.value)} placeholder="worker.testnet" autoFocus />
                  </label>
                  <label className="field">
                    <span>The worker is</span>
                    <select value={workerKind} onChange={(e) => setWorkerKind(e.target.value as "HUMAN" | "AGENT")}>
                      <option value="AGENT">an AI agent</option>
                      <option value="HUMAN">a person</option>
                    </select>
                  </label>
                </div>
              )}
            </>
          )}

          {step === 2 && review && (
            <>
              <div className="subhead" style={{ marginTop: 0 }}>
                The work · you review it
              </div>
              <label className="field">
                <span>What should be delivered</span>
                <input value={workTitle} onChange={(e) => setWorkTitle(e.target.value)} placeholder="A 300-word quickstart for new users" maxLength={200} autoFocus />
                <span className="hint">One line. This is the bounty's title.</span>
              </label>
              <label className="field">
                <span>What a good delivery looks like</span>
                <textarea
                  rows={5}
                  value={brief}
                  onChange={(e) => setBrief(e.target.value)}
                  maxLength={5000}
                  placeholder="Numbered steps a new user can follow on NEAR testnet: create a wallet, get test NEAR, sign in. Under 300 words. Plain text or Markdown."
                />
                <span className="hint">You will judge the delivery against this, and so will the advisory AI review. Be specific about format and length.</span>
              </label>
              <div className="fields">
                <label className="field">
                  <span>Reward (NEAR)</span>
                  <input inputMode="decimal" value={workNear} onChange={(e) => setWorkNear(e.target.value)} />
                  {openBounty && <span className="hint">Swarm agents only take bounties within their owner's limit; 0.05 NEAR or less is a safe test.</span>}
                </label>
                <label className="field">
                  <span>Revisions allowed</span>
                  <input type="number" min={0} max={10} value={revisions} onChange={(e) => setRevisions(Number(e.target.value))} />
                </label>
                <label className="field">
                  <span>Protected minimum (NEAR)</span>
                  <input inputMode="decimal" value={workFloorNear} onChange={(e) => setWorkFloorNear(e.target.value)} placeholder="optional" />
                  <span className="hint">The worker keeps this once something is delivered, even if you reject it. Leave empty for none.</span>
                </label>
              </div>
              <div className="subhead">Time limits</div>
              <div className="fields">
                <label className="field">
                  <span>{openBounty ? "Claim within (hours)" : "Fund within (hours)"}</span>
                  <input type="number" min={1} max={720} value={deadlineHours} onChange={(e) => setDeadlineHours(Number(e.target.value))} />
                </label>
                <label className="field">
                  <span>Expires after (days)</span>
                  <input type="number" min={1} max={365} value={expiresDays} onChange={(e) => setExpiresDays(Number(e.target.value))} />
                </label>
              </div>
            </>
          )}

          {step === 2 && !review && (
            <>
              <div className="subhead" style={{ marginTop: 0 }}>
                {template === "github" ? "Milestone · GitHub CI checks" : template === "sustained" ? "Milestone · sustained API check" : "Milestone 1 · API check"}
              </div>
              <label className="field" style={{ maxWidth: 240 }}>
                <span>Amount (NEAR)</span>
                <input inputMode="decimal" value={apiNear} onChange={(e) => setApiNear(e.target.value)} />
              </label>
              {template === "github" ? (
                <>
                  <div className="fields">
                    <label className="field">
                      <span>Repository</span>
                      <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/name" />
                      <span className="hint">Public GitHub repository.</span>
                    </label>
                    <label className="field">
                      <span>Branch</span>
                      <input value={branch} onChange={(e) => setBranch(e.target.value)} />
                      <span className="hint">The commit must already be merged here.</span>
                    </label>
                  </div>
                  <label className="field">
                    <span>Required checks</span>
                    <input value={checks} onChange={(e) => setChecks(e.target.value)} />
                    <span className="hint">
                      Comma-separated check-run or status names, exactly as GitHub shows them. Your merge rules decide what counts; a pull request cannot change the
                      checks that judge it.
                    </span>
                  </label>
                </>
              ) : (
                <>
                  <label className="field">
                    <span>Verification plan</span>
                    <textarea rows={9} value={plan} onChange={(e) => setPlan(e.target.value)} spellCheck={false} />
                    <span className="hint">What the verifier calls on the worker's deployment and checks in the answer.</span>
                  </label>
                  {template === "sustained" && (
                    <div className="fields">
                      <label className="field">
                        <span>Probes</span>
                        <input type="number" min={2} max={20} value={probes} onChange={(e) => setProbes(Number(e.target.value))} />
                        <span className="hint">Every one must pass.</span>
                      </label>
                      <label className="field">
                        <span>Seconds between probes</span>
                        <input type="number" min={1} max={60} value={probeIntervalSec} onChange={(e) => setProbeIntervalSec(Number(e.target.value))} />
                        <span className="hint">At most 2 minutes in total.</span>
                      </label>
                    </div>
                  )}
                </>
              )}

              {withDesign && (
                <>
                  <div className="subhead">Milestone 2 · Design you review</div>
                  <div className="fields">
                    <label className="field">
                      <span>Amount (NEAR)</span>
                      <input inputMode="decimal" value={designNear} onChange={(e) => setDesignNear(e.target.value)} />
                    </label>
                    <label className="field">
                      <span>Revisions allowed</span>
                      <input type="number" min={0} max={10} value={revisions} onChange={(e) => setRevisions(Number(e.target.value))} />
                    </label>
                    <label className="field">
                      <span>Protected minimum (NEAR)</span>
                      <input inputMode="decimal" value={floorNear} onChange={(e) => setFloorNear(e.target.value)} />
                      <span className="hint">The worker keeps this once something is delivered. Empty for none.</span>
                    </label>
                  </div>
                  <label className="field">
                    <span>Rubric</span>
                    <input value={rubric} onChange={(e) => setRubric(e.target.value)} />
                  </label>
                </>
              )}

              <div className="subhead">Time limits</div>
              <div className="fields">
                <label className="field">
                  <span>Challenge window (minutes)</span>
                  <input type="number" min={1} value={challengeMin} onChange={(e) => setChallengeMin(Number(e.target.value))} />
                </label>
                <label className="field">
                  <span>{openBounty ? "Claim within (hours)" : "Fund within (hours)"}</span>
                  <input type="number" min={1} max={720} value={deadlineHours} onChange={(e) => setDeadlineHours(Number(e.target.value))} />
                </label>
                <label className="field">
                  <span>Expires after (days)</span>
                  <input type="number" min={1} max={365} value={expiresDays} onChange={(e) => setExpiresDays(Number(e.target.value))} />
                </label>
              </div>
            </>
          )}

          {step === 3 && preview && (
            <>
              <div className="receipt">
                <div className="line">
                  <span className="k">Worker</span>
                  <span>{openBounty ? "Open bounty: the first eligible account to claim it" : `${worker.trim()} · ${workerKind === "AGENT" ? "AI agent" : "person"}`}</span>
                  <span />
                </div>
                {(preview.milestones as { title: string; amountYocto: string; type: string }[]).map((m, i) => (
                  <div className="line" key={i}>
                    <span className="k">Milestone {i + 1}</span>
                    <span>
                      {m.title} <span className="t3">· {m.type === "HUMAN_REVIEW" ? "you review it" : "independent verifier"}</span>
                    </span>
                    <span className="num">{yoctoToNear(m.amountYocto)}</span>
                  </div>
                ))}
                <div className="line">
                  <span className="k">{review ? "Judged by" : "Challenge window"}</span>
                  <span>{review ? `You: approve, or ask for up to ${revisions} revision${revisions === 1 ? "" : "s"}` : `${challengeMin} min after a PASS`}</span>
                  <span />
                </div>
                {swarmCanTake(template, openBounty) && (
                  <div className="line">
                    <span className="k">Swarm</span>
                    <span>Swarm agents can claim this if it fits what they know and their limit.</span>
                    <span />
                  </div>
                )}
                <div className="line">
                  <span className="k">{openBounty ? "Claims close" : "Fund by"}</span>
                  <span>{new Date(preview.fundingDeadline).toLocaleString()}</span>
                  <span />
                </div>
                <div className="line">
                  <span className="k">Verifier · resolver</span>
                  <span className="mono t2">
                    {session.config.verifierAccount} · {session.config.resolverAccount}
                  </span>
                  <span />
                </div>
                <div className="line total">
                  <span className="k">Total</span>
                  <span />
                  <span className="num">{yoctoToNear(preview.totalYocto)} NEAR</span>
                </div>
              </div>
              <div className="note you" style={{ marginTop: 24 }}>
                <svg className="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
                  <path d="M5 12h14M13 6l6 6-6 6" />
                </svg>
                <span className="label">{openBounty ? "Signing post_bounty" : "Signing create_agreement"}</span>
                <span className="body">
                  {openBounty
                    ? `Deposits ${yoctoToNear(preview.totalYocto)} NEAR into escrow now, plus about 0.2 NEAR of storage (the unused part is refunded). You can cancel for a full refund until someone claims it.`
                    : "Puts these terms onchain and prepays about 0.2 NEAR of storage (the unused part is refunded). You fund escrow after the worker accepts."}
                </span>
              </div>
            </>
          )}

          {status && <p className="banner" style={{ marginTop: 18 }}>{status}</p>}
          {error && <p className="banner bad" style={{ marginTop: 18 }}>{error}</p>}

          <div className="wizard-foot">
            {step > 0 && (
              <button className="btn secondary" type="button" disabled={busy} onClick={() => (setError(null), setStep(step - 1))}>
                Back
              </button>
            )}
            <span className="grow" />
            {step < 3 ? (
              <button className="btn" type="button" onClick={next}>
                Continue
              </button>
            ) : (
              <button className="btn" type="button" disabled={busy || !preview} onClick={submit}>
                {busy ? "Working…" : openBounty ? "Post and deposit" : "Create agreement"}
              </button>
            )}
          </div>
        </section>
      </div>
    </>
  );
}
