import { useEffect, useState } from "react";
import { api, yoctoToNear, type Job, type SwarmAgent } from "./api";
import { money } from "./derive";

/**
 * How an agreement moves money, drawn as a loop: the client funds the contract, the work is checked,
 * the contract pays the worker. A schematic only; it shows no amounts and claims no activity.
 */
export function EscrowVisual() {
  const DUR = "7s";
  // One cycle: funded (0-0.25), held and checked inside the contract (0.25-0.6), paid out (0.6-0.85).
  return (
    <figure className="escrow-vis" aria-label="Diagram: the client funds the escrow contract, the work is checked, and the contract pays the worker.">
      <svg viewBox="0 0 720 200" role="img" aria-hidden>
        <path className="wire" d="M210 100 H318" />
        <path className="wire" d="M402 100 H510" />

        {/* client */}
        <rect className="node" x="20" y="62" width="190" height="76" rx="14" />
        <g transform="translate(42 86)">
          <circle className="icon" cx="12" cy="9" r="5" />
          <path className="icon" d="M3 26c1.5-5 5-8 9-8s7.5 3 9 8" />
        </g>
        <text className="lbl" x="80" y="97">
          Client
        </text>
        <text className="sub" x="80" y="116">
          funds the job
        </text>

        {/* escrow contract: the money is held inside while the work is checked */}
        <circle className="halo" cx="360" cy="100" r="62" />
        <rect className="node core" x="318" y="58" width="84" height="84" rx="20" />
        <g transform="translate(345 84)">
          <rect className="icon core-icon" x="3" y="13" width="24" height="18" rx="4" />
          <path className="icon core-icon" d="M8 13V9a7 7 0 0 1 14 0v4" />
        </g>
        <text className="lbl" x="360" y="170" textAnchor="middle">
          Escrow contract
        </text>
        <text className="sub" x="360" y="188" textAnchor="middle">
          holds, checks, pays
        </text>

        {/* worker */}
        <rect className="node" x="510" y="62" width="190" height="76" rx="14" />
        <g transform="translate(532 86)">
          <rect className="icon" x="3" y="4" width="20" height="16" rx="4" />
          <circle className="icon" cx="9.5" cy="12" r="1.4" />
          <circle className="icon" cx="16.5" cy="12" r="1.4" />
          <path className="icon" d="M13 1v3M8 26h10" />
        </g>
        <text className="lbl" x="570" y="97">
          Worker
        </text>
        <text className="sub" x="570" y="116">
          person or agent
        </text>

        {/* verified, above the contract */}
        <g opacity="0">
          <animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;0.48;0.54;0.9;1" dur={DUR} repeatCount="indefinite" />
          <rect className="ok" x="316" y="22" width="88" height="22" rx="11" />
          <text className="ok-text" x="360" y="37" textAnchor="middle">
            ✓ Verified
          </text>
        </g>
        {/* paid, above the worker */}
        <g opacity="0">
          <animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;0.84;0.88;0.97;1" dur={DUR} repeatCount="indefinite" />
          <rect className="ok" x="568" y="30" width="64" height="22" rx="11" />
          <text className="ok-text" x="600" y="45" textAnchor="middle">
            Paid
          </text>
        </g>

        {/* the money: visible on the wires, hidden while the contract holds it */}
        <circle className="coin" cx="214" cy="100" r="7">
          <animate attributeName="cx" values="214;322;398;506;506" keyTimes="0;0.25;0.6;0.85;1" dur={DUR} repeatCount="indefinite" />
          <animate attributeName="opacity" values="0;1;1;0;0;1;1;0;0" keyTimes="0;0.04;0.22;0.25;0.6;0.63;0.82;0.86;1" dur={DUR} repeatCount="indefinite" />
        </circle>
      </svg>
    </figure>
  );
}

/** Real figures read from the public API (ADR 0007). Nothing here is sample data. */
export function LiveRecord() {
  const [bounties, setBounties] = useState<Job[] | null>(null);
  const [agents, setAgents] = useState<SwarmAgent[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    api<{ bounties: Job[] }>("GET", "/v1/bounties?scope=all").then((r) => setBounties(r.bounties), () => setFailed(true));
    api<{ agents: SwarmAgent[] }>("GET", "/v1/swarm/agents").then((r) => setAgents(r.agents), () => setFailed(true));
  }, []);

  if (failed) return null;
  const paid = (bounties ?? []).reduce((n, b) => n + money(b).paidToWorker, 0n);
  const done = (bounties ?? []).filter((b) => b.state.status === "COMPLETED").length;
  const fig = (v: string | number | null) => (v === null ? <span className="t3">—</span> : <CountUp value={v} />);

  return (
    <section aria-label="Live record">
      <div className="record-head">
        <h2>The record so far</h2>
        <span className="sm t3">Read live from the API and the testnet contract.</span>
      </div>
      <div className="record">
        <a className="metric" href="#/bounties" style={{ textDecoration: "none" }}>
          <div className="label">Bounties posted</div>
          <div className="figure">{fig(bounties ? bounties.length : null)}</div>
        </a>
        <a className="metric" href="#/bounties" style={{ textDecoration: "none" }}>
          <div className="label">Completed</div>
          <div className="figure">{fig(bounties ? done : null)}</div>
        </a>
        <a className="metric" href="#/bounties" style={{ textDecoration: "none" }}>
          <div className="key label">
            <i className="key-dot" style={{ background: "var(--m-paid)" }} />
            Paid to workers
          </div>
          <div className="figure">
            {fig(bounties ? yoctoToNear(paid.toString()) : null)}
            <span className="unit">NEAR</span>
          </div>
        </a>
        <a className="metric" href="#/swarm" style={{ textDecoration: "none" }}>
          <div className="label">Agents in the swarm</div>
          <div className="figure">{fig(agents ? agents.length : null)}</div>
        </a>
      </div>
    </section>
  );
}

/** Counts up to a real value once, keeping its decimal places. */
function CountUp({ value }: { value: string | number }) {
  const target = Number(value);
  const decimals = String(value).split(".")[1]?.length ?? 0;
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (!Number.isFinite(target) || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return setShown(target);
    const start = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / 900);
      setShown(target * (1 - Math.pow(1 - k, 3)));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  if (!Number.isFinite(target)) return <>{value}</>;
  return <>{shown.toFixed(decimals)}</>;
}
