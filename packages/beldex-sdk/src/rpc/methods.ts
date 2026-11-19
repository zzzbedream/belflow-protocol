// Every Beldex RPC method name BelFlow uses, verified against
// Beldex-Coin/beldex@feature-privacy-token (4d89104, 2026-11-14):
// src/wallet/wallet_rpc_server_commands_defs.h and
// src/rpc/core_rpc_server_commands_defs.h. A fork upgrade that renames a
// method is a one-line change here.

export const DAEMON_METHODS = {
  getInfo: 'get_info',
  bnsResolve: 'bns_resolve',
  getTransactions: 'get_transactions',
  getFeeEstimate: 'get_fee_estimate',
  getTokenInfo: 'get_token_info',
  getTokenList: 'get_token_list',
} as const;

export const DAEMON_PATHS = {
  getTransactions: '/get_transactions',
} as const;

export const WALLET_METHODS = {
  getAddress: 'get_address',
  createAddress: 'create_address',
  getBalance: 'get_balance',
  getHeight: 'get_height',
  transfer: 'transfer',
  transferSplit: 'transfer_split',
  checkTxKey: 'check_tx_key',
  getTxKey: 'get_tx_key',
  getTransferByTxid: 'get_transfer_by_txid',
  getTransfers: 'get_transfers',
  store: 'store',
  bnsHashName: 'bns_hash_name',
  bnsDecryptValue: 'bns_decrypt_value',
  registerPrivacyToken: 'register_privacy_token',
  mintToken: 'mint_token',
  burnToken: 'burn_token',
  updateToken: 'update_token',
  getOwnedTokens: 'get_owned_tokens',
  sign: 'sign',
  verify: 'verify',
} as const;
