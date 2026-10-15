import 'server-only';
import { z } from 'zod';

/** Hardened descriptor writer (UUID names, path containment, "wx" + 0600, cleanup in finally). */
export { createAssetDescriptorWriter } from '@belflow/sdk/node';

/** Strict payload for a Privacy Token deploy request. Unknown keys are rejected. */
export const tokenDeploySchema = z
  .object({
    ticker: z.string().regex(/^[A-Za-z0-9]{2,12}$/, 'Ticker must be 2-12 letters or digits.'),
    name: z
      .string()
      .trim()
      .min(2)
      .max(64)
      .regex(/^[\p{L}\p{N} .,'()&-]+$/u, 'Name contains unsupported characters.'),
    decimals: z.number().int().min(0).max(12),
    totalSupply: z.string().regex(/^\d{1,20}(\.\d{1,12})?$/, 'Supply must be a positive decimal.'),
  })
  .strict();

export type TokenDeployInput = z.infer<typeof tokenDeploySchema>;
