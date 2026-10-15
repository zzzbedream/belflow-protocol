import 'server-only';
import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import {
  buildAuditProofPackage,
  buildPaymentDeclaration,
  formatUnits,
  verifyPackageIntegrity,
  verifyPayment,
  type AuditProofPackage,
} from '@belflow/sdk';
import { z } from 'zod';
import { db } from './db';
import { HttpError, notFound, unauthorized } from './errors';
import { getRuntime, networkSchema, type AppNetwork } from './runtime';
import { getToken } from './tokens';

const scrypt = promisify(scryptCallback) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;
const HEX64 = /^[0-9a-f]{64}$/i;
const ciphertextSchema = z.string().regex(/^[A-Za-z0-9_-]{16,32}\.[A-Za-z0-9_-]{16,512}$/);

export const createProofSchema = z
  .object({
    network: networkSchema,
    txHash: z.string().regex(HEX64),
    txKey: z.string().regex(HEX64),
    txKeyEncrypted: ciphertextSchema,
    recipientAddress: z.string().min(95).max(110),
    recipientBns: z.string().max(80).optional(),
    tokenId: z.string().regex(/^(BDX|[0-9a-f]{64})$/),
    amount: z.string().regex(/^\d{1,20}(\.\d{1,12})?$/),
    invoiceReference: z.string().max(80).optional(),
    passcode: z.string().min(8).max(128).optional(),
  })
  .strict();

export const verifyProofSchema = z
  .object({
    proofId: z.uuid(),
    txKey: z.string().regex(HEX64),
    passcode: z.string().max(128).optional(),
  })
  .strict();

export interface ProofVerificationDto {
  isValid: boolean;
  assetVerificationLevel: string | null;
  blockHeight: number | null;
  confirmations: number;
  inPool: boolean;
  receivedAmount: string;
  failures: string[];
  notes: string[];
  packageIntact: boolean;
  checkedAt: string;
}

