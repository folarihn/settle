import { DomainError, type DomainErrorCode } from "@settle/domain";
import { ZodError } from "zod";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const DOMAIN_STATUS: Record<DomainErrorCode, number> = {
  VALIDATION: 400,
  UNAUTHORIZED: 403,
  NOT_FOUND: 404,
  INVALID_TRANSITION: 409,
  TERMS_LOCKED: 409,
  HASH_MISMATCH: 409,
  BINDING_MISMATCH: 409,
  REPLAY: 409,
  INVALID_SIGNATURE: 409,
  DEADLINE: 409,
  ACCOUNTING: 422,
};

/** One error shape for every failure: `{ error: { code, message } }`. */
export function toErrorResponse(e: unknown): { status: number; body: { error: { code: string; message: string } } } {
  if (e instanceof ApiError) return { status: e.status, body: { error: { code: e.code, message: e.message } } };
  if (e instanceof DomainError) return { status: DOMAIN_STATUS[e.code], body: { error: { code: e.code, message: e.message } } };
  if (e instanceof ZodError) {
    const message = e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
    return { status: 400, body: { error: { code: "VALIDATION", message } } };
  }
  return { status: 500, body: { error: { code: "INTERNAL", message: "internal error" } } };
}
