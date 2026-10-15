// Matching an uncertain payroll chunk against what the wallet actually sent.
// CryptoNote chains never publish destination addresses, so the only source
// is the sending wallet's own cache (get_transfers "out"/"pending"/"pool").

export interface OutgoingTransfer {
  txHash: string;
  /** null while in the mempool / pending. */
  height: number | null;
  /** Unix seconds, when the wallet reports it. */
  timestamp: number | null;
  destinations: Array<{ address: string; amountAtomic: bigint; assetId?: string }>;
}

export interface ExpectedOutput {
  address: string;
  amountAtomic: bigint;
  assetId: string;
}

export interface OutgoingFilter {
  /** Only transfers mined at/after this height (mempool/pending always qualify). */
  sinceHeight?: number;
  /** Only transfers at/after this Unix time in seconds (when the wallet reports time). */
  sinceTimestamp?: number;
  /** Tx hashes already attributed elsewhere (another job or chunk). */
  excludeTxHashes?: ReadonlySet<string>;
}

export interface OutgoingMatch {
  /** Every expected output was found. */
  complete: boolean;
  /** Transactions covering the matched outputs (several when the wallet split). */
  txHashes: string[];
  matchedOutputs: number;
}

const normalizeAsset = (assetId: string | undefined): string =>
  !assetId || assetId.toUpperCase() === 'BDX' ? 'BDX' : assetId.toLowerCase();

function eligible(transfer: OutgoingTransfer, filter: OutgoingFilter): boolean {
  if (filter.excludeTxHashes?.has(transfer.txHash.toLowerCase())) return false;
  if (filter.sinceHeight !== undefined && transfer.height !== null && transfer.height < filter.sinceHeight) return false;
  if (filter.sinceTimestamp !== undefined && transfer.timestamp !== null && transfer.timestamp < filter.sinceTimestamp) return false;
  return true;
}

/**
 * Assigns each expected output to one destination of one eligible transfer
 * (each destination used once, earliest transfers first). A chunk counts as
 * sent only when every output is found.
 */
export function matchOutgoing(
  candidates: readonly OutgoingTransfer[],
  expected: readonly ExpectedOutput[],
  filter: OutgoingFilter = {},
): OutgoingMatch {
  const pool = candidates
    .filter((transfer) => eligible(transfer, filter))
    .sort((a, b) => (a.height ?? Number.MAX_SAFE_INTEGER) - (b.height ?? Number.MAX_SAFE_INTEGER))
    .map((transfer) => ({ transfer, used: transfer.destinations.map(() => false) }));

  const txHashes = new Set<string>();
  let matched = 0;
  for (const output of expected) {
    const asset = normalizeAsset(output.assetId);
    for (const entry of pool) {
      const index = entry.transfer.destinations.findIndex(
        (destination, i) =>
          !entry.used[i] &&
          destination.address === output.address &&
          destination.amountAtomic === output.amountAtomic &&
          (destination.assetId === undefined || normalizeAsset(destination.assetId) === asset),
      );
      if (index >= 0) {
        entry.used[index] = true;
        txHashes.add(entry.transfer.txHash.toLowerCase());
        matched += 1;
        break;
      }
    }
  }
  return { complete: matched === expected.length && expected.length > 0, txHashes: [...txHashes], matchedOutputs: matched };
}
