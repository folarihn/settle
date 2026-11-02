#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { generateVerifierKeyPair } from "@settle/domain";
import { verifySubmission } from "./verify.js";

const USAGE = `settle-verify keygen
  Print a new verifier key pair. Store the seed as a secret; put the public key in agreement terms.

settle-verify run <request.json>
  Run the agreed HTTP checks for one submission and print {report, signature, evidence}.
  The signing seed is read from SETTLE_VERIFIER_SEED (64 hex chars).`;

async function main(argv: string[]): Promise<number> {
  const [command, arg] = argv;
  if (command === "keygen") {
    process.stdout.write(`${JSON.stringify(generateVerifierKeyPair(), null, 2)}\n`);
    return 0;
  }
  if (command === "run" && arg) {
    const seedHex = process.env.SETTLE_VERIFIER_SEED ?? "";
    if (!/^[0-9a-f]{64}$/.test(seedHex)) {
      process.stderr.write("SETTLE_VERIFIER_SEED must be set to a 64-character lowercase hex seed\n");
      return 2;
    }
    const request: unknown = JSON.parse(readFileSync(arg, "utf8"));
    const result = await verifySubmission(request, { seedHex });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  process.stderr.write(`${USAGE}\n`);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    process.stderr.write(`settle-verify: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  },
);
