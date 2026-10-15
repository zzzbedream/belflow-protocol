import { beforeAll, describe, expect, it } from 'vitest';
import { POST as rpcPost } from '@/app/api/rpc/route';
import { POST as challengePost } from '@/app/api/auth/challenge/route';
import { GET as sessionGet, POST as sessionPost } from '@/app/api/auth/session/route';
import { POST as payPost } from '@/app/api/invoices/[id]/pay/route';
import { createInvoice, payInvoice } from '@/server/invoices';
import { MOCK_ACCOUNTS, mockRuntime } from '@/server/mockChain';
import { requireTreasury } from '@/server/auth';
import { ensureBusd, jsonRequest } from './helpers';

let busd: string;

beforeAll(async () => {
  busd = await ensureBusd();
});

async function customerPays(merchant: string, assetId: string, amountAtomic: bigint, flash = true) {
  const chain = mockRuntime().chain;
  const customer = chain.createAccount(MOCK_ACCOUNTS.customer.label);
  if (assetId !== 'BDX' && (chain.getBalances(customer)[assetId]?.unlocked ?? 0n) < amountAtomic) {
    const treasury = chain.createAccount(MOCK_ACCOUNTS.treasury.label);
    chain.mineBlocks(3);
    chain.transfer(treasury, [{ address: customer, assetId, amount: 1_000_000_000n }], { flash: false });
    chain.mineBlocks(3);
  }
  chain.mineBlocks(3);
  return chain.transfer(customer, [{ address: merchant, assetId, amount: amountAtomic }], { flash });
}

describe('invoices', () => {
  it('settles a flash bUSD payment from the mempool with full asset attribution', async () => {
    const invoice = await createInvoice({ network: 'mock-devnet', tokenId: busd, amount: '42.5' });
    const tx = await customerPays(invoice.merchantAddress, busd, 42_500_000n);
    const { invoice: paid, verification } = await payInvoice(invoice.id, { txHash: tx.txHash, txKey: tx.txKey });
    expect(verification).toMatchObject({ isValid: true, isFlash: true, assetVerificationLevel: 'CRYPTOGRAPHIC_FULL' });
    expect(paid.status).toBe('PAID');
    await expect(payInvoice(invoice.id, { txHash: tx.txHash, txKey: tx.txKey })).rejects.toThrow(/already settled/);

    const second = await createInvoice({ network: 'mock-devnet', tokenId: busd, amount: '42.5' });
    await expect(payInvoice(second.id, { txHash: tx.txHash, txKey: tx.txKey })).rejects.toThrow(/already paid another invoice/);
  });

  it('rejects asset confusion: BDX sent for a bUSD invoice', async () => {
    const invoice = await createInvoice({ network: 'mock-devnet', tokenId: busd, amount: '5' });
    const tx = await customerPays(invoice.merchantAddress, 'BDX', 5_000_000n, false);
    const { invoice: still, verification } = await payInvoice(invoice.id, { txHash: tx.txHash, txKey: tx.txKey });
    expect(verification.isValid).toBe(false);
    expect(verification.failures).toContain('ASSET_MISMATCH');
    expect(still.status).toBe('PENDING');
  });

  it('accepts receiver-side verification without a tx key and validates the route input', async () => {
    const invoice = await createInvoice({ network: 'mock-devnet', tokenId: 'BDX', amount: '3' });
    const tx = await customerPays(invoice.merchantAddress, 'BDX', 3_000_000_000n, false);
    const response = await payPost(jsonRequest(`http://localhost:3000/api/invoices/${invoice.id}/pay`, { txHash: tx.txHash }), {
      params: Promise.resolve({ id: invoice.id }),
    });
    const body = (await response.json()) as { data: { verification: { isValid: boolean; assetVerificationLevel: string } } };
    expect(body.data.verification).toMatchObject({ isValid: true, assetVerificationLevel: 'CRYPTOGRAPHIC_FULL' });

    const bad = await payPost(jsonRequest('http://localhost:3000/api/invoices/x/pay', { txHash: 'zz' }), { params: Promise.resolve({ id: '../etc' }) });
    expect(bad.status).toBe(400);
  });
});

describe('/api/rpc proxy', () => {
  const call = (network: string, body: unknown, headers?: Record<string, string>) =>
    rpcPost(jsonRequest(`http://localhost:3000/api/rpc?network=${network}`, body, headers));

  it('serves the mock bridge', async () => {
    const response = await call('mock-devnet', { jsonrpc: '2.0', id: 1, method: 'mock_getInfo' });
    expect(((await response.json()) as { result: { nettype: string } }).result.nettype).toBe('mock-devnet');
  });

  it('blocks non-allowlisted testnet methods and cross-origin or non-JSON requests', async () => {
    const transfer = await call('testnet', { method: 'transfer', params: {} });
    expect(transfer.status).toBe(403);
    const proto = await call('testnet', { method: '__proto__' });
    expect(proto.status).toBe(403);
    const notConfigured = await call('testnet', { method: 'get_info' });
    expect(notConfigured.status).toBe(503);
    const foreign = await call('mock-devnet', { method: 'mock_getInfo' }, { Origin: 'https://evil.example' });
    expect(foreign.status).toBe(403);
    const form = await rpcPost(
      new Request('http://localhost:3000/api/rpc?network=mock-devnet', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' }),
    );
    expect(form.status).toBe(415);
  });
});

describe('wallet-signature login', () => {
  it('logs in with a signed single-use challenge and rejects replays and bad signatures', async () => {
    const chain = mockRuntime().chain;
    const address = chain.createAccount(MOCK_ACCOUNTS.treasury.label);
    const challenge = await challengePost(jsonRequest('http://localhost:3000/api/auth/challenge', { network: 'mock-devnet', address }));
    const { data } = (await challenge.json()) as { data: { nonce: string; statement: string } };
    expect(data.statement).toMatch(/^belflow-auth-v1\|http:\/\/localhost:3000\|mock-devnet\|/);

    const badSig = await sessionPost(jsonRequest('http://localhost:3000/api/auth/session', { nonce: data.nonce, signature: 'MockSigV1deadbeef' }));
    expect(badSig.status).toBe(401);

    const challenge2 = await challengePost(jsonRequest('http://localhost:3000/api/auth/challenge', { network: 'mock-devnet', address }));
    const { data: data2 } = (await challenge2.json()) as { data: { nonce: string; statement: string } };
    const signature = chain.sign(address, data2.statement);
    const ok = await sessionPost(jsonRequest('http://localhost:3000/api/auth/session', { nonce: data2.nonce, signature }));
    expect(ok.status).toBe(200);
    const replay = await sessionPost(jsonRequest('http://localhost:3000/api/auth/session', { nonce: data2.nonce, signature }));
    expect(replay.status).toBe(401);

    const session = (await (await sessionGet()).json()) as { data: { session: { address: string } } };
    expect(session.data.session.address).toBe(address);
  });

  it('keeps testnet treasury actions behind the feature flag', async () => {
    await expect(requireTreasury('testnet')).rejects.toThrow(/disabled/);
    await expect(requireTreasury('mock-devnet')).resolves.toBeUndefined();
  });
});
