import { nearToYocto } from "./api";

/**
 * The New agreement form, as data, and the exact request it becomes. Pure, so every template is
 * tested; the API validates it again and the contract enforces it.
 */
export type Template = "review" | "auto-text" | "api-design" | "github" | "sustained";

export const TEMPLATES: { id: Template; title: string; blurb: string }[] = [
  {
    id: "review",
    title: "Written or creative work",
    blurb: "Docs, copy, a logo as SVG, any deliverable you judge yourself. You approve it or ask for a revision. Swarm agents can take these.",
  },
  {
    id: "auto-text",
    title: "Auto-checked text",
    blurb: "Text or JSON checked by machine against rules you set: word count, required phrases, format. A PASS pays without waiting for a review. Swarm agents can take these.",
  },
  { id: "api-design", title: "API and design", blurb: "An API checked by the independent verifier, then a design you review yourself." },
  { id: "github", title: "GitHub CI", blurb: "Pays when a commit merged into your branch passes the CI checks you name." },
  { id: "sustained", title: "Sustained health", blurb: "Pays when the worker's API passes the same check repeatedly, not just once." },
];

export interface AgreementForm {
  template: Template;
  openBounty: boolean;
  worker: string;
  workerKind: "HUMAN" | "AGENT";
  /** Review template: what to deliver and how it is judged. */
  workTitle: string;
  brief: string;
  workNear: string;
  /** Auto-checked text: the rules (empty strings mean "no rule"). */
  autoFormat: "text" | "markdown" | "json";
  minWords: string;
  maxWords: string;
  mustInclude: string;
  mustNotInclude: string;
  minHeadings: string;
  maxBytes: string;
  apiNear: string;
  designNear: string;
  floorNear: string;
  revisions: number;
  challengeMin: number;
  deadlineHours: number;
  expiresDays: number;
  plan: string;
  probes: number;
  probeIntervalSec: number;
  repo: string;
  branch: string;
  checks: string;
  rubric: string;
}

const humanReview = (id: string, title: string, amountYocto: string, rubric: string, revisions: number, floorNear: string) => ({
  id,
  title,
  type: "HUMAN_REVIEW",
  amountYocto,
  rubric,
  maxRevisions: revisions,
  partialCompensation: floorNear.trim() ? { condition: "DELIVERABLE_SUBMITTED", floorYocto: nearToYocto(floorNear) } : null,
});

