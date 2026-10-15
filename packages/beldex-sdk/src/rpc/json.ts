// Beldex RPC encodes uint64 amounts as bare JSON numbers. JavaScript numbers
// lose precision above 2^53, so large integers are kept as strings on the way
// in and bigint values are written as bare numbers on the way out.

const BIGINT_MARKER = '__belflow_bigint__';
const LARGE_INTEGER = /([:[,]\s*)(-?\d{16,})(?=\s*[,\]}])/g;

export function parseJsonSafe<T>(text: string): T {
  return JSON.parse(text.replace(LARGE_INTEGER, '$1"$2"')) as T;
}

export function stringifyJsonSafe(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? `${BIGINT_MARKER}${item.toString()}` : item,
  ).replace(new RegExp(`"${BIGINT_MARKER}(-?\\d+)"`, 'g'), '$1');
}

/** Normalizes an RPC amount (number or numeric string) into bigint atomic units. */
export function toBigIntAmount(value: number | string | bigint | undefined | null): bigint {
  if (value === undefined || value === null) return 0n;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new RangeError(`Unsafe integer amount: ${value}`);
    return BigInt(value);
  }
  if (!/^-?\d+$/.test(value)) throw new RangeError(`Not an integer amount: ${value}`);
  return BigInt(value);
}
