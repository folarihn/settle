import { useEffect, useState } from "react";

/** Short notices for things that happened (a transaction sent, confirmed, cancelled). */
export interface Toast {
  id: number;
  tone: "ok" | "bad" | "info";
  title: string;
  body?: string;
  href?: string;
  linkText?: string;
}

const EVENT = "settle:toast";
let seq = 0;

export function toast(t: Omit<Toast, "id">) {
  window.dispatchEvent(new CustomEvent<Toast>(EVENT, { detail: { ...t, id: ++seq } }));
}

export function ToastHost() {
  const [items, setItems] = useState<Toast[]>([]);
  useEffect(() => {
    const on = (e: Event) => {
      const t = (e as CustomEvent<Toast>).detail;
      setItems((xs) => [...xs.slice(-3), t]);
      window.setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== t.id)), t.tone === "bad" ? 9000 : 6000);
    };
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`}>
          <i className="toast-mark" aria-hidden />
          <div className="toast-text">
            <strong>{t.title}</strong>
            {t.body && <span>{t.body}</span>}
            {t.href && (
              <a href={t.href} target="_blank" rel="noreferrer">
                {t.linkText ?? "View"} ↗
              </a>
            )}
          </div>
          <button className="toast-x" aria-label="Dismiss" onClick={() => setItems((xs) => xs.filter((x) => x.id !== t.id))}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
