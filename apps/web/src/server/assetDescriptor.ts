import 'server-only';
import { z } from 'zod';

/**
 * Strict payload for a privacy token registration. Unknown keys are rejected.
 * The node's own rules (src/cryptonote_basic/token_descriptor.cpp on
 * feature-privacy-token) are: ticker 1-14 ASCII letters or digits, full_name
 * 1-64 of ASCII letters, digits, space, "_", "-" or "."; decimal_point <= 18.
 * The app keeps a stricter ticker and decimals range.
 */
export const tokenDeploySchema = z
  .object({
    ticker: z.string().regex(/^[A-Za-z0-9]{2,12}$/, 'Ticker must be 2-12 letters or digits.'),
    name: z
      .string()
      .trim()
      .min(2)
      .max(64)
      .regex(/^[A-Za-z0-9 _.-]+$/, 'Name may only use letters, digits, spaces, "_", "-" and ".".'),
    decimals: z.number().int().min(0).max(12),
    totalSupply: z.string().regex(/^\d{1,20}(\.\d{1,12})?$/, 'Supply must be a positive decimal.'),
  })
  .strict();

export type TokenDeployInput = z.infer<typeof tokenDeploySchema>;
