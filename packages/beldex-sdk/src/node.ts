// Node-only helpers (filesystem). Import from "@belflow/sdk/node"; the main
// entry stays browser-safe.

import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stringifyJsonSafe } from './rpc/json';
import type { AssetDescriptorWriter } from './providers/WalletRpcProvider';

/**
 * Writes deploy_new_asset descriptors into a directory shared with
 * beldex-wallet-rpc. The file name is generated here (crypto.randomUUID),
 * the resolved path must stay inside the base directory, the file is created
 * exclusively (flag "wx", mode 0600), and the caller's cleanup runs in a
 * finally block (WalletRpcProvider.mintPrivacyToken).
 */
export function createAssetDescriptorWriter(directory: string): AssetDescriptorWriter {
  const base = path.resolve(directory);
  return async (descriptor) => {
    const file = path.resolve(base, `${randomUUID()}.json`);
    if (path.dirname(file) !== base || !file.startsWith(base + path.sep)) {
      throw new Error('Refusing to write an asset descriptor outside the descriptor directory.');
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
