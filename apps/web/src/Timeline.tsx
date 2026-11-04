import { useEffect, useState } from "react";
import { api, type Job } from "./api";
import { near, relTime } from "./derive";

interface EventRow {
  version: number;
  actor: string;
  type: string;
  event: Record<string, unknown>;
  at: number | string;
}

/** The agreement's recorded history, oldest first, in plain words. */
export function Timeline({ job, me, refreshKey }: { job: Job; me: string; refreshKey: number }) {
  const [events, setEvents] = useState<EventRow[] | null>(null);
  const [all, setAll] = useState(false);

  useEffect(() => {
    api<{ events: EventRow[] }>("GET", `/v1/jobs/${job.id}/events`).then(
      (r) => setEvents(r.events),
      () => setEvents(null), // not a party yet (open bounty): no history to show
    );
  }, [job.id, refreshKey]);

  if (!events || events.length === 0) return null;
  const t = job.state.terms;
  const who = (actor: string) =>
    actor === me ? "You" : actor === "chain" ? "The escrow contract" : actor === t.client.nearAccountId ? "The client" : actor === t.worker.nearAccountId ? "The worker" : actor === t.verifierAuthority ? "The verifier service" : actor === t.disputeResolver ? "The resolver" : actor;
  const titleOf = (id: unknown) => t.milestones.find((m) => m.id === id)?.title ?? String(id);

  return (
    <div className="block">
      <div className="hstack">
        <div className="label grow">Activity</div>
        <span className="xs t3 num">{events.length}</span>
      </div>
      <ol className="activity" style={{ marginTop: 14 }}>
        {[...events].reverse().slice(0, all ? undefined : 8).map((e) => {
          const at = Number(e.at);
          const { text, kind } = describe(e, t.client.nearAccountId, titleOf);
          // A payout is mirrored from the chain, which does not say who sent it (client, worker or
          // the verifier service may), so it is never attributed to a person.
          const subject = e.type === "START_PAYOUT" ? "The escrow contract" : who(e.actor);
          return (
            <li key={e.version} className={kind}>
              <div>
                <span style={{ fontWeight: 500 }}>{subject}</span> <span className="t2">{text}</span>
              </div>
              <div className="when" title={new Date(at).toLocaleString()}>
                {relTime(at)}
              </div>
            </li>
          );
        })}
      </ol>
      {events.length > 8 && (
        <button className="btn ghost" style={{ height: 28, padding: "0 8px", fontSize: 12.5 }} onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `Show all ${events.length}`}
        </button>
      )}
    </div>
  );
}

function describe(e: EventRow, client: string, titleOf: (id: unknown) => string): { text: string; kind?: "money" | "alert" } {
  const f = e.event;
  const ms = `“${titleOf(f.milestoneId)}”`;
  switch (e.type) {
    case "ACCEPT_TERMS":
      return { text: e.actor === client ? "created the agreement and accepted its terms" : "accepted the terms" };
    case "FUND":
      return { text: `deposited ${near(String(f.amountYocto ?? "0"))} NEAR into escrow`, kind: "money" };
    case "CLAIM_BOUNTY":
      return { text: "claimed the bounty and became the worker" };
    case "CANCEL_BOUNTY":
      return { text: "cancelled the bounty; the deposit was refunded", kind: "money" };
    case "SUBMIT":
      return { text: `submitted ${ms}` };
    case "RECORD_VERIFICATION": {
      const outcome = (f.report as { outcome?: string } | undefined)?.outcome ?? "a result";
      return { text: `recorded a signed ${outcome} for ${ms}`, kind: outcome === "PASS" ? undefined : "alert" };
    }
    case "CHALLENGE":
      return { text: `challenged the PASS on ${ms}`, kind: "alert" };
    case "FINALIZE_CHALLENGE":
      return { text: `closed the challenge window on ${ms}; it is payable` };
    case "APPROVE":
      return { text: `approved ${ms}` };
    case "REQUEST_REVISION":
      return { text: `asked for a revision of ${ms}`, kind: "alert" };
    case "OPEN_DISPUTE":
      return { text: `opened a dispute on ${ms}`, kind: "alert" };
    case "PROPOSE_SETTLEMENT":
      return { text: `proposed ${near(String(f.workerYocto))} NEAR to the worker for ${ms}` };
    case "ACCEPT_SETTLEMENT":
      return { text: `accepted ${near(String(f.workerYocto))} NEAR to the worker for ${ms}` };
    case "RESOLVE_DISPUTE":
      return { text: `ruled ${near(String(f.workerYocto))} NEAR to the worker for ${ms}` };
    case "EXPIRE_MILESTONE":
      return { text: `expired ${ms}; it is refunded to the client`, kind: "alert" };
    case "START_PAYOUT":
      return { text: `started the payout transfer for ${ms}`, kind: "money" };
    case "CONFIRM_PAYOUT":
      return f.succeeded ? { text: `confirmed the payment of ${ms}`, kind: "money" } : { text: `reported a failed transfer for ${ms}; it can be paid again`, kind: "alert" };
    default:
      return { text: e.type.toLowerCase().replace(/_/g, " ") };
  }
}
