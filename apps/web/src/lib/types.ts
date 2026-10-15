// Client-side DTOs mirroring the API responses.

import type { ProviderCapabilities, ProviderKind } from '@belflow/sdk';

export interface TokenDto {
  tokenId: string;
  ticker: string;
  name: string;
  decimals: number;
  isNativeBdx: boolean;
  creatorAddr?: string;
}

export interface CapabilityRow {
  kind: ProviderKind;
  label: string;
  role: string;
  active: boolean;
  available: boolean;
  capabilities: ProviderCapabilities;
}

export type ActivityKind = 'PAYROLL' | 'TOKEN_DEPLOY' | 'X402' | 'INVOICE' | 'BNS';

export interface OverviewDto {
  network: 'mock-devnet' | 'testnet';
  testnetConfigured: boolean;
  protoForkHeight: number;
  explorer: { height: number; nettype: string; hardFork: number } | null;
  treasury: { address: string; height: number; balances: Array<TokenDto & { amount: string }> } | null;
  treasuryError: string | null;
  telemetry: null | {
    burnedByKind: Record<ActivityKind, string>;
    feesByKind: Record<ActivityKind, string>;
    burnedTotalAtomic: string;
    feesTotalAtomic: string;
    txCount: number;
    volumeByToken: Record<string, string>;
  };
  tokens: TokenDto[];
  capabilityMatrix: CapabilityRow[];
}

export interface ChunkDto {
  index: number;
  tokenId: string;
  recipientIds: string[];
  status: 'PENDING' | 'SUBMITTING' | 'SENT' | 'UNKNOWN';
  txHashes: string[];
  feeAtomic: string;
  burnedAtomic: string;
  needsReconciliation?: boolean;
}

export interface PayrollJobDto {
  id: string;
  idempotencyKey: string;
  network: string;
  status: string;
  useFlash: boolean;
  totalChunks: number;
  recipientsCount: number;
  chunks: ChunkDto[];
  txHashes: string[];
  feeTotalAtomic: string;
  burnedAtomic: string;
  lockedUntilHeight: number | null;
  lastError: string | null;
  updatedAt: string;
}

export interface PayrollRunDto {
  job: PayrollJobDto;
  sent: Array<{ txHash: string; txKey: string; recipientIds: string[] }>;
  events: string[];
}

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
