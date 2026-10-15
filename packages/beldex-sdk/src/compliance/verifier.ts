import { BDX_DECIMALS, NATIVE_TOKEN_ID } from '../constants';
import { ValidationError } from '../errors';
import { formatUnits } from '../units';
import { buildPaymentDeclaration } from './declaration';
import type { AssetVerificationLevel, TxKeyCheck, VerificationResult } from '../types';

/** "BDX" stays as is; asset ids are compared lowercase. */
export function normalizeAssetId(assetId: string): string {
  return assetId.toUpperCase() === NATIVE_TOKEN_ID ? NATIVE_TOKEN_ID : assetId.toLowerCase();
}

/**
 * PRD-compatible `verifySelectiveAuditProof` result. Without an expected asset
 * and amount the payment cannot be judged, so it is reported invalid with the
 * raw received amount for display only.
 */
export async function verifyForProvider(
  sources: VerificationSources,
  txHash: string,
  txKey: string,
  recipientAddress: string,
  expected?: { assetId: string; amountAtomic: bigint; decimals: number; issuer?: { address: string; signature: string } },
): Promise<VerificationResult> {
  if (!expected) {
    const check = await sources.checkTxKey(txHash, txKey, recipientAddress);
    return {
      isValid: false,
      confirmedAmount: formatUnits(check.receivedAtomic, BDX_DECIMALS),
      confirmedAmountAtomic: check.receivedAtomic.toString(),
      blockHeight: check.blockHeight ?? 0,
      inPool: check.inPool,
      confirmations: check.confirmations,
      assetVerificationLevel: null,
      failures: ['ASSET_UNVERIFIABLE'],
    };
  }
  const result = await verifyPayment(
    { txHash, txKey, recipientAddress, assetId: expected.assetId, amountAtomic: expected.amountAtomic },
    sources,
    { amountMatch: 'exact', ...(expected.issuer ? { issuer: expected.issuer } : {}) },
  );
  return {
    isValid: result.isValid,
    confirmedAmount: formatUnits(result.receivedAtomic, expected.decimals),
    confirmedAmountAtomic: result.receivedAtomic.toString(),
    blockHeight: result.blockHeight ?? 0,
    inPool: result.inPool,
    confirmations: result.confirmations,
    assetVerificationLevel: result.assetVerificationLevel,
    failures: result.failures,
  };
}

/** What the payer claims was paid. */
export interface PaymentClaim {
  txHash: string;
  txKey: string;
  recipientAddress: string;
  assetId: string;
  amountAtomic: bigint;
}

/** Decoded transaction as seen by the daemon or a block explorer. */
export interface TxInspection {
  /** Asset ids visible in the transaction outputs, or null when the format hides them. */
  assetIds: string[] | null;
  isFlash: boolean;
  inPool: boolean;
  blockHeight: number | null;
}

/** Evidence sources. Only Layer A is mandatory. */
export interface VerificationSources {
  /** Layer A: check_tx_key (amount + recipient). */
  checkTxKey(txHash: string, txKey: string, address: string): Promise<TxKeyCheck>;
  /** Layer B1: the receiving wallet's view (get_transfer_by_txid). */
  receiverTransfers?(txHash: string, address: string): Promise<Array<{ assetId?: string; amountAtomic: bigint }> | null>;
  /** Layer B2: decoded transaction from the daemon (or explorer). */
  inspectTx?(txHash: string): Promise<TxInspection | null>;
  /** Layer B3: verifies a payer signature over the canonical declaration. */
  verifySignature?(message: string, address: string, signature: string): Promise<boolean>;
}

export interface VerifyPaymentOptions {
  /** Audit receipts need the exact amount; x402 accepts overpayment. */
  amountMatch: 'exact' | 'at-least';
  /** Accept a mempool tx when the daemon flags it as flash (quorum-locked). */
  allowFlashInPool?: boolean;
  issuer?: { address: string; signature: string };
}

export type VerificationFailure =
  | 'NO_OUTPUT_FOR_RECIPIENT'
  | 'AMOUNT_MISMATCH'
  | 'AMOUNT_INSUFFICIENT'
  | 'NOT_CONFIRMED'
  | 'ASSET_MISMATCH'
  | 'ISSUER_SIGNATURE_INVALID'
  | 'ASSET_UNVERIFIABLE';

export interface PaymentVerification {
  isValid: boolean;
  receivedAtomic: bigint;
  inPool: boolean;
  isFlash: boolean;
  confirmations: number;
  blockHeight: number | null;
  assetVerificationLevel: AssetVerificationLevel | null;
  failures: VerificationFailure[];
  /** Non-fatal notes, e.g. a layer that was unavailable. */
  notes: string[];
}

const LEVEL_RANK: Record<AssetVerificationLevel, number> = {
  CRYPTOGRAPHIC_FULL: 3,
  DAEMON_EXTRACTED: 2,
  ISSUER_SIGNED_DECLARATION: 1,
};

