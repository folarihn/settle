import { createHash } from "node:crypto";
import { BorshWriter } from "./borsh.js";
import type { AgreementEvent, VerificationReport } from "./events.js";
import { YOCTO_PER_NEAR } from "./money.js";
import type { AgreementState, MilestoneStatus } from "./state.js";
import { computePlanHash, computeTermsHash, type AgreementTerms } from "./terms.js";

/**
 * Translation between the domain model and the escrow contract's JSON interface
 * (contracts/escrow/src/types.rs). The contract is the authority for money; this
 * module only builds the calls a party must sign and reads back what the chain says.
 */

export type ContractMilestoneKind =
  | { Automated: { plan_hash: string } }
  | { HumanReview: { max_revisions: number; floor: string } };

export interface ContractTerms {
  agreement_id: string;
  offchain_terms_hash: string;
  client: string;
  worker: string;
  verifier: string;
  verifier_public_key: string;
  resolver: string;
  total: string;
  milestones: { id: string; amount: string; kind: ContractMilestoneKind }[];
  challenge_period_ms: number;
  funding_deadline_ms: number;
  expires_at_ms: number;
}

export type ContractMilestoneStatus =
  | "Pending"
  | "Submitted"
  | "VerifiedPendingChallenge"
  | "RevisionRequested"
  | "Disputed"
  | "Claimable"
  | "PayoutPending"
  | "Paid";

interface ContractShare {
  due: string;
  pending: string;
  paid: string;
}

/** Shape returned by the contract's `get_agreement` view. */
export interface ContractAgreement {
  terms: ContractTerms;
  terms_hash: string;
  status: "Draft" | "Funded" | "Completed";
  accepted_by_worker: boolean;
  funded_at_ms: number | null;
  milestones: {
    status: ContractMilestoneStatus;
    submission: { seq: number; artifact_hash: string; submitted_at_ms: number } | null;
    submission_count: number;
    allocated: boolean;
    worker: ContractShare;
    client: ContractShare;
  }[];
}

/** A function call the acting party signs with their own NEAR key (wallet or agent SDK). */
export interface ContractCall {
  contractId: string;
  methodName: string;
  args: Record<string, unknown>;
  /** yoctoNEAR to attach, as an integer string. */
  deposit: string;
  /** Gas in units, as an integer string. */
  gas: string;
}

const TGAS = 10n ** 12n;
const DEFAULT_GAS = (30n * TGAS).toString();
/** payout schedules up to two transfers, each with a 5 Tgas callback. */
const PAYOUT_GAS = (60n * TGAS).toString();
/** Storage prepayment for create_agreement; the contract refunds whatever it does not need. */
export const CREATE_STORAGE_DEPOSIT = (YOCTO_PER_NEAR / 5n).toString(); // 0.2 NEAR

export function toContractTerms(terms: AgreementTerms): ContractTerms {
  return {
    agreement_id: terms.agreementId,
    offchain_terms_hash: computeTermsHash(terms),
    client: terms.client.nearAccountId,
    worker: terms.worker.nearAccountId,
    verifier: terms.verifierAuthority,
    verifier_public_key: terms.verifierPublicKey,
    resolver: terms.disputeResolver,
    total: terms.totalYocto,
    milestones: terms.milestones.map((m) => ({
      id: m.id,
      amount: m.amountYocto,
      kind:
        m.type === "AUTOMATED"
          ? { Automated: { plan_hash: computePlanHash(m.verificationPlan) } }
          : { HumanReview: { max_revisions: m.maxRevisions, floor: m.partialCompensation?.floorYocto ?? "0" } },
    })),
    challenge_period_ms: terms.challengePeriodSec * 1000,
    funding_deadline_ms: terms.fundingDeadline,
    expires_at_ms: terms.expiresAt,
  };
}

/**
 * The hash the contract computes in `create_agreement`: sha256 over the borsh encoding
 * of its AgreementTerms struct (field order of contracts/escrow/src/types.rs).
 */
export function computeOnchainTermsHash(t: ContractTerms): string {
  const w = new BorshWriter()
    .string(t.agreement_id)
    .string(t.offchain_terms_hash)
    .string(t.client)
    .string(t.worker)
    .string(t.verifier)
    .string(t.verifier_public_key)
    .string(t.resolver)
    .u128(BigInt(t.total))
    .u32(t.milestones.length);
  for (const m of t.milestones) {
    w.string(m.id).u128(BigInt(m.amount));
    if ("Automated" in m.kind) {
      w.u8(0).string(m.kind.Automated.plan_hash);
    } else {
      w.u8(1).u8(m.kind.HumanReview.max_revisions).u128(BigInt(m.kind.HumanReview.floor));
    }
  }
  w.u64(t.challenge_period_ms).u64(t.funding_deadline_ms).u64(t.expires_at_ms);
  return `sha256:${createHash("sha256").update(w.bytes()).digest("hex")}`;
}

