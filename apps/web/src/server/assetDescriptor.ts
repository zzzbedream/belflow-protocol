import 'server-only';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { stringifyJsonSafe, type AssetDescriptorWriter } from '@belflow/sdk';

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

/**
 * Writes deploy_new_asset descriptors into a directory shared with
 * beldex-wallet-rpc. The file name is generated server-side
 * (crypto.randomUUID), the resolved path must stay inside the base directory,
 * the file is created exclusively (flag "wx", mode 0600) and the caller's
 * cleanup runs in a finally block (see WalletRpcProvider.mintPrivacyToken).
 */
export function createAssetDescriptorWriter(directory: string): AssetDescriptorWriter {
  const base = path.resolve(directory);
  return async (descriptor) => {
    const file = path.resolve(base, `${randomUUID()}.json`);
    if (path.dirname(file) !== base || !file.startsWith(base + path.sep)) {
      throw new Error('Refusing to write an asset descriptor outside BELDEX_ASSET_DESCRIPTOR_DIR.');
    }
    await mkdir(base, { recursive: true });
    const cleanup = () => rm(file, { force: true });
    try {
      await writeFile(file, stringifyJsonSafe(descriptor), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    } catch (error) {
      await cleanup();
      throw error;
    }
    return { path: file, cleanup };
  };
}
