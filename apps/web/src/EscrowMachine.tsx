import { useEffect, useReducer, useRef, useState } from "react";
import { autoplayAllowed, DEMO_STEPS, demoReducer, LAST_STEP, receiptAt, type Holder } from "./demo";
import { useInView, usePageVisible, useReducedMotion } from "./motion";

/** Token centres for each holder, in SVG units. */
const AT: Record<Holder, [number, number]> = { client: [118, 214], vault: [280, 222], worker: [442, 214] };
const STEP_MS = 2800;

/**
 * The homepage's escrow machine. A SIMULATION driven only by ./demo: it has no access to the
 * wallet, the API or any real agreement, and it says so on its face.
 */
export function EscrowMachine() {
  const [step, dispatch] = useReducer(demoReducer, 0);
  const reducedMotion = useReducedMotion();
  const [playing, setPlaying] = useState(!reducedMotion);
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref);
  const visible = usePageVisible();
  const s = DEMO_STEPS[step]!;

  useEffect(() => {
    if (!autoplayAllowed({ playing, inView: inView && visible, reducedMotion })) return;
    const t = window.setTimeout(() => (step === LAST_STEP ? dispatch({ type: "replay" }) : dispatch({ type: "next" })), step === LAST_STEP ? STEP_MS * 1.6 : STEP_MS);
    return () => window.clearTimeout(t);
  }, [step, playing, inView, visible, reducedMotion]);

  const [tx, ty] = AT[s.token];
  const lit = (h: Holder) => (s.token === h ? "on" : "");
  const wireOn = (w: typeof s.wire) => (s.wire === w ? "on" : "");
  const engineState = s.verdict === "scanning" ? "scanning" : s.verdict === "fail" ? "fail" : s.verdict === "pass" ? "pass" : "";

  return (
    <div className="machine" ref={ref} aria-roledescription="interactive demonstration">
      <div className="machine-bar">
        <span className="sim-flag">Interactive demo · Simulated</span>
        <span className="machine-step mono">
          {String(step + 1).padStart(2, "0")}/{String(DEMO_STEPS.length).padStart(2, "0")}
        </span>
      </div>

      <svg viewBox="0 0 560 330" className={`machine-svg v-${engineState} ${s.locked ? "is-locked" : ""} ${s.paid ? "is-paid" : ""}`} role="img" aria-label={`Simulated step ${step + 1}: ${s.label}. ${s.caption}`}>
        {/* grid */}
        <defs>
          <pattern id="mgrid" width="20" height="20" patternUnits="userSpaceOnUse">
            <path d="M20 0H0V20" fill="none" className="m-grid" />
          </pattern>
        </defs>
        <rect width="560" height="330" fill="url(#mgrid)" />

        {/* wires: drawn progressively when active */}
        <path className={`m-wire ${wireOn("client-vault")}`} d="M150 214 H206" pathLength={1} />
        <path className={`m-wire ${wireOn("vault-worker")}`} d="M354 214 H410" pathLength={1} />
        <path className={`m-wire ${wireOn("worker-engine")}`} d="M442 180 V66 H356" pathLength={1} />
        <path className={`m-wire ${s.verdict === "pass" || s.verdict === "fail" ? "on" : ""} ${s.verdict === "fail" ? "bad" : ""}`} d="M280 100 V150" pathLength={1} />
        <path className="m-wire base" d="M150 214 H206 M354 214 H410 M442 180 V66 H356 M280 100 V150" />

        {/* verification engine */}
        <g className={`m-node engine ${engineState}`}>
          <rect x="204" y="28" width="152" height="72" />
          <text className="m-cap" x="214" y="44">
            VERIFICATION ENGINE
          </text>
          <rect className="m-window" x="214" y="52" width="132" height="38" />
          <rect className="m-scan" x="214" y="52" width="132" height="3" />
          <text className="m-verdict" x="280" y="77" textAnchor="middle">
            {s.verdict === "pass" ? "PASS ✓" : s.verdict === "fail" ? "FAIL ✕" : s.verdict === "scanning" ? "CHECKING…" : "IDLE"}
          </text>
          <rect className="m-led" x="342" y="35" width="6" height="6" />
        </g>

        {/* client */}
        <g className={`m-node ${lit("client")}`}>
          <rect x="24" y="178" width="126" height="72" />
          <text className="m-cap" x="34" y="194">
            CLIENT
          </text>
          <text className="m-sub" x="34" y="232">
            funds the work
          </text>
          <rect className="m-led" x="136" y="185" width="6" height="6" />
        </g>

        {/* escrow vault */}
        <g className={`m-node vault ${s.locked ? "locked" : ""}`}>
          <rect x="206" y="150" width="148" height="128" />
          <text className="m-cap" x="216" y="166">
            ESCROW VAULT
          </text>
          <rect className="m-door" x="222" y="176" width="116" height="88" />
          <g className="m-bolts">
            <rect x="214" y="190" width="16" height="5" />
            <rect x="214" y="246" width="16" height="5" />
            <rect x="330" y="190" width="16" height="5" />
            <rect x="330" y="246" width="16" height="5" />
          </g>
          <g className="m-dial" style={{ transformOrigin: "280px 196px" }}>
            <circle cx="280" cy="196" r="11" />
            <path d="M280 187 V196" />
          </g>
          <rect className="m-led" x="340" y="157" width="6" height="6" />
        </g>

        {/* challenge window bar */}
        <g className={`m-challenge ${s.challenge ? "on" : ""}`}>
          <text className="m-cap" x="206" y="300">
            CHALLENGE WINDOW
          </text>
          <rect className="m-track" x="206" y="307" width="148" height="6" />
          <rect className="m-fill" x="206" y="307" width="148" height="6" />
        </g>

        {/* worker */}
        <g className={`m-node worker ${lit("worker")} ${s.paid ? "paid" : ""}`}>
          <rect x="410" y="178" width="126" height="72" />
          <text className="m-cap" x="420" y="194">
            WORKER
          </text>
          <text className="m-sub" x="420" y="232">
            {s.paid ? "+2.0 NEAR (sim.)" : "person or AI agent"}
          </text>
          <rect className="m-led" x="522" y="185" width="6" height="6" />
        </g>

        {/* the simulated payment token */}
        <g className="m-token" style={{ transform: `translate(${tx}px, ${ty}px)` }}>
          <rect x="-8" y="-8" width="16" height="16" />
          <text y="4" textAnchor="middle">
            N
          </text>
        </g>
      </svg>

      <div className="machine-foot">
        <div className="machine-caption">
          <strong>{s.label}</strong>
          <span>{s.caption}</span>
        </div>
        <ol className="receipt-tape" aria-label="Simulated receipt">
          {receiptAt(step).map((line, i) => (
            <li key={line} className={i === step ? "new" : ""}>
              {line}
            </li>
          ))}
        </ol>
      </div>

      <div className="machine-controls">
        <button className="mbtn" onClick={() => dispatch({ type: "back" })} disabled={step === 0} aria-label="Previous step">
          ←
        </button>
        <button className="mbtn wide" onClick={() => setPlaying((p) => !p)} aria-pressed={playing} disabled={reducedMotion} title={reducedMotion ? "Autoplay is off because your system asks for reduced motion" : undefined}>
          {playing && !reducedMotion ? "Pause" : "Play"}
        </button>
        <button className="mbtn" onClick={() => dispatch({ type: "next" })} disabled={step === LAST_STEP} aria-label="Next step">
          →
        </button>
        <div className="mticks" role="tablist" aria-label="Demo steps">
          {DEMO_STEPS.map((d, i) => (
            <button
              key={d.key}
              role="tab"
              aria-selected={i === step}
              title={d.label}
              className={`mtick ${i === step ? "on" : ""} ${i < step ? "past" : ""} ${d.verdict === "fail" ? "fail" : ""}`}
              onClick={() => {
                setPlaying(false);
                dispatch({ type: "goto", step: i });
              }}
            >
              <span className="sr">{d.label}</span>
            </button>
          ))}
        </div>
        <button className="mbtn" onClick={() => dispatch({ type: "replay" })} aria-label="Replay from the start">
          ↺
        </button>
      </div>
    </div>
  );
}
