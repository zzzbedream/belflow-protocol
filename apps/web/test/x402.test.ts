import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { GET as demoGet } from '@/app/api/x402/demo/route';
import { GET as metricsGet } from '@/app/api/x402/metrics/route';
import { PrismaNonceStore, runAgent, x402Metrics } from '@/server/x402';
import { mockRuntime } from '@/server/mockChain';
import { ensureBusd } from './helpers';

beforeAll(async () => {
  await ensureBusd();
  // Fund the agent with bUSD so it can pay the demo price.
  const chain = mockRuntime().chain;
  const busd = chain.listAssets().find((a) => a.ticker === 'bUSD')?.assetId as string;
  chain.mineBlocks(3);
  chain.transfer(chain.createAccount('treasury'), [{ address: chain.createAccount('alpha-bot'), assetId: busd, amount: 50_000_000n }], { flash: false });
  chain.mineBlocks(3);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PrismaNonceStore', () => {
  const challenge = (nonce: string, expiresAt: number) => ({
    nonce,
    network: 'mock-devnet',
    resourcePath: '/api/x402/demo',
    amountAtomic: '500000',
    tokenId: 'BDX',
    tokenTicker: 'BDX',
    recipientAddress: 'addr',
    expiresAt,
    consumed: false,
  });

  it('consumes atomically: once per nonce, once per tx, never after expiry', async () => {
    const store = new PrismaNonceStore();
    const now = Date.now();
    const [a, b, c] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    await store.create(challenge(a, now + 60_000));
    await store.create(challenge(b, now + 60_000));
    await store.create(challenge(c, now - 1));
    const tx = crypto.randomUUID().replace(/-/g, '').padEnd(64, '0');

    const results = await Promise.all([store.consume(a, tx, now, 'alpha-bot.bdx'), store.consume(a, tx, now)]);
    // Exactly one consume wins. The loser is refused by whichever claim it hits
    // first (the nonce or the tx hash); both refusals are correct.
    expect(results.filter((result) => result === 'ok')).toHaveLength(1);
    expect(['already-consumed', 'tx-reused']).toContain(results.find((result) => result !== 'ok'));
    expect(await store.consume(b, tx, now)).toBe('tx-reused');
    expect(await store.consume(c, 'f'.repeat(64), now)).toBe('expired');
    expect(await store.consume(crypto.randomUUID(), 'e'.repeat(64), now)).toBe('unknown');
    expect(await store.get(a)).toMatchObject({ consumed: true, consumedByTxHash: tx });
    expect(await store.get('missing')).toBeNull();
  });
});

describe('x402 demo resource and agent', () => {
  it('answers 402 with Beldex challenge headers', async () => {
    const response = await demoGet(new Request('http://localhost:3000/api/x402/demo?network=mock-devnet'));
    expect(response.status).toBe(402);
    expect(response.headers.get('X-Beldex-Recipient')).toBe('oracle-provider.bdx');
    expect(response.headers.get('X-Beldex-Token')).toBe('bUSD');
    expect(response.headers.get('X-Beldex-Amount')).toBe('0.5');
    expect(response.headers.get('X-Beldex-Payment-Nonce')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('runs alpha-bot.bdx end to end: 402, flash payment, 200 with the premium payload', async () => {
    vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => demoGet(new Request(input, init))) as typeof fetch);
    const result = await runAgent({ network: 'mock-devnet', calls: 2, maxPerCall: '1', budget: '2', useFlash: true }, 'http://localhost:3000');
    expect(result.agentBns).toBe('alpha-bot.bdx');
    expect(result.spent).toBe('1');
    expect(result.trace.filter((e) => e.type === 'paid')).toHaveLength(2);
    const last = result.responses.at(-1) as { resource: string; payment: { flash: boolean; settledFromMempool: boolean; assetVerificationLevel: string } };
    expect(last.resource).toBe('latam-fx-signal');
    expect(last.payment).toMatchObject({ flash: true, settledFromMempool: true, assetVerificationLevel: 'CRYPTOGRAPHIC_FULL' });

    const metrics = await x402Metrics('mock-devnet');
    expect(metrics.paidCalls).toBeGreaterThanOrEqual(2);
    expect(metrics.distinctAgents).toBe(1);
    const response = await metricsGet(new Request('http://localhost:3000/api/x402/metrics?network=mock-devnet'));
    expect(((await response.json()) as { data: { price: { token: string } } }).data.price.token).toBe('bUSD');
  });

  it('stops at the budget and records the refusal in the trace', async () => {
    vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => demoGet(new Request(input, init))) as typeof fetch);
    mockRuntime().chain.mineBlocks(3);
    const result = await runAgent({ network: 'mock-devnet', calls: 3, maxPerCall: '1', budget: '0.6', useFlash: true }, 'http://localhost:3000');
    expect(result.trace.filter((e) => e.type === 'paid')).toHaveLength(1);
    expect(result.trace.at(-1)).toMatchObject({ type: 'error' });
    expect(String(result.trace.at(-1)?.detail.message)).toMatch(/Budget/);
  });

  it('refuses a wrong-asset payment (BDX for a bUSD price) with asset_mismatch', async () => {
    vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => demoGet(new Request(input, init))) as typeof fetch);
    mockRuntime().chain.mineBlocks(3);
    const result = await runAgent({ network: 'mock-devnet', calls: 1, maxPerCall: '1', budget: '2', useFlash: true, attack: 'wrong-asset' }, 'http://localhost:3000');
    expect(result.trace.filter((e) => e.type === 'paid')).toHaveLength(1);
    expect(result.responses.at(-1)).toMatchObject({ error: 'asset_mismatch' });
    expect(result.trace.find((e) => e.type === 'response')?.detail.status).toBe(402);
  });
});
