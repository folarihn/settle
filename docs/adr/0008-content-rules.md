# ADR 0008: Auto-checked written and data work (CONTENT_RULES)

Status: accepted (2026-11-07)

## Context

Written work could only be paid after a person reviewed it. That is right for subjective work like a design or a README. A lot of text and data work, though, has rules a machine can check: a length, phrases that must appear, a valid JSON shape. Waiting for a person there adds delay and adds nothing. Swarm agents also had no way to complete a job end to end without a human in the loop.

## Decision

1. **A new verification plan kind, `CONTENT_RULES`**, alongside `HTTP_API` and `GITHUB_CHECKS`.
   - Fields: `format` (`text`, `markdown`, `json`), `maxBytes` (≤ 64 KB), and optional `minWords`, `maxWords`, `mustInclude`, `mustNotInclude` (case-insensitive phrases), `minHeadings` (Markdown), and JSON `assertions` (the same language as API checks).
   - Like every plan, it is fixed before funding and bound to the agreement by its hash.
   - The contract only stores the plan hash, so **no contract change** was needed.
2. **What the worker submits:** the SHA-256 of the deliverable's bytes as the artifact hash, plus a link.
   - The verifier first reads the bytes from SETTLE's own content-addressed store, which is keyed by that hash.
   - Otherwise it fetches the link under the same network policy as API checks: HTTPS only, standard ports, no private or internal hosts.
   - It then proves the bytes match the submitted hash before checking anything else.
3. **Mechanical rules only.** Nothing in the deliverable is executed and nothing is judged for quality, so a PASS can release payment like any other automated check. The challenge window still applies.
4. **Fail closed.**
   - FAIL: a hash mismatch, a missing deliverable, an oversized deliverable, a blocked target, or any rule failing.
   - INCONCLUSIVE: the deliverable could not be read (network, 5xx). It can be re-run.
   - No other outcome ever becomes a PASS.
5. **One checker, three users.** `checkContent` in `@settle/domain` is used by:
   - the verifier, which signs the result;
   - Swarm agents, which check their own work before submitting, fix a failing draft once, and never submit a draft that fails their own check;
   - the web form, through the same rules shown in plain words.
6. **Swarm agents** take bounties whose milestones are either human-review or `CONTENT_RULES`, and request verification after submitting. All of this stays within each agent's inference limit.

## Consequences

- The web form gains **Auto-checked text**. Agreement pages and bounty cards list the rules, and a human worker pastes the delivery; it is stored and submitted by hash.
- Subjective work still goes to human review. AI reviews still only advise.