const OUTCOME_NAME = { PASS: "Pass", FAIL: "Fail", INCONCLUSIVE: "Inconclusive", RUNNER_ERROR: "RunnerError" } as const;

export function toContractReport(r: VerificationReport) {
  return {
    agreement_id: r.agreementId,
    milestone_id: r.milestoneId,
    submission_seq: r.submissionSeq,
    artifact_hash: r.artifactHash,
    plan_hash: r.planHash,
    outcome: OUTCOME_NAME[r.outcome],
    evidence_digest: r.evidenceDigest,
    nonce: r.nonce,
    issued_at_ms: r.issuedAt,
    expires_at_ms: r.expiresAt,
  };
}

const call = (contractId: string, methodName: string, args: Record<string, unknown>, deposit = "0", gas = DEFAULT_GAS): ContractCall => ({
  contractId,
  methodName,
  args,
  deposit,
  gas,
});

export function createAgreementCall(terms: AgreementTerms): ContractCall {
  return call(terms.escrowContract, "create_agreement", { terms: toContractTerms(terms) }, CREATE_STORAGE_DEPOSIT);
}

export function fundCall(terms: AgreementTerms): ContractCall {
  const onchainHash = computeOnchainTermsHash(toContractTerms(terms));
  return call(terms.escrowContract, "fund", { agreement_id: terms.agreementId, terms_hash: onchainHash }, terms.totalYocto);
}

export function payoutCall(terms: AgreementTerms, milestoneId: string): ContractCall {
  return call(terms.escrowContract, "payout", { agreement_id: terms.agreementId, milestone_id: milestoneId }, "0", PAYOUT_GAS);
}

/**
 * The onchain call matching an accepted domain event, or null when the event has no
 * onchain counterpart (the client's own acceptance is implied by create_agreement;
 * amendments only exist before anything is onchain).
 */
export function contractCallFor(state: AgreementState, e: AgreementEvent): ContractCall | null {
  const t = state.terms;
  const base = { agreement_id: t.agreementId };
  const ms = "milestoneId" in e ? { ...base, milestone_id: e.milestoneId } : base;
  switch (e.type) {
    case "AMEND_TERMS":
      return null;
    case "ACCEPT_TERMS":
      return e.actor === t.worker.nearAccountId
        ? call(t.escrowContract, "accept_terms", { ...base, terms_hash: computeOnchainTermsHash(toContractTerms(t)) })
        : null;
    case "FUND":
      return fundCall(t);
    case "SUBMIT":
      return call(t.escrowContract, "submit", { ...ms, artifact_hash: e.artifactHash });
    case "RECORD_VERIFICATION":
      return call(t.escrowContract, "record_verification", { report: toContractReport(e.report), signature: e.signature });
    case "CHALLENGE":
      return call(t.escrowContract, "challenge", { ...ms, reason: e.reason });
    case "REQUEST_REVISION":
      return call(t.escrowContract, "request_revision", { ...ms, feedback: e.feedback });
    case "OPEN_DISPUTE":
      return call(t.escrowContract, "open_dispute", { ...ms, reason: e.reason });
    case "PROPOSE_SETTLEMENT":
    case "ACCEPT_SETTLEMENT":
    case "RESOLVE_DISPUTE":
      return call(t.escrowContract, e.type.toLowerCase(), { ...ms, worker_amount: e.workerYocto });
    case "FINALIZE_CHALLENGE":
    case "APPROVE":
    case "EXPIRE_MILESTONE":
      return call(t.escrowContract, e.type.toLowerCase(), ms);
    case "START_PAYOUT":
      return payoutCall(t, e.milestoneId);
  }
}

const STATUS_FROM_CHAIN: Record<ContractMilestoneStatus, MilestoneStatus> = {
  Pending: "PENDING",
  Submitted: "SUBMITTED",
  VerifiedPendingChallenge: "VERIFIED_PENDING_CHALLENGE",
  RevisionRequested: "REVISION_REQUESTED",
  Disputed: "DISPUTED",
  Claimable: "CLAIMABLE",
  PayoutPending: "PAYOUT_PENDING",
  Paid: "PAID",
};

export const milestoneStatusFromChain = (s: ContractMilestoneStatus): MilestoneStatus => STATUS_FROM_CHAIN[s];
