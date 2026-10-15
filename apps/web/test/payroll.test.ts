import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/server/db';
import { runPayroll } from '@/server/payroll';
import { activityTotals } from '@/server/activity';
import { ensureBusd, employeeRecipients, uuid } from './helpers';

let busd: string;

beforeAll(async () => {
  busd = await ensureBusd();
});

describe('idempotent payroll runner', () => {
  it('pays 20 recipients in 2 transactions, waiting for locked change on the mock chain', async () => {
    const request = { network: 'mock-devnet' as const, idempotencyKey: uuid(), useFlash: true, recipients: employeeRecipients(20, busd) };
    const first = await runPayroll(request);
    expect(first.job.status).toBe('CONFIRMED');
    expect(first.job.totalChunks).toBe(2);
    expect(first.sent).toHaveLength(2);
    expect(first.sent.flatMap((p) => p.recipientIds)).toHaveLength(20);
    expect(first.sent.every((p) => /^[0-9a-f]{64}$/.test(p.txKey))).toBe(true);
    expect(BigInt(first.job.burnedAtomic)).toBeGreaterThan(0n);
    expect(first.events.join(' ')).toMatch(/mined 2 blocks/);

    const replay = await runPayroll(request);
    expect(replay.sent).toEqual([]);
    expect(replay.job.txHashes).toEqual(first.job.txHashes);

    const totals = await activityTotals('mock-devnet');
    expect(BigInt(totals.volumeByToken[busd] ?? '0')).toBeGreaterThanOrEqual(210_000_000n);
  });

  it('rejects reusing a key for a different payload and invalid addresses', async () => {
    const key = uuid();
    await runPayroll({ network: 'mock-devnet', idempotencyKey: key, useFlash: false, recipients: employeeRecipients(1, 'BDX', '1') });
    await expect(
      runPayroll({ network: 'mock-devnet', idempotencyKey: key, useFlash: false, recipients: employeeRecipients(1, 'BDX', '2') }),
    ).rejects.toThrow(/different payroll/);
    const bad = employeeRecipients(1, 'BDX').map((r) => ({ ...r, resolvedAddress: 'x'.repeat(97) }));
    await expect(runPayroll({ network: 'mock-devnet', idempotencyKey: uuid(), useFlash: false, recipients: bad })).rejects.toThrow(/invalid/);
  });

  it('never resends a chunk left in SUBMITTING by a crash', async () => {
    const request = { network: 'mock-devnet' as const, idempotencyKey: uuid(), useFlash: false, recipients: employeeRecipients(2, 'BDX', '1') };
    const done = await runPayroll(request);
    expect(done.job.status).toBe('CONFIRMED');
    // Simulate a crash between "about to broadcast" and "recorded".
    const crashed = done.job.chunks.map((c) => ({ ...c, status: 'SUBMITTING', txHashes: [] }));
    await db.payrollBatchJob.update({ where: { id: done.job.id }, data: { status: 'FAILED', chunksJson: JSON.stringify(crashed) } });
    const resumed = await runPayroll(request);
    expect(resumed.sent).toEqual([]);
    expect(resumed.job.status).toBe('FAILED');
    expect(resumed.job.chunks[0]?.status).toBe('UNKNOWN');
    expect(resumed.job.lastError).toMatch(/Reconcile/);
  });

  it('marks insufficient funds as FAILED and resumable', async () => {
    const request = { network: 'mock-devnet' as const, idempotencyKey: uuid(), useFlash: false, recipients: employeeRecipients(1, busd, '99999999') };
    const result = await runPayroll(request);
    expect(result.job.status).toBe('FAILED');
    expect(result.job.chunks[0]?.status).toBe('PENDING');
    expect(result.sent).toEqual([]);
  });
});
