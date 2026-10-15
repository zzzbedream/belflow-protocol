import type { JsonRpcClient } from './JsonRpcClient';
import { WALLET_METHODS } from './methods';

type RpcAmount = number | string;

export interface TransferDestination {
  address: string;
  amount: bigint;
  /** Empty or omitted = native BDX, otherwise hex asset id. */
  asset_id?: string;
}

export interface TransferResult {
  tx_hash: string;
  tx_key?: string;
  amount?: RpcAmount;
  fee?: RpcAmount;
}

export interface TransferSplitResult {
  tx_hash_list: string[];
  tx_key_list?: string[];
  amount_list?: RpcAmount[];
  fee_list?: RpcAmount[];
}

export interface CheckTxKeyResult {
  received: RpcAmount;
  in_pool: boolean;
  confirmations: RpcAmount;
  /** Not returned by the Proto branch today; read if a future build adds it. */
  asset_id?: string;
}

export interface WalletTransferEntry {
  txid: string;
  type?: string;
  amount?: RpcAmount;
  address?: string;
  asset_id?: string;
  height?: number;
  confirmations?: number;
  [key: string]: unknown;
}

export interface AssetBalanceEntry {
  asset_id: string;
  ticker?: string;
  balance: RpcAmount;
  unlocked_balance: RpcAmount;
}

export interface WalletBalance {
  balance: RpcAmount;
  unlocked_balance: RpcAmount;
  blocks_to_unlock?: number;
  asset_balances?: AssetBalanceEntry[];
}

export interface OwnedAsset {
  asset_id: string;
  full_name: string;
  ticker: string;
  max_supply?: RpcAmount;
  current_supply?: RpcAmount;
  decimal_point?: number;
}

export interface DeployAssetResult {
  asset_id: string;
  tx_hash: string;
  tx_key?: string;
  ticker?: string;
  full_name?: string;
  tx_fee?: RpcAmount;
}

/** beldex-wallet-rpc client. Spending methods must only be reachable from authenticated server code. */
export class WalletRpc {
  constructor(readonly client: JsonRpcClient) {}

  getAddress(accountIndex = 0): Promise<{ address: string }> {
    return this.client.call(WALLET_METHODS.getAddress, { account_index: accountIndex });
  }

  createAddress(label: string, accountIndex = 0): Promise<{ address: string; address_index: number }> {
    return this.client.call(WALLET_METHODS.createAddress, { account_index: accountIndex, label });
  }

  getBalance(accountIndex = 0): Promise<WalletBalance> {
    return this.client.call(WALLET_METHODS.getBalance, { account_index: accountIndex });
  }

  getHeight(): Promise<{ height: number }> {
    return this.client.call(WALLET_METHODS.getHeight);
  }

  transfer(destinations: TransferDestination[], priority: number): Promise<TransferResult> {
    return this.client.call(WALLET_METHODS.transfer, { destinations, priority, get_tx_key: true });
  }

  transferSplit(destinations: TransferDestination[], priority: number): Promise<TransferSplitResult> {
    return this.client.call(WALLET_METHODS.transferSplit, { destinations, priority, get_tx_keys: true });
  }

  checkTxKey(txid: string, txKey: string, address: string): Promise<CheckTxKeyResult> {
    return this.client.call(WALLET_METHODS.checkTxKey, { txid, tx_key: txKey, address });
  }

  getTxKey(txid: string): Promise<{ tx_key: string }> {
    return this.client.call(WALLET_METHODS.getTxKey, { txid });
  }

  getTransferByTxid(txid: string): Promise<{ transfer?: WalletTransferEntry; transfers?: WalletTransferEntry[] }> {
    return this.client.call(WALLET_METHODS.getTransferByTxid, { txid });
  }

  bnsHashName(name: string): Promise<{ name: string }> {
    return this.client.call(WALLET_METHODS.bnsHashName, { name });
  }

  bnsDecryptValue(name: string, type: number, encryptedValue: string): Promise<{ value: string }> {
    return this.client.call(WALLET_METHODS.bnsDecryptValue, { name, type, encrypted_value: encryptedValue });
  }

  deployNewAsset(jsonFilename: string, priority: number): Promise<DeployAssetResult> {
    return this.client.call(WALLET_METHODS.deployNewAsset, {
      json_filename: jsonFilename,
      priority,
      get_tx_key: true,
    });
  }

  emitAsset(assetId: string, amount: bigint, priority: number): Promise<TransferResult> {
    return this.client.call(WALLET_METHODS.emitAsset, { asset_id: assetId, amount, priority, get_tx_key: true });
  }

  getOwnedAssets(): Promise<{ assets?: OwnedAsset[] }> {
    return this.client.call(WALLET_METHODS.getOwnedAssets);
  }

  sign(data: string): Promise<{ signature: string }> {
    return this.client.call(WALLET_METHODS.sign, { data });
  }

  verify(data: string, address: string, signature: string): Promise<{ good: boolean }> {
    return this.client.call(WALLET_METHODS.verify, { data, address, signature });
  }
}
