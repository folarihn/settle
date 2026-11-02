import { z } from "zod";

/** NEAR balances are u128 yoctoNEAR; anything larger cannot exist onchain. */
export const U128_MAX = (1n << 128n) - 1n;
export const YOCTO_PER_NEAR = 10n ** 24n;

/**
 * Amounts travel as base-10 integer strings (JSON has no bigint) and are only
 * ever compared or summed as bigint, never as floating point.
 */
const INTEGER_RE = /^(0|[1-9][0-9]*)$/;

/**
 * Zod still runs refinements on values that failed an earlier check, so anything
 * that calls BigInt() on schema input must go through this guard first.
 */
export const parseYoctoOrNull = (s: string): bigint | null => (INTEGER_RE.test(s) ? BigInt(s) : null);

export const YoctoString = z
  .string()
  .regex(INTEGER_RE, "must be a non-negative integer string of yoctoNEAR")
  .refine((s) => (parseYoctoOrNull(s) ?? 0n) <= U128_MAX, "exceeds u128 maximum");

export type Yocto = z.infer<typeof YoctoString>;

export const toYocto = (s: Yocto): bigint => BigInt(s);
export const fromYocto = (n: bigint): Yocto => n.toString();
