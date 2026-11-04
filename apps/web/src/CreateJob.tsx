import { useState } from "react";
import { api, nearToYocto, yoctoToNear, type Job } from "./api";
import type { Session } from "./App";
import { sendCall } from "./wallet";

type Template = "api-design" | "github" | "sustained";

const TEMPLATES: { id: Template; title: string; blurb: string }[] = [
  { id: "api-design", title: "API and design", blurb: "An API checked by the independent verifier, then a design you review yourself." },
  { id: "github", title: "GitHub CI", blurb: "Pays when a commit merged into your branch passes the CI checks you name." },
  { id: "sustained", title: "Sustained health", blurb: "Pays when the worker's API passes the same check repeatedly, not just once." },
];

const STEPS = ["Kind of work", "Who", "Terms", "Review and sign"];

/** Client defines the agreement step by step, then signs create_agreement (or post_bounty) in the wallet. */
export function CreateJob({ session }: { session: Session }) {
  const [step, setStep] = useState(0);
  const [template, setTemplate] = useState<Template>("api-design");
  const [openBounty, setOpenBounty] = useState(() => window.location.hash.includes("bounty"));
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
  const requiredChecks = checks.split(",").map((c) => c.trim()).filter(Boolean);

  /** The agreement as it will be sent; throws a readable message for anything invalid. */
  const build = () => {
    const apiYocto = nearToYocto(apiNear);
    const designYocto = withDesign ? nearToYocto(designNear) : "0";
    if (BigInt(apiYocto) === 0n || (withDesign && BigInt(designYocto) === 0n)) throw new Error("Every milestone needs an amount above 0.");
    let first: Record<string, unknown>;
    if (template === "github") {
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo.trim())) throw new Error("Enter the repository as owner/name.");
      if (requiredChecks.length === 0) throw new Error("Name at least one CI check.");
      first = {
        id: "ci",
        title: `CI passes on ${repo.trim()} ${branch.trim()}`,
        type: "AUTOMATED",
        amountYocto: apiYocto,
        verificationPlan: { kind: "GITHUB_CHECKS", version: 1, repo: repo.trim(), branch: branch.trim(), requiredChecks },
      };
    } else {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(plan) as Record<string, unknown>;
      } catch {
        throw new Error("The verification plan is not valid JSON.");
      }
      first = {
        id: "api",
        title: template === "sustained" ? "API stays healthy" : "API passes the agreed checks",
        type: "AUTOMATED",
        amountYocto: apiYocto,
        verificationPlan: template === "sustained" ? { ...parsed, repeat: { count: probes, intervalMs: probeIntervalSec * 1000 } } : parsed,
      };
    }
    const milestones: Record<string, unknown>[] = [first];
    if (withDesign) {
      milestones.push({
        id: "design",
        title: "Design deliverable",
        type: "HUMAN_REVIEW",
        amountYocto: designYocto,
        rubric,
        maxRevisions: revisions,
        partialCompensation: floorNear.trim() ? { condition: "DELIVERABLE_SUBMITTED", floorYocto: nearToYocto(floorNear) } : null,
      });
    }
    const now = Date.now();
    return {
      ...(openBounty ? { openBounty: true } : { worker: { kind: workerKind, nearAccountId: worker.trim() } }),
      totalYocto: (BigInt(apiYocto) + BigInt(designYocto)).toString(),
      milestones,
      challengePeriodSec: challengeMin * 60,
      fundingDeadline: now + deadlineHours * 3600_000,
      expiresAt: now + expiresDays * 24 * 3600_000,
    };
  };

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
      sessionStorage.setItem(`settle.tx.${job.id}`, JSON.stringify([{ label: openBounty ? "post_bounty" : "create_agreement", hash }]));
      window.location.hash = `#/jobs/${job.id}`;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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

          {step === 2 && (
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
                  <span className="k">Challenge window</span>
                  <span>{challengeMin} min after a PASS</span>
                  <span />
                </div>
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
