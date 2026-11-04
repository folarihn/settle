import { assertReconciled } from "./accounting.js";
import { fail } from "./errors.js";
import { AgreementEvent } from "./events.js";
import type { NearAccountId } from "./identity.js";
import { fromYocto, toYocto, type Yocto } from "./money.js";
import type { AgreementState, MilestoneState, MilestoneStatus } from "./state.js";
import { verifyReportSignature } from "./signing.js";
import { computePlanHash, computeTermsHash, parseTerms, type AgreementTerms, type MilestoneTerms } from "./terms.js";

type Role = "client" | "worker" | "verifier" | "resolver";

/** Same cap as the escrow contract, which prepays storage for a bounded number of submissions. */
export const MAX_SUBMISSIONS_PER_MILESTONE = 20;
type Event<T extends AgreementEvent["type"]> = Extract<AgreementEvent, { type: T }>;

/** Create a draft from untrusted input. `now` is passed in so transitions stay deterministic. */
export function createDraft(input: unknown, now: number): AgreementState {
  const terms = parseTerms(input);
  if (terms.fundingDeadline <= now) fail("DEADLINE", "fundingDeadline must be in the future");
  return {
    terms,
    termsHash: computeTermsHash(terms),
    status: "DRAFT",
    acceptedBy: { client: false, worker: false },
    fundedYocto: "0",
    fundedAt: null,
    milestones: terms.milestones.map(freshMilestone),
    version: 0,
  };
}

/**
 * Apply one party action. Input is untrusted: it is schema-validated, the actor is
 * checked against the locked roles, and the result must reconcile. The input
 * state is never mutated; on any error nothing changes.
 */
