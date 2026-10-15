import { NATIVE_TOKEN_ID } from '../constants';
import type { DaemonRpc } from '../rpc/daemon';
import type { TxInspection } from './verifier';

// Reads asset tags out of a decoded transaction. The Proto branch's JSON
// layout for asset outputs is not documented, so the walker accepts the field
// names used across CryptoNote asset forks and reports null (unknown) when
// none are present instead of guessing.

const ASSET_KEY = /^(asset|asset_id|asset_type|asset_tag|token_id)$/i;
const NATIVE_MARKERS = new Set(['', NATIVE_TOKEN_ID.toLowerCase(), '0'.repeat(64)]);
const MAX_DEPTH = 8;

function normalizeAsset(value: string): string {
  return NATIVE_MARKERS.has(value.toLowerCase()) ? NATIVE_TOKEN_ID : value.toLowerCase();
}

function collect(node: unknown, depth: number, found: string[]): void {
  if (depth > MAX_DEPTH || node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collect(item, depth + 1, found);
    return;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (ASSET_KEY.test(key) && typeof value === 'string') found.push(normalizeAsset(value));
    else collect(value, depth + 1, found);
  }
}

/**
 * Asset ids of a decoded tx, or null unless EVERY output carries exactly one
 * asset tag. Partial tagging (e.g. untagged native outputs next to a tagged
 * dust token output) must never be read as attribution: an attacker could pay
 * BDX to the recipient and add a token output elsewhere.
 */
export function extractAssetIds(decodedTx: unknown): string[] | null {
  const outputs = (decodedTx as { vout?: unknown } | null)?.vout;
  if (!Array.isArray(outputs) || outputs.length === 0) return null;
  const perOutput: string[] = [];
  for (const output of outputs) {
    const found: string[] = [];
    collect(output, 0, found);
    if (found.length !== 1) return null;
    perOutput.push(found[0] as string);
  }
  return [...new Set(perOutput)];
}

/** Builds an inspection from a daemon get_transactions entry or an explorer tx object. */
export function inspectionFromDecodedTx(entry: Record<string, unknown>): TxInspection {
  let decoded: unknown = entry;
  if (typeof entry.as_json === 'string') {
    try {
      decoded = JSON.parse(entry.as_json);
    } catch {
      decoded = entry;
    }
  }
  const blockHeight = typeof entry.block_height === 'number' && entry.block_height > 0 ? entry.block_height : null;
  const inPool = typeof entry.in_pool === 'boolean' ? entry.in_pool : blockHeight === null;
  return {
    assetIds: extractAssetIds(decoded),
    isFlash: entry.flash === true,
    inPool,
    blockHeight: inPool ? null : blockHeight,
  };
}

export function createDaemonTxInspector(daemon: DaemonRpc): (txHash: string) => Promise<TxInspection | null> {
  return async (txHash) => {
    const [entry] = await daemon.getTransactions([txHash]);
    return entry ? inspectionFromDecodedTx(entry) : null;
  };
}

/** Public explorer fallback (e.g. https://testnet.beldex.dev/api) when no daemon is configured. */
export function createExplorerTxInspector(
  baseUrl: string,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): (txHash: string) => Promise<TxInspection | null> {
  const base = baseUrl.replace(/\/+$/, '');
  return async (txHash) => {
    if (!/^[0-9a-f]{64}$/i.test(txHash)) return null;
    const response = await fetchImpl(`${base}/transaction/${txHash}`, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return null;
    const body = (await response.json()) as { data?: Record<string, unknown>; status?: string };
    return body.data ? inspectionFromDecodedTx(body.data) : null;
  };
}
