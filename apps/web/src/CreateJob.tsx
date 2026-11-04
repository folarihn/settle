import { useState } from "react";
import { api, nearToYocto, type Job } from "./api";
import type { Session } from "./App";
import { sendCall } from "./wallet";

type Template = "api-design" | "github" | "sustained";

const TEMPLATES: { id: Template; title: string; blurb: string }[] = [
  { id: "api-design", title: "API + design", blurb: "An automated API check, then a design the client reviews. The demo agreement." },
  { id: "github", title: "GitHub CI bounty", blurb: "Pays when a commit merged into your branch passes the CI checks you name." },
  { id: "sustained", title: "Sustained health", blurb: "Pays when the worker's API passes the same check repeatedly, not just once." },
];

/** Client creates the agreement offchain, then signs create_agreement (storage prepaid, excess refunded). */
export function CreateJob({ session }: { session: Session }) {
  const [template, setTemplate] = useState<Template>("api-design");
  const [openBounty, setOpenBounty] = useState(false);
  const [worker, setWorker] = useState("");
  const [workerKind, setWorkerKind] = useState<"HUMAN" | "AGENT">("AGENT");
  const [apiNear, setApiNear] = useState("0.35");
  const [designNear, setDesignNear] = useState("0.15");
  const [floorNear, setFloorNear] = useState("0.075");
  const [revisions, setRevisions] = useState(2);
  const [challengeSec, setChallengeSec] = useState(120);
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

  const firstMilestone = (amountYocto: string) => {
    if (template === "github") {
      const requiredChecks = checks.split(",").map((c) => c.trim()).filter(Boolean);
      return {
        id: "ci",
        title: `CI passes on ${repo.trim()} ${branch.trim()}`,
        type: "AUTOMATED",
        amountYocto,
        verificationPlan: { kind: "GITHUB_CHECKS", version: 1, repo: repo.trim(), branch: branch.trim(), requiredChecks },
      };
    }
    const parsed = JSON.parse(plan) as Record<string, unknown>;
    const verificationPlan = template === "sustained" ? { ...parsed, repeat: { count: probes, intervalMs: probeIntervalSec * 1000 } } : parsed;
    return {
      id: "api",
      title: template === "sustained" ? "API stays healthy" : "API passes the agreed checks",
      type: "AUTOMATED",
      amountYocto,
      verificationPlan,
    };
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const apiYocto = nearToYocto(apiNear);
      const withDesign = template === "api-design";
      const designYocto = withDesign ? nearToYocto(designNear) : "0";
      const milestones: unknown[] = [firstMilestone(apiYocto)];
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
      const job = await api<Job>("POST", "/v1/jobs", {
        ...(openBounty ? { openBounty: true } : { worker: { kind: workerKind, nearAccountId: worker.trim() } }),
        totalYocto: (BigInt(apiYocto) + BigInt(designYocto)).toString(),
        milestones,
        challengePeriodSec: challengeSec,
        fundingDeadline: Date.now() + 24 * 3600_000,
        expiresAt: Date.now() + 7 * 24 * 3600_000,
      });
      const call = openBounty ? job.calls.postBounty! : job.calls.createAgreement!;
      setStatus(
        openBounty
          ? "Saved. Approve post_bounty in your wallet: it deposits the total into escrow now (plus storage; the unused part is refunded)..."
          : "Saved. Approve create_agreement in your wallet (storage deposit; unused part is refunded)...",
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

  return (
    <form className="card form" onSubmit={submit}>
      <h2>Create agreement</h2>
      <p className="muted">You are the client. Terms are locked once the worker accepts and you fund escrow.</p>
      <fieldset>
        <legend>Template</legend>
        <div className="steps">
          {TEMPLATES.map((t) => (
            <label key={t.id} className={`card template ${template === t.id ? "selected" : ""}`}>
              <input type="radio" name="template" checked={template === t.id} onChange={() => setTemplate(t.id)} />
              <strong>{t.title}</strong>
              <span className="muted small">{t.blurb}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <label className="checkbox">
        <input type="checkbox" checked={openBounty} onChange={(e) => setOpenBounty(e.target.checked)} />
        Post as an open bounty: fund it now, and the first human or agent to claim it becomes the worker
      </label>
      {!openBounty && (
        <>
          <label>
            Worker NEAR account
            <input value={worker} onChange={(e) => setWorker(e.target.value)} placeholder="worker.testnet" required />
          </label>
          <label>
            Worker is
            <select value={workerKind} onChange={(e) => setWorkerKind(e.target.value as "HUMAN" | "AGENT")}>
              <option value="AGENT">an AI agent</option>
              <option value="HUMAN">a human</option>
            </select>
          </label>
        </>
      )}

      {template === "github" ? (
        <fieldset>
          <legend>Milestone: GitHub CI checks</legend>
          <label>
            Amount (NEAR)
            <input value={apiNear} onChange={(e) => setApiNear(e.target.value)} />
          </label>
          <label>
            Repository (owner/name, public)
            <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="acme/widget" required />
          </label>
          <label>
            Branch the commit must be merged into
            <input value={branch} onChange={(e) => setBranch(e.target.value)} required />
          </label>
          <label>
            Required checks (comma-separated check-run or status names)
            <input value={checks} onChange={(e) => setChecks(e.target.value)} required />
          </label>
          <p className="muted small">
            The worker submits a commit SHA. It passes only if that commit is on {branch || "the branch"} and every named check succeeded, so
            your branch protection and review decide what gets merged; a pull request cannot change the checks that judge it.
          </p>
        </fieldset>
      ) : (
        <fieldset>
          <legend>Milestone 1: automated API check{template === "sustained" ? " (sustained)" : ""}</legend>
          <label>
            Amount (NEAR)
            <input value={apiNear} onChange={(e) => setApiNear(e.target.value)} />
          </label>
          <label>
            Verification plan (locked by hash)
            <textarea rows={10} value={plan} onChange={(e) => setPlan(e.target.value)} spellCheck={false} />
          </label>
          {template === "sustained" && (
            <>
              <label>
                Probes (every one must pass)
                <input type="number" min={2} max={20} value={probes} onChange={(e) => setProbes(Number(e.target.value))} />
              </label>
              <label>
                Seconds between probes (total at most 120 s)
                <input type="number" min={1} max={60} value={probeIntervalSec} onChange={(e) => setProbeIntervalSec(Number(e.target.value))} />
              </label>
            </>
          )}
        </fieldset>
      )}

      {template === "api-design" && (
        <fieldset>
          <legend>Milestone 2: human design review</legend>
          <label>
            Amount (NEAR)
            <input value={designNear} onChange={(e) => setDesignNear(e.target.value)} />
          </label>
          <label>
            Rubric
            <input value={rubric} onChange={(e) => setRubric(e.target.value)} />
          </label>
          <label>
            Revisions allowed
            <input type="number" min={0} max={10} value={revisions} onChange={(e) => setRevisions(Number(e.target.value))} />
          </label>
          <label>
            Protected floor if a deliverable is submitted (NEAR, empty for none)
            <input value={floorNear} onChange={(e) => setFloorNear(e.target.value)} />
          </label>
        </fieldset>
      )}
      <label>
        Challenge window after a PASS (seconds, min 60)
        <input type="number" min={60} value={challengeSec} onChange={(e) => setChallengeSec(Number(e.target.value))} />
      </label>
      <button disabled={busy}>{busy ? "Working…" : openBounty ? "Post bounty (deposits the total now)" : "Create agreement (signs create_agreement)"}</button>
      {status && <p>{status}</p>}
      {error && <p className="error">{error}</p>}
    </form>
  );
}
