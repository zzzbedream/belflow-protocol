import { BNS_TYPE_WALLET } from '../constants';
import { RpcError } from '../errors';
import type { JsonRpcClient } from './JsonRpcClient';
import { DAEMON_METHODS, DAEMON_PATHS } from './methods';

export interface DaemonInfo {
  height: number;
  nettype?: string;
  testnet?: boolean;
  mainnet?: boolean;
  current_hf_version?: number;
  status?: string;
}

export interface DaemonTxEntry {
  tx_hash: string;
  as_json?: string;
  in_pool?: boolean;
  flash?: boolean;
  block_height?: number;
  block_timestamp?: number;
  burned?: number | string;
  fee?: number | string;
  [key: string]: unknown;
}

export interface FeeEstimate {
  fee_per_byte?: number | string;
  fee_per_output?: number | string;
  flash_fee_per_byte?: number | string;
  flash_fee_per_output?: number | string;
  flash_fee_fixed?: number | string;
}

const METHOD_NOT_FOUND = -32601;

/** Read-only daemon (beldexd) RPC used for BNS, tx inspection and network info. */
export class DaemonRpc {
  constructor(readonly client: JsonRpcClient) {}

  getInfo(): Promise<DaemonInfo> {
    return this.client.call<DaemonInfo>(DAEMON_METHODS.getInfo);
  }

  /** nameHashHex: 32-byte BLAKE2b hash of the lowercase name, hex encoded. */
  bnsResolve(nameHashHex: string, type: number = BNS_TYPE_WALLET): Promise<{ encrypted_value?: string; nonce?: string }> {
    return this.client.call(DAEMON_METHODS.bnsResolve, { type, name_hash: nameHashHex });
  }

  getFeeEstimate(): Promise<FeeEstimate> {
    return this.client.call<FeeEstimate>(DAEMON_METHODS.getFeeEstimate);
  }

  /**
   * Fetches decoded transactions. Oxen-lineage daemons accept get_transactions
   * on /json_rpc; older builds only expose the legacy /get_transactions path.
   */
  async getTransactions(txHashes: string[]): Promise<DaemonTxEntry[]> {
    const params = { txs_hashes: txHashes, decode_as_json: true, tx_extra: true };
    try {
      const result = await this.client.call<{ txs?: DaemonTxEntry[] }>(DAEMON_METHODS.getTransactions, params);
      return result.txs ?? [];
    } catch (error) {
      if (!(error instanceof RpcError) || error.rpcCode !== METHOD_NOT_FOUND) throw error;
      const legacy = await this.client.callPath<{ txs?: DaemonTxEntry[] }>(DAEMON_PATHS.getTransactions, params);
      return legacy.txs ?? [];
    }
  }
}
