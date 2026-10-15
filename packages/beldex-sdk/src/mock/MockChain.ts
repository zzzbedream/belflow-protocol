import { encodeAddress, decodeAddress } from '../address/address';
import { CHANGE_UNLOCK_BLOCKS, MAX_RECIPIENTS_PER_TX, NATIVE_TOKEN_ID } from '../constants';
import { ValidationError } from '../errors';
import { DEFAULT_FEE_SCHEDULE, estimateTxFee, type FeeSchedule } from '../fees';
import type { TxKeyCheck } from '../types';
import { digestHex, hmacHex, timingSafeEqualHex } from './hash';
import { credit, spend, spendableOf, totalOf } from './ledger';
import { emptyState, type MockAccount, type MockAsset, type MockChainState, type MockOutput, type MockTx } from './state';

export interface MockChainOptions {
  seed?: string;
  startHeight?: number;
  /** Mine a block after every non-flash transaction (flash txs stay in the mempool). */
  autoMine?: boolean;
  feeSchedule?: FeeSchedule;
}

export interface MockTransferOutput {
  address: string;
  assetId: string;
  amount: bigint;
}

export interface MockTxView {
  txHash: string;
  inPool: boolean;
  flash: boolean;
  blockHeight: number | null;
  assetIds: string[];
  feeAtomic: bigint;
  burnedAtomic: bigint;
  timestamp: number;
}

export interface MockBalance {
  total: bigint;
  unlocked: bigint;
}

const GENESIS_TIMESTAMP = 1_790_000_000;
const BLOCK_TIME_SECONDS = 30;
/** Own-property lookup: plain-object maps must never resolve "__proto__" or "constructor". */
function own<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

const DEFAULT_SEED = 'belflow-mock-devnet';
const DEFAULT_START_HEIGHT = 4_250_000;
const SIGNATURE_PREFIX = 'MockSigV1';
const TICKER_PATTERN = /^[A-Za-z0-9]{2,12}$/;

/**
 * Deterministic in-memory Beldex chain. Same seed + same calls = same hashes,
 * keys and addresses. Used by tests and by the web app's mock-devnet mode.
 */
export class MockChain {
  private state: MockChainState;
  private readonly autoMine: boolean;
  private readonly feeSchedule: FeeSchedule;

  constructor(options: MockChainOptions = {}, snapshot?: MockChainState) {
    this.state = snapshot
      ? (JSON.parse(JSON.stringify(snapshot)) as MockChainState)
      : emptyState(options.seed ?? DEFAULT_SEED, options.startHeight ?? DEFAULT_START_HEIGHT);
    this.autoMine = options.autoMine ?? true;
    this.feeSchedule = options.feeSchedule ?? DEFAULT_FEE_SCHEDULE;
  }

  static fromSnapshot(snapshot: MockChainState, options: MockChainOptions = {}): MockChain {
    if (snapshot.version !== 1) throw new ValidationError('Unsupported mock chain snapshot version.');
    return new MockChain(options, snapshot);
  }

  snapshot(): MockChainState {
    return JSON.parse(JSON.stringify(this.state)) as MockChainState;
  }

  get height(): number {
    return this.state.height;
  }

  getInfo(): { height: number; nettype: 'mock-devnet'; current_hf_version: number; status: 'OK' } {
    return { height: this.state.height, nettype: 'mock-devnet', current_hf_version: 22, status: 'OK' };
  }

  // ---------------------------------------------------------------- accounts

  /** Deterministic testnet-format address for a label. Registers the account. */
  createAccount(label: string): string {
    const address = encodeAddress({
      network: 'testnet',
      kind: 'standard',
      spendPublicKey: digestHex(this.state.seed, 'spend', label),
      viewPublicKey: digestHex(this.state.seed, 'view', label),
    });
    const existing = own(this.state.accounts, address);
    if (!existing || existing.label === 'external') {
      const account: MockAccount = { label, utxos: existing?.utxos ?? {} };
      this.state = { ...this.state, accounts: { ...this.state.accounts, [address]: account } };
    }
    return address;
  }

