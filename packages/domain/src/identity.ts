import { z } from "zod";

// NEAR account id rules: 2-64 chars, lowercase alphanumerics separated by single
// '-', '_' or '.' (named accounts), or a 64-char hex implicit account.
const NEAR_ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export const NearAccountId = z
  .string()
  .min(2)
  .max(64)
  .regex(NEAR_ACCOUNT_RE, "invalid NEAR account id");

export type NearAccountId = z.infer<typeof NearAccountId>;

/**
 * A party to an agreement. The NEAR account is the payment identity; an offchain
 * auth subject (API token owner, session) never grants authority over funds.
 */
export const Principal = z
  .object({
    kind: z.enum(["HUMAN", "AGENT"]),
    nearAccountId: NearAccountId,
    offchainAuthSubject: z.string().min(1).max(200).optional(),
  })
  .strict();

export type Principal = z.infer<typeof Principal>;
