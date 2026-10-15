import { beforeAll, describe, expect, it } from 'vitest';
import { GET, POST } from '@/app/api/faucet/route';
import { db } from '@/server/db';
import { claimFaucet, hashClientIp } from '@/server/faucet';
import { mockRuntime } from '@/server/mockChain';
import { ensureBusd, jsonRequest } from './helpers';

let busd: string;

beforeAll(async () => {
  busd = await ensureBusd();
});

const fresh = (label: string) => mockRuntime().chain.createAccount(`faucet-test:${label}:${Math.random()}`);

describe('evaluator faucet (mock devnet)', () => {
  it('grants the fixed package of BDX and bUSD', async () => {
    const recipient = fresh('a');
    const result = await claimFaucet({ network: 'mock-devnet', recipient }, '198.51.100.1');
    expect(result.status).toBe('SENT');
    expect(result.grants.map((g) => [g.ticker, g.amount])).toEqual([
      ['BDX', '2'],
      ['bUSD', '250'],
    ]);
    const balances = mockRuntime().chain.getBalances(recipient);
    expect(balances.BDX?.total).toBe(2_000_000_000n);
    expect(balances[busd]?.total).toBe(250_000_000n);
  });

  it('allows one claim per address and per connection every 24 h, and resolves .bdx names', async () => {
    await claimFaucet({ network: 'mock-devnet', recipient: 'mateo.bdx' }, '198.51.100.2');
    await expect(claimFaucet({ network: 'mock-devnet', recipient: 'mateo.bdx' }, '198.51.100.3')).rejects.toThrow(/One faucet claim/);
    await expect(claimFaucet({ network: 'mock-devnet', recipient: fresh('b') }, '198.51.100.2')).rejects.toThrow(/One faucet claim/);
  });

  it('two simultaneous claims for one address never both succeed', async () => {
    const recipient = fresh('race');
    const results = await Promise.allSettled([
      claimFaucet({ network: 'mock-devnet', recipient }, '198.51.100.20'),
      claimFaucet({ network: 'mock-devnet', recipient }, '198.51.100.21'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBeLessThanOrEqual(1);
  });

  it('stores only an HMAC of the IP, never the IP itself', async () => {
    const ip = '203.0.113.77';
    await claimFaucet({ network: 'mock-devnet', recipient: fresh('c') }, ip);
    const dump = JSON.stringify(await db.faucetClaim.findMany());
    expect(dump).not.toContain(ip);
    expect(dump).toContain(hashClientIp(ip));
    expect(hashClientIp(ip)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashClientIp(ip)).not.toBe(hashClientIp('203.0.113.78'));
  });

  it('routes: config is public, claims validate input and never take amounts from the client', async () => {
    const config = (await (await GET(new Request('http://localhost:3000/api/faucet?network=mock-devnet'))).json()) as {
      data: { enabled: boolean; grants: Array<{ ticker: string }> };
    };
    expect(config.data.enabled).toBe(true);
    expect(config.data.grants.map((g) => g.ticker)).toEqual(['BDX', 'bUSD']);
    const tampered = await POST(jsonRequest('http://localhost:3000/api/faucet', { network: 'mock-devnet', recipient: fresh('d'), amount: '1000000' }, { 'x-forwarded-for': '192.0.2.50' }));
    expect(tampered.status).toBe(400);
    const okResponse = await POST(jsonRequest('http://localhost:3000/api/faucet', { network: 'mock-devnet', recipient: fresh('e') }, { 'x-forwarded-for': '192.0.2.51' }));
    expect(okResponse.status).toBe(201);
    const disabled = await POST(jsonRequest('http://localhost:3000/api/faucet', { network: 'testnet', recipient: fresh('f') }, { 'x-forwarded-for': '192.0.2.52' }));
    expect(disabled.status).toBe(404);
  });
});