function strongest(a: AssetVerificationLevel | null, b: AssetVerificationLevel): AssetVerificationLevel {
  return a !== null && LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b;
}

async function attempt<T>(label: string, notes: string[], run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    notes.push(`${label} unavailable: ${(error as Error).message}`);
    return null;
  }
}

/**
 * Two-layer verification against asset confusion. Layer A (check_tx_key)
 * proves the amount reached the recipient. Layer B proves which asset it was:
 * receiving wallet or node attribution (CRYPTOGRAPHIC_FULL), decoded tx tags
 * (DAEMON_EXTRACTED) or the payer's signed declaration
 * (ISSUER_SIGNED_DECLARATION). Any contradiction invalidates the payment.
 */
export async function verifyPayment(
  rawClaim: PaymentClaim,
  sources: VerificationSources,
  options: VerifyPaymentOptions,
): Promise<PaymentVerification> {
  if (rawClaim.amountAtomic <= 0n) throw new ValidationError('Claimed amount must be positive.');
  const claim = { ...rawClaim, assetId: normalizeAssetId(rawClaim.assetId), txHash: rawClaim.txHash.toLowerCase() };
  const failures: VerificationFailure[] = [];
  const notes: string[] = [];
  let level: AssetVerificationLevel | null = null;

  // Layer A: amount and recipient.
  const rawCheck = await sources.checkTxKey(claim.txHash, claim.txKey, claim.recipientAddress);
  const check = rawCheck.assetId === undefined ? rawCheck : { ...rawCheck, assetId: normalizeAssetId(rawCheck.assetId) };
  if (check.receivedAtomic === 0n) failures.push('NO_OUTPUT_FOR_RECIPIENT');
  else if (options.amountMatch === 'exact' && check.receivedAtomic !== claim.amountAtomic) failures.push('AMOUNT_MISMATCH');
  else if (options.amountMatch === 'at-least' && check.receivedAtomic < claim.amountAtomic) failures.push('AMOUNT_INSUFFICIENT');

  if (check.assetId !== undefined) {
    if (check.assetId === claim.assetId) level = 'CRYPTOGRAPHIC_FULL';
    else failures.push('ASSET_MISMATCH');
  }

  // Layer B1: receiving wallet.
  const incoming = sources.receiverTransfers
    ? await attempt('get_transfer_by_txid', notes, () => sources.receiverTransfers!(claim.txHash, claim.recipientAddress))
    : null;
  const attributed = (incoming ?? []).filter((entry) => entry.assetId !== undefined);
  if (attributed.length > 0) {
    if (attributed.every((entry) => normalizeAssetId(entry.assetId as string) === claim.assetId)) {
      level = strongest(level, 'CRYPTOGRAPHIC_FULL');
    }
    else failures.push('ASSET_MISMATCH');
  }

  // Layer B2: decoded transaction (also tells us whether a mempool tx is flash).
  const inspection = sources.inspectTx
    ? await attempt('get_transactions', notes, () => sources.inspectTx!(claim.txHash))
    : null;
  if (inspection?.assetIds) {
    const assets = [...new Set(inspection.assetIds.map(normalizeAssetId))];
    if (!assets.includes(claim.assetId)) failures.push('ASSET_MISMATCH');
    else if (assets.length === 1) level = strongest(level, 'DAEMON_EXTRACTED');
    else notes.push('Transaction carries several assets; daemon tags cannot attribute this output.');
  }

  // Layer B3: payer's signed declaration.
  if (options.issuer && sources.verifySignature) {
    const message = buildPaymentDeclaration({
      txHash: claim.txHash,
      assetId: claim.assetId,
      amountAtomic: claim.amountAtomic,
      recipientAddress: claim.recipientAddress,
    });
    const signed = await attempt('signature verification', notes, () =>
      sources.verifySignature!(message, options.issuer!.address, options.issuer!.signature),
    );
    if (signed === true) level = strongest(level, 'ISSUER_SIGNED_DECLARATION');
    else if (signed === false) failures.push('ISSUER_SIGNATURE_INVALID');
  }

  const isFlash = inspection?.isFlash ?? false;
  if (check.inPool && !(options.allowFlashInPool && isFlash)) failures.push('NOT_CONFIRMED');
  if (level === null && !failures.includes('ASSET_MISMATCH')) failures.push('ASSET_UNVERIFIABLE');

  const uniqueFailures = [...new Set(failures)];
  return {
    isValid: uniqueFailures.length === 0,
    receivedAtomic: check.receivedAtomic,
    inPool: check.inPool,
    isFlash,
    confirmations: check.confirmations,
    blockHeight: check.blockHeight ?? inspection?.blockHeight ?? null,
    assetVerificationLevel: uniqueFailures.length === 0 ? level : null,
    failures: uniqueFailures,
    notes,
  };
}
