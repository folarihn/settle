import type { ReactNode } from "react";
import type { Milestone, MilestoneTerms } from "./api";
import { AGREEMENT_STATUS, MILESTONE_STATUS, near, type Money, type NextAction, type Tone } from "./derive";

export function Badge({ tone = "neutral", children }: { tone?: Tone | "outline"; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function AgreementBadge({ status }: { status: string }) {
  const s = AGREEMENT_STATUS[status] ?? { label: status, tone: "neutral" as const };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function MilestoneBadge({ status }: { status: string }) {
  const s = MILESTONE_STATUS[status] ?? { label: status, tone: "neutral" as const };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

const SEGMENTS: { key: keyof Omit<Money, "total">; label: string; color: string }[] = [
  { key: "locked", label: "In escrow", color: "var(--m-locked)" },
  { key: "claimable", label: "Payable", color: "var(--m-claimable)" },
  { key: "inFlight", label: "Paying out", color: "var(--m-pending)" },
  { key: "paidToWorker", label: "Paid to worker", color: "var(--m-paid)" },
  { key: "refundedToClient", label: "Refunded to client", color: "var(--m-refund)" },
];

/** Where every yoctoNEAR of the agreement is, as the escrow contract reports it. */
export function MoneyBar({ m }: { m: Money }) {
  const shown = SEGMENTS.filter((s) => m[s.key] > 0n);
  return (
    <div>
      <div className="moneybar" role="img" aria-label={shown.map((s) => `${s.label} ${near(m[s.key])} NEAR`).join(", ") || "Not funded yet"}>
        {shown.map((s) => (
          <span key={s.key} style={{ width: `${Number((m[s.key] * 10000n) / (m.total || 1n)) / 100}%`, background: s.color }} />
        ))}
      </div>
      <div className="legend">
        {shown.length === 0 && <span>Not funded yet: no money is in escrow.</span>}
        {shown.map((s) => (
          <span key={s.key}>
            <i className="swatch" style={{ background: s.color }} /> {s.label} <b>{near(m[s.key])} NEAR</b>
          </span>
        ))}
      </div>
    </div>
  );
}

const ICON: Record<NextAction["who"], string> = { you: "→", other: "◷", auto: "⚙", done: "✓" };

export function NextStep({ action }: { action: NextAction }) {
  const cls = action.who === "you" ? "you" : action.who === "done" ? "done" : "wait";
  const head = action.who === "you" ? "Your move" : action.who === "done" ? "Done" : action.who === "auto" ? "Happening automatically" : "Waiting on the other side";
  return (
    <div className={`callout ${cls}`}>
      <span className="icon" aria-hidden>
        {ICON[action.who]}
      </span>
      <div>
        <strong>{head}</strong>
        <span>{action.text}</span>
      </div>
    </div>
  );
}

/** Progress of one milestone through its agreed path. */
export function Stepper({ m, terms }: { m: Milestone; terms: MilestoneTerms }) {
  const auto = terms.type === "AUTOMATED";
  const steps = auto ? ["Submitted", "Verified", "Challenge window", "Payable", "Paid"] : ["Submitted", "Reviewed", "Payable", "Paid"];
  const reached: Record<string, number> = auto
    ? { PENDING: 0, SUBMITTED: 1, VERIFIED_PENDING_CHALLENGE: 2, DISPUTED: 2, CLAIMABLE: 4, PAYOUT_PENDING: 4, PAID: 5 }
    : { PENDING: 0, REVISION_REQUESTED: 0, SUBMITTED: 1, DISPUTED: 1, CLAIMABLE: 3, PAYOUT_PENDING: 3, PAID: 4 };
  const done = reached[m.status] ?? 0;
  const stopped = m.status === "DISPUTED" || m.status === "REVISION_REQUESTED";
  return (
    <div className="stepper" aria-label={`Progress: ${done} of ${steps.length} steps`}>
      {steps.map((label, i) => (
        <div key={label} className={`step ${i < done ? "done" : i === done ? (stopped ? "stopped" : "current") : ""}`}>
          <div className="bar" />
          <span className="label">{label}</span>
        </div>
      ))}
    </div>
  );
}

export function Stat({ label, value, color, hint }: { label: string; value: string; color?: string; hint?: string }) {
  return (
    <div className="stat" title={hint}>
      <div className="label">
        {color && <i className="swatch" style={{ background: color }} />}
        {label}
      </div>
      <div className="value">
        {value}
        <small>NEAR</small>
      </div>
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children}
    </div>
  );
}
