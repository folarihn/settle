import { useState } from "react";
import { api, nearToYocto, yoctoToNear, type Job } from "./api";
import type { Session } from "./App";
import { sendCall } from "./wallet";

type Template = "api-design" | "github" | "sustained";

const TEMPLATES: { id: Template; title: string; blurb: string }[] = [
  { id: "api-design", title: "API + design", blurb: "An automated API check, then a design you review. The demo agreement." },
  { id: "github", title: "GitHub CI bounty", blurb: "Pays when a commit merged into your branch passes the CI checks you name." },
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

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>{openBounty ? "Post a bounty" : "New agreement"}</h1>
          <p className="muted">You are the client. Everything here is locked by hash before any money moves.</p>
        </div>
      </div>

      <section className="card">
        <div className="wizard-steps" aria-label="Steps">
          {STEPS.map((s, i) => (
            <span key={s} className={i === step ? "current" : i < step ? "done" : ""}>
              {i + 1}. {s}
            </span>
          ))}
        </div>

        {step === 0 && (
          <div className="choices" role="radiogroup" aria-label="Kind of work">
            {TEMPLATES.map((t) => (
              <label key={t.id} className={`choice ${template === t.id ? "selected" : ""}`}>
                <input type="radio" name="template" checked={template === t.id} onChange={() => (setTemplate(t.id), setError(null))} />
                <span className="title">{t.title}</span>
                <span className="muted small">{t.blurb}</span>
              </label>
            ))}
          </div>
        )}

        {step === 1 && (
          <>
            <div className="choices" role="radiogroup" aria-label="Who does the work">
              <label className={`choice ${!openBounty ? "selected" : ""}`}>
                <input type="radio" name="who" checked={!openBounty} onChange={() => (setOpenBounty(false), setError(null))} />
                <span className="title">A specific worker</span>
                <span className="muted small">They accept the exact terms first; then you fund escrow.</span>
              </label>
              <label className={`choice ${openBounty ? "selected" : ""}`}>
                <input type="radio" name="who" checked={openBounty} onChange={() => (setOpenBounty(true), setError(null))} />
                <span className="title">Open bounty</span>
                <span className="muted small">Fund it now. The first human or agent to claim it becomes the worker.</span>
              </label>
            </div>
            {!openBounty && (
              <div className="field-row" style={{ marginTop: 16 }}>
                <label className="field">
                  Worker's NEAR account
                  <input value={worker} onChange={(e) => setWorker(e.target.value)} placeholder="worker.testnet" autoFocus />
                </label>
                <label className="field">
                  The worker is
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
            <h3 style={{ marginBottom: 12 }}>{template === "github" ? "GitHub CI checks" : template === "sustained" ? "Sustained API check" : "Milestone 1 · API check"}</h3>
            <label className="field" style={{ maxWidth: 260 }}>
              Amount (NEAR)
              <input inputMode="decimal" value={apiNear} onChange={(e) => setApiNear(e.target.value)} />
            </label>
            {template === "github" ? (
              <>
                <div className="field-row">
                  <label className="field">
                    Repository (public, owner/name)
                    <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="acme/widget" />
                  </label>
                  <label className="field">
                    Branch the commit must be merged into
                    <input value={branch} onChange={(e) => setBranch(e.target.value)} />
                  </label>
                </div>
                <label className="field">
                  Required checks
                  <input value={checks} onChange={(e) => setChecks(e.target.value)} />
                  <span className="hint">Comma-separated names of check runs or commit statuses, exactly as GitHub shows them.</span>
                </label>
                <p className="muted small">
                  The worker submits a commit SHA. It passes only if that commit is already on {branch || "the branch"} and every named check succeeded, so your
                  own merge rules decide what counts; a pull request cannot change the checks that judge it.
                </p>
              </>
            ) : (
              <>
                <label className="field">
                  Verification plan
                  <textarea rows={9} value={plan} onChange={(e) => setPlan(e.target.value)} spellCheck={false} />
                  <span className="hint">What the verifier calls on the worker's deployment and checks in the answer. Locked by hash.</span>
                </label>
                {template === "sustained" && (
                  <div className="field-row">
                    <label className="field">
                      Probes (every one must pass)
                      <input type="number" min={2} max={20} value={probes} onChange={(e) => setProbes(Number(e.target.value))} />
                    </label>
                    <label className="field">
                      Seconds between probes
                      <input type="number" min={1} max={60} value={probeIntervalSec} onChange={(e) => setProbeIntervalSec(Number(e.target.value))} />
                      <span className="hint">At most 2 minutes in total.</span>
                    </label>
                  </div>
                )}
              </>
            )}

            {withDesign && (
              <>
                <h3 style={{ margin: "20px 0 12px" }}>Milestone 2 · Design you review</h3>
                <div className="field-row">
                  <label className="field">
                    Amount (NEAR)
                    <input inputMode="decimal" value={designNear} onChange={(e) => setDesignNear(e.target.value)} />
                  </label>
                  <label className="field">
                    Revisions allowed
                    <input type="number" min={0} max={10} value={revisions} onChange={(e) => setRevisions(Number(e.target.value))} />
                  </label>
                  <label className="field">
                    Protected minimum (NEAR)
                    <input inputMode="decimal" value={floorNear} onChange={(e) => setFloorNear(e.target.value)} />
                    <span className="hint">Guaranteed to the worker once something is delivered. Empty for none.</span>
                  </label>
                </div>
                <label className="field">
                  Rubric
                  <input value={rubric} onChange={(e) => setRubric(e.target.value)} />
                </label>
              </>
            )}

            <h3 style={{ margin: "20px 0 12px" }}>Time limits</h3>
            <div className="field-row">
              <label className="field">
                Challenge window after a PASS (minutes)
                <input type="number" min={1} value={challengeMin} onChange={(e) => setChallengeMin(Number(e.target.value))} />
              </label>
              <label className="field">
                {openBounty ? "Claim within (hours)" : "Fund within (hours)"}
                <input type="number" min={1} max={720} value={deadlineHours} onChange={(e) => setDeadlineHours(Number(e.target.value))} />
              </label>
              <label className="field">
                Agreement expires after (days)
                <input type="number" min={1} max={365} value={expiresDays} onChange={(e) => setExpiresDays(Number(e.target.value))} />
              </label>
            </div>
          </>
        )}

        {step === 3 && preview && (
          <div className="stack" style={{ gap: 12 }}>
            <dl className="kv">
              <dt>Worker</dt>
              <dd>{openBounty ? "Open bounty: the first eligible account to claim it" : `${worker.trim()} (${workerKind === "AGENT" ? "AI agent" : "person"})`}</dd>
              {(preview.milestones as { title: string; amountYocto: string; type: string }[]).map((m, i) => (
                <div key={i} style={{ display: "contents" }}>
                  <dt>Milestone {i + 1}</dt>
                  <dd>
                    {m.title} · <b>{yoctoToNear(m.amountYocto)} NEAR</b> · {m.type === "HUMAN_REVIEW" ? "you review it" : "independent verifier"}
                  </dd>
                </div>
              ))}
              <dt>Total</dt>
              <dd className="amount">{yoctoToNear(preview.totalYocto)} NEAR</dd>
              <dt>Challenge window</dt>
              <dd>{challengeMin} min after a PASS</dd>
              <dt>{openBounty ? "Claim deadline" : "Funding deadline"}</dt>
              <dd>{new Date(preview.fundingDeadline).toLocaleString()}</dd>
              <dt>Resolver</dt>
              <dd className="mono">{session.config.resolverAccount}</dd>
              <dt>Verifier</dt>
              <dd className="mono">{session.config.verifierAccount}</dd>
            </dl>
            <div className="callout you">
              <span className="icon">→</span>
              <div>
                <strong>{openBounty ? "Signing post_bounty deposits the total now" : "Signing create_agreement puts these terms onchain"}</strong>
                <span>
                  {openBounty
                    ? `${yoctoToNear(preview.totalYocto)} NEAR goes into escrow with about 0.2 NEAR of storage (the unused part is refunded). You can cancel for a full refund until someone claims it.`
                    : "It prepays about 0.2 NEAR of storage (the unused part is refunded). You fund escrow later, after the worker accepts."}
                </span>
              </div>
            </div>
          </div>
        )}

        {status && <p style={{ marginTop: 12 }}>{status}</p>}
        {error && (
          <p className="error" style={{ marginTop: 12 }}>
            {error}
          </p>
        )}

        <div className="wizard-nav">
          {step > 0 && (
            <button className="secondary" type="button" disabled={busy} onClick={() => (setError(null), setStep(step - 1))}>
              Back
            </button>
          )}
          <span className="spacer" />
          {step < 3 ? (
            <button type="button" onClick={next}>
              Continue
            </button>
          ) : (
            <button type="button" disabled={busy || !preview} onClick={submit}>
              {busy ? "Working…" : openBounty ? "Post bounty and deposit" : "Create agreement"}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
