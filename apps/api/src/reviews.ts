import { randomBytes } from "node:crypto";
import type { AgreementState } from "@settle/domain";
import { verifyResponseSignature, type Completion, type NearAi, type SignatureRecord } from "@settle/near-ai";
import type { Db, Sql } from "./db.js";

/**
 * Governance AI review (ADR 0006): an advisory review of each human-review submission against
 * its rubric, written by a NEAR AI model and stored with NEAR AI's TEE response signature. It is
 * shown to the client and the resolver and never changes an agreement: people decide.
 * Runs in the verification worker (the independent party), never in the swarm runner.
 */

export type ReviewAi = Pick<NearAi, "chat" | "costs" | "signature" | "model">;

const VERDICTS = new Set(["meets", "partly", "does_not_meet"]);
/** Only deliverables stored in this deployment are reviewed; the worker never fetches arbitrary URLs. */
const DELIVERABLE_HASH = /^sha256:[0-9a-f]{64}$/;

export async function recordInference(
  sql: Sql,
  c: Completion,
  purpose: "triage" | "deliverable" | "review",
  ref: { agentId?: string | null; jobId?: string | null; milestoneId?: string | null },
  at: number,
) {
  await sql.query(
    `INSERT INTO inference_calls (id, agent_id, job_id, milestone_id, purpose, model, completion_id, inference_id, prompt_tokens, completion_tokens, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [`inf_${randomBytes(9).toString("base64url")}`, ref.agentId ?? null, ref.jobId ?? null, ref.milestoneId ?? null, purpose, c.model, c.id, c.inferenceId, c.usage.promptTokens, c.usage.completionTokens, at],
  );
}

/** Fills in exact costs NEAR AI has reported since; calls without a reported cost stay pending. */
export async function backfillCosts(db: Db, ai: Pick<NearAi, "costs">, limit = 50): Promise<number> {
  const { rows } = await db.query<{ inference_id: string }>("SELECT inference_id FROM inference_calls WHERE cost_nano_usd IS NULL ORDER BY created_at LIMIT $1", [limit]);
  if (rows.length === 0) return 0;
  const costs = await ai.costs(rows.map((r) => r.inference_id));
  for (const [id, nano] of costs) await db.query("UPDATE inference_calls SET cost_nano_usd = $2 WHERE inference_id = $1", [id, nano]);
  return costs.size;
}

export class ReviewWorker {
  constructor(
    private readonly db: Db,
    private readonly ai: ReviewAi,
    private readonly log: { warn: (o: object, m: string) => void },
    private readonly now: () => number = Date.now,
  ) {}

  /** Reviews new submissions, then attaches signatures that were not ready on the first try. */
  async tick(): Promise<number> {
    let done = 0;
    const { rows } = await this.db.query<{ id: string; state: AgreementState }>("SELECT id, state FROM jobs WHERE state->>'status' = 'FUNDED' LIMIT 200");
    for (const { id, state } of rows) {
      for (const [i, m] of state.milestones.entries()) {
        const terms = state.terms.milestones[i]!;
        if (terms.type !== "HUMAN_REVIEW" || m.status !== "SUBMITTED" || !m.submission) continue;
        const seen = await this.db.query("SELECT 1 FROM ai_reviews WHERE job_id = $1 AND milestone_id = $2 AND submission_seq = $3", [id, m.id, m.submission.seq]);
        if (seen.rows.length) continue;
        try {
          await this.review(id, m.id, m.submission.seq, terms.title, terms.rubric, m.submission.artifactHash);
          done += 1;
        } catch (e) {
          this.log.warn({ jobId: id, milestone: m.id, err: (e as Error).message.slice(0, 200) }, "AI review failed; retried next tick");
        }
      }
    }
    await this.attachSignatures();
    await backfillCosts(this.db, this.ai).catch((e) => this.log.warn({ err: String(e) }, "cost backfill failed"));
    return done;
  }

  private async review(jobId: string, milestoneId: string, seq: number, title: string, rubric: string, artifactHash: string) {
    const at = this.now();
    const insert = (verdict: string, summary: string, points: string[], c: Completion | null) =>
      this.db.query(
        `INSERT INTO ai_reviews (job_id, milestone_id, submission_seq, verdict, summary, points, model, completion_id, request_body, response_body, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT DO NOTHING`,
        [jobId, milestoneId, seq, verdict, summary, JSON.stringify(points), c?.model ?? this.ai.model, c?.id ?? null, c?.requestBody ?? null, c?.responseBody ?? null, at],
      );

    const d = DELIVERABLE_HASH.test(artifactHash)
      ? (await this.db.query<{ content: string }>("SELECT content FROM deliverables WHERE hash = $1", [artifactHash])).rows[0]
      : undefined;
    if (!d) {
      await insert("cannot_review", "The deliverable is not stored in SETTLE's content-addressed store, so the AI reviewer cannot read it. Review it yourself.", [], null);
      return;
    }

    const c = await this.ai.chat(
      [
        {
          role: "system",
          content:
            "You are an impartial reviewer for a work escrow. Judge ONLY whether the deliverable meets the rubric. You are advisory: a person makes the decision. " +
            'Answer with JSON only: {"verdict":"meets"|"partly"|"does_not_meet","summary":"one or two sentences","points":["specific observation", "..."]}. At most 5 points.',
        },
        { role: "user", content: `Task: ${title}\n\nRubric:\n${rubric}\n\nDeliverable:\n${d.content.slice(0, 30_000)}` },
      ],
      { maxTokens: 700, temperature: 0 },
    );
    await recordInference(this.db, c, "review", { jobId, milestoneId }, at);
    const parsed = parseReview(c.content);
    if (!parsed) {
      await insert("cannot_review", "The AI reviewer's answer could not be read. Review it yourself.", [], c);
      return;
    }
    await insert(parsed.verdict, parsed.summary, parsed.points, c);
  }

  /** NEAR AI publishes a signature shortly after the response; keep trying for ten minutes. */
  private async attachSignatures() {
    const { rows } = await this.db.query<{ job_id: string; milestone_id: string; submission_seq: number; completion_id: string; model: string; request_body: string; response_body: string }>(
      "SELECT job_id, milestone_id, submission_seq, completion_id, model, request_body, response_body FROM ai_reviews WHERE completion_id IS NOT NULL AND signature IS NULL AND created_at > $1 LIMIT 20",
      [this.now() - 10 * 60_000],
    );
    for (const r of rows) {
      let sig: SignatureRecord | null;
      try {
        sig = await this.ai.signature(r.completion_id, { model: r.model });
      } catch {
        continue;
      }
      if (!sig) continue;
      const check = verifyResponseSignature(sig, r.request_body, r.response_body, r.model);
      await this.db.query("UPDATE ai_reviews SET signature = $4, signature_check = $5 WHERE job_id = $1 AND milestone_id = $2 AND submission_seq = $3", [
        r.job_id,
        r.milestone_id,
        r.submission_seq,
        JSON.stringify(sig),
        check.ok ? `verified (${check.kind})` : `not verified: ${check.reason}`,
      ]);
    }
  }
}

/** Extracts the JSON verdict from a model answer; anything malformed is rejected, not guessed. */
export function parseReview(text: string): { verdict: string; summary: string; points: string[] } | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]) as { verdict?: unknown; summary?: unknown; points?: unknown };
    if (typeof j.verdict !== "string" || !VERDICTS.has(j.verdict) || typeof j.summary !== "string") return null;
    const points = Array.isArray(j.points) ? j.points.filter((p): p is string => typeof p === "string").slice(0, 5).map((p) => p.slice(0, 400)) : [];
    return { verdict: j.verdict, summary: j.summary.slice(0, 600), points };
  } catch {
    return null;
  }
}
