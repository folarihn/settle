import { yoctoToNear, type Job, type MilestoneTerms } from "./api";

/**
 * Display helpers derived only from an agreement's recorded state (funding and payouts are
 * mirrored from the escrow contract). Nothing here invents numbers or decides anything.
 */

export interface Money {
  total: bigint;
  /** In escrow, not yet allocated to anyone. */
  locked: bigint;
  /** Allocated and waiting for the payout transfer. */
  claimable: bigint;
  /** Transfer in flight. */
  inFlight: bigint;
  paidToWorker: bigint;
  refundedToClient: bigint;
}

export function money(job: Job): Money {
  const t = job.state.terms;
  const m: Money = { total: BigInt(t.totalYocto), locked: 0n, claimable: 0n, inFlight: 0n, paidToWorker: 0n, refundedToClient: 0n };
  const funded = job.state.status === "OPEN" || job.state.status === "FUNDED" || job.state.status === "COMPLETED";
  if (!funded) return m;
  job.state.milestones.forEach((ms, i) => {
    const amount = BigInt(t.milestones[i]!.amountYocto);
    const a = ms.allocation;
    if (!a) m.locked += amount;
    else if (ms.status === "PAID") {
      m.paidToWorker += BigInt(a.workerYocto);
      m.refundedToClient += BigInt(a.clientYocto);
    } else if (ms.status === "PAYOUT_PENDING") m.inFlight += amount;
    else m.claimable += amount;
  });
  return m;
}

export const near = (y: bigint | string) => yoctoToNear(typeof y === "bigint" ? y.toString() : y);

/** Short human title: the milestone titles. */
export function title(job: Job): string {
  const ms = job.state.terms.milestones.map((m) => m.title);
  return ms.length <= 2 ? ms.join(" · ") : `${ms[0]} · ${ms[1]} +${ms.length - 2}`;
}

export const isUnclaimedBounty = (job: Job) => !!job.state.terms.openBounty && job.state.terms.worker.nearAccountId === "open-bounty";

export function counterparty(job: Job, me: string): string {
  const t = job.state.terms;
  if (isUnclaimedBounty(job)) return t.client.nearAccountId === me ? "open bounty" : t.client.nearAccountId;
  return t.client.nearAccountId === me ? t.worker.nearAccountId : t.client.nearAccountId;
}

export type Tone = "neutral" | "info" | "ok" | "warn" | "bad" | "violet" | "accent";

