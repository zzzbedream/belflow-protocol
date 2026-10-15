import {
  DEFAULT_FEE_PER_KB_ATOMIC,
  DEFAULT_FEE_PER_OUTPUT_ATOMIC,
  FLASH_FEE_MULTIPLIER,
  TX_BASE_SIZE_BYTES,
  TX_SIZE_PER_INPUT_BYTES,
  TX_SIZE_PER_OUTPUT_BYTES,
} from './constants';
import { ValidationError } from './errors';
import type { FeeEstimate } from './rpc/daemon';
import { toBigIntAmount } from './rpc/json';

export interface FeeSchedule {
  perOutputAtomic: bigint;
  perKbAtomic: bigint;
  flashMultiplier: bigint;
}

export interface FeeBreakdown {
  totalAtomic: bigint;
  /** Paid to the block producer. */
  minerAtomic: bigint;
  /** Permanently removed from supply (flash surcharge). */
  burnedAtomic: bigint;
  estimatedSizeBytes: number;
}

export const DEFAULT_FEE_SCHEDULE: FeeSchedule = {
  perOutputAtomic: DEFAULT_FEE_PER_OUTPUT_ATOMIC,
  perKbAtomic: DEFAULT_FEE_PER_KB_ATOMIC,
  flashMultiplier: FLASH_FEE_MULTIPLIER,
};

const BYTES_PER_KB = 1024n;

export function estimateTxSizeBytes(outputs: number, inputs = 2): number {
  return TX_BASE_SIZE_BYTES + outputs * TX_SIZE_PER_OUTPUT_BYTES + inputs * TX_SIZE_PER_INPUT_BYTES;
}

/**
 * Preview of the fee for one transaction. `outputs` includes the change
 * output. Flash pays `flashMultiplier` times the base fee and the surcharge
 * above the base fee is burned.
 */
export function estimateTxFee(params: {
  outputs: number;
  inputs?: number;
  flash: boolean;
  schedule?: FeeSchedule;
}): FeeBreakdown {
  if (!Number.isInteger(params.outputs) || params.outputs < 1) {
    throw new ValidationError('A transaction needs at least one output.');
  }
  const schedule = params.schedule ?? DEFAULT_FEE_SCHEDULE;
  const sizeBytes = estimateTxSizeBytes(params.outputs, params.inputs);
  const sizeFee = (schedule.perKbAtomic * BigInt(sizeBytes) + BYTES_PER_KB - 1n) / BYTES_PER_KB;
  const base = schedule.perOutputAtomic * BigInt(params.outputs) + sizeFee;
  if (!params.flash) {
    return { totalAtomic: base, minerAtomic: base, burnedAtomic: 0n, estimatedSizeBytes: sizeBytes };
  }
  const total = base * schedule.flashMultiplier;
  return { totalAtomic: total, minerAtomic: base, burnedAtomic: total - base, estimatedSizeBytes: sizeBytes };
}

/** Sums the fee preview of several transactions (one per batch chunk). */
export function estimateBatchFees(chunkSizes: number[], flash: boolean, schedule?: FeeSchedule): FeeBreakdown {
  return chunkSizes.reduce<FeeBreakdown>(
    (acc, recipients) => {
      const fee = estimateTxFee({ outputs: recipients + 1, flash, ...(schedule ? { schedule } : {}) });
      return {
        totalAtomic: acc.totalAtomic + fee.totalAtomic,
        minerAtomic: acc.minerAtomic + fee.minerAtomic,
        burnedAtomic: acc.burnedAtomic + fee.burnedAtomic,
        estimatedSizeBytes: acc.estimatedSizeBytes + fee.estimatedSizeBytes,
      };
    },
    { totalAtomic: 0n, minerAtomic: 0n, burnedAtomic: 0n, estimatedSizeBytes: 0 },
  );
}

/** Builds a schedule from the daemon's get_fee_estimate, falling back to defaults. */
export function feeScheduleFromEstimate(estimate: FeeEstimate): FeeSchedule {
  const perOutput = toBigIntAmount(estimate.fee_per_output) || DEFAULT_FEE_PER_OUTPUT_ATOMIC;
  const perByte = toBigIntAmount(estimate.fee_per_byte);
  const perKb = perByte > 0n ? perByte * BYTES_PER_KB : DEFAULT_FEE_PER_KB_ATOMIC;
  const flashPerOutput = toBigIntAmount(estimate.flash_fee_per_output);
  const multiplier = flashPerOutput > 0n && perOutput > 0n ? flashPerOutput / perOutput || 1n : FLASH_FEE_MULTIPLIER;
  return { perOutputAtomic: perOutput, perKbAtomic: perKb, flashMultiplier: multiplier };
}
