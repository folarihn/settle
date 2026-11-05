import { ApiError } from "./api";

/**
 * What people see when something goes wrong. Raw API codes and stack-ish messages never reach the
 * page; each known case gets a plain sentence and, where it helps, what to do next.
 */
export function describeError(e: unknown): string {
  if (e instanceof ApiError) {
    switch (e.code) {
      case "AUTH_REQUIRED":
        return "Sign in with your NEAR testnet wallet to see this.";
      case "NOT_FOUND":
        return "Not found, or not shared with your account.";
      case "RATE_LIMITED":
        return "Too many requests from your network. Wait a minute and try again.";
      case "AUTH_FAILED":
        return "The wallet signature could not be verified. Try signing in again.";
      case "UNAUTHORIZED":
        return "Your account is not allowed to do that on this agreement.";
      case "IN_FLIGHT":
        return "That is already in progress. Wait for it to finish.";
      case "CONFLICT":
        return "This agreement just changed. The page has been refreshed; try again.";
      case "INTERNAL":
        return "SETTLE's API had an internal problem. Nothing was changed; try again shortly.";
    }
    if (/^HTTP_5\d\d$/.test(e.code)) return "SETTLE's API had a problem (it may be waking up after idling). Try again in a moment.";
    // Rule and validation messages are written for people; show them as they are.
    if (["BAD_REQUEST", "INVALID_TRANSITION", "VALIDATION", "LIMIT", "CHAIN_ONLY", "NOT_READY"].includes(e.code) || /^[A-Z_]+$/.test(e.code)) return e.message;
    return e.message || "Something went wrong.";
  }
  const msg = e instanceof Error ? e.message : String(e);
  if (isWalletRejection(msg)) return "The wallet request was cancelled. Nothing was sent.";
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return "Could not reach SETTLE's API. Check your connection, or try again shortly (it may be waking up).";
  return msg || "Something went wrong.";
}

export const isWalletRejection = (message: string) => /user (closed|rejected|cancel+ed)|rejected by user|request was rejected|window closed/i.test(message);

/** A wallet transaction, from the click to the contract confirming it. */
export type TxPhase =
  | { phase: "idle" }
  | { phase: "signing"; label: string }
  | { phase: "sent"; label: string; hash: string }
  | { phase: "confirmed"; label: string; hash: string }
  | { phase: "failed"; label: string; message: string };

export type TxEvent =
  | { type: "sign"; label: string }
  | { type: "sent"; hash: string }
  | { type: "confirmed" }
  | { type: "error"; error: unknown }
  | { type: "reset" };

/**
 * Only one transaction at a time (a second "sign" while one is in flight is ignored), and
 * "confirmed" is reachable only from "sent": nothing is shown as done before it has a hash and
 * the contract has been read back.
 */
export function txReducer(s: TxPhase, ev: TxEvent): TxPhase {
  switch (ev.type) {
    case "sign":
      return s.phase === "signing" || s.phase === "sent" ? s : { phase: "signing", label: ev.label };
    case "sent":
      return s.phase === "signing" ? { phase: "sent", label: s.label, hash: ev.hash } : s;
    case "confirmed":
      return s.phase === "sent" ? { phase: "confirmed", label: s.label, hash: s.hash } : s;
    case "error":
      return s.phase === "idle" ? s : { phase: "failed", label: s.label, message: describeError(ev.error) };
    case "reset":
      return { phase: "idle" };
  }
}

/** The wallet area's states. Connecting a wallet is not signing in, and neither sends a transaction. */
export type WalletState = "loading" | "disconnected" | "connected" | "signed-in";

export function walletState(o: { walletReady: boolean; accountId: string | null; signedIn: boolean }): WalletState {
  if (!o.walletReady) return "loading";
  if (!o.accountId) return "disconnected";
  return o.signedIn ? "signed-in" : "connected";
}
