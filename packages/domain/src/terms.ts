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
    /**
     * Sustained health: run the same request `count` times, `intervalMs` apart; every probe
     * must pass. Bounded to two minutes so one verification never holds the worker for long.
     */
    repeat: z
      .object({ count: z.number().int().min(2).max(20), intervalMs: z.number().int().min(1000).max(60_000) })
      .strict()
      .refine((r) => (r.count - 1) * r.intervalMs <= 120_000, "repeat must finish within 120 seconds")
      .optional(),
  })
  .strict();
export type HttpVerificationPlan = z.infer<typeof HttpVerificationPlan>;

const CheckName = z.string().trim().min(1).max(200);

/**
 * Continuous-integration checks on GitHub. The submission's artifact hash is the commit SHA.
 * PASS needs the commit to be on `branch` (so the client's own merge rules apply: a pull
 * request cannot rewrite the workflow that judges it) and every required check run or
 * commit status to have succeeded.
 */
export const GithubChecksPlan = z
  .object({
    kind: z.literal("GITHUB_CHECKS"),
    version: z.literal(1),
    repo: z.string().regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/, "repo must be owner/name"),
    branch: z.string().min(1).max(200).regex(/^[A-Za-z0-9._\/-]+$/, "invalid branch name"),
    requiredChecks: z.array(CheckName).min(1).max(20),
  })
  .strict();
export type GithubChecksPlan = z.infer<typeof GithubChecksPlan>;

const Phrase = z.string().trim().min(1).max(200);

/**
 * Written or data work checked against rules fixed before funding (ADR 0008). The submission's
 * artifact hash is the SHA-256 of the deliverable's bytes; the verifier checks the bytes it
 * reads match that hash, then applies every rule. No code is executed and no judgement is made:
 * each rule is mechanical, so a PASS can release payment like any other automated check.
 */
const ContentRulesFields = z
  .object({
    kind: z.literal("CONTENT_RULES"),
    version: z.literal(1),
    format: z.enum(["text", "markdown", "json"]),
    maxBytes: z.number().int().min(1).max(65_536),
    minWords: z.number().int().min(1).max(20_000).optional(),
    maxWords: z.number().int().min(1).max(20_000).optional(),
    /** Each phrase must appear (case-insensitive). */
    mustInclude: z.array(Phrase).max(20).optional(),
    /** None of these may appear (case-insensitive). */
    mustNotInclude: z.array(Phrase).max(20).optional(),
    /** Markdown: at least this many headings (#, ##, ...). */
    minHeadings: z.number().int().min(1).max(50).optional(),
    /** JSON: checks on the parsed document, same language as API checks. */
    assertions: z.array(JsonAssertion).max(50).optional(),
  })
  .strict();

/** Rules that need more than one field to judge; applied wherever a content plan is parsed. */
function contentRulesConsistent(p: z.infer<typeof ContentRulesFields>, ctx: z.RefinementCtx) {
  if (p.minWords !== undefined && p.maxWords !== undefined && p.minWords > p.maxWords) ctx.addIssue({ code: "custom", path: ["minWords"], message: "minWords cannot exceed maxWords" });
  if (p.format !== "json" && p.assertions?.length) ctx.addIssue({ code: "custom", path: ["assertions"], message: "JSON assertions need format json" });
  if (p.format !== "markdown" && p.minHeadings !== undefined) ctx.addIssue({ code: "custom", path: ["minHeadings"], message: "minHeadings needs format markdown" });
}

export const ContentRulesPlan = ContentRulesFields.superRefine(contentRulesConsistent);
export type ContentRulesPlan = z.infer<typeof ContentRulesFields>;

export const VerificationPlan = z
  .discriminatedUnion("kind", [HttpVerificationPlan, GithubChecksPlan, ContentRulesFields])
  .superRefine((p, ctx) => {
    if (p.kind === "CONTENT_RULES") contentRulesConsistent(p, ctx);
  });
export type VerificationPlan = z.infer<typeof VerificationPlan>;

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
    verificationPlan: VerificationPlan,
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

/**
 * Worker named in an open bounty until someone claims it (the contract's OPEN_BOUNTY_WORKER;
 * a short top-level name nobody can register). The posted terms, and so their hashes, use
 * this placeholder; the claimer replaces it.
 */
export const OPEN_BOUNTY_WORKER = "open-bounty";
export const BOUNTY_PLACEHOLDER_WORKER = { kind: "AGENT", nearAccountId: OPEN_BOUNTY_WORKER } as const;

export const AgreementTerms = z
  .object({
    schemaVersion: z.literal(1),
    agreementId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, "agreement id must be 8-64 url-safe characters"),
    client: Principal,
    worker: Principal,
    /** The escrow contract this agreement settles on; reports are signed for it. */
    escrowContract: NearAccountId,
    verifierAuthority: NearAccountId,
    /** Raw ed25519 public key (hex) whose signature authenticates verification reports. */
    verifierPublicKey: z.string().regex(/^[0-9a-f]{64}$/, "must be a 32-byte hex ed25519 public key"),
    disputeResolver: NearAccountId,
    asset: z.literal("NEAR"),
    totalYocto: YoctoString,
    milestones: z.array(MilestoneTerms).min(1).max(10),
    challengePeriodSec: z.number().int().min(60).max(MAX_CHALLENGE_SEC),
    fundingDeadline: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
    /** Posted funded with no worker; the first eligible claimer before `fundingDeadline` becomes the worker. */
    openBounty: z.literal(true).optional(),
  })
  .strict()
  .superRefine((t, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });

    const client = t.client.nearAccountId;
    const worker = t.worker.nearAccountId;
    if (client === worker) issue(["worker"], "client and worker must be different accounts");
    if (!t.openBounty && worker === OPEN_BOUNTY_WORKER) issue(["worker"], `'${OPEN_BOUNTY_WORKER}' is reserved for open bounties`);
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
export const computePlanHash = (plan: VerificationPlan): string => hashCanonical(plan);
