/**
 * Verified historical receipts: real NEAR testnet transactions from the recorded end-to-end runs
 * in docs/TESTNET_RUN.md, each confirmed there with a finalized RPC read. Shown on the homepage
 * as history, labelled as such; they are not a live feed.
 */
export interface Receipt {
  step: string;
  detail: string;
  hash: string;
  tone: "ok" | "bad" | "info";
}

export interface ReceiptRun {
  run: string;
  title: string;
  receipts: Receipt[];
}

export const RECEIPT_RUNS: ReceiptRun[] = [
  {
    run: "Run 9",
    title: "GitHub CI check: a failing commit held, a passing one paid",
    receipts: [
      { step: "Agreement created", detail: "two automated milestones, 0.01 NEAR each", hash: "8J598aHFbwmN9rVcufBewiuFpXZXhizw9jTFfZMn4qt5", tone: "info" },
      { step: "Escrow funded", detail: "client deposits the exact total", hash: "DxWJSEUefrSPG3jbhYz8GzTyWBfK1Ce2UkLqWttESmqX", tone: "info" },
      { step: "Verification FAILED", detail: "commit not on the agreed branch; money stays", hash: "Gpzvjxfm9wHgy3zjqHNQFUod8Mt4HL4dHcf76ZUuDxBt", tone: "bad" },
      { step: "Verification PASSED", detail: "both required CI checks succeeded", hash: "2ooxMZW2zjJ2gjvqg9i8q6qt69jHGxZUwfKcXE4V3LMA", tone: "ok" },
    ],
  },
  {
    run: "Run 10",
    title: "Open bounties: one claimed and paid, one cancelled and refunded",
    receipts: [
      { step: "Bounty posted", detail: "0.02 NEAR escrowed, no worker named", hash: "8bS2ojFHLzHdeuP2NZcGFmks1hBZzr4c6zc4CxFcXssQ", tone: "info" },
      { step: "Bounty claimed", detail: "first claim the contract executes wins", hash: "9i7K8P5hG4mbG2VFVfPeVgB3J1PKP3VdKK8tRgkPZZxf", tone: "info" },
      { step: "Cancelled and refunded", detail: "unclaimed bounty, full deposit returned", hash: "4kpGaxDTXcZchqykbjNQLX5Daccf71BkcGsNufa6aDTL", tone: "bad" },
    ],
  },
  {
    run: "Run 12",
    title: "Swarm agent on NEAR AI: delivered, revised, approved, paid",
    receipts: [
      { step: "Bounty claimed by an AI agent", detail: "agent funded by its owner, works on NEAR AI", hash: "8Bv52hx3EKNeo74YiAfQTkCBMZFarZD4wrFTPJbPZzgV", tone: "info" },
      { step: "Work submitted", detail: "deliverable hash recorded onchain", hash: "BdQsJDANLrjHwa8iCveyjZB1PdWrjFE2PNL9g9FYpcPz", tone: "info" },
      { step: "Revision requested", detail: "client asks for a standalone SVG; funds stay", hash: "EvDfHcDioCYa3LbGQkdYn7JWhUpgVCUX6oQhqS1Ufeg4", tone: "bad" },
      { step: "Approved and paid", detail: "a person approves; the contract pays", hash: "68fU2wHnzd7ZhPpUJugv3YH9TT9JKUcQU2tXhBkHbBMJ", tone: "ok" },
    ],
  },
];
