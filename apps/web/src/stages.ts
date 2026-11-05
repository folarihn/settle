import type { ChainSnapshot, Job } from "./api";

/**
 * Where an agreement is on its path, derived only from the recorded state (which mirrors the
 * escrow contract). Unusual outcomes are explicit branches. Nothing is shown as paid while the
 * payout is still waiting for the transfer's callback, and a page that disagrees with the
 * contract says it is syncing instead of guessing.
 */

export type StageKey = "draft" | "accepted" | "funded" | "submitted" | "verified" | "challenge" | "paid";
export type StageState = "done" | "now" | "todo" | "skip";

export interface Stage {
  key: StageKey;
  label: string;
  state: StageState;
}

export type BranchKind = "revision" | "failed" | "dispute" | "expired" | "cancelled" | "partial" | "refunded";

export interface StageView {
  stages: Stage[];
  branch: { kind: BranchKind; label: string } | null;
  /** The milestone the stages describe (the first one not yet paid). */
  focus: { index: number; total: number; title: string } | null;
  /** The payout or another step is waiting for the contract's confirmation. */
  awaitingChain: boolean;
  /** The page's record and the contract disagree; a sync is due. */
  syncing: boolean;
}

const ORDER: StageKey[] = ["draft", "accepted", "funded", "submitted", "verified", "challenge", "paid"];
const LABELS: Record<StageKey, string> = {
  draft: "Draft",
  accepted: "Accepted",
  funded: "Funded",
  submitted: "Submitted",
  verified: "Verified",
  challenge: "Challenge",
  paid: "Paid",
};

function build(now: StageKey, opts: { done?: StageKey[]; skip?: StageKey[]; allDone?: boolean } = {}): Stage[] {
  const at = ORDER.indexOf(now);
  return ORDER.map((key, i) => {
    let state: StageState = opts.allDone ? "done" : i < at ? "done" : i === at ? "now" : "todo";
    if (opts.done?.includes(key)) state = "done";
    if (opts.skip?.includes(key)) state = "skip";
    return { key, label: LABELS[key], state };
  });
}

export function agreementStages(job: Job, chain: ChainSnapshot | null, now: number = Date.now()): StageView {
  const s = job.state;
  const t = s.terms;
  const syncing = !!chain && (chain.divergences.length > 0 || chain.termsMatch === false);
  const base = { branch: null, focus: null, awaitingChain: false, syncing } satisfies Omit<StageView, "stages">;

  switch (s.status) {
    case "DRAFT": {
      const expired = now > t.fundingDeadline;
      const stages = t.openBounty ? build("draft") : !s.acceptedBy.worker ? build("accepted") : build("funded");
      return { ...base, stages, branch: expired ? { kind: "expired", label: "Funding deadline passed: this draft can no longer be funded." } : null };
    }
    case "OPEN":
      // A bounty is funded when posted; claiming it is the worker's acceptance.
      return { ...base, stages: build("accepted", { done: ["funded"] }).map((x) => (x.key === "accepted" ? { ...x, label: "Claimed" } : x)) };
    case "CANCELLED":
      return {
        ...base,
        stages: ORDER.map((key) => ({ key, label: LABELS[key], state: key === "draft" || key === "funded" ? "done" : "todo" })),
        branch: { kind: "cancelled", label: "Cancelled before anyone claimed it; the whole deposit was refunded." },
      };
    case "COMPLETED": {
      const allocs = s.milestones.map((m) => m.allocation).filter((a): a is NonNullable<typeof a> => !!a);
      const toWorker = allocs.reduce((n, a) => n + BigInt(a.workerYocto), 0n);
      const toClient = allocs.reduce((n, a) => n + BigInt(a.clientYocto), 0n);
      const branch: StageView["branch"] =
        toWorker === 0n && toClient > 0n
          ? { kind: "refunded", label: "Settled as a refund: the client got the deposit back." }
          : toClient > 0n
            ? { kind: "partial", label: "Settled with a partial payment: part went to the worker, the rest back to the client." }
            : null;
      return { ...base, stages: build("paid", { allDone: true }), branch };
    }
    case "FUNDED":
      break;
  }

  const i = s.milestones.findIndex((m) => m.status !== "PAID");
  if (i < 0) return { ...base, stages: build("paid", { allDone: true }), awaitingChain: true };
  const m = s.milestones[i]!;
  const mt = t.milestones[i]!;
  const human = mt.type === "HUMAN_REVIEW";
  const skip: StageKey[] = human ? ["challenge"] : [];
  const focus = { index: i, total: s.milestones.length, title: mt.title };
  const verifiedLabel = human ? "Approved" : "Verified";
  const relabel = (st: Stage[]) => st.map((x) => (x.key === "verified" ? { ...x, label: verifiedLabel } : x));
  const failed = m.lastVerification?.outcome === "FAIL";

  switch (m.status) {
    case "PENDING":
      return {
        ...base,
        focus,
        stages: relabel(build("submitted", { skip })),
        branch: failed ? { kind: "failed", label: "The last delivery failed verification. The money stays in escrow until a delivery passes." } : null,
      };
    case "REVISION_REQUESTED":
      return { ...base, focus, stages: relabel(build("submitted", { skip })), branch: { kind: "revision", label: "The client asked for a revision; the money stays in escrow." } };
    case "SUBMITTED":
      return { ...base, focus, stages: relabel(build("verified", { skip })) };
    case "DISPUTED":
      return { ...base, focus, stages: relabel(build("verified", { skip })), branch: { kind: "dispute", label: "In dispute: the parties can agree a split, or the resolver rules within the protected minimum." } };
    case "VERIFIED_PENDING_CHALLENGE":
      return { ...base, focus, stages: relabel(build("challenge", { skip })) };
    case "CLAIMABLE":
      return { ...base, focus, stages: relabel(build("paid", { skip })) };
    case "PAYOUT_PENDING":
      // The transfer has been sent but its callback has not confirmed it: not paid yet.
      return { ...base, focus, stages: relabel(build("paid", { skip })), awaitingChain: true };
    default:
      return { ...base, focus, stages: relabel(build("submitted", { skip })), syncing: true };
  }
}
