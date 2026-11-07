import type { ContentRulesPlan, JsonAssertion } from "./terms.js";

/**
 * Mechanical checks shared by the verifier (which signs the result), swarm agents (which check
 * their own work before submitting) and the web app (which previews the rules). Pure: no I/O.
 */
export interface ContentCheck {
  check: string;
  ok: boolean;
  detail: string;
}

/** Evaluates `$`, `$.field`, `$.list[0].field` (the only forms plans may use). Own properties only. */
export function readPath(root: unknown, path: string): { exists: boolean; value?: unknown } {
  let current: unknown = root;
  for (const [, key, index] of path.slice(1).matchAll(/\.([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]/g)) {
    if (key !== undefined) {
      if (current === null || typeof current !== "object" || Array.isArray(current) || !Object.hasOwn(current, key)) {
        return { exists: false };
      }
      current = (current as Record<string, unknown>)[key];
    } else {
      const i = Number(index);
      if (!Array.isArray(current) || i >= current.length) return { exists: false };
      current = current[i];
    }
  }
  return { exists: true, value: current };
}

export function jsonTypeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function preview(v: unknown): string {
  const s = JSON.stringify(v) ?? String(v);
  return s.length > 200 ? `${s.slice(0, 200)}...` : s;
}

export function checkJsonAssertion(a: JsonAssertion, root: unknown): ContentCheck {
  const found = readPath(root, a.path);
  const actual = found.exists ? preview(found.value) : "missing";
  switch (a.op) {
    case "exists":
      return { check: `${a.path} exists`, ok: found.exists, detail: actual };
    case "equals":
      return { check: `${a.path} == ${preview(a.value)}`, ok: found.exists && found.value === a.value, detail: `got ${actual}` };
    case "type":
      return { check: `${a.path} is ${a.type}`, ok: found.exists && jsonTypeOf(found.value) === a.type, detail: `got ${found.exists ? jsonTypeOf(found.value) : "missing"}` };
  }
}

export const countWords = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;
const countHeadings = (text: string) => text.split(/\r?\n/).filter((l) => /^#{1,6}\s+\S/.test(l)).length;

/** Every rule in the plan, applied to the deliverable's text. PASS needs all of them to hold. */
export function checkContent(plan: ContentRulesPlan, text: string): ContentCheck[] {
  const bytes = new TextEncoder().encode(text).length;
  const checks: ContentCheck[] = [{ check: "size", ok: bytes > 0 && bytes <= plan.maxBytes, detail: `${bytes} bytes (limit ${plan.maxBytes})` }];
  const lower = text.toLowerCase();

  if (plan.minWords !== undefined || plan.maxWords !== undefined) {
    const n = countWords(text);
    const ok = (plan.minWords === undefined || n >= plan.minWords) && (plan.maxWords === undefined || n <= plan.maxWords);
    const range = `${plan.minWords ?? 0}–${plan.maxWords ?? "∞"}`;
    checks.push({ check: `words ${range}`, ok, detail: `${n} words` });
  }
  for (const p of plan.mustInclude ?? []) checks.push({ check: `includes "${p}"`, ok: lower.includes(p.toLowerCase()), detail: lower.includes(p.toLowerCase()) ? "found" : "missing" });
  for (const p of plan.mustNotInclude ?? []) checks.push({ check: `does not include "${p}"`, ok: !lower.includes(p.toLowerCase()), detail: lower.includes(p.toLowerCase()) ? "found" : "absent" });
  if (plan.minHeadings !== undefined) {
    const n = countHeadings(text);
    checks.push({ check: `at least ${plan.minHeadings} headings`, ok: n >= plan.minHeadings, detail: `${n} headings` });
  }
  if (plan.format === "json") {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      checks.push({ check: "valid JSON", ok: false, detail: "the deliverable is not valid JSON" });
      return checks;
    }
    checks.push({ check: "valid JSON", ok: true, detail: jsonTypeOf(json) });
    for (const a of plan.assertions ?? []) checks.push(checkJsonAssertion(a, json));
  }
  return checks;
}

/** The rules as plain sentences, for people reading a bounty and for agents writing to it. */
export function describeContentRules(plan: ContentRulesPlan): string[] {
  const out: string[] = [`Format: ${plan.format === "json" ? "a JSON document only (no code fences, no prose)" : plan.format === "markdown" ? "Markdown" : "plain text"}.`];
  out.push(`At most ${plan.maxBytes.toLocaleString("en-US")} bytes.`);
  if (plan.minWords !== undefined && plan.maxWords !== undefined) out.push(`Between ${plan.minWords} and ${plan.maxWords} words.`);
  else if (plan.minWords !== undefined) out.push(`At least ${plan.minWords} words.`);
  else if (plan.maxWords !== undefined) out.push(`At most ${plan.maxWords} words.`);
  if (plan.minHeadings !== undefined) out.push(`At least ${plan.minHeadings} Markdown heading${plan.minHeadings === 1 ? "" : "s"} (lines starting with #).`);
  for (const p of plan.mustInclude ?? []) out.push(`Must include the phrase "${p}".`);
  for (const p of plan.mustNotInclude ?? []) out.push(`Must not include "${p}".`);
  for (const a of plan.assertions ?? []) out.push(a.op === "exists" ? `JSON must have ${a.path}.` : a.op === "type" ? `JSON ${a.path} must be ${a.type === "array" ? "an array" : `a ${a.type}`}.` : `JSON ${a.path} must equal ${JSON.stringify(a.value)}.`);
  return out;
}
