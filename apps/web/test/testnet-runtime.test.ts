import { encodeAddress } from '@belflow/sdk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Configure a fake testnet sidecar before any server module reads the env.
const OPERATOR = encodeAddress({ network: 'testnet', kind: 'standard', spendPublicKey: '12'.repeat(32), viewPublicKey: '34'.repeat(32) });
const TREASURY = encodeAddress({ network: 'testnet', kind: 'standard', spendPublicKey: '56'.repeat(32), viewPublicKey: '78'.repeat(32) });
process.env.BELDEX_WALLET_RPC_URL = 'http://wallet.test:19092/json_rpc';
process.env.BELFLOW_TREASURY_ENABLED = 'true';
process.env.TREASURY_OPERATOR_ADDRESS = OPERATOR;
process.env.BELDEX_EXPLORER_API_URL = 'https://explorer.test/api';

const walletCalls: string[] = [];

function fakeNetwork(input: RequestInfo | URL, init?: RequestInit): Response {
  const url = String(input);
  if (url.startsWith('https://explorer.test/api/networkinfo')) {
    return Response.json({ data: { height: 4_283_500, nettype: 'testnet', current_hf_version: 22 }, status: 'OK' });
  }
  if (url.startsWith('http://wallet.test')) {
    const body = JSON.parse(String(init?.body)) as { id: string; method: string; params: Record<string, unknown> };
    walletCalls.push(body.method);
    const results: Record<string, unknown> = {
      get_address: { address: TREASURY },
      get_balance: { balance: 12_500_000_000, unlocked_balance: 12_500_000_000, asset_balances: [] },
      get_height: { height: 4_283_500 },
      verify: { good: body.params.signature === 'SigV1-good' },
    };
    const result = results[body.method];
    return Response.json(result ? { jsonrpc: '2.0', id: body.id, result } : { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'nope' } });
  }
  return new Response('not found', { status: 404 });
}

beforeAll(() => {
  vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => fakeNetwork(input, init)) as typeof fetch);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('testnet runtime with a wallet-rpc sidecar', () => {
  it('builds the overview from the sidecar and the public explorer', async () => {
    const { GET } = await import('@/app/api/overview/route');
    const response = await GET(new Request('http://localhost:3000/api/overview?network=testnet'));
    const { data } = (await response.json()) as {
      data: { testnetConfigured: boolean; explorer: { height: number }; treasury: { address: string; balances: Array<{ ticker: string; amount: string }> }; capabilityMatrix: Array<{ kind: string; active: boolean }> };
    };
    expect(data.testnetConfigured).toBe(true);
    expect(data.explorer.height).toBe(4_283_500);
    expect(data.treasury.address).toBe(TREASURY);
    expect(data.treasury.balances.find((b) => b.ticker === 'BDX')?.amount).toBe('12.5');
    expect(data.capabilityMatrix.find((row) => row.kind === 'wallet-rpc-sidecar')?.active).toBe(true);
    expect(walletCalls).toContain('get_balance');
  });

  it('requires an operator login for treasury actions and rejects other wallets', async () => {
    const { requireTreasury, issueChallenge, completeLogin, readSession, logout } = await import('@/server/auth');
    await expect(requireTreasury('testnet')).rejects.toThrow(/Sign in/);

    const other = encodeAddress({ network: 'testnet', kind: 'standard', spendPublicKey: '9a'.repeat(32), viewPublicKey: 'bc'.repeat(32) });
    const outsider = await issueChallenge('testnet', other);
    await completeLogin(outsider.nonce, 'SigV1-good');
    await expect(requireTreasury('testnet')).rejects.toThrow(/not the treasury operator/);

    const operator = await issueChallenge('testnet', OPERATOR);
    await expect(completeLogin(operator.nonce, 'SigV1-bad')).rejects.toThrow(/Signature/);
    const retry = await issueChallenge('testnet', OPERATOR);
    await completeLogin(retry.nonce, 'SigV1-good');
    await expect(requireTreasury('testnet')).resolves.toBeUndefined();
    expect(await readSession()).toEqual({ address: OPERATOR, network: 'testnet' });
    await logout();
    expect(await readSession()).toBeNull();
    await expect(completeLogin('0'.repeat(32), 'SigV1-good')).rejects.toThrow(/Unknown/);
  });

  it('keeps the read-only proxy closed to spending methods even when configured', async () => {
    const { POST } = await import('@/app/api/rpc/route');
    const call = (method: string) =>
      POST(new Request('http://localhost:3000/api/rpc?network=testnet', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params: {} }) }));
    expect((await call('transfer')).status).toBe(403);
    expect((await call('get_tx_key')).status).toBe(403);
    expect((await call('sign')).status).toBe(403);
    const check = await call('check_tx_key');
    expect(check.status).toBe(502);
  });
});