export const AGREEMENT_STATUS: Record<string, { label: string; tone: Tone }> = {
  DRAFT: { label: "Draft", tone: "neutral" },
  OPEN: { label: "Open bounty", tone: "violet" },
  FUNDED: { label: "Funded", tone: "info" },
  COMPLETED: { label: "Completed", tone: "ok" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
};

export const MILESTONE_STATUS: Record<string, { label: string; tone: Tone }> = {
  PENDING: { label: "Not submitted", tone: "neutral" },
  SUBMITTED: { label: "Submitted", tone: "info" },
  VERIFIED_PENDING_CHALLENGE: { label: "Passed · challenge window", tone: "accent" },
  REVISION_REQUESTED: { label: "Revision requested", tone: "warn" },
  DISPUTED: { label: "In dispute", tone: "bad" },
  CLAIMABLE: { label: "Payable", tone: "ok" },
  PAYOUT_PENDING: { label: "Paying out", tone: "warn" },
  PAID: { label: "Paid", tone: "ok" },
};

export function planKind(terms: MilestoneTerms): string {
  if (terms.type === "HUMAN_REVIEW") return "Human review";
  const p = (terms.verificationPlan ?? {}) as { kind?: string; repeat?: unknown };
  if (p.kind === "GITHUB_CHECKS") return "GitHub CI";
  if (p.kind === "CONTENT_RULES") return "Auto-checked text";
  return p.repeat ? "Sustained API check" : "API check";
}

export interface NextAction {
  /** Whose move it is from the viewer's point of view. */
  who: "you" | "other" | "auto" | "done";
  text: string;
}

/** What happens next on this agreement, phrased for the viewer. */
export function nextAction(job: Job, me: string): NextAction {
  const s = job.state;
  const t = s.terms;
  const isClient = t.client.nearAccountId === me;
  const isWorker = t.worker.nearAccountId === me;
  const isResolver = t.disputeResolver === me;

  switch (s.status) {
    case "COMPLETED":
      return { who: "done", text: "Completed: every milestone is paid out." };
    case "CANCELLED":
      return { who: "done", text: "Bounty cancelled; the deposit went back to the client." };
    case "OPEN":
      return isClient
        ? { who: "other", text: `Open bounty: waiting for someone to claim it before ${fmtDate(t.fundingDeadline)}.` }
        : { who: "you", text: "Open bounty: claim it to become the worker. The money is already in escrow." };
    case "DRAFT":
      if (t.openBounty) return isClient ? { who: "you", text: "Post the bounty onchain to fund it and list it." } : { who: "other", text: "Waiting for the client to post the bounty." };
      if (!s.acceptedBy.worker) return isWorker ? { who: "you", text: "Review the terms and accept them." } : { who: "other", text: `Waiting for ${t.worker.nearAccountId} to accept the terms.` };
      return isClient ? { who: "you", text: `Fund escrow with ${near(t.totalYocto)} NEAR.` } : { who: "other", text: "Waiting for the client to fund escrow." };
  }

  // FUNDED: the first milestone that still needs something.
  for (const [i, m] of s.milestones.entries()) {
    const mt = t.milestones[i]!;
    const auto = mt.type === "AUTOMATED";
    const name = `“${mt.title}”`;
    switch (m.status) {
      case "PENDING":
      case "REVISION_REQUESTED":
        return isWorker
          ? { who: "you", text: m.status === "REVISION_REQUESTED" ? `Submit a revised ${name}.` : `Submit ${name}.` }
          : { who: "other", text: `Waiting for the worker to submit ${name}.` };
      case "SUBMITTED":
        if (auto) return { who: "auto", text: `${name} is with the independent verifier.` };
        return isClient ? { who: "you", text: `Review ${name}: approve, ask for a revision, or open a dispute.` } : { who: "other", text: `Waiting for the client to review ${name}.` };
      case "VERIFIED_PENDING_CHALLENGE":
        return isClient
          ? { who: "you", text: `${name} passed. You can challenge until ${fmtDate(m.challengeEndsAt)}; after that it is paid automatically.` }
          : { who: "auto", text: `${name} passed. Payment follows after the challenge window (${fmtDate(m.challengeEndsAt)}).` };
      case "DISPUTED":
        return isResolver
          ? { who: "you", text: `Rule on the dispute over ${name}, within the agreed minimum.` }
          : { who: isClient || isWorker ? "you" : "other", text: `${name} is disputed: propose a split, or the resolver decides.` };
      case "CLAIMABLE":
        return auto ? { who: "auto", text: `${name} is payable and will be paid out automatically.` } : { who: isClient || isWorker ? "you" : "other", text: `${name} is payable: send the payout.` };
      case "PAYOUT_PENDING":
        return { who: "auto", text: `Payout of ${name} is in flight onchain.` };
    }
  }
  return { who: "auto", text: "Waiting for the final payout to be confirmed onchain." };
}

export function fmtDate(ms: number | null | undefined): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function relTime(ms: number): string {
  const d = Date.now() - ms;
  const abs = Math.abs(d);
  const unit = abs < 60_000 ? [Math.round(abs / 1000), "s"] : abs < 3_600_000 ? [Math.round(abs / 60_000), "min"] : abs < 86_400_000 ? [Math.round(abs / 3_600_000), "h"] : [Math.round(abs / 86_400_000), "d"];
  return d >= 0 ? `${unit[0]} ${unit[1]} ago` : `in ${unit[0]} ${unit[1]}`;
}

/** A CONTENT_RULES plan as the API returns it (display only; the verifier and agents use @settle/domain). */
export interface ContentRules {
  kind: "CONTENT_RULES";
  format: "text" | "markdown" | "json";
  /** The client's brief: agreed and hashed with the rules, but not machine-checked. */
  brief?: string;
  maxBytes: number;
  minWords?: number;
  maxWords?: number;
  mustInclude?: string[];
  mustNotInclude?: string[];
  minHeadings?: number;
  assertions?: { op: string; path: string; type?: string; value?: unknown }[];
}

export function contentRules(terms: MilestoneTerms): ContentRules | null {
  const p = terms.verificationPlan as { kind?: string } | undefined;
  return terms.type === "AUTOMATED" && p?.kind === "CONTENT_RULES" ? (p as ContentRules) : null;
}

/**
 * The rules as plain sentences. Mirrors describeContentRules in @settle/domain, which is the
 * wording agents receive; kept local so the web bundle stays free of the domain package.
 */
export function describeRules(r: ContentRules): string[] {
  const out = [`${r.format === "json" ? "A JSON document" : r.format === "markdown" ? "Markdown" : "Plain text"}, at most ${r.maxBytes.toLocaleString("en-US")} bytes.`];
  if (r.minWords !== undefined && r.maxWords !== undefined) out.push(`Between ${r.minWords} and ${r.maxWords} words.`);
  else if (r.minWords !== undefined) out.push(`At least ${r.minWords} words.`);
  else if (r.maxWords !== undefined) out.push(`At most ${r.maxWords} words.`);
  if (r.minHeadings !== undefined) out.push(`At least ${r.minHeadings} heading${r.minHeadings === 1 ? "" : "s"}.`);
  for (const p of r.mustInclude ?? []) out.push(`Includes "${p}".`);
  for (const p of r.mustNotInclude ?? []) out.push(`Does not include "${p}".`);
  for (const a of r.assertions ?? []) out.push(a.op === "exists" ? `JSON has ${a.path}.` : a.op === "type" ? `JSON ${a.path} is ${a.type}.` : `JSON ${a.path} equals ${JSON.stringify(a.value)}.`);
  return out;
}

const who = (a: string | null) => (!a ? "The contract" : a.length > 22 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
const quote = (t: string) => `“${t.length > 48 ? `${t.slice(0, 46)}…` : t}”`;

/** One activity event as a short sentence, from recorded data only. */
export function describeActivity(e: { type: string; actor: string | null; title: string; amountYocto: string | null; outcome: string | null }): { text: string; tone: Tone } {
  const amount = e.amountYocto ? `${near(e.amountYocto)} NEAR` : "";
  switch (e.type) {
    case "FUND":
      return { text: `${who(e.actor)} posted ${quote(e.title)}${amount ? ` · ${amount} in escrow` : ""}`, tone: "info" };
    case "CLAIM_BOUNTY":
      return { text: `${who(e.actor)} claimed ${quote(e.title)}`, tone: "info" };
    case "SUBMIT":
      return { text: `${who(e.actor)} delivered ${quote(e.title)}`, tone: "neutral" };
    case "RECORD_VERIFICATION":
      return { text: `Verifier signed ${e.outcome ?? "a result"} for ${quote(e.title)}`, tone: e.outcome === "PASS" ? "ok" : "bad" };
    case "APPROVE":
      return { text: `${who(e.actor)} approved ${quote(e.title)}`, tone: "ok" };
    case "REQUEST_REVISION":
      return { text: `${who(e.actor)} asked for a revision of ${quote(e.title)}`, tone: "warn" };
    case "CONFIRM_PAYOUT":
      return e.outcome === "PAID" ? { text: `Contract paid ${amount || "the worker"} for ${quote(e.title)}`, tone: "ok" } : { text: `A payout for ${quote(e.title)} failed and stays claimable`, tone: "bad" };
    case "CANCEL_BOUNTY":
      return { text: `${quote(e.title)} was cancelled and refunded`, tone: "neutral" };
    default:
      return { text: `${who(e.actor)}: ${e.type.toLowerCase().replace(/_/g, " ")} on ${quote(e.title)}`, tone: "neutral" };
  }
}
