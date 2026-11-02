import { z } from "zod";
import { DomainError } from "./errors.js";
import { hashCanonical } from "./hash.js";
import { NearAccountId, Principal } from "./identity.js";
import { YoctoString, parseYoctoOrNull } from "./money.js";

const JsonScalar = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);

// `$`, `$.field`, `$.list[0].field` — deliberately tiny so plans stay auditable.
const JsonPath = z
  .string()
  .max(200)
  .regex(/^\$(\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\])*$/, "unsupported JSON path");

export const JsonAssertion = z.discriminatedUnion("op", [
  z.object({ op: z.literal("exists"), path: JsonPath }).strict(),
  z.object({ op: z.literal("equals"), path: JsonPath, value: JsonScalar }).strict(),
  z
    .object({
      op: z.literal("type"),
      path: JsonPath,
      type: z.enum(["string", "number", "boolean", "object", "array", "null"]),
    })
    .strict(),
]);
export type JsonAssertion = z.infer<typeof JsonAssertion>;

/**
 * An HTTP API acceptance test agreed before funding. The submission supplies the
 * deployment base URL; everything the verifier checks is fixed here.
 */
export const HttpVerificationPlan = z
  .object({
    kind: z.literal("HTTP_API"),
    version: z.literal(1),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    path: z.string().max(500).regex(/^\/[^\s#]*$/, "path must start with '/' and contain no whitespace or fragment"),
    requestBody: z.record(z.unknown()).optional(),
    expectedStatus: z.number().int().min(100).max(599),
    assertions: z.array(JsonAssertion).max(50),
    timeoutMs: z.number().int().min(100).max(30_000),
    maxResponseBytes: z.number().int().min(1).max(1_048_576),
    maxLatencyMs: z.number().int().min(1).max(30_000).optional(),
  })
  .strict();
export type HttpVerificationPlan = z.infer<typeof HttpVerificationPlan>;

const MilestoneId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "milestone id must be a lowercase slug");

const MilestoneBase = {
  id: MilestoneId,
  title: z.string().trim().min(1).max(200),
  amountYocto: YoctoString,
};

export const AutomatedMilestoneTerms = z
  .object({
    ...MilestoneBase,
    type: z.literal("AUTOMATED"),
    verificationPlan: HttpVerificationPlan,
  })
  .strict();

/**
 * `floorYocto` is the pre-agreed amount the worker has earned once a deliverable
 * has been submitted, even if the client ultimately rejects it. It is not paid
 * automatically: it bounds what a dispute resolution may award.
 */
export const PartialCompensation = z
  .object({
    condition: z.literal("DELIVERABLE_SUBMITTED"),
    floorYocto: YoctoString,
  })
  .strict();

export const HumanReviewMilestoneTerms = z
  .object({
    ...MilestoneBase,
    type: z.literal("HUMAN_REVIEW"),
    rubric: z.string().trim().min(1).max(5000),
    maxRevisions: z.number().int().min(0).max(10),
    partialCompensation: PartialCompensation.nullable(),
  })
  .strict();

export const MilestoneTerms = z.discriminatedUnion("type", [AutomatedMilestoneTerms, HumanReviewMilestoneTerms]);
export type MilestoneTerms = z.infer<typeof MilestoneTerms>;
export type AutomatedMilestoneTerms = z.infer<typeof AutomatedMilestoneTerms>;
export type HumanReviewMilestoneTerms = z.infer<typeof HumanReviewMilestoneTerms>;

const MAX_CHALLENGE_SEC = 30 * 24 * 60 * 60;

export const AgreementTerms = z
  .object({
    schemaVersion: z.literal(1),
    agreementId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, "agreement id must be 8-64 url-safe characters"),
    client: Principal,
    worker: Principal,
    verifierAuthority: NearAccountId,
    disputeResolver: NearAccountId,
    asset: z.literal("NEAR"),
    totalYocto: YoctoString,
    milestones: z.array(MilestoneTerms).min(1).max(10),
    challengePeriodSec: z.number().int().min(60).max(MAX_CHALLENGE_SEC),
    fundingDeadline: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
  })
  .strict()
  .superRefine((t, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });

    const client = t.client.nearAccountId;
    const worker = t.worker.nearAccountId;
    if (client === worker) issue(["worker"], "client and worker must be different accounts");
    for (const role of ["verifierAuthority", "disputeResolver"] as const) {
      if (t[role] === client || t[role] === worker) {
        issue([role], `${role} must be independent of client and worker`);
      }
    }
    if (t.fundingDeadline >= t.expiresAt) issue(["expiresAt"], "expiresAt must be after fundingDeadline");

    const seen = new Set<string>();
    let sum: bigint | null = 0n;
    t.milestones.forEach((m, i) => {
      if (seen.has(m.id)) issue(["milestones", i, "id"], `duplicate milestone id '${m.id}'`);
      seen.add(m.id);
      const amount = parseYoctoOrNull(m.amountYocto);
      if (amount === null) {
        sum = null; // already reported by the field schema
        return;
      }
      if (amount === 0n) issue(["milestones", i, "amountYocto"], "milestone amount must be positive");
      if (sum !== null) sum += amount;
      if (m.type === "HUMAN_REVIEW" && m.partialCompensation) {
        const floor = parseYoctoOrNull(m.partialCompensation.floorYocto);
        if (floor !== null && floor > amount) {
          issue(["milestones", i, "partialCompensation", "floorYocto"], "floor cannot exceed milestone amount");
        }
      }
    });
    const total = parseYoctoOrNull(t.totalYocto);
    if (sum !== null && total !== null && sum !== total) {
      issue(["totalYocto"], `milestone amounts sum to ${sum} but totalYocto is ${t.totalYocto}`);
    }
  });
export type AgreementTerms = z.infer<typeof AgreementTerms>;

/** Validate untrusted input into terms, or throw a VALIDATION error listing every problem. */
export function parseTerms(input: unknown): AgreementTerms {
  const result = AgreementTerms.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    throw new DomainError("VALIDATION", `invalid agreement terms: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`, {
      issues,
    });
  }
  return result.data;
}

export const computeTermsHash = (terms: AgreementTerms): string => hashCanonical(terms);
export const computePlanHash = (plan: HttpVerificationPlan): string => hashCanonical(plan);
