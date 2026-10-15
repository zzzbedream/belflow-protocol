import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseJsonSafe, stringifyJsonSafe, toBigIntAmount } from '../../src/rpc/json';
import { MAX_U64, formatUnits, parseUnits } from '../../src/units';

// AUD-01: mixed-precision arithmetic fuzzing. BDX has 9 decimals, Privacy
// Tokens can use 0-18; any truncation or overflow would corrupt payroll
// amounts or fees. Every property runs ≥ 1,000 random cases.

const RUNS = { numRuns: 1_000 };
const DECIMALS = [0, 2, 6, 8, 9, 12, 18] as const;
const u64 = fc.bigInt({ min: 0n, max: MAX_U64 });

describe('AUD-01 arithmetic and unit fuzzing', () => {
  it('formatUnits → parseUnits round-trips every uint64 at every supported precision', () => {
    fc.assert(
      fc.property(u64, fc.constantFrom(...DECIMALS), (atomic, decimals) => {
        const text = formatUnits(atomic, decimals);
        expect(text).not.toMatch(/e/i);
        expect(parseUnits(text, decimals)).toBe(atomic);
      }),
      RUNS,
    );
  });

  it('parseUnits → formatUnits is lossless for any valid decimal string', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...DECIMALS).chain((decimals) =>
          fc.tuple(
            fc.constant(decimals),
            // Strictly below the u64 boundary once any fraction is appended.
            fc.bigInt({ min: 0n, max: MAX_U64 / 10n ** BigInt(decimals) - 1n }),
            fc.string({ unit: fc.constantFrom(...'0123456789'), minLength: 0, maxLength: decimals }),
          ),
        ),
        ([decimals, whole, fraction]) => {
          const input = fraction ? `${whole}.${fraction}` : `${whole}`;
          const atomic = parseUnits(input, decimals);
          expect(parseUnits(formatUnits(atomic, decimals), decimals)).toBe(atomic);
        },
      ),
      RUNS,
    );
  });

  it('rejects floats beyond precision, scientific notation, negatives, NaN, Infinity and > u64', () => {
    const malformed = fc.oneof(
      fc.double({ noNaN: false }).map((value) => String(value)).filter((text) => /e|N|I|-/.test(text)),
      fc.integer({ min: 1, max: 10 ** 9 }).map((value) => `-${value}`),
      fc.integer({ min: 1, max: 99 }).map((value) => `${value}e${value % 9}`),
      fc.constantFrom('', ' ', '.', '1.', '.5', '1,5', '0x10', '1_000', '١٢٣', '+1', 'NaN', 'Infinity'),
    );
    fc.assert(
      fc.property(malformed, fc.constantFrom(...DECIMALS), (text, decimals) => {
        expect(() => parseUnits(text, decimals)).toThrow();
      }),
      RUNS,
    );
    fc.assert(
      fc.property(fc.bigInt({ min: MAX_U64 + 1n, max: MAX_U64 * 1000n }), (tooBig) => {
        expect(() => parseUnits(tooBig.toString(), 0)).toThrow(/uint64/);
        expect(() => toBigIntAmount(tooBig.toString())).toThrow(/uint64/);
      }),
      RUNS,
    );
  });

  it('rejects excess precision instead of silently truncating', () => {
    fc.assert(
      fc.property(fc.constantFrom(...DECIMALS.filter((d) => d < 18)), fc.integer({ min: 1, max: 9 }), (decimals, digit) => {
        const tooPrecise = `0.${'0'.repeat(decimals)}${digit}`;
        expect(() => parseUnits(tooPrecise, decimals)).toThrow(/decimal places/);
      }),
      RUNS,
    );
  });

  it('toBigIntAmount accepts only safe non-negative integers within uint64', () => {
    fc.assert(
      fc.property(fc.oneof(fc.double(), fc.integer({ min: -(2 ** 31), max: -1 })), (value) => {
        if (Number.isSafeInteger(value) && value >= 0) expect(toBigIntAmount(value)).toBe(BigInt(value));
        else expect(() => toBigIntAmount(value)).toThrow(RangeError);
      }),
      RUNS,
    );
    expect(toBigIntAmount(MAX_U64.toString())).toBe(MAX_U64);
  });

  it('uint64 amounts survive JSON round trips, including inside embedded JSON strings', () => {
    fc.assert(
      fc.property(u64, u64, (amount, nested) => {
        const wire = stringifyJsonSafe({ amount, as_json: JSON.stringify({ amount: Number(nested % 1000n) }), note: `${nested}` });
        const parsed = parseJsonSafe<{ amount: string | number; as_json: string; note: string }>(wire);
        expect(BigInt(parsed.amount)).toBe(amount);
        expect(JSON.parse(parsed.as_json).amount).toBe(Number(nested % 1000n));
        expect(parsed.note).toBe(`${nested}`);
      }),
      RUNS,
    );
  });
});
