import { fail } from "./errors.js";
import { toYocto } from "./money.js";
import type { AgreementState } from "./state.js";

export interface EscrowSummary {
  fundedYocto: bigint;
  /** Funds still governed by milestone rules (no allocation yet). */
  lockedYocto: bigint;
  /** Allocated but not yet sent. */
  claimableWorkerYocto: bigint;
  claimableClientYocto: bigint;
  pendingPayoutYocto: bigint;
  paidWorkerYocto: bigint;
  refundedClientYocto: bigint;
}

export function escrowSummary(state: AgreementState): EscrowSummary {
  const s: EscrowSummary = {
    fundedYocto: toYocto(state.fundedYocto),
    lockedYocto: 0n,
    claimableWorkerYocto: 0n,
    claimableClientYocto: 0n,
    pendingPayoutYocto: 0n,
    paidWorkerYocto: 0n,
    refundedClientYocto: 0n,
  };
  if (state.status === "DRAFT") return s;

  state.terms.milestones.forEach((terms, i) => {
    const m = state.milestones[i]!;
    const amount = toYocto(terms.amountYocto);
    if (!m.allocation) {
      s.lockedYocto += amount;
      return;
    }
    const worker = toYocto(m.allocation.workerYocto);
    const client = toYocto(m.allocation.clientYocto);
    if (worker + client !== amount) {
      fail("ACCOUNTING", `milestone '${m.id}' allocation ${worker}+${client} does not equal ${amount}`);
    }
    if (m.status === "CLAIMABLE") {
      s.claimableWorkerYocto += worker;
      s.claimableClientYocto += client;
    } else if (m.status === "PAYOUT_PENDING") {
      s.pendingPayoutYocto += amount;
    } else if (m.status === "PAID") {
      s.paidWorkerYocto += worker;
      s.refundedClientYocto += client;
    } else {
      fail("ACCOUNTING", `milestone '${m.id}' has an allocation in status ${m.status}`);
    }
  });
  return s;
}

/** Every yoctoNEAR in escrow must be in exactly one bucket. Throws ACCOUNTING otherwise. */
export function assertReconciled(state: AgreementState): void {
  if (state.status === "DRAFT") {
    if (state.fundedYocto !== "0") fail("ACCOUNTING", "draft agreement holds funds");
    return;
  }
  const s = escrowSummary(state);
  const accounted =
    s.lockedYocto +
    s.claimableWorkerYocto +
    s.claimableClientYocto +
    s.pendingPayoutYocto +
    s.paidWorkerYocto +
    s.refundedClientYocto;
  if (accounted !== s.fundedYocto) {
    fail("ACCOUNTING", `escrow does not reconcile: funded ${s.fundedYocto}, accounted ${accounted}`);
  }
}
