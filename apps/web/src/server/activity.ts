import 'server-only';
import { db } from './db';
import type { AppNetwork } from './runtime';

export type ActivityKind = 'PAYROLL' | 'TOKEN_DEPLOY' | 'X402' | 'INVOICE' | 'BNS';

export interface ActivityEntry {
  network: AppNetwork;
  kind: ActivityKind;
  txHash: string;
  feeAtomic: string;
  burnedAtomic: string;
  tokenId?: string;
  volumeAtomic?: string;
}

/** Idempotent: the same (network, kind, txHash) is recorded once. */
export async function recordActivity(entry: ActivityEntry): Promise<void> {
  await db.chainActivity.upsert({
    where: { network_kind_txHash: { network: entry.network, kind: entry.kind, txHash: entry.txHash } },
    update: {},
    create: {
      network: entry.network,
      kind: entry.kind,
      txHash: entry.txHash,
      feeAtomic: entry.feeAtomic,
      burnedAtomic: entry.burnedAtomic,
      tokenId: entry.tokenId ?? null,
      volumeAtomic: entry.volumeAtomic ?? '0',
    },
  });
}

export interface ActivityTotals {
  burnedByKind: Record<ActivityKind, string>;
  feesByKind: Record<ActivityKind, string>;
  burnedTotalAtomic: string;
  feesTotalAtomic: string;
  txCount: number;
  volumeByToken: Record<string, string>;
}

const KINDS: ActivityKind[] = ['PAYROLL', 'TOKEN_DEPLOY', 'X402', 'INVOICE', 'BNS'];

export async function activityTotals(network: AppNetwork): Promise<ActivityTotals> {
  const rows = await db.chainActivity.findMany({ where: { network } });
  const zero = () => Object.fromEntries(KINDS.map((k) => [k, 0n])) as Record<ActivityKind, bigint>;
  const burned = zero();
  const fees = zero();
  const volume = new Map<string, bigint>();
  for (const row of rows) {
    const kind = row.kind as ActivityKind;
    burned[kind] += BigInt(row.burnedAtomic);
    fees[kind] += BigInt(row.feeAtomic);
    if (row.tokenId && row.volumeAtomic !== '0') volume.set(row.tokenId, (volume.get(row.tokenId) ?? 0n) + BigInt(row.volumeAtomic));
  }
  const toStrings = (record: Record<ActivityKind, bigint>) =>
    Object.fromEntries(Object.entries(record).map(([k, v]) => [k, v.toString()])) as Record<ActivityKind, string>;
  return {
    burnedByKind: toStrings(burned),
    feesByKind: toStrings(fees),
    burnedTotalAtomic: Object.values(burned).reduce((a, b) => a + b, 0n).toString(),
    feesTotalAtomic: Object.values(fees).reduce((a, b) => a + b, 0n).toString(),
    txCount: rows.length,
    volumeByToken: Object.fromEntries([...volume].map(([k, v]) => [k, v.toString()])),
  };
}
