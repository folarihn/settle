import { z } from "zod";
import { NearAccountId } from "./identity.js";
import { YoctoString } from "./money.js";
import { AgreementTerms } from "./terms.js";

const Sha256Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/, "must be sha256:<64 hex>");
const MilestoneRef = z.string().min(1).max(64);
const Timestamp = z.number().int().nonnegative();

export const VerificationOutcome = z.enum(["PASS", "FAIL", "INCONCLUSIVE", "RUNNER_ERROR"]);
export type VerificationOutcome = z.infer<typeof VerificationOutcome>;

/**
 * What the verifier attests to. Every identifier is bound so a report cannot be
 * reused for another job, milestone, submission, artifact or a changed plan. It is
 * authenticated by the verifier's ed25519 signature (see signing.ts), so any party
 * may relay it; field set and order match the escrow contract.
 */
export const VerificationReport = z
  .object({
    agreementId: z.string().min(1).max(64),
    milestoneId: MilestoneRef,
    /** Assigned by the state machine / contract on submit: 1, 2, ... */
    submissionSeq: z.number().int().min(1).max(0xffffffff),
    artifactHash: z.string().min(1).max(200),
    planHash: Sha256Digest,
    outcome: VerificationOutcome,
    evidenceDigest: Sha256Digest,
    nonce: z.string().min(16).max(128),
    issuedAt: Timestamp,
    expiresAt: Timestamp,
  })
  .strict();
export type VerificationReport = z.infer<typeof VerificationReport>;

const base = { actor: NearAccountId, at: Timestamp };
const onMilestone = { ...base, milestoneId: MilestoneRef };

/** Every action a party (human or agent) can take. Adapters parse untrusted input with this schema. */
export const AgreementEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("AMEND_TERMS"), ...base, terms: AgreementTerms }).strict(),
  z.object({ type: z.literal("ACCEPT_TERMS"), ...base, termsHash: Sha256Digest }).strict(),
  z.object({ type: z.literal("FUND"), ...base, termsHash: Sha256Digest, amountYocto: YoctoString }).strict(),
  z
    .object({
      type: z.literal("SUBMIT"),
      ...onMilestone,
      // Git commit SHA for technical work, content hash for creative deliverables.
      artifactHash: z.string().min(1).max(200),
      uri: z.string().url().max(2000).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("RECORD_VERIFICATION"),
      ...onMilestone,
      report: VerificationReport,
      signature: z.string().regex(/^[0-9a-f]{128}$/, "must be a 64-byte hex ed25519 signature"),
    })
    .strict(),
  z.object({ type: z.literal("CHALLENGE"), ...onMilestone, reason: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ type: z.literal("FINALIZE_CHALLENGE"), ...onMilestone }).strict(),
  z.object({ type: z.literal("APPROVE"), ...onMilestone }).strict(),
  z.object({ type: z.literal("REQUEST_REVISION"), ...onMilestone, feedback: z.string().trim().min(1).max(5000) }).strict(),
  z.object({ type: z.literal("OPEN_DISPUTE"), ...onMilestone, reason: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ type: z.literal("PROPOSE_SETTLEMENT"), ...onMilestone, workerYocto: YoctoString }).strict(),
  z.object({ type: z.literal("ACCEPT_SETTLEMENT"), ...onMilestone, workerYocto: YoctoString }).strict(),
  z.object({ type: z.literal("RESOLVE_DISPUTE"), ...onMilestone, workerYocto: YoctoString }).strict(),
  z.object({ type: z.literal("EXPIRE_MILESTONE"), ...onMilestone }).strict(),
  z.object({ type: z.literal("START_PAYOUT"), ...onMilestone }).strict(),
  // Open bounties. Both happen onchain first and are mirrored by chain sync; the actor of
  // CLAIM_BOUNTY is whoever the contract recorded as the claimer.
  z.object({ type: z.literal("CLAIM_BOUNTY"), ...base, workerKind: z.enum(["HUMAN", "AGENT"]) }).strict(),
  z.object({ type: z.literal("CANCEL_BOUNTY"), ...base }).strict(),
]);
export type AgreementEvent = z.infer<typeof AgreementEvent>;
