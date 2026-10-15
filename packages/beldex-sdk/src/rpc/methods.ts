// Every Beldex RPC method name BelFlow uses, verified against
// Beldex-Coin/beldex@feature-confidential-asset. A fork upgrade that renames
// a method is a one-line change here.

export const DAEMON_METHODS = {
  getInfo: 'get_info',
  bnsResolve: 'bns_resolve',
  getTransactions: 'get_transactions',
  getFeeEstimate: 'get_fee_estimate',
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
  bnsHashName: 'bns_hash_name',
  bnsDecryptValue: 'bns_decrypt_value',
  deployNewAsset: 'deploy_new_asset',
  emitAsset: 'emit_asset',
  getOwnedAssets: 'get_owned_assets',
  sign: 'sign',
  verify: 'verify',
} as const;
