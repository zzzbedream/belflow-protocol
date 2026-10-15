import 'server-only';
import { serverEnv } from './env';

export interface ExplorerInfo {
  height: number;
  nettype: string;
  hardFork: number;
}

let cache: { value: ExplorerInfo; expiresAt: number } | null = null;
const TTL_MS = 15_000;

/** Public testnet explorer status, used even when no sidecar is configured. */
export async function explorerInfo(): Promise<ExplorerInfo | null> {
  if (cache && cache.expiresAt > Date.now()) return cache.value;
  try {
    const response = await fetch(`${serverEnv().BELDEX_EXPLORER_API_URL}/networkinfo`, { signal: AbortSignal.timeout(8_000), cache: 'no-store' });
    if (!response.ok) return null;
    const body = (await response.json()) as { data?: { height?: number; nettype?: string; current_hf_version?: number } };
    if (typeof body.data?.height !== 'number') return null;
    const value = { height: body.data.height, nettype: body.data.nettype ?? 'unknown', hardFork: body.data.current_hf_version ?? 0 };
    cache = { value, expiresAt: Date.now() + TTL_MS };
    return value;
  } catch {
    return null;
  }
}
