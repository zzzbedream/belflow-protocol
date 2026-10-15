// Serializable MockChain state. Amounts are decimal strings so the snapshot
// survives JSON round trips.

export interface MockUtxo {
  amount: string;
  unlockHeight: number;
}

export interface MockAccount {
  label: string;
  /** tokenId -> unspent outputs */
  utxos: Record<string, MockUtxo[]>;
}

export interface MockAsset {
  assetId: string;
  ticker: string;
  name: string;
  decimals: number;
  maxSupply: string;
  currentSupply: string;
  owner: string;
}

export interface MockOutput {
  address: string;
  assetId: string;
  amount: string;
}

export type MockTxKind = 'transfer' | 'deploy' | 'emit' | 'faucet';

export interface MockTx {
  txHash: string;
  txKey: string;
  kind: MockTxKind;
  from: string;
  outputs: MockOutput[];
  fee: string;
  burned: string;
  flash: boolean;
  /** null while the tx sits in the mempool. */
  height: number | null;
  timestamp: number;
}

export interface MockChainState {
  version: 1;
  seed: string;
  height: number;
  sequence: number;
  accounts: Record<string, MockAccount>;
  assets: Record<string, MockAsset>;
  txs: Record<string, MockTx>;
  mempool: string[];
  bns: Record<string, string>;
}

export function emptyState(seed: string, height: number): MockChainState {
  return { version: 1, seed, height, sequence: 0, accounts: {}, assets: {}, txs: {}, mempool: [], bns: {} };
}
