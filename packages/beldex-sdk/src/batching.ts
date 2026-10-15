import { MAX_RECIPIENTS_PER_TX } from './constants';
import { ValidationError } from './errors';
import type { BatchPaymentRecipient } from './types';

export interface BatchChunk {
  /** Stable index used as part of idempotency bookkeeping. */
  index: number;
  tokenId: string;
  recipients: BatchPaymentRecipient[];
}

/**
 * Splits a payroll into transactions: one asset per transaction and at most
 * `maxPerTx` recipients (16 outputs minus one change output). Recipient order
 * is preserved inside each token group so chunk indexes are deterministic.
 */
export function planBatches(
  recipients: readonly BatchPaymentRecipient[],
  maxPerTx: number = MAX_RECIPIENTS_PER_TX,
): BatchChunk[] {
  if (!Number.isInteger(maxPerTx) || maxPerTx < 1 || maxPerTx > MAX_RECIPIENTS_PER_TX) {
    throw new ValidationError(`maxPerTx must be between 1 and ${MAX_RECIPIENTS_PER_TX}.`);
  }
  const seen = new Set<string>();
  for (const recipient of recipients) {
    if (seen.has(recipient.id)) throw new ValidationError(`Duplicate recipient id "${recipient.id}".`);
    if (!recipient.resolvedAddress) throw new ValidationError(`Recipient "${recipient.id}" has no resolved address.`);
    seen.add(recipient.id);
  }

  const groups = new Map<string, BatchPaymentRecipient[]>();
  for (const recipient of recipients) {
    groups.set(recipient.tokenId, [...(groups.get(recipient.tokenId) ?? []), recipient]);
  }

  const chunks: BatchChunk[] = [];
  for (const [tokenId, group] of groups) {
    for (let offset = 0; offset < group.length; offset += maxPerTx) {
      chunks.push({ index: chunks.length, tokenId, recipients: group.slice(offset, offset + maxPerTx) });
    }
  }
  return chunks;
}
