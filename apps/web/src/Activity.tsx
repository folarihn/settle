import { useEffect, useState } from "react";
import { api, type ActivityItem } from "./api";
import { describeActivity, relTime } from "./derive";

/** Recent real events on posted bounties (GET /v1/activity). Hidden when there are none or the API is unreachable. */
export function ActivityStrip({ limit = 12 }: { limit?: number }) {
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  useEffect(() => {
    const load = () =>
      api<{ items: ActivityItem[] }>("GET", `/v1/activity?limit=${limit}`).then(
        (r) => setItems(r.items),
        () => setItems([]),
      );
    void load();
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 30_000);
    return () => clearInterval(t);
  }, [limit]);
  if (!items?.length) return null;
  const row = items.map((e) => {
    const d = describeActivity(e);
    return (
      <a key={`${e.jobId}-${e.type}-${e.at}`} className={`act-item ${d.tone}`} href={`#/jobs/${e.jobId}`}>
        <i aria-hidden />
        <span>{d.text}</span>
        <time className="mono" dateTime={new Date(e.at).toISOString()}>
          {relTime(e.at)}
        </time>
      </a>
    );
  });
  return (
    <section className="activity" aria-label="Recent activity on the bounty board">
      <span className="act-label">
        <i aria-hidden /> Live activity
      </span>
      <div className="act-viewport">
        {/* The row is rendered twice so the loop scrolls seamlessly; the copy is hidden from assistive tech. */}
        <div className="act-track">
          <div className="act-row">{row}</div>
          <div className="act-row" aria-hidden>
            {row}
          </div>
        </div>
      </div>
    </section>
  );
}
