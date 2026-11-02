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
 * reused for another job, milestone, submission, artifact or a changed plan.
 * Signature verification is added with the verifier service (Phase 2); here the
 * report is accepted only when submitted by the agreed verifier account.
 */
export const VerificationReport = z
  .object({
    agreementId: z.string().min(1),
    milestoneId: MilestoneRef,
    submissionId: z.string().min(1).max(128),
    artifactHash: z.string().min(1).max(200),
    planHash: Sha256Digest,
    verifierId: NearAccountId,
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
      submissionId: z.string().min(1).max(128),
      // Git commit SHA for technical work, content hash for creative deliverables.
      artifactHash: z.string().min(1).max(200),
      uri: z.string().url().max(2000).optional(),
    })
    .strict(),
  z.object({ type: z.literal("RECORD_VERIFICATION"), ...onMilestone, report: VerificationReport }).strict(),
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
]);
export type AgreementEvent = z.infer<typeof AgreementEvent>;