  hasAccount(address: string): boolean {
    return own(this.state.accounts, address) !== undefined;
  }

  getBalances(address: string): Record<string, MockBalance> {
    const account = own(this.state.accounts, address);
    if (!account) return { [NATIVE_TOKEN_ID]: { total: 0n, unlocked: 0n } };
    const result: Record<string, MockBalance> = { [NATIVE_TOKEN_ID]: { total: 0n, unlocked: 0n } };
    for (const [tokenId, utxos] of Object.entries(account.utxos)) {
      result[tokenId] = { total: totalOf(utxos), unlocked: spendableOf(utxos, this.state.height) };
    }
    return result;
  }

  faucet(address: string, amount: bigint): MockTx {
    decodeAddress(address);
    const account = this.accountOrExternal(address);
    const updated = this.withUtxos(account, NATIVE_TOKEN_ID, credit(own(account.utxos, NATIVE_TOKEN_ID) ?? [], amount, 0));
    const tx = this.buildTx({
      kind: 'faucet',
      from: 'faucet',
      outputs: [{ address, assetId: NATIVE_TOKEN_ID, amount: amount.toString() }],
      fee: 0n,
      burned: 0n,
      flash: false,
      height: this.state.height,
    });
    this.commit({ [address]: updated }, tx, false);
    return tx;
  }

  // -------------------------------------------------------------------- BNS

  registerBns(name: string, address: string): void {
    decodeAddress(address);
    this.state = { ...this.state, bns: { ...this.state.bns, [name.toLowerCase()]: address } };
  }

  resolveBns(name: string): string | null {
    return own(this.state.bns, name.toLowerCase()) ?? null;
  }

  // ----------------------------------------------------------------- assets

  listAssets(): MockAsset[] {
    return Object.values(this.state.assets);
  }

  getAsset(assetId: string): MockAsset | null {
    return own(this.state.assets, assetId) ?? null;
  }

  deployAsset(
    owner: string,
    params: { ticker: string; name: string; decimals: number; supply: bigint },
    flash = false,
  ): { asset: MockAsset; tx: MockTx } {
    const ticker = params.ticker.trim();
    if (!TICKER_PATTERN.test(ticker)) {
      throw new ValidationError('Ticker must be 2-12 alphanumeric characters.');
    }
    if (ticker.toUpperCase() === NATIVE_TOKEN_ID) throw new ValidationError('BDX is reserved.');
    if (this.listAssets().some((asset) => asset.ticker.toLowerCase() === ticker.toLowerCase())) {
      throw new ValidationError(`Ticker ${ticker} already exists on this chain.`);
    }
    if (params.supply <= 0n) throw new ValidationError('Initial supply must be positive.');

    const assetId = digestHex(this.state.seed, 'asset', ticker, this.state.sequence);
    const asset: MockAsset = {
      assetId,
      ticker,
      name: params.name.trim(),
      decimals: params.decimals,
      maxSupply: params.supply.toString(),
      currentSupply: params.supply.toString(),
      owner,
    };
    const tx = this.executeTransfer(owner, [], flash, {
      kind: 'deploy',
      mint: { address: owner, assetId, amount: params.supply },
    });
    this.state = { ...this.state, assets: { ...this.state.assets, [assetId]: asset } };
    return { asset, tx };
  }

  // -------------------------------------------------------------- transfers

