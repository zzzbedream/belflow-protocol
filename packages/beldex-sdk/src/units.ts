import { ValidationError } from './errors';

const DECIMAL_PATTERN = /^(\d+)(?:\.(\d+))?$/;
const MAX_DECIMALS = 18;
/** Every on-chain amount is a uint64. */
export const MAX_U64 = 2n ** 64n - 1n;

function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    throw new ValidationError(`Decimals must be an integer between 0 and ${MAX_DECIMALS}.`);
  }
}

/**
 * Converts a human readable amount ("1250.5") into atomic units.
 * Floats are never used: the string is split and padded.
 */
export function parseUnits(value: string, decimals: number): bigint {
  assertDecimals(decimals);
  const match = DECIMAL_PATTERN.exec(value.trim());
  if (!match) {
    throw new ValidationError(`"${value}" is not a valid non-negative decimal amount.`);
  }
  const whole = match[1] ?? '0';
  const fraction = match[2] ?? '';
  if (fraction.length > decimals) {
    throw new ValidationError(`"${value}" has more than ${decimals} decimal places.`);
  }
  const atomic = BigInt(whole + fraction.padEnd(decimals, '0'));
  if (atomic > MAX_U64) throw new ValidationError(`"${value}" exceeds the uint64 range of on-chain amounts.`);
  return atomic;
}

/**
 * Converts atomic units back into a display string.
 * Trailing zeros are trimmed down to `minFractionDigits`.
 */
export function formatUnits(atomic: bigint, decimals: number, minFractionDigits = 0): string {
  assertDecimals(decimals);
  const negative = atomic < 0n;
  const digits = (negative ? -atomic : atomic).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  let fraction = decimals > 0 ? digits.slice(digits.length - decimals) : '';
  while (fraction.length > minFractionDigits && fraction.endsWith('0')) {
    fraction = fraction.slice(0, -1);
  }
  const body = fraction.length > 0 ? `${whole}.${fraction}` : whole;
  return negative ? `-${body}` : body;
}

/** Returns true when the amount string parses to a strictly positive value. */
export function isPositiveAmount(value: string, decimals: number): boolean {
  try {
    return parseUnits(value, decimals) > 0n;
  } catch {
    return false;
  }
}
