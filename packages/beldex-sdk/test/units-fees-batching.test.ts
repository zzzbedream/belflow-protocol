import { describe, expect, it } from 'vitest';
import { planBatches } from '../src/batching';
import { MAX_RECIPIENTS_PER_TX } from '../src/constants';
import { estimateBatchFees, estimateTxFee, feeScheduleFromEstimate } from '../src/fees';
import { formatUnits, isPositiveAmount, parseUnits } from '../src/units';
import type { BatchPaymentRecipient } from '../src/types';

describe('units', () => {
  it('parses decimal strings into atomic units without floats', () => {
    expect(parseUnits('1.25', 9)).toBe(1_250_000_000n);
    expect(parseUnits('1250.00', 6)).toBe(1_250_000_000n);
    expect(parseUnits('0', 9)).toBe(0n);
    expect(parseUnits(' 7 ', 0)).toBe(7n);
  });

  it('rejects malformed amounts and excess precision', () => {
    expect(() => parseUnits('1.0000000001', 9)).toThrow(/decimal places/);
    expect(() => parseUnits('-1', 9)).toThrow(/valid/);
    expect(() => parseUnits('1e3', 9)).toThrow(/valid/);
    expect(() => parseUnits('1', 19)).toThrow(/Decimals/);
  });

  it('formats atomic units, trimming trailing zeros', () => {
    expect(formatUnits(1_250_000_000n, 9)).toBe('1.25');
    expect(formatUnits(1_000_000_000n, 9)).toBe('1');
    expect(formatUnits(5n, 9)).toBe('0.000000005');
    expect(formatUnits(1_200_000n, 6, 2)).toBe('1.20');
    expect(formatUnits(-1_500_000n, 6)).toBe('-1.5');
    expect(formatUnits(42n, 0)).toBe('42');
  });

  it('detects positive amounts', () => {
    expect(isPositiveAmount('0.1', 2)).toBe(true);
    expect(isPositiveAmount('0', 2)).toBe(false);
    expect(isPositiveAmount('abc', 2)).toBe(false);
  });
});

describe('fees', () => {
  it('charges flash a multiple of the base fee and burns the surcharge', () => {
    const normal = estimateTxFee({ outputs: 3, flash: false });
    const flash = estimateTxFee({ outputs: 3, flash: true });
    expect(normal.burnedAtomic).toBe(0n);
    expect(flash.totalAtomic).toBe(normal.totalAtomic * 5n);
    expect(flash.burnedAtomic).toBe(flash.totalAtomic - normal.totalAtomic);
    expect(flash.minerAtomic).toBe(normal.totalAtomic);
  });

  it('rejects transactions without outputs', () => {
    expect(() => estimateTxFee({ outputs: 0, flash: false })).toThrow(/output/);
  });

  it('sums chunk fees', () => {
    const total = estimateBatchFees([15, 5], true);
    const a = estimateTxFee({ outputs: 16, flash: true });
    const b = estimateTxFee({ outputs: 6, flash: true });
    expect(total.totalAtomic).toBe(a.totalAtomic + b.totalAtomic);
    expect(total.burnedAtomic).toBe(a.burnedAtomic + b.burnedAtomic);
  });

  it('derives a schedule from the daemon fee estimate', () => {
    const schedule = feeScheduleFromEstimate({ fee_per_output: 100, fee_per_byte: 2, flash_fee_per_output: 500 });
    expect(schedule).toEqual({ perOutputAtomic: 100n, perKbAtomic: 2048n, flashMultiplier: 5n });
    const fallback = feeScheduleFromEstimate({});
    expect(fallback.perOutputAtomic).toBe(10_000_000n);
    expect(fallback.flashMultiplier).toBe(5n);
  });
});

describe('planBatches', () => {
  const recipient = (id: number, tokenId = 'BDX'): BatchPaymentRecipient => ({
    id: `r${id}`,
    recipientInput: `user${id}.bdx`,
    resolvedAddress: `addr${id}`,
    amount: '1',
    tokenId,
  });

  it('groups by token and splits at the output limit', () => {
    const recipients = [
      ...Array.from({ length: 20 }, (_, i) => recipient(i)),
      recipient(100, 'busd'),
    ];
    const chunks = planBatches(recipients);
    expect(chunks.map((c) => [c.tokenId, c.recipients.length])).toEqual([
      ['BDX', MAX_RECIPIENTS_PER_TX],
      ['BDX', 5],
      ['busd', 1],
    ]);
    expect(chunks.map((c) => c.index)).toEqual([0, 1, 2]);
  });

  it('validates ids, addresses and the chunk size', () => {
    expect(() => planBatches([recipient(1), recipient(1)])).toThrow(/Duplicate/);
    expect(() => planBatches([{ ...recipient(1), resolvedAddress: '' }])).toThrow(/resolved address/);
    expect(() => planBatches([recipient(1)], 16)).toThrow(/maxPerTx/);
  });
});
