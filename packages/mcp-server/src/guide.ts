import type { ChainSnapshot, JobView } from "@settle/agent-sdk";
import { yoctoToNear } from "./units.js";

/**
 * Turns a job into a compact summary plus the next steps open to the viewer, so a
 * model can act without knowing the state machine. Only describes; never decides.
 */
export function summarize(job: JobView, chain: ChainSnapshot | null, me: string) {
  const t = job.state.terms;
  return {
    agreementId: job.id,
    yourRoles: job.roles,
    status: job.state.status,
    client: t.client,
    worker: t.openBounty && t.worker.nearAccountId === "open-bounty" ? "open bounty: not claimed yet" : t.worker,
    ...(t.openBounty ? { openBounty: true, claimBy: new Date(t.fundingDeadline).toISOString() } : {}),
    workerAccepted: job.state.acceptedBy.worker,
    totalNear: yoctoToNear(t.totalYocto),
    challengePeriodMinutes: t.challengePeriodSec / 60,
    fundingDeadline: new Date(t.fundingDeadline).toISOString(),
    expiresAt: new Date(t.expiresAt).toISOString(),
    milestones: job.state.milestones.map((m, i) => {
      const terms = t.milestones[i]!;
      return {
        id: m.id,
        title: terms.title,
        kind: terms.type === "AUTOMATED" ? planKind(terms.verificationPlan) : "human review",
        ...(terms.type === "AUTOMATED" ? { check: terms.verificationPlan } : {}),
        amountNear: yoctoToNear(terms.amountYocto),
        status: m.status,
        ...(terms.type === "HUMAN_REVIEW" ? { rubric: terms.rubric, revisionsUsed: m.revisionsUsed, maxRevisions: terms.maxRevisions } : {}),
        submission: m.submission,
        lastVerification: m.lastVerification?.outcome ?? null,
        challengeEndsAt: m.challengeEndsAt ? new Date(m.challengeEndsAt).toISOString() : null,
        settlementProposal: m.settlementProposal
          ? { proposer: m.settlementProposal.proposer, workerNear: yoctoToNear(m.settlementProposal.workerYocto) }
          : null,
        allocation: m.allocation ? { workerNear: yoctoToNear(m.allocation.workerYocto), clientNear: yoctoToNear(m.allocation.clientYocto) } : null,
      };
    }),
    onchain: chain
      ? { status: chain.agreement?.status ?? "not created", termsMatch: chain.termsMatch, divergences: chain.divergences, error: chain.error }
      : null,
    nextSteps: nextSteps(job, chain, me),
  };
}

export function nextSteps(job: JobView, chain: ChainSnapshot | null, me: string): string[] {
  const s = job.state;
  const isClient = s.terms.client.nearAccountId === me;
  const isWorker = s.terms.worker.nearAccountId === me;
  const id = job.id;
  const steps: string[] = [];

  if (s.status === "OPEN") {
    return [isClient ? `Open bounty: waiting for someone to claim it before ${new Date(s.terms.fundingDeadline).toISOString()}. You can withdraw it with settle_cancel_bounty.` : `Open bounty: claim it with settle_claim_bounty {agreementId: "${id}"} to become its worker.`];
  }
  if (s.status === "CANCELLED") return ["Bounty cancelled; the deposit was refunded to the client."];
  if (s.status === "DRAFT") {
    if (chain && !chain.agreement && !chain.error) {
      steps.push(isClient ? `The agreement is not onchain yet: call settle_publish_agreement {agreementId: "${id}"}.` : `Waiting for the client to publish the agreement onchain.`);
      return steps;
    }
    if (!s.acceptedBy.worker) {
      steps.push(isWorker ? `Review the terms, then call settle_accept_agreement {agreementId: "${id}"}.` : `Waiting for the worker ${s.terms.worker.nearAccountId} to accept the terms.`);
    } else {
      steps.push(isClient ? `Call settle_fund_agreement {agreementId: "${id}"} to deposit ${yoctoToNear(s.terms.totalYocto)} NEAR into escrow.` : `Waiting for the client to fund escrow.`);
    }
    return steps;
  }
  if (s.status === "COMPLETED") return ["Agreement completed: every milestone is paid."];

  for (const [i, m] of s.milestones.entries()) {
    const terms = s.terms.milestones[i]!;
    const ref = `{agreementId: "${id}", milestoneId: "${m.id}"}`;
    const proposal = m.settlementProposal;
    switch (m.status) {
      case "PENDING":
      case "REVISION_REQUESTED":
        steps.push(
          isWorker
            ? `${m.id}: submit the work with settle_submit_work ${ref}${submitHint(terms)}.`
            : `${m.id}: waiting for the worker to submit.`,
        );
        break;
      case "SUBMITTED":
        if (terms.type === "AUTOMATED") steps.push(`${m.id}: submitted for automatic verification. If the last result was INCONCLUSIVE, call settle_request_verification ${ref}.`);
        else steps.push(isClient ? `${m.id}: review the submission and call settle_review ${ref} with approve, request_revision or open_dispute.` : `${m.id}: waiting for the client's review.`);
        break;
      case "VERIFIED_PENDING_CHALLENGE":
        steps.push(
          `${m.id}: passed verification; challenge window ends ${new Date(m.challengeEndsAt!).toISOString()}.` +
            (isClient ? " You may challenge before then with settle_review decision=challenge." : "") +
            " After it ends the service finalizes and pays automatically, or call settle_finalize.",
        );
        break;
      case "DISPUTED":
        steps.push(`${m.id}: disputed. Either party can propose a split with settle_settlement; otherwise the resolver decides.`);
        break;
      case "CLAIMABLE":
        steps.push(`${m.id}: payable. Call settle_claim_payment ${ref} (automated milestones are also paid automatically).`);
        break;
      case "PAYOUT_PENDING":
        steps.push(`${m.id}: payout transfer in flight; call settle_get_agreement again shortly.`);
        break;
      case "PAID":
        break;
    }
    if (proposal && proposal.proposer !== me && (isClient || isWorker) && m.status !== "CLAIMABLE" && m.status !== "PAID") {
      steps.push(`${m.id}: ${proposal.proposer} proposed ${yoctoToNear(proposal.workerYocto)} NEAR to the worker; accept with settle_settlement action=accept.`);
    }
  }
  return steps;
}

function planKind(plan: unknown): string {
  const p = plan as { kind?: string; repeat?: { count: number; intervalMs: number } };
  if (p.kind === "GITHUB_CHECKS") return "GitHub CI checks";
  return p.repeat ? `API check, sustained (${p.repeat.count} probes, ${p.repeat.intervalMs / 1000} s apart)` : "API check";
}

function submitHint(terms: { type: string } & Record<string, unknown>): string {
  if (terms.type !== "AUTOMATED") return " and a link to the deliverable";
  const plan = terms.verificationPlan as { kind?: string; repo?: string; branch?: string };
  return plan.kind === "GITHUB_CHECKS" ? ` and the full commit SHA (merged into ${plan.repo} ${plan.branch}) as artifactHash` : " and the deployment base URL";
}
