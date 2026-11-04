/** Exact NEAR <-> yoctoNEAR conversion on decimal strings; never floating point. */
const YOCTO_DIGITS = 24;

export function nearToYocto(near: string): string {
  const m = /^(0|[1-9][0-9]{0,14})(?:\.([0-9]{1,24}))?$/.exec(near.trim());
  if (!m) throw new Error(`'${near}' is not a NEAR amount (use a decimal like "0.25", at most 24 decimals)`);
  return BigInt(m[1]! + (m[2] ?? "").padEnd(YOCTO_DIGITS, "0")).toString();
}

export function yoctoToNear(yocto: string | bigint): string {
  const s = BigInt(yocto).toString().padStart(YOCTO_DIGITS + 1, "0");
  const whole = s.slice(0, -YOCTO_DIGITS);
  const frac = s.slice(-YOCTO_DIGITS).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}
