/** Thin client for the SETTLE API. The same routes back the agent SDK. */

export interface ContractCall {
  contractId: string;
  methodName: string;
  args: Record<string, unknown>;
  deposit: string;
  gas: string;
}

export interface Milestone {
  id: string;
  status: string;
  submission: { seq: number; artifactHash: string; uri?: string } | null;
  submissionCount: number;
  revisionsUsed: number;
  challengeEndsAt: number | null;
  settlementProposal: { proposer: string; workerYocto: string } | null;
  allocation: { workerYocto: string; clientYocto: string } | null;
  lastVerification: { outcome: string } | null;
}

export interface MilestoneTerms {
  id: string;
  title: string;
  type: "AUTOMATED" | "HUMAN_REVIEW";
  amountYocto: string;
  maxRevisions?: number;
  rubric?: string;
  partialCompensation?: { floorYocto: string } | null;
  verificationPlan?: unknown;
}

export interface Job {
  id: string;
  version: number;
  roles: string[];
  onchainTermsHash: string;
  state: {
    status: "DRAFT" | "OPEN" | "FUNDED" | "COMPLETED" | "CANCELLED";
    termsHash: string;
    acceptedBy: { client: boolean; worker: boolean };
    terms: {
      agreementId: string;
      client: { nearAccountId: string; kind: string };
      worker: { nearAccountId: string; kind: string };
      disputeResolver: string;
      verifierAuthority: string;
      totalYocto: string;
      milestones: MilestoneTerms[];
      challengePeriodSec: number;
      fundingDeadline: number;
      expiresAt: number;
      openBounty?: true;
    };
    milestones: Milestone[];
  };
  calls: {
    createAgreement?: ContractCall;
    fund?: ContractCall;
    postBounty?: ContractCall;
    claimBounty?: ContractCall;
    cancelBounty?: ContractCall;
    payout: Record<string, ContractCall>;
  };
}

export interface ChainSnapshot {
  agreement: { status: string; milestones: { status: string; submission: { seq: number } | null }[] } | null;
  error: string | null;
  termsMatch: boolean | null;
  divergences: { milestoneId: string; offchain: string; onchain: string }[];
}

export interface Verification {
  id: string;
  milestoneId: string;
  submissionSeq: number;
  status: string;
  outcome: string | null;
  error: string | null;
  createdAt: number;
  contractCall: ContractCall | null;
}

export interface PublicConfig {
  network: string;
  rpcUrl: string;
  escrowContract: string;
  resolverAccount: string;
  verifierAccount: string;
  authRecipient: string;
  demoPlan: unknown;
  fixturePath: string | null;
  workerWakeUrl: string | null;
  swarm: { model: string; nearUsd: string; operator: string; wakeUrl: string | null } | null;
  /** The deployment's public HTTPS origin, when the API knows it. */
  publicUrl?: string | null;
}

export interface SwarmAgent {
  id: string;
  name: string;
  owner: string;
  account: string | null;
  status: "provisioning" | "awaiting_funds" | "active" | "paused";
  prompt: string;
  knowledgeChars: number;
  maxBountyYocto: string;
  maxJobNanoUsd: number;
  createdAt: number;
  stats: { jobsWon: number; jobsPaid: number; earnedYocto: string; inferenceCalls: number; inferenceNanoUsd: number; pendingCostCalls: number; unsettledNanoUsd: number };
  withdrawal: { status: string; paidYocto: string | null; feeYocto: string | null; feeTx: string | null; payoutTx: string | null; error: string | null } | null;
}

export interface AiReview {
  milestoneId: string;
  submissionSeq: number;
  verdict: "meets" | "partly" | "does_not_meet" | "cannot_review";
  summary: string;
  points: string[];
  model: string;
  signature: { kind: string | null; address: string; algo: string } | null;
  signatureCheck: string | null;
  createdAt: number;
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const TOKEN_KEY = "settle.session";
export const SESSION_EXPIRED = "settle:session-expired";

export function getToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
export function setToken(token: string | null) {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage blocked: the session lasts for this page only.
  }
}

export async function api<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const token = getToken();
  const res = await fetch(path, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401 && token) {
    // The session expired or was revoked: drop it and tell the app, which falls back to the
    // signed-out view instead of showing an error on every page.
    setToken(null);
    window.dispatchEvent(new Event(SESSION_EXPIRED));
  }
  if (!res.ok) throw new ApiError(json.error?.code ?? `HTTP_${res.status}`, json.error?.message ?? res.statusText);
  return json as T;
}

const YOCTO = 10n ** 24n;

/** "0.35" -> yoctoNEAR string, exact (no floating point). */
export function nearToYocto(near: string): string {
  const m = near.trim().match(/^(\d+)(?:\.(\d{0,24}))?$/);
  if (!m) throw new Error(`invalid NEAR amount: ${near}`);
  return (BigInt(m[1]!) * YOCTO + BigInt((m[2] ?? "").padEnd(24, "0") || "0")).toString();
}

export function yoctoToNear(yocto: string): string {
  const n = BigInt(yocto);
  const frac = (n % YOCTO).toString().padStart(24, "0").replace(/0+$/, "");
  return `${n / YOCTO}${frac ? `.${frac}` : ""}`;
}
