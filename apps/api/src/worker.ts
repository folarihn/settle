import type { VerifyOptions } from "@settle/verifier";
import type { VerificationService } from "./verifications.js";

/** Processes queued verifications until none remain. Returns how many it ran. */
export async function drainQueue(verifications: VerificationService, opts: VerifyOptions): Promise<number> {
  let processed = 0;
  for (let row = await verifications.claim(); row; row = await verifications.claim()) {
    await verifications.process(row, opts);
    processed += 1;
  }
  return processed;
}

export async function runWorkerLoop(
  verifications: VerificationService,
  seedHex: string,
  log: { error: (o: unknown, msg?: string) => void },
  idleMs = 1000,
): Promise<never> {
  for (;;) {
    try {
      if ((await drainQueue(verifications, { seedHex })) === 0) await new Promise((r) => setTimeout(r, idleMs));
    } catch (e) {
      log.error(e, "verification worker iteration failed");
      await new Promise((r) => setTimeout(r, idleMs));
    }
  }
}
