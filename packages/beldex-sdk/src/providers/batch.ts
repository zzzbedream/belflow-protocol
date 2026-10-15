import { planBatches } from '../batching';
import { BDX_DECIMALS, RING_SIZE } from '../constants';
import { BelflowError } from '../errors';
import { formatUnits } from '../units';
import type { BatchPaymentRecipient, ConfidentialTxPart, ConfidentialTxResult, ProviderCapabilities } from '../types';

export type ChunkSender = (recipients: BatchPaymentRecipient[], useFlashTx: boolean) => Promise<ConfidentialTxPart[]>;

/**
 * Raised when a batch fails after some transactions were already broadcast.
 * `completed` lists them so the caller can record what was paid and never
 * resend those recipients.
 */
export class PartialBatchError extends BelflowError {
  constructor(
    readonly completed: ConfidentialTxPart[],
    override readonly cause: unknown,
  ) {
    super(
      `Batch stopped after ${completed.length} transaction(s): ${(cause as Error)?.message ?? 'unknown error'}`,
      'PARTIAL_BATCH',
    );
  }
}

export async function executeBatch(
  recipients: BatchPaymentRecipient[],
  useFlashTx: boolean,
  sendChunk: ChunkSender,
): Promise<ConfidentialTxPart[]> {
  const completed: ConfidentialTxPart[] = [];
  for (const chunk of planBatches(recipients)) {
    try {
      completed.push(...(await sendChunk(chunk.recipients, useFlashTx)));
    } catch (error) {
      if (completed.length === 0) throw error;
      throw new PartialBatchError(completed, error);
    }
  }
  return completed;
}

export function summarizeBatch(parts: ConfidentialTxPart[], recipientsCount: number, now = Date.now()): ConfidentialTxResult {
  const first = parts[0];
  const fee = parts.reduce((sum, part) => sum + BigInt(part.feeAtomic), 0n);
  const burned = parts.reduce((sum, part) => sum + BigInt(part.burnedAtomic), 0n);
  const heights = parts.map((part) => part.blockHeight).filter((h): h is number => typeof h === 'number');
  return {
    txHash: first?.txHash ?? '',
    txKey: first?.txKey ?? '',
    ...(heights.length > 0 ? { blockHeight: Math.max(...heights) } : {}),
    feeBurnedBdx: formatUnits(burned, BDX_DECIMALS),
    feeTotalBdx: formatUnits(fee, BDX_DECIMALS),
    ringSize: RING_SIZE,
    timestamp: now,
    recipientsCount,
    transactions: parts,
  };
}

export const FULL_CAPABILITIES: ProviderCapabilities = {
  batch: true,
  txKeys: true,
  assets: true,
  bns: true,
  signMessage: true,
  flash: true,
  verify: true,
};

/** @bdxi/web3js v1.0.x: single-destination BDX sends, BNS, message signing. */
export const EXTENSION_CAPABILITIES: ProviderCapabilities = {
  batch: false,
  txKeys: false,
  assets: false,
  bns: true,
  signMessage: true,
  flash: true,
  verify: false,
};
