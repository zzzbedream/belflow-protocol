import type { DaemonRpc } from '../rpc/daemon';
import type { TxInspection } from './verifier';

// Reads pool, flash and height status out of a decoded transaction. It never
// attributes a token: on feature-privacy-token, tx_out_zyphora outputs carry
// only a blinded token id (T = token_id + r*X), so a daemon or explorer cannot
// say which token an output pays. Token identity comes from the tx_key
// (check_tx_key token_received, or the zyphora decode) or the receiving wallet.

/** Builds an inspection from a daemon get_transactions entry or an explorer tx object. */
export function inspectionFromDecodedTx(entry: Record<string, unknown>): TxInspection {
  const blockHeight = typeof entry.block_height === 'number' && entry.block_height > 0 ? entry.block_height : null;
  const inPool = typeof entry.in_pool === 'boolean' ? entry.in_pool : blockHeight === null;
  return {
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
