import { describe, expect, it } from "vitest";
import { computeOnchainTermsHash, contractCallFor, toContractReport, type ContractTerms } from "../src/index.js";
import { fundedAgreement, signed, WORKER, run } from "./fixtures.js";

const NEAR = 10n ** 24n;
const API = (35n * NEAR) / 100n;
const DESIGN = (15n * NEAR) / 100n;
const T0 = 1_800_000_000_000;
const HOUR = 3_600_000;
const d = (c: string) => `sha256:${c.repeat(64)}`;

describe("escrow contract interface", () => {
  // Same terms as `terms()` in contracts/escrow/src/tests.rs (`terms_hash_vector_matches_domain`).
  it("computes the contract's borsh terms hash exactly", () => {
    const t: ContractTerms = {
      agreement_id: "job_demo_0001",
      offchain_terms_hash: d("0"),
      client: "client.testnet",
      worker: "worker.testnet",
      verifier: "verifier.testnet",
      verifier_public_key: "d04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737",
      resolver: "resolver.testnet",
      total: (API + DESIGN).toString(),
      milestones: [
        { id: "api", amount: API.toString(), kind: { Automated: { plan_hash: d("a") } } },
        { id: "design", amount: DESIGN.toString(), kind: { HumanReview: { max_revisions: 2, floor: ((75n * NEAR) / 1000n).toString() } } },
      ],
      challenge_period_ms: HOUR,
      funding_deadline_ms: T0 + 24 * HOUR,
      expires_at_ms: T0 + 14 * 24 * HOUR,
    };
    expect(computeOnchainTermsHash(t)).toBe("sha256:c6457601cba9b243067f750272d1ef45c7d542584d30f9fe968dc4dfd44f751f");
  });

  it("maps a submission and a signed report to the matching contract calls", () => {
    let s = fundedAgreement();
    const event = { type: "SUBMIT" as const, actor: WORKER, at: Date.now(), milestoneId: "api", artifactHash: "commit-1" };
    expect(contractCallFor(s, event)).toMatchObject({ methodName: "submit", deposit: "0", args: { milestone_id: "api", artifact_hash: "commit-1" } });
    s = run(s, ["SUBMIT", WORKER, { milestoneId: "api", artifactHash: "commit-1" }]);
    const { report } = signed(s, { outcome: "INCONCLUSIVE" });
    expect(toContractReport(report)).toMatchObject({ outcome: "Inconclusive", submission_seq: 1 });
  });
});
