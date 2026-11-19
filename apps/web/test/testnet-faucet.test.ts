import { encodeAddress } from '@belflow/sdk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Testnet faucet against a fake wallet-rpc whose faucet account is in its
// 2-block unlock window, then unlocked.
process.env.BELDEX_WALLET_RPC_URL = 'http://wallet.test:19092/json_rpc';
process.env.BELFLOW_FAUCET_ENABLED = 'true';
process.env.BELFLOW_FAUCET_ACCOUNT_INDEX = '3';
process.env.BELFLOW_TRUSTED_IP_HEADER = 'x-real-ip';

const TREASURY = encodeAddress({ network: 'testnet', kind: 'standard', spendPublicKey: '01'.repeat(32), viewPublicKey: '02'.repeat(32) });
const EVALUATOR = encodeAddress({ network: 'testnet', kind: 'standard', spendPublicKey: '03'.repeat(32), viewPublicKey: '04'.repeat(32) });
let unlocked = 0;
const calls: Array<{ method: string; params: Record<string, unknown> }> = [];

beforeAll(() => {
  vi.stubGlobal('fetch', (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: string; method: string; params: Record<string, unknown> };
    calls.push({ method: body.method, params: body.params });
    const results: Record<string, unknown> = {
      get_address: { address: TREASURY },
      get_height: { height: 4_300_000 },
      get_balance: { balance: 50_000_000_000, unlocked_balance: unlocked, token_balances: [] },
      transfer: { tx_hash: 'a'.repeat(64), tx_key: 'b'.repeat(64), fee: 1000 },
      store: {},
    };
    return Response.json({ jsonrpc: '2.0', id: body.id, result: results[body.method] ?? {} });
  }) as typeof fetch);
});

afterAll(() => vi.unstubAllGlobals());

describe('testnet faucet', () => {
  it('answers 503 + Retry-After while faucet UTXOs are locked and records no claim', async () => {
    const { POST } = await import('@/app/api/faucet/route');
    const { db } = await import('@/server/db');
    const before = await db.faucetClaim.count();
    unlocked = 0;
    const response = await POST(
      new Request('http://localhost:3000/api/faucet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-real-ip': '192.0.2.99' },
        body: JSON.stringify({ network: 'testnet', recipient: EVALUATOR }),
      }),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('120');
    expect(await db.faucetClaim.count()).toBe(before);
  });

  it('sends from the dedicated faucet account once funds unlock', async () => {
    const { claimFaucet } = await import('@/server/faucet');
    unlocked = 50_000_000_000;
    const result = await claimFaucet({ network: 'testnet', recipient: EVALUATOR }, '192.0.2.100');
    expect(result).toMatchObject({ status: 'SENT', recipient: EVALUATOR });
    const transfer = calls.find((call) => call.method === 'transfer');
    expect(transfer?.params.account_index).toBe(3);
    expect(calls.some((call) => call.method === 'store')).toBe(true);
  });
});
