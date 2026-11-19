// Offline emulator of beldex-wallet-rpc and beldexd JSON-RPC as built from
// Beldex-Coin/beldex@feature-privacy-token, backed by the deterministic
// MockChain. It speaks the method names and payload shapes BelFlow uses
// against the real testnet, so the orchestrator can run end to end in CI and
// with --emulate.
//
// Deliberate fidelity choices:
// - check_tx_key returns { received, token_received, in_pool, confirmations }:
//   BDX in `received`, each privacy token in `token_received`.
// - register_privacy_token takes the descriptor inline (json_string) and issues
//   current_supply; registration fees and collateral are not modelled.
// - Subaddresses get distinct addresses and are scanned by get_transfer_by_txid.
//   Simplification: funds sent to a subaddress are not spendable by the parent
//   account here (a real wallet would include them in the account balance).
// - get_transactions returns key-only outputs: MockChain does not build real
//   tx_out_zyphora cryptography, so BelFlow's zyphora decoder is exercised by
//   its unit tests and by the live run, not here.

import { FundsLockedError, InsufficientFundsError, MockChain, parseJsonSafe, stringifyJsonSafe } from '@belflow/sdk';

export interface EmulatorOptions {
  seed?: string;
  /** BDX (atomic) credited to account 0 at start. 0 = unfunded wallet. */
  fundAtomic?: bigint;
}

type Params = Record<string, unknown>;
type Handler = (params: Params) => unknown | Promise<unknown>;

class RpcFault extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

const FLASH_PRIORITY = 5;
const NATIVE = 'BDX';
const tokenIdOf = (assetId: string) => (assetId === NATIVE ? '' : assetId);

