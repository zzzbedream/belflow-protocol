import 'server-only';
import { formatUnits, verifyPayment, verifyReceivedPayment, type PaymentVerification } from '@belflow/sdk';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { recordActivity } from './activity';
import { claimSettlement, releaseSettlement } from './settlement';
import { db } from './db';
import { conflict, notFound } from './errors';
import { getRuntime, networkSchema, type AppNetwork } from './runtime';
import { getToken, toAtomic } from './tokens';

/** Ciphertext produced by lib/crypto (base64url iv.ciphertext). */
const ciphertextSchema = z.string().regex(/^[A-Za-z0-9_-]{16,32}\.[A-Za-z0-9_-]{16,4096}$/);

export const createInvoiceSchema = z
  .object({
    network: networkSchema,
    tokenId: z.string().regex(/^(BDX|[0-9a-f]{64})$/),
    amount: z.string().regex(/^\d{1,20}(\.\d{1,12})?$/),
    encryptedMemo: ciphertextSchema.optional(),
  })
  .strict();

export const payInvoiceSchema = z
  .object({
    txHash: z.string().regex(/^[0-9a-f]{64}$/i),
    txKey: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
  })
  .strict();

export interface InvoiceDto {
  id: string;
  network: string;
  merchantAddress: string;
  merchantBns: string | null;
  tokenId: string;
  tokenTicker: string;
  tokenDecimals: number;
  expectedAmount: string;
  encryptedMemo: string | null;
  status: string;
  paidTxHash: string | null;
  paidAt: string | null;
  assetVerificationLevel: string | null;
  createdAt: string;
}

type InvoiceRow = NonNullable<Awaited<ReturnType<typeof db.confidentialInvoice.findUnique>>>;

export function toInvoiceDto(row: InvoiceRow): InvoiceDto {
  return {
    id: row.id,
    network: row.network,
    merchantAddress: row.merchantAddress,
    merchantBns: row.merchantBns,
    tokenId: row.tokenId,
    tokenTicker: row.tokenTicker,
    tokenDecimals: row.tokenDecimals,
    expectedAmount: row.expectedAmount,
    encryptedMemo: row.encryptedMemo,
    status: row.status,
    paidTxHash: row.paidTxHash,
    paidAt: row.paidAt?.toISOString() ?? null,
    assetVerificationLevel: row.assetVerificationLevel,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function createInvoice(input: z.infer<typeof createInvoiceSchema>): Promise<InvoiceDto> {
  const runtime = await getRuntime(input.network);
  const token = await getToken(input.network, input.tokenId);
  const atomic = await toAtomic(input.network, input.tokenId, input.amount);
  if (atomic <= 0n) throw conflict('Invoice amount must be positive.');
  // A fresh subaddress per invoice binds a payment to this invoice: someone
  // else's tx to the treasury can never be submitted to settle it.
  const payTo = (await runtime.treasury.createSubaddress?.(`invoice-${randomUUID()}`)) ?? runtime.treasuryAddress;
  const row = await db.confidentialInvoice.create({
    data: {
      network: input.network,
      merchantAddress: payTo,
      merchantBns: input.network === 'mock-devnet' ? 'tesoreria.bdx' : null,
      tokenId: token.tokenId,
      tokenTicker: token.ticker,
      tokenDecimals: token.decimals,
      expectedAmount: formatUnits(atomic, token.decimals),
      encryptedMemo: input.encryptedMemo ?? null,
    },
  });
  return toInvoiceDto(row);
}

export async function getInvoice(id: string): Promise<InvoiceDto> {
  const row = await db.confidentialInvoice.findUnique({ where: { id } });
  if (!row) throw notFound('Invoice not found.');
  return toInvoiceDto(row);
}

/**
 * Settles an invoice. With a tx key (wallet-rpc / mock payers) the full dual
 * verification runs; without one (browser extension) the merchant wallet's
 * incoming view is used. Flash payments settle from the mempool. A tx hash
 * can settle only one invoice (unique constraint).
 */
export async function payInvoice(
  id: string,
  input: z.infer<typeof payInvoiceSchema>,
): Promise<{ invoice: InvoiceDto; verification: PaymentVerification }> {
  const invoice = await db.confidentialInvoice.findUnique({ where: { id } });
  if (!invoice) throw notFound('Invoice not found.');
  if (invoice.status !== 'PENDING') throw conflict('Invoice is already settled.');
  const network = invoice.network as AppNetwork;
  const runtime = await getRuntime(network);
  const amountAtomic = await toAtomic(network, invoice.tokenId, invoice.expectedAmount);
  const claim = { txHash: input.txHash.toLowerCase(), recipientAddress: invoice.merchantAddress, assetId: invoice.tokenId, amountAtomic };
  const verification = input.txKey
    ? await verifyPayment({ ...claim, txKey: input.txKey.toLowerCase() }, runtime.verification, { amountMatch: 'at-least', allowFlashInPool: true })
    : await verifyReceivedPayment(claim, runtime.verification, { amountMatch: 'at-least', allowFlashInPool: true });

  if (!verification.isValid) return { invoice: toInvoiceDto(invoice), verification };

  const purpose = `INVOICE:${id}`;
  if (!(await claimSettlement(claim.txHash, purpose))) {
    throw conflict('This transaction already settled another invoice or x402 call.');
  }
  const updated = await db.confidentialInvoice
    .updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'PAID', paidTxHash: claim.txHash, paidAt: new Date(), assetVerificationLevel: verification.assetVerificationLevel },
    })
    .catch(() => ({ count: 0 }));
  if (updated.count !== 1) {
    await releaseSettlement(claim.txHash, purpose);
    throw conflict('Invoice is already settled.');
  }
  await recordActivity({ network, kind: 'INVOICE', txHash: claim.txHash, feeAtomic: '0', burnedAtomic: '0', tokenId: invoice.tokenId, volumeAtomic: amountAtomic.toString() });
  return { invoice: await getInvoice(id), verification };
}