async function hashPasscode(passcode: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(passcode, salt, 32);
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

async function passcodeMatches(stored: string, candidate: string | undefined): Promise<boolean> {
  if (!candidate) return false;
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = await scrypt(candidate, Buffer.from(salt, 'base64url'), expected.length);
  return timingSafeEqual(expected, actual);
}

/**
 * Creates a selective-disclosure receipt for ONE output. The payment is
 * verified first (exact amount, asset attribution, confirmed), the treasury
 * signs the canonical declaration, and only the client-encrypted tx key is
 * stored. The plaintext tx key is used for this check and then discarded.
 */
export async function createProof(input: z.infer<typeof createProofSchema>) {
  const runtime = await getRuntime(input.network);
  const token = await getToken(input.network, input.tokenId);
  const amountAtomic = BigInt(formatAtomic(input.amount, token.decimals));
  const declaration = buildPaymentDeclaration({
    txHash: input.txHash,
    assetId: token.tokenId,
    amountAtomic,
    recipientAddress: input.recipientAddress,
  });
  const issuer = await runtime.treasury.signMessage(declaration);
  const verification = await verifyPayment(
    { txHash: input.txHash, txKey: input.txKey, recipientAddress: input.recipientAddress, assetId: token.tokenId, amountAtomic },
    runtime.verification,
    { amountMatch: 'exact', issuer },
  );
  if (!verification.isValid) {
    throw new HttpError(422, `Payment could not be verified: ${verification.failures.join(', ')}`, 'NOT_VERIFIED');
  }

  const proofId = randomUUID();
  const pkg = buildAuditProofPackage({
    proofId,
    network: input.network,
    txHash: input.txHash.toLowerCase(),
    recipientAddress: input.recipientAddress,
    ...(input.recipientBns ? { recipientBns: input.recipientBns } : {}),
    tokenId: token.tokenId,
    tokenTicker: token.ticker,
    decimals: token.decimals,
    amountAtomic: amountAtomic.toString(),
    ...(input.invoiceReference ? { invoiceReference: input.invoiceReference } : {}),
    issuerAddress: issuer.address,
    issuerSignature: issuer.signature,
    createdAt: Date.now(),
  });

  await db.selectiveAuditRecord.create({
    data: {
      id: proofId,
      network: input.network,
      txHash: pkg.txHash,
      txKeyEncrypted: input.txKeyEncrypted,
      recipientAddress: pkg.recipientAddress,
      recipientBns: pkg.recipientBns ?? null,
      disclosedAmount: pkg.disclosedAmount,
      amountAtomic: pkg.amountAtomic,
      tokenId: pkg.tokenId,
      tokenTicker: pkg.tokenTicker,
      tokenDecimals: pkg.decimals,
      auditorPasscode: input.passcode ? await hashPasscode(input.passcode) : null,
      issuerAddress: issuer.address,
      issuerSignature: issuer.signature,
      packageJson: JSON.stringify(pkg),
      packageHash: pkg.packageHash,
      assetVerificationLevel: verification.assetVerificationLevel,
      verifiedBlockHeight: verification.blockHeight,
    },
  });
  return { proofId, package: pkg, assetVerificationLevel: verification.assetVerificationLevel, blockHeight: verification.blockHeight };
}

function formatAtomic(amount: string, decimals: number): string {
  const [whole = '0', fraction = ''] = amount.split('.');
  if (fraction.length > decimals) throw new HttpError(400, `Amount has more than ${decimals} decimals.`, 'VALIDATION');
  return BigInt(whole + fraction.padEnd(decimals, '0')).toString();
}

async function loadRecord(proofId: string, passcode: string | undefined) {
  const record = await db.selectiveAuditRecord.findUnique({ where: { id: proofId } });
  if (!record) throw notFound('Proof not found.');
  if (record.auditorPasscode && !(await passcodeMatches(record.auditorPasscode, passcode))) {
    throw unauthorized('This proof requires the auditor passcode.');
  }
  return record;
}

/** Public view for the auditor portal (tx key stays encrypted). */
export async function getProof(proofId: string, passcode: string | undefined) {
  const record = await loadRecord(proofId, passcode);
  return {
    proofId: record.id,
    network: record.network,
    package: JSON.parse(record.packageJson) as AuditProofPackage,
    txKeyEncrypted: record.txKeyEncrypted,
    assetVerificationLevel: record.assetVerificationLevel,
    verifiedBlockHeight: record.verifiedBlockHeight,
    createdAt: record.createdAt.toISOString(),
  };
}

export async function hasPasscode(proofId: string): Promise<boolean> {
  const record = await db.selectiveAuditRecord.findUnique({ where: { id: proofId }, select: { auditorPasscode: true } });
  if (!record) throw notFound('Proof not found.');
  return record.auditorPasscode !== null;
}

/** Live re-verification against the node (check_tx_key + asset layer + issuer signature). */
export async function verifyProof(input: z.infer<typeof verifyProofSchema>): Promise<ProofVerificationDto> {
  const record = await loadRecord(input.proofId, input.passcode);
  const pkg = JSON.parse(record.packageJson) as AuditProofPackage;
  const packageIntact = verifyPackageIntegrity(pkg) && pkg.packageHash === record.packageHash;
  const runtime = await getRuntime(record.network as AppNetwork);
  const result = await verifyPayment(
    { txHash: pkg.txHash, txKey: input.txKey, recipientAddress: pkg.recipientAddress, assetId: pkg.tokenId, amountAtomic: BigInt(pkg.amountAtomic) },
    runtime.verification,
    { amountMatch: 'exact', ...(pkg.issuerAddress && pkg.issuerSignature ? { issuer: { address: pkg.issuerAddress, signature: pkg.issuerSignature } } : {}) },
  );
  return {
    isValid: result.isValid && packageIntact,
    assetVerificationLevel: result.assetVerificationLevel,
    blockHeight: result.blockHeight,
    confirmations: result.confirmations,
    inPool: result.inPool,
    receivedAmount: formatUnits(result.receivedAtomic, pkg.decimals),
    failures: packageIntact ? result.failures : [...result.failures, 'PACKAGE_TAMPERED'],
    notes: result.notes,
    packageIntact,
    checkedAt: new Date().toISOString(),
  };
}
