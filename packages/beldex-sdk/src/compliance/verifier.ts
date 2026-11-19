import { BDX_DECIMALS, NATIVE_TOKEN_ID } from '../constants';
import { AssetMismatchError, ValidationError, belflowErrorCode } from '../errors';
import { formatUnits } from '../units';
import { buildPaymentDeclaration } from './declaration';
import type { AssetVerificationLevel, TxKeyCheck, VerificationResult } from '../types';

/** Throws the typed AssetMismatchError when a verification detected asset confusion. */
export function assertNoAssetMismatch(result: Pick<PaymentVerification, 'failures'>, expectedAssetId: string, txHash: string): void {
  if (result.failures.includes('ASSET_MISMATCH')) throw new AssetMismatchError(expectedAssetId, txHash);
}

/** "BDX" stays as is; asset ids are compared lowercase. */
export function normalizeAssetId(assetId: string): string {
  return assetId.toUpperCase() === NATIVE_TOKEN_ID ? NATIVE_TOKEN_ID : assetId.toLowerCase();
}

/**
 * Receiver-side verification when the payer cannot export a tx key (browser
 * extension checkout). The merchant's own wallet reports what it received and
 * in which token; the decoded tx only says whether a mempool tx is flash.
 */
export async function verifyReceivedPayment(
  claim: Omit<PaymentClaim, 'txKey'>,
  sources: Pick<VerificationSources, 'receiverTransfers' | 'inspectTx'>,
  options: Pick<VerifyPaymentOptions, 'amountMatch' | 'allowFlashInPool'>,
): Promise<PaymentVerification> {
  if (claim.amountAtomic <= 0n) throw new ValidationError('Claimed amount must be positive.');
  const assetId = normalizeAssetId(claim.assetId);
  const failures: VerificationFailure[] = [];
  const notes: string[] = [];
  const incoming = sources.receiverTransfers
    ? await attempt('get_transfer_by_txid', notes, () => sources.receiverTransfers!(claim.txHash.toLowerCase(), claim.recipientAddress))
    : null;
  const inspection = sources.inspectTx ? await attempt('get_transactions', notes, () => sources.inspectTx!(claim.txHash.toLowerCase())) : null;

  const entries = incoming ?? [];
  const received = entries.reduce((sum, entry) => sum + entry.amountAtomic, 0n);
  let level: AssetVerificationLevel | null = null;
  const tagged = entries.filter((entry) => entry.assetId !== undefined);
  if (tagged.length > 0 && tagged.length === entries.length) {
    if (tagged.every((entry) => normalizeAssetId(entry.assetId as string) === assetId)) level = 'CRYPTOGRAPHIC_FULL';
    else failures.push('ASSET_MISMATCH');
  }
  if (received === 0n) failures.push('NO_OUTPUT_FOR_RECIPIENT');
  else if (options.amountMatch === 'exact' && received !== claim.amountAtomic) failures.push('AMOUNT_MISMATCH');
  else if (options.amountMatch === 'at-least' && received < claim.amountAtomic) failures.push('AMOUNT_INSUFFICIENT');

  const inPool = inspection?.inPool ?? false;
  const isFlash = inspection?.isFlash ?? false;
  if (inPool && !(options.allowFlashInPool && isFlash)) failures.push('NOT_CONFIRMED');
  if (level === null && !failures.includes('ASSET_MISMATCH')) failures.push('ASSET_UNVERIFIABLE');
  const unique = [...new Set(failures)];
  return {
    isValid: unique.length === 0,
    receivedAtomic: received,
    inPool,
    isFlash,
    confirmations: 0,
    blockHeight: inspection?.blockHeight ?? null,
    assetVerificationLevel: unique.length === 0 ? level : null,
    failures: unique,
    notes,
  };
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

/**
 * Decoded transaction as seen by the daemon or a block explorer. It carries no
 * token identity: tx_out_zyphora outputs only expose a blinded token id.
 */
export interface TxInspection {
  isFlash: boolean;
  inPool: boolean;
  blockHeight: number | null;
}

/** Evidence sources. Only Layer A is mandatory. */
export interface VerificationSources {
  /** Layer A: check_tx_key (BDX amount, plus token_received on feature-privacy-token). */
  checkTxKey(txHash: string, txKey: string, address: string): Promise<TxKeyCheck>;
  /** Layer B1: the receiving wallet's view (get_transfer_by_txid). */
  receiverTransfers?(txHash: string, address: string): Promise<Array<{ assetId?: string; amountAtomic: bigint }> | null>;
  /** Layer B2: decoded transaction from the daemon (or explorer): flash and pool status only. */
  inspectTx?(txHash: string): Promise<TxInspection | null>;
  /** Layer B3: verifies a payer signature over the canonical declaration. */
  verifySignature?(message: string, address: string, signature: string): Promise<boolean>;
  /**
   * Independent Layer A for privacy tokens: decodes tx_out_zyphora outputs
   * with the tx_key and no wallet (amount and token, commitment-checked).
   * When check_tx_key also reports token_received, both must agree.
   * Null when the transaction has no such outputs.
   */
  zyphoraTxKey?(txHash: string, txKey: string, address: string): Promise<Array<{ tokenId: string; amountAtomic: bigint }> | null>;
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
  CRYPTOGRAPHIC_FULL: 2,
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

const sumAtomic = (entries: Array<{ amountAtomic: bigint }>) => entries.reduce((sum, entry) => sum + entry.amountAtomic, 0n);

/**
 * Layer A on feature-privacy-token: check_tx_key reports native BDX in
 * `received` and each token in `token_received`, so the claimed token's
 * amount is attributed cryptographically. Anything else paid to the same
 * address in the same transaction is a contradiction.
 */
function attributeTxKeyCheck(
  check: TxKeyCheck,
  tokenId: string,
): { receivedAtomic: bigint; attributed: boolean; contradiction: boolean } {
  if (check.tokenReceived === undefined) return { receivedAtomic: check.receivedAtomic, attributed: false, contradiction: false };
  const tokens = check.tokenReceived.map((entry) => ({ tokenId: normalizeAssetId(entry.tokenId), amountAtomic: entry.amountAtomic }));
  const isNative = tokenId === NATIVE_TOKEN_ID;
  const claimed = isNative ? check.receivedAtomic : sumAtomic(tokens.filter((entry) => entry.tokenId === tokenId));
  const other = (isNative ? 0n : check.receivedAtomic) + sumAtomic(tokens.filter((entry) => entry.tokenId !== tokenId));
  return { receivedAtomic: claimed, attributed: claimed > 0n && other === 0n, contradiction: other > 0n };
}

/**
 * Layered verification against token confusion. Layer A proves the amount
 * and the token that reached the recipient: check_tx_key's token_received,
 * cross-checked by the wallet-free zyphora decode when available
 * (CRYPTOGRAPHIC_FULL). Layer B adds the receiving wallet's view, flash
 * status and the payer's signed declaration (ISSUER_SIGNED_DECLARATION).
 * Any contradiction invalidates the payment.
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

  // Layer A: check_tx_key (amount, recipient and, on feature-privacy-token, the token).
  const check = await sources.checkTxKey(claim.txHash, claim.txKey, claim.recipientAddress);
  const fromCheck = attributeTxKeyCheck(check, claim.assetId);
  let receivedAtomic = fromCheck.receivedAtomic;
  if (fromCheck.contradiction) failures.push('ASSET_MISMATCH');
  else if (fromCheck.attributed) level = 'CRYPTOGRAPHIC_FULL';

  // Independent Layer A: wallet-free decode of tx_out_zyphora outputs with the tx_key.
  // null = no decoder or no zyphora outputs in the tx; [] = zyphora outputs, none paying the address.
  let zyphora: Array<{ tokenId: string; amountAtomic: bigint }> | null = null;
  if (sources.zyphoraTxKey) {
    try {
      zyphora = await sources.zyphoraTxKey(claim.txHash, claim.txKey, claim.recipientAddress);
    } catch (error) {
      // A commitment or format failure is evidence of forged or inconsistent data, not an outage.
      if (belflowErrorCode(error) === 'VALIDATION') failures.push('ASSET_MISMATCH');
      notes.push(`zyphora tx_key decode unavailable: ${(error as Error).message}`);
    }
  }
  const tokensFromCheck = sumAtomic(check.tokenReceived ?? []);
  if (zyphora && zyphora.length === 0 && tokensFromCheck > 0n) {
    failures.push('ASSET_MISMATCH');
    notes.push('check_tx_key reports tokens that the wallet-free zyphora decode cannot find.');
  } else if (zyphora && zyphora.length > 0) {
    const matching = zyphora.filter((output) => normalizeAssetId(output.tokenId) === claim.assetId);
    const decodedAtomic = sumAtomic(matching);
    // Without token_received, `received` is unattributed: it may count the token outputs or only BDX.
    const unattributedExtra = check.tokenReceived === undefined && check.receivedAtomic !== 0n && check.receivedAtomic !== decodedAtomic;
    if (matching.length !== zyphora.length || unattributedExtra) failures.push('ASSET_MISMATCH');
    else if (check.tokenReceived !== undefined && decodedAtomic !== fromCheck.receivedAtomic) {
      failures.push('ASSET_MISMATCH');
      notes.push('The wallet-free zyphora decode disagrees with check_tx_key.');
    } else {
      receivedAtomic = decodedAtomic;
      level = 'CRYPTOGRAPHIC_FULL';
    }
  }

  if (receivedAtomic === 0n) failures.push('NO_OUTPUT_FOR_RECIPIENT');
  else if (options.amountMatch === 'exact' && receivedAtomic !== claim.amountAtomic) failures.push('AMOUNT_MISMATCH');
  else if (options.amountMatch === 'at-least' && receivedAtomic < claim.amountAtomic) failures.push('AMOUNT_INSUFFICIENT');

  // Layer B1: receiving wallet.
  const incoming = sources.receiverTransfers
    ? await attempt('get_transfer_by_txid', notes, () => sources.receiverTransfers!(claim.txHash, claim.recipientAddress))
    : null;
  const walletEntries = incoming ?? [];
  const attributed = walletEntries.filter((entry) => entry.assetId !== undefined);
  if (attributed.some((entry) => normalizeAssetId(entry.assetId as string) !== claim.assetId)) {
    failures.push('ASSET_MISMATCH');
  } else if (attributed.length > 0) {
    // The wallet view attributes the token only when it accounts for every entry and for the
    // exact amount Layer A proved; a partial or different view adds no evidence.
    const walletAtomic = sumAtomic(attributed);
    if (attributed.length === walletEntries.length && walletAtomic === receivedAtomic) {
      level = strongest(level, 'CRYPTOGRAPHIC_FULL');
    } else {
      notes.push('The receiving wallet view does not match the amount proven by check_tx_key; it does not attribute the token.');
    }
  }

  // Layer B2: decoded transaction, only to tell whether a mempool tx is flash.
  const inspection = sources.inspectTx
    ? await attempt('get_transactions', notes, () => sources.inspectTx!(claim.txHash))
    : null;

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
    receivedAtomic,
    inPool: check.inPool,
    isFlash,
    confirmations: check.confirmations,
    blockHeight: check.blockHeight ?? inspection?.blockHeight ?? null,
    assetVerificationLevel: uniqueFailures.length === 0 ? level : null,
    failures: uniqueFailures,
    notes,
  };
}