export function createBeldexEmulator(options: EmulatorOptions = {}) {
  const chain = new MockChain({ seed: options.seed ?? 'belflow-emulator', startHeight: 4_283_500 });
  const labelFor = (accountIndex: unknown) => (Number(accountIndex ?? 0) === 0 ? 'treasury' : `treasury#${Number(accountIndex)}`);
  const addressOf = (accountIndex: unknown) => chain.createAccount(labelFor(accountIndex));
  if ((options.fundAtomic ?? 0n) > 0n) chain.faucet(addressOf(0), options.fundAtomic as bigint);

  const run = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (error) {
      if (error instanceof FundsLockedError) throw new RpcFault(-37, 'not enough unlocked money');
      if (error instanceof InsufficientFundsError) throw new RpcFault(-16, 'not enough money');
      throw new RpcFault(-1, (error as Error).message);
    }
  };

  const transfer = (params: Params) => {
    const destinations = (params.destinations as Array<{ address: string; amount: number | string | bigint; token_id?: string }>) ?? [];
    const from = addressOf(params.account_index);
    return run(() =>
      chain.transfer(
        from,
        destinations.map((d) => ({ address: d.address, assetId: d.token_id || NATIVE, amount: BigInt(d.amount) })),
        { flash: Number(params.priority) === FLASH_PRIORITY },
      ),
    );
  };

  // Every address this wallet owns (main addresses + created subaddresses).
  const owned = new Set<string>([addressOf(0)]);
  let subaddressCounter = 0;

  const wallet: Record<string, Handler> = {
    get_address: (p) => {
      const address = addressOf(p.account_index);
      owned.add(address);
      return { address };
    },
    create_address: (p) => {
      subaddressCounter += 1;
      const address = chain.createAccount(`${labelFor(p.account_index)}:sub:${subaddressCounter}`);
      owned.add(address);
      return { address, address_index: subaddressCounter };
    },
    get_height: () => ({ height: chain.height + 1 }),
    store: () => ({}),
    get_balance: (p) => {
      const balances = chain.getBalances(addressOf(p.account_index));
      const bdx = balances[NATIVE] ?? { total: 0n, unlocked: 0n };
      return {
        balance: bdx.total,
        unlocked_balance: bdx.unlocked,
        token_balances: Object.entries(balances)
          .filter(([id]) => id !== NATIVE)
          .map(([id, b]) => ({ token_id: id, ticker: chain.getAsset(id)?.ticker, balance: b.total, unlocked_balance: b.unlocked })),
      };
    },
    transfer: (p) => {
      const tx = transfer(p);
      return { tx_hash: tx.txHash, tx_key: tx.txKey, fee: BigInt(tx.fee) };
    },
    transfer_split: (p) => {
      const tx = transfer(p);
      return { tx_hash_list: [tx.txHash], tx_key_list: [tx.txKey], fee_list: [BigInt(tx.fee)] };
    },
    register_privacy_token: (p) => {
      if (typeof p.json_string !== 'string' || p.json_string === '') throw new RpcFault(-1, 'json_string is required by this emulator');
      const descriptor = parseJsonSafe<{ ticker: string; full_name: string; current_supply: string | number; decimal_point: number }>(p.json_string);
      const { asset, tx } = run(() =>
        chain.deployAsset(addressOf(p.account_index), {
          ticker: descriptor.ticker,
          name: descriptor.full_name,
          decimals: descriptor.decimal_point,
          supply: BigInt(descriptor.current_supply),
        }),
      );
      return { token_id: asset.assetId, tx_hash: tx.txHash, tx_key: tx.txKey, ticker: asset.ticker, full_name: asset.name, tx_fee: BigInt(tx.fee) };
    },
    mint_token: (p) => {
      const tx = run(() => chain.emitAsset(addressOf(p.account_index), String(p.token_id), BigInt(p.amount as string)));
      return { tx_hash: tx.txHash, tx_key: tx.txKey, fee: BigInt(tx.fee) };
    },
    get_owned_tokens: () => ({
      tokens: chain.listAssets().map((a) => ({ token_id: a.assetId, full_name: a.name, ticker: a.ticker, decimal_point: a.decimals })),
    }),
    check_tx_key: (p) => {
      const check = run(() => chain.checkTxKey(String(p.txid), String(p.tx_key), String(p.address)));
      return {
        received: check.receivedAtomic,
        token_received: (check.tokenReceived ?? []).map((entry) => ({ token_id: entry.tokenId, amount: entry.amountAtomic })),
        in_pool: check.inPool,
        confirmations: check.confirmations,
      };
    },
    get_transfer_by_txid: (p) => {
      const view = chain.getTransaction(String(p.txid));
      const transfers = [...owned].flatMap((address) =>
        chain
          .getIncomingTransfers(String(p.txid), address)
          .map((entry) => ({ txid: p.txid, type: view?.inPool ? 'pool' : 'in', amount: entry.amount, address, token_id: tokenIdOf(entry.assetId) })),
      );
      return { transfers };
    },
    get_transfers: (p) => {
      const txs = chain.getOutgoingTransfers(addressOf(p.account_index), p.min_height as number | undefined);
      const entry = (tx: (typeof txs)[number]) => ({
        txid: tx.txHash,
        height: tx.height ?? 0,
        timestamp: tx.timestamp,
        destinations: tx.outputs.map((o) => ({ address: o.address, amount: BigInt(o.amount), token_id: tokenIdOf(o.assetId) })),
      });
      return { out: txs.filter((tx) => tx.height !== null).map(entry), pool: txs.filter((tx) => tx.height === null).map(entry) };
    },
    sign: (p) => ({ signature: chain.sign(addressOf(0), String(p.data)) }),
    verify: (p) => ({ good: chain.verify(String(p.data), String(p.address), String(p.signature)) }),
  };

  const daemon: Record<string, Handler> = {
    get_info: () => ({ height: chain.height + 1, nettype: 'testnet', testnet: true, status: 'OK', current_hf_version: 22 }),
    get_fee_estimate: () => ({ fee_per_output: 10_000_000, fee_per_byte: 6_510 }),
    get_token_info: (p) => {
      const asset = chain.getAsset(String(p.token_id));
      if (!asset) throw new RpcFault(-1, 'Token not found');
      return { token_id: asset.assetId, ticker: asset.ticker, full_name: asset.name, current_supply: asset.currentSupply, total_max_supply: asset.currentSupply, decimal_point: asset.decimals };
    },
    get_transactions: (p) => ({
      txs: ((p.txs_hashes as string[]) ?? []).flatMap((hash) => {
        const view = chain.getTransaction(hash);
        if (!view) return [];
        const outputs = view.assetIds.map((_assetId, index) => ({ amount: 0, target: { key: `${hash.slice(0, 60)}${index.toString(16).padStart(4, '0')}` } }));
        return [{ tx_hash: hash, in_pool: view.inPool, flash: view.flash, block_height: view.blockHeight ?? 0, as_json: JSON.stringify({ version: 4, vout: outputs }) }];
      }),
    }),
  };

  const toFetch = (handlers: Record<string, Handler>): typeof fetch =>
    (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = parseJsonSafe<{ id: string; method: string; params?: Params }>(String(init?.body ?? '{}'));
      const handler = Object.hasOwn(handlers, body.method) ? handlers[body.method] : undefined;
      if (!handler) return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } }));
      try {
        const result = await handler(body.params ?? {});
        return new Response(stringifyJsonSafe({ jsonrpc: '2.0', id: body.id, result }));
      } catch (error) {
        const fault = error instanceof RpcFault ? error : new RpcFault(-1, (error as Error).message);
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: fault.code, message: fault.message } }));
      }
    }) as typeof fetch;

  return {
    chain,
    walletFetch: toFetch(wallet),
    daemonFetch: toFetch(daemon),
    /** Simulates block production (each call = `count` blocks). */
    mine: (count = 1) => chain.mineBlocks(count),
  };
}

export type BeldexEmulator = ReturnType<typeof createBeldexEmulator>;
