import { beforeAll, describe, expect, it } from 'vitest';
import { GET as proofGet } from '@/app/api/audit/[proofId]/route';
import { createProof, getProof, inspectProof, verifyProof } from '@/server/audit';
import { db } from '@/server/db';
import { runPayroll } from '@/server/payroll';
import { ensureBusd, employeeRecipients, uuid } from './helpers';

const CIPHER = 'AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
let receipt: { txHash: string; txKey: string; recipientAddress: string; tokenId: string; amount: string };

beforeAll(async () => {
  const busd = await ensureBusd();
  const recipients = employeeRecipients(2, busd, '1250.5');
  const run = await runPayroll({ network: 'mock-devnet', idempotencyKey: uuid(), useFlash: false, recipients });
  const part = run.sent[0];
  if (!part) throw new Error('payroll did not send');
  const first = recipients[0];
  if (!first) throw new Error('no recipient');
  receipt = { txHash: part.txHash, txKey: part.txKey, recipientAddress: first.resolvedAddress, tokenId: busd, amount: '1250.5' };
});

const baseInput = () => ({ network: 'mock-devnet' as const, ...receipt, txKeyEncrypted: CIPHER, recipientBns: 'devteam.bdx' });

describe('selective audit proofs', () => {
  it('creates a signed, verified proof and re-verifies it for the auditor', async () => {
    const created = await createProof(baseInput());
    expect(created.assetVerificationLevel).toBe('CRYPTOGRAPHIC_FULL');
    expect(created.package.declaration).toBe(`belflow-proof-v1|${receipt.txHash}|${receipt.tokenId}|1250500000|${receipt.recipientAddress}`);
    expect(created.package.issuerSignature).toMatch(/^MockSigV1/);
    expect(JSON.stringify(created.package)).not.toContain(receipt.txKey);

    const stored = await db.selectiveAuditRecord.findUnique({ where: { id: created.proofId } });
    expect(stored?.txKeyEncrypted).toBe(CIPHER);
    expect(JSON.stringify(stored)).not.toContain(receipt.txKey);

    const view = await getProof(created.proofId, undefined);
    expect(view.package.disclosedAmount).toBe('1250.5');

    const verified = await verifyProof({ proofId: created.proofId, txKey: receipt.txKey });
    expect(verified).toMatchObject({ isValid: true, packageIntact: true, receivedAmount: '1250.5', assetVerificationLevel: 'CRYPTOGRAPHIC_FULL' });
    expect(verified.blockHeight).toBeGreaterThan(0);
  });

  it('refuses proofs for wrong amounts, wrong keys and tampered packages', async () => {
    await expect(createProof({ ...baseInput(), amount: '1250.4' })).rejects.toThrow(/AMOUNT_MISMATCH/);
    const created = await createProof(baseInput());
    const wrongKey = await verifyProof({ proofId: created.proofId, txKey: 'f'.repeat(64) });
    expect(wrongKey.isValid).toBe(false);
    expect(wrongKey.failures).toContain('NO_OUTPUT_FOR_RECIPIENT');

    const record = await db.selectiveAuditRecord.findUniqueOrThrow({ where: { id: created.proofId } });
    const forged = { ...JSON.parse(record.packageJson), disclosedAmount: '999999' };
    await db.selectiveAuditRecord.update({ where: { id: created.proofId }, data: { packageJson: JSON.stringify(forged) } });
    const tampered = await verifyProof({ proofId: created.proofId, txKey: receipt.txKey });
    expect(tampered.isValid).toBe(false);
    expect(tampered.failures).toContain('PACKAGE_TAMPERED');
  });

  it('gates passcode-protected proofs', async () => {
    const created = await createProof({ ...baseInput(), passcode: 'auditor-2026' });
    await expect(getProof(created.proofId, undefined)).rejects.toThrow(/passcode/);
    await expect(getProof(created.proofId, 'wrong-passcode')).rejects.toThrow(/passcode/);
    await expect(getProof(created.proofId, 'auditor-2026')).resolves.toMatchObject({ proofId: created.proofId });
    await expect(verifyProof({ proofId: created.proofId, txKey: receipt.txKey })).rejects.toThrow(/passcode/);

    const locked = await proofGet(new Request(`http://localhost:3000/api/audit/${created.proofId}`), { params: Promise.resolve({ proofId: created.proofId }) });
    expect(locked.status).toBe(401);
    expect(((await locked.json()) as { data: { requiresPasscode: boolean } }).data.requiresPasscode).toBe(true);
    const unlocked = await proofGet(
      new Request(`http://localhost:3000/api/audit/${created.proofId}`, { headers: { 'X-Auditor-Passcode': 'auditor-2026' } }),
      { params: Promise.resolve({ proofId: created.proofId }) },
    );
    expect(unlocked.status).toBe(200);
    const missing = await proofGet(new Request('http://localhost:3000/api/audit/x'), { params: Promise.resolve({ proofId: uuid() }) });
    expect(missing.status).toBe(404);
  });

  it('inspects tampered claims read-only: the real claim passes, a swapped asset or amount fails', async () => {
    const created = await createProof(baseInput());
    const base = { proofId: created.proofId, txKey: receipt.txKey };
    await expect(inspectProof({ ...base, tokenId: receipt.tokenId, amountAtomic: '1250500000' })).resolves.toMatchObject({ isValid: true });
    const wrongAsset = await inspectProof({ ...base, tokenId: 'BDX', amountAtomic: '1250500000' });
    expect(wrongAsset.isValid).toBe(false);
    expect(wrongAsset.failures).toContain('ASSET_MISMATCH');
    const wrongAmount = await inspectProof({ ...base, tokenId: receipt.tokenId, amountAtomic: '1' });
    expect(wrongAmount.isValid).toBe(false);
    await expect(inspectProof({ ...base, tokenId: receipt.tokenId, amountAtomic: '0' })).rejects.toThrow(/positive/);
    const stored = await db.selectiveAuditRecord.findUniqueOrThrow({ where: { id: created.proofId } });
    expect(JSON.parse(stored.packageJson).tokenId).toBe(receipt.tokenId);
  });
});
