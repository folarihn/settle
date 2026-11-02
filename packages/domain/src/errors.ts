export type DomainErrorCode =
  | "VALIDATION"
  | "UNAUTHORIZED"
  | "INVALID_TRANSITION"
  | "TERMS_LOCKED"
  | "HASH_MISMATCH"
  | "BINDING_MISMATCH"
  | "REPLAY"
  | "DEADLINE"
  | "ACCOUNTING"
  | "NOT_FOUND";

/** Every rejected operation throws this; callers branch on `code`, never on message text. */
export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export function fail(code: DomainErrorCode, message: string, details?: Record<string, unknown>): never {
  throw new DomainError(code, message, details);
}
