import { FundsLockedError, InsufficientFundsError, RpcError, ValidationError } from '../errors';
import { JsonRpcClient } from '../rpc/JsonRpcClient';
import type { MockChain, MockTxView } from './MockChain';
import type { MockAsset, MockTx } from './state';

// Wire-safe view of MockChain: every amount is a decimal string so the same
// interface works in-process and over JSON-RPC (/api/rpc "mock_*" methods).

export interface MockBalanceDto {
  total: string;
  unlocked: string;
}

export interface MockTxKeyCheckDto {
  receivedAtomic: string;
  inPool: boolean;
  confirmations: number;
  blockHeight: number | null;
  assetId?: string;
}

export interface MockTxViewDto extends Omit<MockTxView, 'feeAtomic' | 'burnedAtomic'> {
  feeAtomic: string;
  burnedAtomic: string;
}

export interface MockOutputDto {
  address: string;
  assetId: string;
  amountAtomic: string;
}

export interface MockChainApi {
  getInfo(): Promise<{ height: number; nettype: string }>;
  createAccount(label: string): Promise<string>;
  faucet(address: string, amountAtomic: string): Promise<MockTx>;
  getBalances(address: string): Promise<Record<string, MockBalanceDto>>;
  resolveBns(name: string): Promise<string | null>;
  listAssets(): Promise<MockAsset[]>;
  deployAsset(
    owner: string,
    params: { ticker: string; name: string; decimals: number; supplyAtomic: string },
    flash: boolean,
  ): Promise<{ asset: MockAsset; tx: MockTx }>;
  transfer(from: string, outputs: MockOutputDto[], flash: boolean): Promise<MockTx>;
  checkTxKey(txHash: string, txKey: string, address: string): Promise<MockTxKeyCheckDto>;
  getTransaction(txHash: string): Promise<MockTxViewDto | null>;
  getIncomingTransfers(txHash: string, address: string): Promise<Array<{ assetId: string; amountAtomic: string }>>;
  getTxKey(txHash: string, requester: string): Promise<string>;
  mineBlocks(count: number): Promise<number>;
  /** Server-side only: the HTTP bridge never exposes signing. */
  sign?(address: string, message: string): Promise<string>;
  verify(message: string, address: string, signature: string): Promise<boolean>;
}

/** In-process implementation backed by a MockChain instance. */
export class LocalMockChainApi implements MockChainApi {
  constructor(
    readonly chain: MockChain,
    private readonly onChange?: (chain: MockChain) => void,
  ) {}

  private changed<T>(value: T): T {
    this.onChange?.(this.chain);
    return value;
  }

  async getInfo() {
    return this.chain.getInfo();
  }

  async createAccount(label: string) {
    return this.changed(this.chain.createAccount(label));
  }

  async faucet(address: string, amountAtomic: string) {
    return this.changed(this.chain.faucet(address, BigInt(amountAtomic)));
  }

  async getBalances(address: string) {
    const balances = this.chain.getBalances(address);
    return Object.fromEntries(
      Object.entries(balances).map(([id, b]) => [id, { total: b.total.toString(), unlocked: b.unlocked.toString() }]),
    );
  }

  async resolveBns(name: string) {
    return this.chain.resolveBns(name);
  }

  async listAssets() {
    return this.chain.listAssets();
  }

  async deployAsset(
    owner: string,
    params: { ticker: string; name: string; decimals: number; supplyAtomic: string },
    flash: boolean,
  ) {
    const result = this.chain.deployAsset(owner, { ...params, supply: BigInt(params.supplyAtomic) }, flash);
    return this.changed(result);
  }

  async transfer(from: string, outputs: MockOutputDto[], flash: boolean) {
    const tx = this.chain.transfer(
      from,
      outputs.map((output) => ({ address: output.address, assetId: output.assetId, amount: BigInt(output.amountAtomic) })),
      { flash },
    );
    return this.changed(tx);
  }

  async checkTxKey(txHash: string, txKey: string, address: string) {
    const check = this.chain.checkTxKey(txHash, txKey, address);
    return { ...check, receivedAtomic: check.receivedAtomic.toString() };
  }

