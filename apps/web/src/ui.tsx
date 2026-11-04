import type { CSSProperties, ReactNode } from "react";
import type { Milestone, MilestoneTerms } from "./api";
import { AGREEMENT_STATUS, MILESTONE_STATUS, near, type Money, type NextAction, type Tone } from "./derive";

const TONE: Record<Tone, string> = {
  neutral: "var(--s-gray)",
  info: "var(--s-blue)",
  ok: "var(--s-green)",
  warn: "var(--s-amber)",
  bad: "var(--s-red)",
  violet: "var(--s-violet)",
  accent: "var(--s-blue)",
};

/** A coloured dot and a word: how every state is shown. */
export function Status({ tone = "neutral", ring, children }: { tone?: Tone; ring?: boolean; children: ReactNode }) {
  return (
    <span className={`status ${ring ? "ring" : ""}`} style={{ "--tone": TONE[tone] } as CSSProperties}>
      {children}
    </span>
  );
}

export function AgreementStatus({ status }: { status: string }) {
  const s = AGREEMENT_STATUS[status] ?? { label: status, tone: "neutral" as const };
  return (
    <Status tone={s.tone} ring={status === "DRAFT" || status === "OPEN"}>
      {s.label}
    </Status>
  );
}

export function MilestoneStatus({ status }: { status: string }) {
  const s = MILESTONE_STATUS[status] ?? { label: status, tone: "neutral" as const };
  return (
    <Status tone={s.tone} ring={status === "PENDING"}>
      {s.label}
    </Status>
  );
}

/** Milestones paid, as small segments. */
export function Meter({ done, total }: { done: number; total: number }) {
  return (
    <span className="meter" role="img" aria-label={`${done} of ${total} milestones paid`}>
      {Array.from({ length: total }, (_, i) => (
        <i key={i} className={i < done ? "on" : ""} />
      ))}
    </span>
  );
}

const SEGMENTS: { key: keyof Omit<Money, "total">; label: string; color: string }[] = [
  { key: "locked", label: "In escrow", color: "var(--m-locked)" },
  { key: "claimable", label: "Payable", color: "var(--m-payable)" },
  { key: "inFlight", label: "Paying out", color: "var(--m-flight)" },
  { key: "paidToWorker", label: "Paid to worker", color: "var(--m-paid)" },
  { key: "refundedToClient", label: "Refunded to client", color: "var(--m-refund)" },
];

/** Where every yoctoNEAR of the agreement is, as the escrow contract reports it. */
export function MoneyLedger({ m }: { m: Money }) {
  const shown = SEGMENTS.filter((s) => m[s.key] > 0n);
  return (
    <div>
      <div className="bar" role="img" aria-label={shown.map((s) => `${s.label} ${near(m[s.key])} NEAR`).join(", ") || "Not funded yet"}>
        {shown.map((s) => (
          <span key={s.key} style={{ width: `${Number((m[s.key] * 10000n) / (m.total || 1n)) / 100}%`, background: s.color }} />
        ))}
      </div>
      <div className="ledger">
        {shown.length === 0 && <span className="sm t3">Not funded yet. Nothing is in escrow.</span>}
        {shown.map((s) => (
          <div className="row" key={s.key}>
            <i className="key-dot" style={{ background: s.color }} />
            {s.label}
            <span className="num">{near(m[s.key])}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const GLYPH: Record<NextAction["who"], ReactNode> = {
  you: <path d="M5 12h14M13 6l6 6-6 6" />,
  other: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4l2.5 2" />
    </>
  ),
  auto: (
    <>
      <path d="M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3" />
      <path d="M18 3v4h-4M6 21v-4h4" />
    </>
  ),
  done: <path d="M5 12.5l4.5 4.5L19 7.5" />,
};

export function NextStep({ action }: { action: NextAction }) {
  const cls = action.who === "you" ? "you" : action.who === "done" ? "done" : "";
  const head = action.who === "you" ? "Your move" : action.who === "done" ? "Complete" : action.who === "auto" ? "In progress, automatically" : "Waiting on the other party";
  return (
    <div className={`note ${cls}`}>
      <svg className="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {GLYPH[action.who]}
      </svg>
      <span className="label">{head}</span>
      <span className="body">{action.text}</span>
    </div>
  );
}

/** Progress of one milestone through its agreed path. */
export function Track({ m, terms }: { m: Milestone; terms: MilestoneTerms }) {
  const auto = terms.type === "AUTOMATED";
  const steps = auto ? ["Submitted", "Verified", "Challenge window", "Payable", "Paid"] : ["Submitted", "Reviewed", "Payable", "Paid"];
  const reached: Record<string, number> = auto
    ? { PENDING: 0, SUBMITTED: 1, VERIFIED_PENDING_CHALLENGE: 2, DISPUTED: 2, CLAIMABLE: 4, PAYOUT_PENDING: 4, PAID: 5 }
    : { PENDING: 0, REVISION_REQUESTED: 0, SUBMITTED: 1, DISPUTED: 1, CLAIMABLE: 3, PAYOUT_PENDING: 3, PAID: 4 };
  const done = reached[m.status] ?? 0;
  const held = m.status === "DISPUTED" || m.status === "REVISION_REQUESTED";
  return (
    <div className="track" aria-label={`Progress: ${done} of ${steps.length} steps`}>
      {steps.map((label, i) => (
        <div key={label} className={`stop ${i < done ? "done" : i === done ? (held ? "held now" : "now") : ""}`}>
          {label}
        </div>
      ))}
    </div>
  );
}

export function Metric({ label, value, color, hint }: { label: string; value: string; color: string; hint?: string }) {
  return (
    <div className="metric" title={hint}>
      <div className="key label">
        <i className="key-dot" style={{ background: color }} />
        {label}
      </div>
      <div className="figure">
        {value}
        <span className="unit">NEAR</span>
      </div>
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

/** The SETTLE mark: two halves of an agreement meeting in the middle. */
export function Mark() {
  return (
    <svg className="mark" viewBox="0 0 24 24" aria-hidden>
      <rect width="24" height="24" rx="6" fill="var(--inverse)" />
      <path d="M7 9.5h6.5a2.5 2.5 0 0 1 0 5H10.5a2.5 2.5 0 0 0 0 5H17" fill="none" stroke="var(--inverse-text)" strokeWidth="2" strokeLinecap="round" transform="translate(0 -2.5)" />
    </svg>
  );
}

const ICONS = {
  overview: <path d="M4 13h6V4H4zM14 20h6v-9h-6zM4 20h6v-3H4zM14 7h6V4h-6z" />,
  bounty: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="12" cy="12" r="0.8" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  back: <path d="M15 6l-6 6 6 6" />,
  external: <path d="M14 5h5v5M19 5l-8 8M18 14v5H5V6h5" />,
  out: <path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10" />,
};

export function Icon({ name }: { name: keyof typeof ICONS }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {ICONS[name]}
    </svg>
  );
}
