// Beldex RPC encodes uint64 amounts as bare JSON numbers. JavaScript numbers
// lose precision above 2^53, so large integer tokens are quoted before
// parsing. A small scanner skips string literals so JSON embedded inside
// strings (e.g. get_transactions "as_json") is never altered.

const BIGINT_MARKER = '__belflow_bigint__';
const SAFE_DIGITS = 15;

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= '0' && char <= '9';
}

/** Quotes integer literals longer than 15 digits that appear outside strings. */
export function quoteLargeIntegers(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const char = text[i] as string;
    if (char === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (char === '-' || isDigit(char)) {
      let j = i + 1;
      while (j < text.length && /[0-9.eE+-]/.test(text[j] as string)) j += 1;
      const token = text.slice(i, j);
      const digits = token.replace('-', '');
      out += /^-?\d+$/.test(token) && digits.length > SAFE_DIGITS ? `"${token}"` : token;
      i = j;
      continue;
    }
    out += char;
    i += 1;
  }
  return out;
}

export function parseJsonSafe<T>(text: string): T {
  return JSON.parse(quoteLargeIntegers(text)) as T;
}

export function stringifyJsonSafe(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? `${BIGINT_MARKER}${item.toString()}` : item,
  ).replace(new RegExp(`"${BIGINT_MARKER}(-?\\d+)"`, 'g'), '$1');
}

const UINT64_MAX = 2n ** 64n - 1n;

/** Normalizes an RPC amount (number or numeric string) into a uint64 bigint. */
export function toBigIntAmount(value: number | string | bigint | undefined | null): bigint {
  if (value === undefined || value === null) return 0n;
  let result: bigint;
  if (typeof value === 'bigint') result = value;
  else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new RangeError(`Unsafe integer amount: ${value}`);
    result = BigInt(value);
  } else {
    if (!/^\d+$/.test(value)) throw new RangeError(`Not a non-negative integer amount: ${value}`);
    result = BigInt(value);
  }
  if (result < 0n || result > UINT64_MAX) throw new RangeError(`Amount outside uint64: ${result}`);
  return result;
}