export function applyEvent(state: AgreementState, input: unknown): AgreementState {
  const parsed = AgreementEvent.safeParse(input);
  if (!parsed.success) {
    fail("VALIDATION", `invalid event: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const event = parsed.data;
  const next = structuredClone(state);

  switch (event.type) {
    case "AMEND_TERMS":
      amendTerms(next, event);
      break;
    case "ACCEPT_TERMS":
      acceptTerms(next, event);
      break;
    case "FUND":
      fund(next, event);
      break;
    case "CLAIM_BOUNTY":
      claimBounty(next, event);
      break;
    case "CANCEL_BOUNTY":
      cancelBounty(next, event);
      break;
    default:
      applyMilestoneEvent(next, event);
  }

  next.version = state.version + 1;
  assertReconciled(next);
  return next;
}

/**
 * Record the outcome of an asynchronous payout. This is driven by the chain
 * callback / indexer, never by a party, so it is deliberately not an AgreementEvent.
 * A failed transfer restores the same allocation so it can be retried, never lost.
 */
export function confirmPayout(state: AgreementState, milestoneId: string, succeeded: boolean): AgreementState {
  const next = structuredClone(state);
  const m = findMilestone(next, milestoneId).state;
  requireStatus(m, ["PAYOUT_PENDING"]);
  m.status = succeeded ? "PAID" : "CLAIMABLE";
  if (next.milestones.every((x) => x.status === "PAID")) next.status = "COMPLETED";
  next.version = state.version + 1;
  assertReconciled(next);
  return next;
}

export function rolesOf(terms: AgreementTerms, account: NearAccountId): Set<Role> {
  const roles = new Set<Role>();
  if (terms.client.nearAccountId === account) roles.add("client");
  if (terms.worker.nearAccountId === account) roles.add("worker");
  if (terms.verifierAuthority === account) roles.add("verifier");
  if (terms.disputeResolver === account) roles.add("resolver");
  return roles;
}

function requireRole(state: AgreementState, actor: NearAccountId, allowed: Role[]): Role {
  const roles = rolesOf(state.terms, actor);
  const match = allowed.find((r) => roles.has(r));
  if (!match) fail("UNAUTHORIZED", `${actor} is not authorized; requires ${allowed.join(" or ")}`);
  return match;
}

function requireAgreementStatus(state: AgreementState, status: AgreementState["status"]): void {
  if (state.status !== status) {
    fail(status === "DRAFT" ? "TERMS_LOCKED" : "INVALID_TRANSITION", `agreement is ${state.status}, expected ${status}`);
  }
}

function requireStatus(m: MilestoneState, allowed: MilestoneStatus[]): void {
  if (!allowed.includes(m.status)) {
    fail("INVALID_TRANSITION", `milestone '${m.id}' is ${m.status}; expected ${allowed.join(" or ")}`);
  }
}

function freshMilestone(terms: MilestoneTerms): MilestoneState {
  return {
    id: terms.id,
    status: "PENDING",
    submission: null,
    submissionCount: 0,
    revisionsUsed: 0,
    challengeEndsAt: null,
    lastVerification: null,
    lastReportNonce: null,
    settlementProposal: null,
    allocation: null,
  };
}

function findMilestone(state: AgreementState, id: string): { terms: MilestoneTerms; state: MilestoneState } {
  const i = state.terms.milestones.findIndex((m) => m.id === id);
  if (i < 0) fail("NOT_FOUND", `no milestone '${id}'`);
  return { terms: state.terms.milestones[i]!, state: state.milestones[i]! };
}

function allocate(m: MilestoneState, terms: MilestoneTerms, workerYocto: bigint): void {
  const amount = toYocto(terms.amountYocto);
  if (workerYocto < 0n || workerYocto > amount) fail("ACCOUNTING", `worker share ${workerYocto} outside 0..${amount}`);
  m.allocation = { workerYocto: fromYocto(workerYocto), clientYocto: fromYocto(amount - workerYocto) };
  m.status = "CLAIMABLE";
  m.settlementProposal = null;
  m.challengeEndsAt = null;
}

// ---- agreement-level transitions -------------------------------------------------

function amendTerms(state: AgreementState, e: Event<"AMEND_TERMS">): void {
  requireAgreementStatus(state, "DRAFT");
  requireRole(state, e.actor, ["client"]);
  if (e.terms.agreementId !== state.terms.agreementId) fail("VALIDATION", "agreementId cannot change");
  if (e.terms.client.nearAccountId !== state.terms.client.nearAccountId) fail("VALIDATION", "client cannot change");
  if (e.terms.fundingDeadline <= e.at) fail("DEADLINE", "fundingDeadline must be in the future");
  state.terms = e.terms;
  state.termsHash = computeTermsHash(e.terms);
  state.acceptedBy = { client: false, worker: false };
  state.milestones = e.terms.milestones.map(freshMilestone);
}

function acceptTerms(state: AgreementState, e: Event<"ACCEPT_TERMS">): void {
  requireAgreementStatus(state, "DRAFT");
  const role = requireRole(state, e.actor, ["client", "worker"]);
  if (e.termsHash !== state.termsHash) fail("HASH_MISMATCH", "accepted terms hash does not match current terms");
  state.acceptedBy[role as "client" | "worker"] = true;
}

function fund(state: AgreementState, e: Event<"FUND">): void {
  requireAgreementStatus(state, "DRAFT");
  requireRole(state, e.actor, ["client"]);
  if (e.termsHash !== state.termsHash) fail("HASH_MISMATCH", "funding references different terms");
  // An open bounty is funded before anyone accepts it: posting it is the deposit.
  const needsWorker = !state.terms.openBounty;
  if (!state.acceptedBy.client || (needsWorker && !state.acceptedBy.worker)) {
    fail("INVALID_TRANSITION", "both client and worker must accept the terms before funding");
  }
  if (e.at > state.terms.fundingDeadline) fail("DEADLINE", "funding deadline has passed");
  if (toYocto(e.amountYocto) !== toYocto(state.terms.totalYocto)) {
    fail("ACCOUNTING", `funding must be exactly ${state.terms.totalYocto} yoctoNEAR, got ${e.amountYocto}`);
  }
  state.status = state.terms.openBounty ? "OPEN" : "FUNDED";
  state.fundedYocto = state.terms.totalYocto;
  state.fundedAt = e.at;
}

/** The claimer becomes the worker of the posted terms; the deposit is already in escrow. */
function claimBounty(state: AgreementState, e: Event<"CLAIM_BOUNTY">): void {
  requireAgreementStatus(state, "OPEN");
  if (e.at > state.terms.fundingDeadline) fail("DEADLINE", "the claim deadline has passed");
  const t = state.terms;
  if ([t.client.nearAccountId, t.verifierAuthority, t.disputeResolver].includes(e.actor)) {
    fail("UNAUTHORIZED", "the client, verifier and resolver cannot claim their own bounty");
  }
  // termsHash stays the hash of the posted document both sides agreed to.
  state.terms = { ...t, worker: { kind: e.workerKind, nearAccountId: e.actor } };
  state.acceptedBy.worker = true;
  state.status = "FUNDED";
}

function cancelBounty(state: AgreementState, e: Event<"CANCEL_BOUNTY">): void {
  requireAgreementStatus(state, "OPEN");
  requireRole(state, e.actor, ["client"]);
  state.status = "CANCELLED";
  state.fundedYocto = "0";
}

// ---- milestone transitions -------------------------------------------------------

type MilestoneEvent = Exclude<AgreementEvent, { type: "AMEND_TERMS" | "ACCEPT_TERMS" | "FUND" | "CLAIM_BOUNTY" | "CANCEL_BOUNTY" }>;

function applyMilestoneEvent(state: AgreementState, e: MilestoneEvent): void {
  requireAgreementStatus(state, "FUNDED");
  const { terms, state: m } = findMilestone(state, e.milestoneId);

  switch (e.type) {
    case "SUBMIT": {
      requireRole(state, e.actor, ["worker"]);
      requireStatus(m, ["PENDING", "REVISION_REQUESTED"]);
      if (e.at >= state.terms.expiresAt) fail("DEADLINE", "agreement has expired");
      if (m.submissionCount >= MAX_SUBMISSIONS_PER_MILESTONE) fail("INVALID_TRANSITION", "submission limit reached");
      m.submission = {
        seq: m.submissionCount + 1,
        artifactHash: e.artifactHash,
        ...(e.uri !== undefined ? { uri: e.uri } : {}),
        submittedAt: e.at,
      };
      m.submissionCount += 1;
      m.status = "SUBMITTED";
      return;
    }

    case "RECORD_VERIFICATION": {
      // Any party may relay a report; the verifier's signature is the authority.
      const r = e.report;
      if (!verifyReportSignature(state.terms.escrowContract, r, e.signature, state.terms.verifierPublicKey)) {
        fail("INVALID_SIGNATURE", "report is not signed by the agreed verifier key");
      }
      if (terms.type !== "AUTOMATED") fail("INVALID_TRANSITION", `milestone '${m.id}' is not automatically verified`);
      requireStatus(m, ["SUBMITTED"]);
      const sub = m.submission!;
      const mismatches: string[] = [];
      if (r.agreementId !== state.terms.agreementId) mismatches.push("agreementId");
      if (r.milestoneId !== m.id) mismatches.push("milestoneId");
      if (r.submissionSeq !== sub.seq) mismatches.push("submissionSeq");
      if (r.artifactHash !== sub.artifactHash) mismatches.push("artifactHash");
      if (r.planHash !== computePlanHash(terms.verificationPlan)) mismatches.push("planHash");
      if (mismatches.length) fail("BINDING_MISMATCH", `report does not match: ${mismatches.join(", ")}`, { mismatches });
      if (m.lastReportNonce === r.nonce) fail("REPLAY", "verification report nonce already used");
      if (r.issuedAt < sub.submittedAt) fail("BINDING_MISMATCH", "report predates the submission");
      if (e.at > r.expiresAt) fail("DEADLINE", "verification report has expired");

      m.lastReportNonce = r.nonce;
      m.lastVerification = { outcome: r.outcome, nonce: r.nonce, evidenceDigest: r.evidenceDigest };
      if (r.outcome === "PASS") {
        m.status = "VERIFIED_PENDING_CHALLENGE";
        m.challengeEndsAt = e.at + state.terms.challengePeriodSec * 1000;
      } else if (r.outcome === "FAIL") {
        // A definitive failure: the worker must submit new work.
        m.status = "PENDING";
        m.submission = null;
      }
      // INCONCLUSIVE / RUNNER_ERROR: fail closed, stay SUBMITTED so verification can be re-run.
      return;
    }

    case "CHALLENGE": {
      requireRole(state, e.actor, ["client"]);
      requireStatus(m, ["VERIFIED_PENDING_CHALLENGE"]);
      if (e.at >= m.challengeEndsAt!) fail("DEADLINE", "challenge period has ended");
      m.status = "DISPUTED";
      m.challengeEndsAt = null;
      return;
    }

    case "FINALIZE_CHALLENGE": {
      requireRole(state, e.actor, ["client", "worker", "verifier"]);
      requireStatus(m, ["VERIFIED_PENDING_CHALLENGE"]);
      if (e.at < m.challengeEndsAt!) fail("DEADLINE", "challenge period has not ended");
      allocate(m, terms, toYocto(terms.amountYocto));
      return;
    }

    case "APPROVE": {
      requireRole(state, e.actor, ["client"]);
      requireHumanReview(terms, m);
      requireStatus(m, ["SUBMITTED"]);
      allocate(m, terms, toYocto(terms.amountYocto));
      return;
    }

    case "REQUEST_REVISION": {
      requireRole(state, e.actor, ["client"]);
      const review = requireHumanReview(terms, m);
      requireStatus(m, ["SUBMITTED"]);
      if (m.revisionsUsed >= review.maxRevisions) {
        fail("INVALID_TRANSITION", `all ${review.maxRevisions} agreed revisions used; approve, settle or dispute`);
      }
      m.revisionsUsed += 1;
      m.submission = null;
      m.status = "REVISION_REQUESTED";
      return;
    }

    case "OPEN_DISPUTE": {
      requireRole(state, e.actor, ["client", "worker"]);
      requireHumanReview(terms, m);
      requireStatus(m, ["SUBMITTED", "REVISION_REQUESTED"]);
      m.status = "DISPUTED";
      return;
    }

    case "PROPOSE_SETTLEMENT": {
      const role = requireRole(state, e.actor, ["client", "worker"]);
      requireHumanReview(terms, m);
      requireStatus(m, ["SUBMITTED", "REVISION_REQUESTED", "DISPUTED"]);
      requireWithinAmount(terms, e.workerYocto);
      m.settlementProposal = { proposer: role === "client" ? state.terms.client.nearAccountId : state.terms.worker.nearAccountId, workerYocto: e.workerYocto };
      return;
    }

    case "ACCEPT_SETTLEMENT": {
      requireRole(state, e.actor, ["client", "worker"]);
      requireHumanReview(terms, m);
      requireStatus(m, ["SUBMITTED", "REVISION_REQUESTED", "DISPUTED"]);
      const p = m.settlementProposal;
      if (!p) fail("INVALID_TRANSITION", "no settlement proposal to accept");
      if (p.proposer === e.actor) fail("UNAUTHORIZED", "the other party must accept the settlement");
      if (p.workerYocto !== e.workerYocto) fail("BINDING_MISMATCH", "accepted amount differs from the proposal");
      allocate(m, terms, toYocto(p.workerYocto));
      return;
    }

    case "RESOLVE_DISPUTE": {
      requireRole(state, e.actor, ["resolver"]);
      requireStatus(m, ["DISPUTED"]);
      const share = toYocto(e.workerYocto);
      const floor = protectedFloor(terms, m);
      if (share < floor) fail("ACCOUNTING", `resolution below the agreed protected floor of ${floor} yoctoNEAR`);
      allocate(m, terms, share);
      return;
    }

    case "EXPIRE_MILESTONE": {
      requireRole(state, e.actor, ["client", "worker"]);
      // Only milestones with no live submission expire; submitted work must be reviewed or disputed.
      requireStatus(m, ["PENDING", "REVISION_REQUESTED"]);
      if (e.at < state.terms.expiresAt) fail("DEADLINE", "agreement has not expired");
      allocate(m, terms, 0n);
      return;
    }

    case "START_PAYOUT": {
      // Recipients are fixed by the allocation; the verifier may trigger it for automatic payouts.
      requireRole(state, e.actor, ["client", "worker", "verifier"]);
      requireStatus(m, ["CLAIMABLE"]);
      m.status = "PAYOUT_PENDING";
      return;
    }
  }
}

function requireHumanReview(terms: MilestoneTerms, m: MilestoneState) {
  if (terms.type !== "HUMAN_REVIEW") fail("INVALID_TRANSITION", `milestone '${m.id}' is not a human-review milestone`);
  return terms;
}

function requireWithinAmount(terms: MilestoneTerms, workerYocto: Yocto): void {
  if (toYocto(workerYocto) > toYocto(terms.amountYocto)) {
    fail("ACCOUNTING", `worker share exceeds milestone amount ${terms.amountYocto}`);
  }
}

/** The pre-agreed minimum a dispute can award: only once its condition was actually met. */
export function protectedFloor(terms: MilestoneTerms, m: MilestoneState): bigint {
  if (terms.type !== "HUMAN_REVIEW" || !terms.partialCompensation) return 0n;
  return m.submissionCount > 0 ? toYocto(terms.partialCompensation.floorYocto) : 0n;
}