  transfer(from: string, outputs: MockTransferOutput[], options: { flash: boolean }): MockTx {
    if (outputs.length === 0) throw new ValidationError('A transfer needs at least one output.');
    if (outputs.length > MAX_RECIPIENTS_PER_TX) {
      throw new ValidationError(`At most ${MAX_RECIPIENTS_PER_TX} outputs per transaction.`);
    }
    for (const output of outputs) {
      decodeAddress(output.address);
      if (output.amount <= 0n) throw new ValidationError('Output amounts must be positive.');
      if (output.assetId !== NATIVE_TOKEN_ID && !own(this.state.assets, output.assetId)) {
        throw new ValidationError(`Unknown asset ${output.assetId}.`);
      }
    }
    return this.executeTransfer(from, outputs, options.flash, { kind: 'transfer' });
  }

  mineBlocks(count = 1): number {
    const included = this.state.height + 1;
    const txs = { ...this.state.txs };
    for (const hash of this.state.mempool) {
      const tx = txs[hash];
      if (tx) txs[hash] = { ...tx, height: included };
    }
    this.state = { ...this.state, height: this.state.height + count, txs, mempool: [] };
    return this.state.height;
  }

  // ----------------------------------------------------------- verification

  checkTxKey(txHash: string, txKey: string, address: string): TxKeyCheck {
    const tx = this.requireTx(txHash);
    const keyMatches = /^[0-9a-f]{64}$/i.test(txKey) && timingSafeEqualHex(tx.txKey, txKey.toLowerCase());
    const received = keyMatches ? tx.outputs.filter((output) => output.address === address) : [];
    const assets = [...new Set(received.map((output) => output.assetId))];
    return {
      receivedAtomic: received.reduce((sum, output) => sum + BigInt(output.amount), 0n),
      inPool: tx.height === null,
      confirmations: tx.height === null ? 0 : this.state.height - tx.height + 1,
      blockHeight: tx.height,
      ...(assets.length === 1 ? { assetId: assets[0] } : {}),
    };
  }

  getTxKey(txHash: string, requester: string): string {
    const tx = this.requireTx(txHash);
    if (tx.from !== requester) throw new ValidationError('Only the sender can export the tx key.');
    return tx.txKey;
  }

  getTransaction(txHash: string): MockTxView | null {
    const tx = own(this.state.txs, txHash);
    if (!tx) return null;
    return {
      txHash,
      inPool: tx.height === null,
      flash: tx.flash,
      blockHeight: tx.height,
      assetIds: [...new Set(tx.outputs.map((output) => output.assetId))],
      feeAtomic: BigInt(tx.fee),
      burnedAtomic: BigInt(tx.burned),
      timestamp: tx.timestamp,
    };
  }

  /** What the sending wallet's cache reports (get_transfers "out"/"pool"), change excluded. */
  getOutgoingTransfers(from: string, sinceHeight?: number): MockTx[] {
    return Object.values(this.state.txs).filter(
      (tx) => tx.from === from && tx.kind === 'transfer' && (sinceHeight === undefined || tx.height === null || tx.height >= sinceHeight),
    );
  }

  /** What the receiving wallet sees for an incoming tx (get_transfer_by_txid). */
  getIncomingTransfers(txHash: string, address: string): Array<{ assetId: string; amount: bigint }> {
    const tx = own(this.state.txs, txHash);
    if (!tx) return [];
    return tx.outputs
      .filter((output) => output.address === address)
      .map((output) => ({ assetId: output.assetId, amount: BigInt(output.amount) }));
  }

  sign(address: string, message: string): string {
    const account = own(this.state.accounts, address);
    if (!account || account.label === 'external') {
      throw new ValidationError('This mock chain does not hold the keys for that address.');
    }
    return `${SIGNATURE_PREFIX}${hmacHex(digestHex(this.state.seed, 'sign', address), message)}`;
  }

  verify(message: string, address: string, signature: string): boolean {
    if (!signature.startsWith(SIGNATURE_PREFIX)) return false;
    const expected = hmacHex(digestHex(this.state.seed, 'sign', address), message);
    return timingSafeEqualHex(signature.slice(SIGNATURE_PREFIX.length), expected);
  }

  // --------------------------------------------------------------- internals

