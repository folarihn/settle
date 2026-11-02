import { useState } from "react";
import { api, nearToYocto, type Job } from "./api";
import type { Session } from "./App";
import { sendCall } from "./wallet";

/** Client creates the agreement offchain, then signs create_agreement (storage prepaid, excess refunded). */
export function CreateJob({ session }: { session: Session }) {
  const [worker, setWorker] = useState("");
  const [workerKind, setWorkerKind] = useState<"HUMAN" | "AGENT">("AGENT");
  const [apiNear, setApiNear] = useState("0.35");
  const [designNear, setDesignNear] = useState("0.15");
  const [floorNear, setFloorNear] = useState("0.075");
  const [revisions, setRevisions] = useState(2);
  const [challengeSec, setChallengeSec] = useState(120);
  const [plan, setPlan] = useState(JSON.stringify(session.config.demoPlan, null, 2));
  const [rubric, setRubric] = useState("Landing page matches the brief on mobile and desktop.");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const apiYocto = nearToYocto(apiNear);
      const designYocto = nearToYocto(designNear);
      const job = await api<Job>("POST", "/v1/jobs", {
        worker: { kind: workerKind, nearAccountId: worker.trim() },
        totalYocto: (BigInt(apiYocto) + BigInt(designYocto)).toString(),
        milestones: [
          { id: "api", title: "API passes the agreed checks", type: "AUTOMATED", amountYocto: apiYocto, verificationPlan: JSON.parse(plan) },
          {
            id: "design",
            title: "Design deliverable",
            type: "HUMAN_REVIEW",
            amountYocto: designYocto,
            rubric,
            maxRevisions: revisions,
            partialCompensation: floorNear.trim() ? { condition: "DELIVERABLE_SUBMITTED", floorYocto: nearToYocto(floorNear) } : null,
          },
        ],
        challengePeriodSec: challengeSec,
        fundingDeadline: Date.now() + 24 * 3600_000,
        expiresAt: Date.now() + 7 * 24 * 3600_000,
      });
      setStatus("Saved. Approve create_agreement in your wallet (storage deposit; unused part is refunded)...");
      const hash = await sendCall(session.wallet, job.calls.createAgreement!);
      sessionStorage.setItem(`settle.tx.${job.id}`, JSON.stringify([{ label: "create_agreement", hash }]));
      window.location.hash = `#/jobs/${job.id}`;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card form" onSubmit={submit}>
      <h2>New job</h2>
      <p className="muted">You are the client. Terms are locked once the worker accepts and you fund escrow.</p>
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
      <fieldset>
        <legend>Milestone 1: automated API check</legend>
        <label>
          Amount (NEAR)
          <input value={apiNear} onChange={(e) => setApiNear(e.target.value)} />
        </label>
        <label>
          Verification plan (locked by hash)
          <textarea rows={10} value={plan} onChange={(e) => setPlan(e.target.value)} spellCheck={false} />
        </label>
      </fieldset>
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
      <label>
        Challenge window after a PASS (seconds, min 60)
        <input type="number" min={60} value={challengeSec} onChange={(e) => setChallengeSec(Number(e.target.value))} />
      </label>
      <button disabled={busy}>{busy ? "Working..." : "Create job and sign create_agreement"}</button>
      {status && <p>{status}</p>}
      {error && <p className="error">{error}</p>}
    </form>
  );
}
