import type { NearAccountId } from "./identity.js";
import type { Yocto } from "./money.js";
import type { AgreementTerms } from "./terms.js";
import type { VerificationOutcome } from "./events.js";

/**
 * Milestone lifecycle (see docs/ARCHITECTURE.md):
 *   PENDING -> SUBMITTED -> VERIFIED_PENDING_CHALLENGE -> CLAIMABLE -> PAYOUT_PENDING -> PAID
 *   SUBMITTED -> REVISION_REQUESTED | DISPUTED -> CLAIMABLE
 * CLAIMABLE always carries a fixed allocation; a zero worker share is a full refund.
 */
export type MilestoneStatus =
  | "PENDING"
  | "SUBMITTED"
  | "VERIFIED_PENDING_CHALLENGE"
  | "REVISION_REQUESTED"
  | "DISPUTED"
  | "CLAIMABLE"
  | "PAYOUT_PENDING"
  | "PAID";

export interface Submission {
  submissionId: string;
  artifactHash: string;
  uri?: string;
  submittedAt: number;
}

export interface Allocation {
  workerYocto: Yocto;
  clientYocto: Yocto;
}

export interface MilestoneState {
  id: string;
  status: MilestoneStatus;
  submission: Submission | null;
  submissionCount: number;
  revisionsUsed: number;
  challengeEndsAt: number | null;
  lastVerification: { outcome: VerificationOutcome; nonce: string; evidenceDigest: string } | null;
  settlementProposal: { proposer: NearAccountId; workerYocto: Yocto } | null;
  allocation: Allocation | null;
}

export type AgreementStatus = "DRAFT" | "FUNDED" | "COMPLETED";

export interface AgreementState {
  terms: AgreementTerms;
  termsHash: string;
  status: AgreementStatus;
  /** Acceptances are of a specific terms hash; amending terms clears them. */
  acceptedBy: { client: boolean; worker: boolean };
  fundedYocto: Yocto;
  fundedAt: number | null;
  milestones: MilestoneState[];
  usedReportNonces: string[];
  usedSubmissionIds: string[];
  /** Incremented on every accepted transition; adapters use it for optimistic concurrency. */
  version: number;
}
