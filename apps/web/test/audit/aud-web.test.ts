import { OutcomeUnknownError } from '@belflow/sdk';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { POST as auditPost } from '@/app/api/audit/route';
import { GET as demoGet } from '@/app/api/x402/demo/route';
import nextConfig from '../../next.config';
import { createProof } from '@/server/audit';
import { db } from '@/server/db';
import { toErrorResponse } from '@/server/http';
import { createInvoice, payInvoice } from '@/server/invoices';
import { mockRuntime } from '@/server/mockChain';
import { reconcilePayrollJob, runPayroll } from '@/server/payroll';
import { getRuntime } from '@/server/runtime';
import { deployToken } from '@/server/tokens';
import { ensureBusd, employeeRecipients, jsonRequest, uuid } from '../helpers';

let busd: string;
let baudit: string;

beforeAll(async () => {
  busd = await ensureBusd();
  const existing = mockRuntime().chain.listAssets().find((asset) => asset.ticker === 'bAUDIT');
  baudit = existing?.assetId ?? (await deployToken('mock-devnet', { ticker: 'bAUDIT', name: 'BelFlow Adversarial Test Token', decimals: 6, totalSupply: '500000' })).tokenId;
  mockRuntime().chain.mineBlocks(3);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The attacker (customer) pays the merchant subaddress in some asset. */
function attackerPays(address: string, assetId: string, amountAtomic: bigint) {
  const chain = mockRuntime().chain;
  const treasury = chain.createAccount('treasury');
  const attacker = chain.createAccount('customer');
  chain.mineBlocks(3);
  if (assetId !== 'BDX') chain.transfer(treasury, [{ address: attacker, assetId, amount: amountAtomic * 2n }], { flash: false });
  chain.mineBlocks(3);
  return chain.transfer(attacker, [{ address, assetId, amount: amountAtomic }], { flash: false });
}

describe('AUD-02 (web): asset confusion on invoices and audit proofs', () => {
  it('a bAUDIT payment never settles a bUSD invoice and is reported as ASSET_MISMATCH', async () => {
    const invoice = await createInvoice({ network: 'mock-devnet', tokenId: busd, amount: '100' });
    const tx = attackerPays(invoice.merchantAddress, baudit, 100_000_000n);
    const { invoice: after, verification } = await payInvoice(invoice.id, { txHash: tx.txHash, txKey: tx.txKey });
    expect(after.status).toBe('PENDING');
    expect(verification.failures).toContain('ASSET_MISMATCH');
  });

  it('/api/audit refuses to issue a bUSD proof for a bAUDIT payment with a typed 422', async () => {
    const recipient = mockRuntime().chain.createAccount('employee:juan');
    const run = await runPayroll({
      network: 'mock-devnet',
      idempotencyKey: uuid(),
      useFlash: false,
      recipients: [{ id: 'x', recipientInput: 'juan.bdx', resolvedAddress: recipient, amount: '100', tokenId: baudit }],
    });
    const part = run.sent[0]!;
    const response = await auditPost(
      jsonRequest('http://localhost:3000/api/audit', {
        network: 'mock-devnet',
        txHash: part.txHash,
        txKey: part.txKey,
        txKeyEncrypted: 'AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
        recipientAddress: recipient,
        tokenId: busd,
        amount: '100',
      }),
    );
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('ASSET_MISMATCH');
    await expect(
      createProof({ network: 'mock-devnet', txHash: part.txHash, txKey: part.txKey, txKeyEncrypted: 'AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', recipientAddress: recipient, tokenId: baudit, amount: '100' }),
    ).resolves.toMatchObject({ assetVerificationLevel: 'CRYPTOGRAPHIC_FULL' });
  });
});

describe('AUD-03 (web): concurrency against SQLite', () => {
  it('20 identical payroll requests at once pay each recipient exactly once', async () => {
    const request = { network: 'mock-devnet' as const, idempotencyKey: uuid(), useFlash: false, recipients: employeeRecipients(3, 'BDX', '0.25') };
    const results = await Promise.all(Array.from({ length: 20 }, () => runPayroll(request)));
    const sentTxs = results.flatMap((r) => r.sent.map((p) => p.txHash));
    expect(new Set(sentTxs).size).toBe(sentTxs.length);
    expect(sentTxs).toHaveLength(1);
    const job = await db.payrollBatchJob.findUniqueOrThrow({ where: { idempotencyKey: request.idempotencyKey } });
    expect(await db.payrollTxRecord.count({ where: { jobId: job.id } })).toBe(1);
  });

  it('20 concurrent x402 retries with one proof unlock exactly one response', async () => {
    const first = await demoGet(new Request('http://localhost:3000/api/x402/demo?network=mock-devnet'));
    const nonce = first.headers.get('X-Beldex-Payment-Nonce') as string;
    const runtime = await getRuntime('mock-devnet');
    const chain = mockRuntime().chain;
    chain.mineBlocks(3);
    const oracle = first.headers.get('X-Beldex-Recipient-Address') as string;
    const agent = chain.createAccount('alpha-bot');
    chain.transfer(chain.createAccount('treasury'), [{ address: agent, assetId: busd, amount: 5_000_000n }], { flash: false });
    chain.mineBlocks(3);
    const pay = chain.transfer(agent, [{ address: oracle, assetId: busd, amount: 500_000n }], { flash: true });
    expect(runtime.network).toBe('mock-devnet');
    const headers = { 'X-Beldex-Payment-Proof': `${pay.txHash}:${pay.txKey}:alpha-bot.bdx`, 'X-Beldex-Payment-Nonce': nonce };
    const statuses = (
      await Promise.all(Array.from({ length: 20 }, () => demoGet(new Request('http://localhost:3000/api/x402/demo?network=mock-devnet', { headers }))))
    ).map((r) => r.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 200 || s === 402 || s === 409)).toHaveLength(20);
  });
});

describe('AUD-04 (web): broadcast + timeout mid-payroll, then reconcile', () => {
  it('never resends the uncertain chunk and reconciles it from wallet history', async () => {
    const runtime = await getRuntime('mock-devnet');
    const real = runtime.treasury.sendBatchChunk.bind(runtime.treasury);
    let broadcasts = 0;
    // 30 recipients = 2 chunks. Chunk 2 is broadcast, then the response is lost.
    vi.spyOn(runtime.treasury, 'sendBatchChunk').mockImplementation(async (recipients, flash) => {
      const parts = await real(recipients, flash);
      broadcasts += 1;
      if (broadcasts === 2) throw new OutcomeUnknownError('transfer');
      return parts;
    });
    const request = { network: 'mock-devnet' as const, idempotencyKey: uuid(), useFlash: false, recipients: employeeRecipients(30, 'BDX', '0.01') };
    const first = await runPayroll(request);
    expect(first.job.status).toBe('FAILED');
    expect(first.job.chunks.map((c) => c.status)).toEqual(['SENT', 'UNKNOWN']);

    const resumed = await runPayroll(request);
    expect(resumed.sent).toEqual([]);
    expect(broadcasts).toBe(2);

    const reconciled = await reconcilePayrollJob(request);
    expect(reconciled.job.chunks.map((c) => c.status)).toEqual(['SENT', 'SENT']);
    expect(reconciled.job.status).toBe('CONFIRMED');
    expect(reconciled.events.join(' ')).toMatch(/found in wallet history/);
    expect(broadcasts).toBe(2);
  });

  it('does not attribute an older identical payroll to an uncertain chunk', async () => {
    const recipients = employeeRecipients(2, 'BDX', '0.02');
    await runPayroll({ network: 'mock-devnet', idempotencyKey: uuid(), useFlash: false, recipients });
    mockRuntime().chain.mineBlocks(3);
    const runtime = await getRuntime('mock-devnet');
    // Same salaries again, but this time the send never reaches the wallet.
    vi.spyOn(runtime.treasury, 'sendBatchChunk').mockRejectedValue(new OutcomeUnknownError('transfer'));
    const request = { network: 'mock-devnet' as const, idempotencyKey: uuid(), useFlash: false, recipients };
    await runPayroll(request);
    const reconciled = await reconcilePayrollJob(request);
    expect(reconciled.job.chunks[0]?.status).toBe('UNKNOWN');
    expect(reconciled.events.join(' ')).toMatch(/not found yet/);
    mockRuntime().chain.mineBlocks(12);
    const later = await reconcilePayrollJob(request);
    expect(later.job.chunks[0]?.status).toBe('PENDING');
  });
});

describe('AUD-05 (web): zero leakage', () => {
  it('never leaks stack traces, filesystem paths or RPC credentials in error responses', async () => {
    const secretPath = 'C:/srv/belflow/assets/7c1f.json';
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const error of [new Error(`ENOENT ${secretPath}`), Object.assign(new Error('auth failed for belflow:hunter2@127.0.0.1:29092'), { stack: 'at secret (/app/x.ts)' })]) {
      const body = JSON.stringify(await toErrorResponse(error).json());
      expect(body).not.toContain(secretPath);
      expect(body).not.toContain('hunter2');
      expect(body).not.toContain('at secret');
    }
    spy.mockRestore();
  });

  it('API responses are no-store and proof/checkout pages are no-store + no-referrer', async () => {
    const api = await demoGet(new Request('http://localhost:3000/api/x402/demo?network=mock-devnet'));
    expect(api.headers.get('Cache-Control')).toMatch(/no-store/);
    const rules = await nextConfig.headers!();
    const headerFor = (source: string, key: string) =>
      rules.filter((rule) => rule.source === source || rule.source === '/:path*').flatMap((rule) => rule.headers).find((h) => h.key === key)?.value;
    for (const source of ['/verify/:path*', '/pay/:path*']) {
      expect(headerFor(source, 'Cache-Control')).toMatch(/no-store/);
      expect(headerFor(source, 'Referrer-Policy')).toBe('no-referrer');
    }
  });

  it('the database never stores a plaintext tx key', async () => {
    const records = await db.selectiveAuditRecord.findMany();
    const jobs = await db.payrollBatchJob.findMany();
    const dump = JSON.stringify({ records, jobs });
    const keys = mockRuntime().chain.snapshot().txs;
    for (const tx of Object.values(keys).slice(0, 50)) expect(dump).not.toContain(tx.txKey);
  });
});