  private executeTransfer(
    from: string,
    outputs: MockTransferOutput[],
    flash: boolean,
    options: { kind: 'transfer' | 'deploy'; mint?: MockTransferOutput },
  ): MockTx {
    const sender = own(this.state.accounts, from);
    if (!sender || sender.label === 'external') throw new ValidationError('Unknown sender account.');

    const outputCount = outputs.length + (options.mint ? 1 : 0) + 1;
    const fee = estimateTxFee({ outputs: outputCount, flash, schedule: this.feeSchedule });
    const txHeight = this.state.height + 1;
    const unlockHeight = txHeight + CHANGE_UNLOCK_BLOCKS;

    const needs = new Map<string, bigint>([[NATIVE_TOKEN_ID, fee.totalAtomic]]);
    for (const output of outputs) needs.set(output.assetId, (needs.get(output.assetId) ?? 0n) + output.amount);

    let senderAfter: MockAccount = sender;
    for (const [tokenId, needed] of needs) {
      const utxos = spend({ utxos: own(senderAfter.utxos, tokenId) ?? [], needed, height: this.state.height, changeUnlockHeight: unlockHeight, tokenId });
      senderAfter = this.withUtxos(senderAfter, tokenId, utxos);
    }

    const updates: Record<string, MockAccount> = { [from]: senderAfter };
    const allOutputs = options.mint ? [...outputs, options.mint] : outputs;
    for (const output of allOutputs) {
      const current = updates[output.address] ?? this.accountOrExternal(output.address);
      updates[output.address] = this.withUtxos(
        current,
        output.assetId,
        credit(own(current.utxos, output.assetId) ?? [], output.amount, unlockHeight),
      );
    }

    const tx = this.buildTx({
      kind: options.kind,
      from,
      outputs: allOutputs.map((output): MockOutput => ({ ...output, amount: output.amount.toString() })),
      fee: fee.totalAtomic,
      burned: fee.burnedAtomic,
      flash,
      height: null,
    });
    this.commit(updates, tx, true);
    if (this.autoMine && !flash) this.mineBlocks(1);
    return own(this.state.txs, tx.txHash) as MockTx;
  }

  private buildTx(params: {
    kind: MockTx['kind'];
    from: string;
    outputs: MockOutput[];
    fee: bigint;
    burned: bigint;
    flash: boolean;
    height: number | null;
  }): MockTx {
    const sequence = this.state.sequence;
    return {
      txHash: digestHex(this.state.seed, 'tx', sequence),
      txKey: digestHex(this.state.seed, 'txkey', sequence),
      kind: params.kind,
      from: params.from,
      outputs: params.outputs,
      fee: params.fee.toString(),
      burned: params.burned.toString(),
      flash: params.flash,
      height: params.height,
      timestamp: GENESIS_TIMESTAMP + (params.height ?? this.state.height + 1) * BLOCK_TIME_SECONDS,
    };
  }

  private commit(accounts: Record<string, MockAccount>, tx: MockTx, toMempool: boolean): void {
    this.state = {
      ...this.state,
      sequence: this.state.sequence + 1,
      accounts: { ...this.state.accounts, ...accounts },
      txs: { ...this.state.txs, [tx.txHash]: tx },
      mempool: toMempool ? [...this.state.mempool, tx.txHash] : this.state.mempool,
    };
  }

  private accountOrExternal(address: string): MockAccount {
    return own(this.state.accounts, address) ?? { label: 'external', utxos: {} };
  }

  private withUtxos(account: MockAccount, tokenId: string, utxos: MockAccount['utxos'][string]): MockAccount {
    return { ...account, utxos: { ...account.utxos, [tokenId]: utxos } };
  }

  private requireTx(txHash: string): MockTx {
    const tx = own(this.state.txs, txHash);
    if (!tx) throw new ValidationError('Transaction not found on the mock chain.');
    return tx;
  }
}
