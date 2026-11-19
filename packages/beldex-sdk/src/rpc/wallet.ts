import type { JsonRpcClient } from './JsonRpcClient';
import { stringifyJsonSafe } from './json';
import { WALLET_METHODS } from './methods';

// Request and response shapes of beldex-wallet-rpc on feature-privacy-token
// (src/wallet/wallet_rpc_server_commands_defs.h, transfer_destination.h,
// transfer_view.cpp). Token ids are hex; an empty or omitted token_id is BDX.

type RpcAmount = number | string;

export interface TransferDestination {
  address: string;
  amount: bigint;
  /** Empty or omitted = native BDX, otherwise the hex token id. */
  token_id?: string;
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

export interface TokenReceivedEntry {
  token_id: string;
  amount: RpcAmount;
}

export interface CheckTxKeyResult {
  /** Native BDX paid to the address (txout_to_key outputs only). */
  received: RpcAmount;
  /** Privacy tokens paid to the address (tx_out_zyphora outputs), one entry per token id. */
  token_received?: TokenReceivedEntry[];
  in_pool: boolean;
  confirmations: RpcAmount;
}

export interface WalletTransferEntry {
  txid: string;
  type?: string;
  amount?: RpcAmount;
  address?: string;
  /** Omitted or empty for BDX. */
  token_id?: string;
  height?: number;
  timestamp?: number;
  confirmations?: number;
  destinations?: Array<{ address: string; amount: RpcAmount; token_id?: string }>;
  [key: string]: unknown;
}

export interface TokenBalanceEntry {
  token_id: string;
  ticker?: string;
  balance: RpcAmount;
  unlocked_balance: RpcAmount;
}

export interface WalletBalance {
  balance: RpcAmount;
  unlocked_balance: RpcAmount;
  blocks_to_unlock?: number;
  token_balances?: TokenBalanceEntry[];
}

export interface OwnedToken {
  token_id: string;
  full_name: string;
  ticker: string;
  max_supply?: RpcAmount;
  current_supply?: RpcAmount;
  decimal_point?: number;
  meta_info?: string;
}

/** Token descriptor accepted inline by register_privacy_token (json_string). */
export interface TokenDescriptor {
  ticker: string;
  full_name: string;
  total_max_supply: bigint;
  current_supply: bigint;
  decimal_point: number;
  meta_info: string;
}

export interface RegisterTokenResult {
  token_id: string;
  tx_hash: string;
  tx_key?: string;
  ticker?: string;
  full_name?: string;
  tx_fee?: RpcAmount;
}

export interface TokenOperationResult {
  tx_hash: string;
  tx_key?: string;
  fee?: RpcAmount;
}

/** TOKEN_DESCRIPTOR_VERSION in src/cryptonote_basic/token_descriptor.h. */
export const TOKEN_DESCRIPTOR_VERSION = 1;

/** Serializes a descriptor with u64 amounts as plain JSON numbers. */
export const descriptorJson = (descriptor: TokenDescriptor): string =>
  stringifyJsonSafe({ version: TOKEN_DESCRIPTOR_VERSION, ...descriptor });

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

  transfer(destinations: TransferDestination[], priority: number, accountIndex = 0): Promise<TransferResult> {
    return this.client.call(WALLET_METHODS.transfer, { destinations, priority, get_tx_key: true, account_index: accountIndex });
  }

  transferSplit(destinations: TransferDestination[], priority: number, accountIndex = 0): Promise<TransferSplitResult> {
    return this.client.call(WALLET_METHODS.transferSplit, { destinations, priority, get_tx_keys: true, account_index: accountIndex });
  }

  /** Outgoing/pending/pool transfers as recorded in the wallet cache (destinations included for "out"). */
  getTransfers(params: { out?: boolean; pending?: boolean; pool?: boolean; minHeight?: number; accountIndex?: number }): Promise<{
    out?: WalletTransferEntry[];
    pending?: WalletTransferEntry[];
    pool?: WalletTransferEntry[];
  }> {
    return this.client.call(WALLET_METHODS.getTransfers, {
      out: params.out ?? true,
      pending: params.pending ?? true,
      pool: params.pool ?? true,
      in: false,
      account_index: params.accountIndex ?? 0,
      ...(params.minHeight !== undefined ? { filter_by_height: true, min_height: params.minHeight } : {}),
    });
  }

  /** Flushes the wallet file to disk (outgoing destinations and tx keys). */
  store(): Promise<Record<string, never>> {
    return this.client.call(WALLET_METHODS.store);
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

  /** Registers a privacy token from an inline descriptor; no file is shared with the wallet host. */
  registerPrivacyToken(descriptor: TokenDescriptor, priority: number, accountIndex = 0): Promise<RegisterTokenResult> {
    return this.client.call(WALLET_METHODS.registerPrivacyToken, {
      json_string: descriptorJson(descriptor),
      priority,
      account_index: accountIndex,
      get_tx_key: true,
    });
  }

  mintToken(tokenId: string, amount: bigint, priority: number, accountIndex = 0): Promise<TokenOperationResult> {
    return this.client.call(WALLET_METHODS.mintToken, { token_id: tokenId, amount, priority, account_index: accountIndex, get_tx_key: true });
  }

  burnToken(tokenId: string, amount: bigint, priority: number, accountIndex = 0): Promise<TokenOperationResult> {
    return this.client.call(WALLET_METHODS.burnToken, { token_id: tokenId, amount, priority, account_index: accountIndex, get_tx_key: true });
  }

  updateToken(tokenId: string, descriptor: TokenDescriptor, priority: number, accountIndex = 0): Promise<TokenOperationResult> {
    return this.client.call(WALLET_METHODS.updateToken, {
      token_id: tokenId,
      json_string: descriptorJson(descriptor),
      priority,
      account_index: accountIndex,
      get_tx_key: true,
    });
  }

  getOwnedTokens(): Promise<{ tokens?: OwnedToken[] }> {
    return this.client.call(WALLET_METHODS.getOwnedTokens);
  }

  sign(data: string): Promise<{ signature: string }> {
    return this.client.call(WALLET_METHODS.sign, { data });
  }

  verify(data: string, address: string, signature: string): Promise<{ good: boolean }> {
    return this.client.call(WALLET_METHODS.verify, { data, address, signature });
  }
}
