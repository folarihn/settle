import type { Job, Milestone, MilestoneTerms } from "./api";

/** Builds a Job as the API returns it, for unit tests of display logic. */
export function makeJob(over: {
  status?: Job["state"]["status"];
  accepted?: boolean;
  openBounty?: boolean;
  worker?: string;
  fundingDeadline?: number;
  milestones?: { terms?: Partial<MilestoneTerms>; state?: Partial<Milestone> }[];
  totalNear?: number;
  id?: string;
  client?: string;
}): Job {
  const ms = over.milestones ?? [{}];
  const amount = (BigInt(over.totalNear ?? 1) * 10n ** 24n) / BigInt(ms.length);
  return {
    id: over.id ?? "job_test",
    version: 1,
    roles: [],
    onchainTermsHash: "sha256:x",
    state: {
      status: over.status ?? "FUNDED",
      termsHash: "sha256:x",
      acceptedBy: { client: true, worker: over.accepted ?? true },
      terms: {
        agreementId: over.id ?? "job_test",
        client: { nearAccountId: over.client ?? "client.testnet", kind: "HUMAN" },
        worker: { nearAccountId: over.worker ?? "worker.testnet", kind: "AGENT" },
        disputeResolver: "resolver.testnet",
        verifierAuthority: "verifier.testnet",
        totalYocto: (amount * BigInt(ms.length)).toString(),
        milestones: ms.map((m, i) => ({ id: `m${i}`, title: `Milestone ${i + 1}`, type: "AUTOMATED", amountYocto: amount.toString(), ...m.terms })),
        challengePeriodSec: 60,
        fundingDeadline: over.fundingDeadline ?? Date.now() + 3_600_000,
        expiresAt: Date.now() + 86_400_000,
        ...(over.openBounty ? { openBounty: true as const } : {}),
      },
      milestones: ms.map((m, i) => ({
        id: `m${i}`,
        status: "PENDING",
        submission: null,
        submissionCount: 0,
        revisionsUsed: 0,
        challengeEndsAt: null,
        settlementProposal: null,
        allocation: null,
        lastVerification: null,
        ...m.state,
      })),
    },
    calls: { payout: {} },
  };
}
