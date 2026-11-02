import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  computePlanHash,
  hashCanonical,
  HttpVerificationPlan,
  NearAccountId,
  publicKeyFromSeed,
  signReport,
  type VerificationReport,
} from "@settle/domain";
import { runPlan, type RunDeps, type RunResult } from "./runner.js";

/** One verification job: the locked plan plus the submission it applies to. */
export const VerificationRequest = z
  .object({
    escrowContract: NearAccountId,
    agreementId: z.string().min(1).max(64),
    milestoneId: z.string().min(1).max(64),
    plan: HttpVerificationPlan,
    submission: z
      .object({
        seq: z.number().int().min(1),
        artifactHash: z.string().min(1).max(200),
        /** Base URL of the deployed API under test; the plan path is appended. */
        uri: z.string().min(1).max(2000),
      })
      .strict(),
  })
  .strict();
export type VerificationRequest = z.infer<typeof VerificationRequest>;

/**
 * The full record behind a report. Its canonical hash is the report's evidenceDigest,
 * so anyone holding the evidence can check it was not altered after signing.
 */
export interface Evidence extends RunResult {
  schema: "settle-evidence-v1";
  escrowContract: string;
  agreementId: string;
  milestoneId: string;
  submissionSeq: number;
  artifactHash: string;
  planHash: string;
  submittedUri: string;
  verifierPublicKey: string;
  startedAt: number;
  finishedAt: number;
}

export interface SignedVerification {
  report: VerificationReport;
  signature: string;
  evidence: Evidence;
}

export interface VerifyOptions extends RunDeps {
  /** ed25519 seed (hex). Read from the verifier's own secret store, never from the request. */
  seedHex: string;
  now?: () => number;
  /** How long the signed report stays valid for submission onchain. */
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export async function verifySubmission(input: unknown, opts: VerifyOptions): Promise<SignedVerification> {
  const req = VerificationRequest.parse(input);
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const run = await runPlan(req.plan, req.submission.uri, opts);
  const finishedAt = now();

  const evidence: Evidence = {
    schema: "settle-evidence-v1",
    escrowContract: req.escrowContract,
    agreementId: req.agreementId,
    milestoneId: req.milestoneId,
    submissionSeq: req.submission.seq,
    artifactHash: req.submission.artifactHash,
    planHash: computePlanHash(req.plan),
    submittedUri: req.submission.uri,
    verifierPublicKey: publicKeyFromSeed(opts.seedHex),
    startedAt,
    finishedAt,
    ...run,
  };
  const report: VerificationReport = {
    agreementId: req.agreementId,
    milestoneId: req.milestoneId,
    submissionSeq: req.submission.seq,
    artifactHash: req.submission.artifactHash,
    planHash: evidence.planHash,
    outcome: run.outcome,
    evidenceDigest: hashCanonical(evidence),
    nonce: randomBytes(16).toString("hex"),
    issuedAt: finishedAt,
    expiresAt: finishedAt + (opts.ttlMs ?? DEFAULT_TTL_MS),
  };
  return { report, signature: signReport(req.escrowContract, report, opts.seedHex), evidence };
}

/** True only if this evidence is exactly what the report's digest committed to. */
export function evidenceMatchesReport(evidence: Evidence, report: VerificationReport): boolean {
  return (
    hashCanonical(evidence) === report.evidenceDigest &&
    evidence.agreementId === report.agreementId &&
    evidence.milestoneId === report.milestoneId &&
    evidence.submissionSeq === report.submissionSeq &&
    evidence.artifactHash === report.artifactHash &&
    evidence.planHash === report.planHash &&
    evidence.outcome === report.outcome
  );
}
