/**
 * The homepage's escrow machine is a SIMULATION. This module is its whole state: a fixed script of
 * eight steps. It never reads application state, never calls the API or a wallet, and moves no
 * money. Kept pure so the mapping from step to picture is tested.
 */

export type Holder = "client" | "vault" | "worker";
export type Verdict = "none" | "scanning" | "fail" | "pass";

export interface DemoStep {
  key: string;
  label: string;
  caption: string;
  /** Where the simulated payment token is. */
  token: Holder;
  /** Escrow vault door closed with the funds inside. */
  locked: boolean;
  /** Which wire is drawn as active. */
  wire: "none" | "client-vault" | "worker-engine" | "vault-worker";
  verdict: Verdict;
  challenge: boolean;
  paid: boolean;
  /** One line added to the simulated receipt at this step. */
  receipt: string;
}

export const DEMO_STEPS: readonly DemoStep[] = [
  {
    key: "created",
    label: "Agreement created",
    caption: "Both sides agree the milestone, the check and the price. Nothing has moved yet.",
    token: "client",
    locked: false,
    wire: "none",
    verdict: "none",
    challenge: false,
    paid: false,
    receipt: "terms agreed · checks fixed",
  },
  {
    key: "locked",
    label: "Funds locked",
    caption: "The client deposits the exact total. The vault closes; neither side can take it back alone.",
    token: "vault",
    locked: true,
    wire: "client-vault",
    verdict: "none",
    challenge: false,
    paid: false,
    receipt: "2.0 NEAR locked in escrow",
  },
  {
    key: "submitted",
    label: "Work submitted",
    caption: "The worker submits the delivery. The verification engine starts checking it against the agreed test.",
    token: "vault",
    locked: true,
    wire: "worker-engine",
    verdict: "scanning",
    challenge: false,
    paid: false,
    receipt: "delivery #1 submitted",
  },
  {
    key: "failed",
    label: "Verification failed",
    caption: "The check fails. The money stays in the vault; nobody is paid for work that does not pass.",
    token: "vault",
    locked: true,
    wire: "none",
    verdict: "fail",
    challenge: false,
    paid: false,
    receipt: "check FAILED · funds stay locked",
  },
  {
    key: "corrected",
    label: "Corrected submission",
    caption: "The worker fixes the problem and submits again. The engine re-runs the same, unchanged test.",
    token: "vault",
    locked: true,
    wire: "worker-engine",
    verdict: "scanning",
    challenge: false,
    paid: false,
    receipt: "delivery #2 submitted",
  },
  {
    key: "passed",
    label: "Verification passed",
    caption: "The check passes and the verifier signs the result. Payment is not released yet.",
    token: "vault",
    locked: true,
    wire: "none",
    verdict: "pass",
    challenge: false,
    paid: false,
    receipt: "check PASSED · signed",
  },
  {
    key: "challenge",
    label: "Challenge window",
    caption: "The client has a fixed window to object. If nobody does, the result stands.",
    token: "vault",
    locked: true,
    wire: "none",
    verdict: "pass",
    challenge: true,
    paid: false,
    receipt: "challenge window open",
  },
  {
    key: "released",
    label: "Payment released",
    caption: "The window closes. The vault opens and the contract pays the worker exactly what was agreed.",
    token: "worker",
    locked: false,
    wire: "vault-worker",
    verdict: "pass",
    challenge: false,
    paid: true,
    receipt: "2.0 NEAR paid to worker",
  },
];

export const LAST_STEP = DEMO_STEPS.length - 1;

export type DemoAction = { type: "next" } | { type: "back" } | { type: "goto"; step: number } | { type: "replay" };

/** Step transitions. Advancing past the end stays on the last step (the user replays explicitly). */
export function demoReducer(step: number, action: DemoAction): number {
  switch (action.type) {
    case "next":
      return Math.min(step + 1, LAST_STEP);
    case "back":
      return Math.max(step - 1, 0);
    case "goto":
      return Math.max(0, Math.min(LAST_STEP, Math.trunc(action.step)));
    case "replay":
      return 0;
  }
}

/** Receipt lines visible at a step: every line up to and including it. */
export const receiptAt = (step: number) => DEMO_STEPS.slice(0, step + 1).map((s, i) => `${String(i + 1).padStart(2, "0")}  ${s.receipt}`);

/**
 * Autoplay only when the user asked for it, the machine is on screen, and the user has not asked
 * the system for reduced motion. Manual stepping always works.
 */
export function autoplayAllowed(o: { playing: boolean; inView: boolean; reducedMotion: boolean }): boolean {
  return o.playing && o.inView && !o.reducedMotion;
}