/** The agreement as it will be sent; throws a readable message for anything invalid. */
export function buildAgreement(f: AgreementForm, now: number) {
  const milestones: Record<string, unknown>[] = [];

  if (f.template === "review") {
    const title = f.workTitle.trim();
    const brief = f.brief.trim();
    if (!title) throw new Error("Say what should be delivered, in one line.");
    if (title.length > 200) throw new Error("Keep the title under 200 characters.");
    if (!brief) throw new Error("Describe what a good delivery looks like; you will judge it against this.");
    if (brief.length > 5000) throw new Error("Keep the description under 5,000 characters.");
    const amount = nearToYocto(f.workNear);
    if (BigInt(amount) === 0n) throw new Error("The reward must be above 0.");
    if (f.floorNear.trim() && BigInt(nearToYocto(f.floorNear)) > BigInt(amount)) throw new Error("The protected minimum cannot be more than the reward.");
    milestones.push(humanReview("work", title, amount, brief, f.revisions, f.floorNear));
  } else if (f.template === "auto-text") {
    const title = f.workTitle.trim();
    if (!title) throw new Error("Say what should be delivered, in one line.");
    if (title.length > 200) throw new Error("Keep the title under 200 characters.");
    const amount = nearToYocto(f.workNear);
    if (BigInt(amount) === 0n) throw new Error("The reward must be above 0.");
    milestones.push({ id: "work", title, type: "AUTOMATED", amountYocto: amount, verificationPlan: contentPlan(f) });
  } else {
    const apiYocto = nearToYocto(f.apiNear);
    if (BigInt(apiYocto) === 0n) throw new Error("Every milestone needs an amount above 0.");
    if (f.template === "github") {
      const requiredChecks = f.checks.split(",").map((c) => c.trim()).filter(Boolean);
      if (!/^[\w.-]+\/[\w.-]+$/.test(f.repo.trim())) throw new Error("Enter the repository as owner/name.");
      if (requiredChecks.length === 0) throw new Error("Name at least one CI check.");
      milestones.push({
        id: "ci",
        title: `CI passes on ${f.repo.trim()} ${f.branch.trim()}`,
        type: "AUTOMATED",
        amountYocto: apiYocto,
        verificationPlan: { kind: "GITHUB_CHECKS", version: 1, repo: f.repo.trim(), branch: f.branch.trim(), requiredChecks },
      });
    } else {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(f.plan) as Record<string, unknown>;
      } catch {
        throw new Error("The verification plan is not valid JSON.");
      }
      milestones.push({
        id: "api",
        title: f.template === "sustained" ? "API stays healthy" : "API passes the agreed checks",
        type: "AUTOMATED",
        amountYocto: apiYocto,
        verificationPlan: f.template === "sustained" ? { ...parsed, repeat: { count: f.probes, intervalMs: f.probeIntervalSec * 1000 } } : parsed,
      });
    }
    if (f.template === "api-design") {
      const designYocto = nearToYocto(f.designNear);
      if (BigInt(designYocto) === 0n) throw new Error("Every milestone needs an amount above 0.");
      milestones.push(humanReview("design", "Design deliverable", designYocto, f.rubric, f.revisions, f.floorNear));
    }
  }

  return {
    ...(f.openBounty ? { openBounty: true } : { worker: { kind: f.workerKind, nearAccountId: f.worker.trim() } }),
    totalYocto: milestones.reduce((n, m) => n + BigInt(m.amountYocto as string), 0n).toString(),
    milestones,
    challengePeriodSec: f.challengeMin * 60,
    fundingDeadline: now + f.deadlineHours * 3600_000,
    expiresAt: now + f.expiresDays * 24 * 3600_000,
  };
}

const intOrUndefined = (v: string, name: string, min: number, max: number): number | undefined => {
  if (!v.trim()) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be a whole number from ${min} to ${max}.`);
  return n;
};
const phrases = (v: string) =>
  v
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

/** The CONTENT_RULES plan from the form; the API validates it again with the shared schema. */
export function contentPlan(f: AgreementForm): Record<string, unknown> {
  const minWords = intOrUndefined(f.minWords, "Minimum words", 1, 20_000);
  const maxWords = intOrUndefined(f.maxWords, "Maximum words", 1, 20_000);
  if (minWords !== undefined && maxWords !== undefined && minWords > maxWords) throw new Error("Minimum words cannot be more than maximum words.");
  const minHeadings = f.autoFormat === "markdown" ? intOrUndefined(f.minHeadings, "Minimum headings", 1, 50) : undefined;
  const maxBytes = intOrUndefined(f.maxBytes, "Maximum size", 1, 65_536) ?? 8000;
  const include = phrases(f.mustInclude);
  const exclude = phrases(f.mustNotInclude);
  if ([...include, ...exclude].some((p) => p.length > 200)) throw new Error("Keep each phrase under 200 characters.");
  if (include.length > 20 || exclude.length > 20) throw new Error("Use at most 20 phrases in each list.");
  const brief = f.brief.trim();
  if (brief.length > 4000) throw new Error("Keep the brief under 4,000 characters.");
  return {
    kind: "CONTENT_RULES",
    version: 1,
    format: f.autoFormat,
    ...(brief ? { brief } : {}),
    maxBytes,
    ...(minWords !== undefined ? { minWords } : {}),
    ...(maxWords !== undefined ? { maxWords } : {}),
    ...(include.length ? { mustInclude: include } : {}),
    ...(exclude.length ? { mustNotInclude: exclude } : {}),
    ...(minHeadings !== undefined ? { minHeadings } : {}),
  };
}

/** Swarm agents take bounties judged by a person or checked against content rules. */
export const swarmCanTake = (template: Template, openBounty: boolean) => openBounty && (template === "review" || template === "auto-text");
