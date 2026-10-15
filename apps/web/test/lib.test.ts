import { describe, expect, it } from 'vitest';
import { formatGrouped } from '@/lib/format';
import { decryptFromLink, encryptForLink, generateLinkKey, linkKeyFromHash } from '@/lib/crypto';
import { SAMPLE_PAYROLL_CSV, parsePayrollCsv } from '@/lib/csv';
import { RAILGUN_PROTOCOL_ROUND_TRIP_BPS, isUsdStable, zkPoolCostAtomic } from '@/lib/economics';

describe('payroll CSV', () => {
  it('parses the sample with stable row ids', () => {
    const { rows, errors } = parsePayrollCsv(SAMPLE_PAYROLL_CSV);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toEqual({ id: 'row-1', recipientInput: 'devteam.bdx', amount: '1250.00', token: 'bUSD', memo: 'OCT-2026 engineering' });
  });

  it('reports missing columns and invalid rows without dropping valid ones', () => {
    expect(parsePayrollCsv('name,amount\nx,1').errors[0]).toMatch(/Missing column/);
    const { rows, errors } = parsePayrollCsv('Recipient_BNS_or_Address,amount,token_id\njuan.bdx,-5,BDX\nmaria.bdx,10,BDX\n,3,BDX');
    expect(rows.map((r) => r.recipientInput)).toEqual(['maria.bdx']);
    expect(errors.join(' ')).toMatch(/Row 2: amount/);
    expect(errors.join(' ')).toMatch(/Row 4: recipient/);
  });

  it('caps the number of rows', () => {
    const big = ['recipient_bns_or_address,amount,token_id', ...Array.from({ length: 501 }, () => 'a.bdx,1,BDX')].join('\n');
    expect(parsePayrollCsv(big).errors[0]).toMatch(/At most 500/);
  });
});

describe('link encryption', () => {
  it('round-trips and rejects the wrong key or tampering', async () => {
    const key = await generateLinkKey();
    const cipher = await encryptForLink(key, 'INV-1 · retainer');
    expect(cipher).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    await expect(decryptFromLink(key, cipher)).resolves.toBe('INV-1 · retainer');
    await expect(decryptFromLink(await generateLinkKey(), cipher)).rejects.toBeDefined();
    const [iv, body] = cipher.split('.');
    const flipped = `${iv}.${body?.slice(0, -2)}${body?.endsWith('A') ? 'B' : 'A'}A`;
    await expect(decryptFromLink(key, flipped)).rejects.toBeDefined();
    await expect(decryptFromLink('short', cipher)).rejects.toThrow(/Invalid decryption key/);
    await expect(decryptFromLink(key, 'nodot')).rejects.toThrow(/Malformed/);
  });

  it('reads only well-formed keys from the fragment', async () => {
    const key = await generateLinkKey();
    expect(linkKeyFromHash(`#k=${key}`)).toBe(key);
    expect(linkKeyFromHash('#k=abc')).toBeNull();
    expect(linkKeyFromHash('')).toBeNull();
  });
});

describe('economics and formatting', () => {
  it('computes ZK-pool cost in basis points', () => {
    expect(zkPoolCostAtomic(1_000_000_000n, RAILGUN_PROTOCOL_ROUND_TRIP_BPS)).toBe(5_000_000n);
    expect(isUsdStable('bUSD')).toBe(true);
    expect(isUsdStable('bCLP')).toBe(false);
  });

  it('groups thousands without touching decimals', () => {
    expect(formatGrouped('1234567.891')).toBe('1,234,567.891');
    expect(formatGrouped('12')).toBe('12');
  });
});