  async getTransaction(txHash: string) {
    const view = this.chain.getTransaction(txHash);
    return view ? { ...view, feeAtomic: view.feeAtomic.toString(), burnedAtomic: view.burnedAtomic.toString() } : null;
  }

  async getIncomingTransfers(txHash: string, address: string) {
    return this.chain
      .getIncomingTransfers(txHash, address)
      .map((entry) => ({ assetId: entry.assetId, amountAtomic: entry.amount.toString() }));
  }

  async getTxKey(txHash: string, requester: string) {
    return this.chain.getTxKey(txHash, requester);
  }

  async mineBlocks(count: number) {
    return this.changed(this.chain.mineBlocks(count));
  }

  async sign(address: string, message: string) {
    return this.chain.sign(address, message);
  }

  async verify(message: string, address: string, signature: string) {
    return this.chain.verify(message, address, signature);
  }
}

/** JSON-RPC error codes the bridge uses to carry typed SDK errors. */
export const MOCK_RPC_ERRORS = {
  validation: -32602,
  fundsLocked: -32010,
  insufficientFunds: -32011,
  forbidden: -32012,
} as const;

/** Browser implementation that talks to the app's /api/rpc mock bridge. */
export class HttpMockChainApi implements MockChainApi {
  private readonly client: JsonRpcClient;

  constructor(url: string, fetchImpl?: typeof fetch) {
    this.client = new JsonRpcClient({ url, rpcPath: '', ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  }

  private async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    try {
      return await this.client.call<T>(`mock_${method}`, params);
    } catch (error) {
      if (error instanceof RpcError) {
        if (error.rpcCode === MOCK_RPC_ERRORS.fundsLocked) {
          const height = Number(/block (\d+)/.exec(error.message)?.[1] ?? -1);
          throw new FundsLockedError(String(params.tokenId ?? 'funds'), height);
        }
        if (error.rpcCode === MOCK_RPC_ERRORS.insufficientFunds) throw new InsufficientFundsError(String(params.tokenId ?? 'funds'));
        if (error.rpcCode === MOCK_RPC_ERRORS.validation) throw new ValidationError(error.message);
      }
      throw error;
    }
  }

  getInfo() {
    return this.call<{ height: number; nettype: string }>('getInfo', {});
  }
  createAccount(label: string) {
    return this.call<string>('createAccount', { label });
  }
  faucet(address: string, amountAtomic: string) {
    return this.call<MockTx>('faucet', { address, amountAtomic });
  }
  getBalances(address: string) {
    return this.call<Record<string, MockBalanceDto>>('getBalances', { address });
  }
  resolveBns(name: string) {
    return this.call<string | null>('resolveBns', { name });
  }
  listAssets() {
    return this.call<MockAsset[]>('listAssets', {});
  }
  deployAsset(owner: string, params: { ticker: string; name: string; decimals: number; supplyAtomic: string }, flash: boolean) {
    return this.call<{ asset: MockAsset; tx: MockTx }>('deployAsset', { owner, params, flash });
  }
  transfer(from: string, outputs: MockOutputDto[], flash: boolean) {
    return this.call<MockTx>('transfer', { from, outputs, flash });
  }
  checkTxKey(txHash: string, txKey: string, address: string) {
    return this.call<MockTxKeyCheckDto>('checkTxKey', { txHash, txKey, address });
  }
  getTransaction(txHash: string) {
    return this.call<MockTxViewDto | null>('getTransaction', { txHash });
  }
  getIncomingTransfers(txHash: string, address: string) {
    return this.call<Array<{ assetId: string; amountAtomic: string }>>('getIncomingTransfers', { txHash, address });
  }
  getTxKey(txHash: string, requester: string) {
    return this.call<string>('getTxKey', { txHash, requester });
  }
  mineBlocks(count: number) {
    return this.call<number>('mineBlocks', { count });
  }
  verify(message: string, address: string, signature: string) {
    return this.call<boolean>('verify', { message, address, signature });
  }
}
