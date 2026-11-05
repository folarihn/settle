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
      <svg viewBox="0 0 720 150" role="img" aria-hidden>
        <path className="wire" d="M146 34 H322" />
        <path className="wire" d="M398 34 H574" />

        {/* client */}
        <g transform="translate(97 20)">
          <circle className="icon" cx="13" cy="8" r="5" />
          <path className="icon" d="M3 27c1.5-6 5.5-9 10-9s8.5 3 10 9" />
        </g>
        <text className="lbl" x="110" y="84" textAnchor="middle">
          Client
        </text>
        <text className="sub" x="110" y="104" textAnchor="middle">
          funds the job
        </text>

        {/* escrow contract: holds the money while the work is checked */}
        <g transform="translate(345 16)">
          <rect className="icon core-icon" x="2" y="13" width="26" height="19" />
          <path className="icon core-icon" d="M8 13V8h14v5" />
          <path className="icon core-icon" d="M15 20v5" />
        </g>
        <text className="lbl core" x="360" y="84" textAnchor="middle">
          Escrow contract
        </text>
        <text className="sub" x="360" y="104" textAnchor="middle">
          holds, checks, pays
        </text>

        {/* worker */}
        <g transform="translate(597 18)">
          <rect className="icon" x="2" y="5" width="22" height="17" />
          <path className="icon" d="M9 12v2M17 12v2M13 1v4M7 29h12" />
        </g>
        <text className="lbl" x="610" y="84" textAnchor="middle">
          Worker
        </text>
        <text className="sub" x="610" y="104" textAnchor="middle">
          person or agent
        </text>

        {/* flags under the labels, in step with the money */}
        <text className="flag" x="360" y="136" textAnchor="middle" opacity="0">
          <animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;0.48;0.52;0.9;1" dur={DUR} repeatCount="indefinite" />
          ✓ VERIFIED
        </text>
        <text className="flag" x="610" y="136" textAnchor="middle" opacity="0">
          <animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;0.84;0.87;0.97;1" dur={DUR} repeatCount="indefinite" />
          PAID
        </text>

        {/* the money: a square on the wire, hidden while the contract holds it */}
        <rect className="coin" x="146" y="29" width="10" height="10">
          <animate attributeName="x" values="146;318;392;566;566" keyTimes="0;0.25;0.6;0.85;1" dur={DUR} repeatCount="indefinite" />
          <animate attributeName="opacity" values="0;1;1;0;0;1;1;0;0" keyTimes="0;0.04;0.22;0.25;0.6;0.63;0.82;0.86;1" dur={DUR} repeatCount="indefinite" />
        </rect>
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
