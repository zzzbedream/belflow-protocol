// Core data contracts for BelFlow. The PRD interfaces are kept intact and
// extended where the real Beldex stack requires more information.

import type { VerificationSources } from './compliance/verifier';

export type BeldexNetwork = 'testnet' | 'mainnet' | 'mock-devnet';

/** Which backend signs and reads chain data. */
export type ProviderKind = 'browser-extension' | 'wallet-rpc-sidecar' | 'mock-chain';

/**
 * What a provider can do. The browser extension (@bdxi/web3js v1.0.x) only
 * supports single-destination BDX sends, so most flags are false for it.
 */
export interface ProviderCapabilities {
  /** Multi-output transactions (one tx, many recipients). */
  readonly batch: boolean;
  /** Returns the tx secret key needed for selective audit proofs. */
  readonly txKeys: boolean;
  /** Deploy, emit and send Privacy Tokens (Confidential Assets). */
  readonly assets: boolean;
  /** Resolve .bdx names. */
  readonly bns: boolean;
  /** Sign arbitrary single-line messages with the account spend key. */
  readonly signMessage: boolean;
  /** Flash (instant, quorum-locked) transactions. */
  readonly flash: boolean;
  /** Run check_tx_key style verification. */
  readonly verify: boolean;
}

export interface PrivacyTokenMetadata {
  /** Hash identifier of the Confidential Asset (asset_id on Proto). "BDX" for the native coin. */
  tokenId: string;
  ticker: string;
  name: string;
  decimals: number;
  totalSupply?: string;
  isNativeBdx: boolean;
  /** Set by mintPrivacyToken: the deploy transaction and its fee (atomic BDX). */
  deployTxHash?: string;
  deployFeeAtomic?: string;
}

export interface BNSResolution {
  domain: string;
  resolvedAddress: string;
  ownerBnsHash: string;
  isValid: boolean;
  /** Where the answer came from. Extension answers are not verified on-chain. */
  source?: 'daemon' | 'extension' | 'mock';
}

export interface BatchPaymentRecipient {
  id: string;
  /** "juan.bdx" or a full Beldex address. */
  recipientInput: string;
  resolvedAddress: string;
  /** Human readable amount, e.g. "1250.00". */
  amount: string;
  /** "BDX" or the Privacy Token asset id. */
  tokenId: string;
  memo?: string;
}

/** One on-chain transaction produced while paying a batch. */
export interface ConfidentialTxPart {
  txHash: string;
  txKey: string;
  feeAtomic: string;
  /** BDX burned by this transaction (flash surcharge), atomic units. */
  burnedAtomic: string;
  recipientIds: string[];
  inPool: boolean;
  blockHeight?: number | null;
  /** Some recipients of a split transfer could not be matched to a tx; reconcile manually. */
  needsReconciliation?: boolean;
}

export interface ConfidentialTxResult {
  txHash: string;
  /** Ephemeral tx secret key used for selective audit proofs. Empty when the provider cannot export it. */
  txKey: string;
  blockHeight?: number;
  /** BDX burned by the transaction(s), display units. */
  feeBurnedBdx: string;
  /** Total fee paid, display units. */
  feeTotalBdx?: string;
  /** Beldex RingCT ring size (9 decoys + 1 real input = 10). */
  ringSize: number;
  timestamp: number;
  recipientsCount: number;
  /** Every transaction created for this batch (more than one when transfer_split was needed). */
  transactions?: ConfidentialTxPart[];
}

/**
 * How strongly the asset (token) identity of a verified payment is proven.
 * check_tx_key on the Proto branch returns an amount but no asset id, so a
 * second layer is always required.
 */
export type AssetVerificationLevel =
  /** The node or the receiving wallet reported the asset id cryptographically. */
  | 'CRYPTOGRAPHIC_FULL'
  /** The asset tag was read from the decoded transaction on the daemon. */
  | 'DAEMON_EXTRACTED'
  /** Only the payer's signed declaration binds txHash + asset + amount + recipient. */
  | 'ISSUER_SIGNED_DECLARATION';

export interface SelectiveAuditProof {
  proofId: string;
  txHash: string;
  txKey: string;
  recipientAddress: string;
  recipientBns?: string;
  disclosedAmount: string;
  tokenTicker: string;
  tokenId: string;
  invoiceReference?: string;
  verifiedOnChain: boolean;
  verifiedBlockHeight?: number;
  assetVerificationLevel?: AssetVerificationLevel;
  issuerAddress?: string;
  issuerSignature?: string;
}

export interface X402PaymentChallenge {
  status: 402;
  recipientBnsOrAddress: string;
  amountRequired: string;
  tokenId: string;
  nonce: string;
  expiresAt: number;
}

/** Raw result of a check_tx_key style call, in atomic units. */
export interface TxKeyCheck {
  receivedAtomic: bigint;
  inPool: boolean;
  confirmations: number;
  blockHeight: number | null;
  /** Present only when the backend can attribute the received amount to an asset. */
  assetId?: string;
}

export interface VerificationResult {
  isValid: boolean;
  confirmedAmount: string;
  blockHeight: number;
  confirmedAmountAtomic?: string;
  inPool?: boolean;
  confirmations?: number;
  assetVerificationLevel?: AssetVerificationLevel | null;
  failures?: string[];
}

export interface ExpectedPayment {
  assetId: string;
  amountAtomic: bigint;
  decimals: number;
  issuer?: { address: string; signature: string };
}

export interface WalletConnection {
  address: string;
  network: BeldexNetwork;
}

export interface IBeldexProvider {
  readonly kind: ProviderKind;
  readonly network: BeldexNetwork;
  readonly capabilities: ProviderCapabilities;

  connectWallet(): Promise<WalletConnection>;
  /** Balances keyed by tokenId ("BDX" or asset id), display units. */
  getBalances(address: string): Promise<Record<string, string>>;
  resolveBNS(domain: string): Promise<BNSResolution>;
  mintPrivacyToken(
    params: Omit<PrivacyTokenMetadata, 'tokenId' | 'isNativeBdx'>,
  ): Promise<PrivacyTokenMetadata>;
  sendConfidentialBatch(
    recipients: BatchPaymentRecipient[],
    useFlashTx: boolean,
  ): Promise<ConfidentialTxResult>;
  /**
   * Without `expected` the result is always invalid (asset and amount unknown);
   * with it, full dual verification runs. See compliance/verifier.ts.
   */
  verifySelectiveAuditProof(
    txHash: string,
    txKey: string,
    recipientAddress: string,
    expected?: ExpectedPayment,
  ): Promise<VerificationResult>;
  /** Sign a single-line message (no control characters, ≤ 512 chars). */
  signMessage?(message: string): Promise<{ signature: string; address: string }>;
  /** Pays one chunk (≤ 15 recipients, one asset). More than one part means the wallet split it. */
  sendBatchChunk?(recipients: BatchPaymentRecipient[], useFlashTx: boolean): Promise<ConfidentialTxPart[]>;
  /** Re-export a tx secret key from the sending wallet. */
  getTxKey?(txHash: string): Promise<string>;
  /** Evidence sources for dual (amount + asset) verification. */
  verificationSources?(): VerificationSources;
}
