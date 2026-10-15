import { describe, expect, it } from 'vitest';
import { FundsLockedError, InsufficientFundsError, OutcomeUnknownError } from '../../src/errors';
import { LocalMockChainApi } from '../../src/mock/api';
import { MockChain } from '../../src/mock/MockChain';
import { waitForUnlockedFunds, hasUnlockedFunds } from '../../src/providers/funds';
import { MockTestnetProvider } from '../../src/providers/MockTestnetProvider';
import { matchOutgoing, type OutgoingTransfer } from '../../src/providers/reconcile';
import { WalletRpcProvider } from '../../src/providers/WalletRpcProvider';
import { JsonRpcClient } from '../../src/rpc/JsonRpcClient';
import { WalletRpc } from '../../src/rpc/wallet';
import { rpcFetch } from '../helpers';

// AUD-04 primitives: reconciling an uncertain broadcast without ever matching
// an older identical payment, and waiting for 2-block change unlocks.

const A = 'addrA';
const B = 'addrB';
const tx = (hash: string, height: number | null, dests: Array<[string, bigint]>, timestamp: number | null = 1_000): OutgoingTransfer => ({
  txHash: hash,
  height,
  timestamp,
  destinations: dests.map(([address, amountAtomic]) => ({ address, amountAtomic, assetId: 'BDX' })),
});
const expected = [
  { address: A, amountAtomic: 5n, assetId: 'BDX' },
  { address: B, amountAtomic: 7n, assetId: 'BDX' },
];

describe('AUD-04 reconciliation matcher', () => {
  it('finds a chunk split across two txs and reports complete', () => {
    const match = matchOutgoing([tx('h1', 100, [[A, 5n]]), tx('h2', 100, [[B, 7n]])], expected, { sinceHeight: 99 });
    expect(match).toEqual({ complete: true, txHashes: ['h1', 'h2'], matchedOutputs: 2 });
  });

  it('ignores an identical older payment (below start height, before start time, or already attributed)', () => {
    const old = tx('old', 50, [[A, 5n], [B, 7n]], 10);
    expect(matchOutgoing([old], expected, { sinceHeight: 99 }).complete).toBe(false);
    expect(matchOutgoing([tx('old2', null, [[A, 5n], [B, 7n]], 10)], expected, { sinceTimestamp: 500 }).complete).toBe(false);
    expect(matchOutgoing([tx('dup', 120, [[A, 5n], [B, 7n]])], expected, { excludeTxHashes: new Set(['dup']) }).complete).toBe(false);
    expect(matchOutgoing([old, tx('new', 120, [[A, 5n], [B, 7n]])], expected, { sinceHeight: 99 }).txHashes).toEqual(['new']);
  });

  it('never uses one destination twice and reports partial matches', () => {
    const twice = [{ address: A, amountAtomic: 5n, assetId: 'BDX' }, { address: A, amountAtomic: 5n, assetId: 'BDX' }];
    expect(matchOutgoing([tx('one', 100, [[A, 5n]])], twice).matchedOutputs).toBe(1);
    expect(matchOutgoing([tx('both', 100, [[A, 5n], [A, 5n]])], twice).complete).toBe(true);
    expect(matchOutgoing([], []).complete).toBe(false);
    const wrongAsset = [{ address: A, amountAtomic: 5n, assetId: 'c'.repeat(64) }];
    expect(matchOutgoing([tx('bdx', 100, [[A, 5n]])], wrongAsset).complete).toBe(false);
  });

  it('works against the mock chain wallet history', async () => {
    const chain = new MockChain({ seed: 'aud04' });
    const provider = new MockTestnetProvider({ api: new LocalMockChainApi(chain), accountLabel: 'treasury' });
    await provider.connectWallet();
    const alice = chain.createAccount('alice');
    const start = await provider.chainHeight();
    await provider.sendConfidentialBatch([{ id: 'a', recipientInput: 'a', resolvedAddress: alice, amount: '1.5', tokenId: 'BDX' }], false);
    const history = await provider.listOutgoingTransfers({ sinceHeight: start });
    expect(matchOutgoing(history, [{ address: alice, amountAtomic: 1_500_000_000n, assetId: 'BDX' }], { sinceHeight: start }).complete).toBe(true);
  });
});

describe('AUD-04 wallet-rpc: broadcast then timeout', () => {
  it('raises OutcomeUnknownError (never "not sent") and the tx is then visible in get_transfers', async () => {
    let transferCalls = 0;
    const answer = rpcFetch({
      get_transfers: () => ({
        out: [{ txid: 'C'.repeat(64), height: 210, timestamp: 2_000, destinations: [{ address: A, amount: 5 }, { address: B, amount: 7 }] }],
        pool: [{ txid: 'd'.repeat(64), height: 0, destinations: [{ address: A, amount: 1 }] }],
      }),
      store: () => ({}),
    });
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string };
      if (body.method === 'transfer') {
        transferCalls += 1;
        throw Object.assign(new Error('timeout after broadcast'), { name: 'TimeoutError' });
      }
      return answer(input, init);
    }) as typeof fetch;
    const provider = new WalletRpcProvider({ wallet: new WalletRpc(new JsonRpcClient({ url: 'http://w', fetch: fetchImpl })), network: 'testnet' });
    const recipient = { id: 'r', recipientInput: A, resolvedAddress: A, amount: '0.000000005', tokenId: 'BDX' };
    await expect(provider.sendBatchChunk([recipient], false)).rejects.toBeInstanceOf(OutcomeUnknownError);
    expect(transferCalls).toBe(1);
    const history = await provider.listOutgoingTransfers({ sinceHeight: 200 });
    expect(history[0]).toMatchObject({ txHash: 'c'.repeat(64), height: 210 });
    expect(history[1]?.height).toBeNull();
    expect(matchOutgoing(history, expected, { sinceHeight: 200 }).txHashes).toEqual(['c'.repeat(64)]);
  });
});

describe('waitForUnlockedFunds (2-block change lock)', () => {
  function walletWith(sequence: Array<{ balance: number; unlocked: number; assets?: Array<{ asset_id: string; balance: number; unlocked_balance: number }> }>) {
    let call = 0;
    return new WalletRpc(
      new JsonRpcClient({
        url: 'http://w',
        fetch: rpcFetch({
          get_balance: () => {
            const step = sequence[Math.min(call, sequence.length - 1)]!;
            call += 1;
            return { balance: step.balance, unlocked_balance: step.unlocked, asset_balances: step.assets ?? [] };
          },
        }),
      }),
    );
  }
  const instant = { sleep: async () => undefined, pollMs: 1 };

  it('polls until change unlocks, for BDX and the asset together', async () => {
    const asset = 'e'.repeat(64);
    const wallet = walletWith([
      { balance: 100, unlocked: 10, assets: [{ asset_id: asset, balance: 50, unlocked_balance: 0 }] },
      { balance: 100, unlocked: 100, assets: [{ asset_id: asset, balance: 50, unlocked_balance: 0 }] },
      { balance: 100, unlocked: 100, assets: [{ asset_id: asset, balance: 50, unlocked_balance: 50 }] },
    ]);
    await expect(waitForUnlockedFunds(wallet, { minBdxAtomic: 60n, assetId: asset, minAssetAtomic: 40n, ...instant })).resolves.toBeDefined();
  });

  it('fails fast when the total cannot cover it and times out while locked', async () => {
    await expect(waitForUnlockedFunds(walletWith([{ balance: 5, unlocked: 5 }]), { minBdxAtomic: 6n, ...instant })).rejects.toBeInstanceOf(InsufficientFundsError);
    let clock = 0;
    await expect(
      waitForUnlockedFunds(walletWith([{ balance: 100, unlocked: 1 }]), { minBdxAtomic: 50n, timeoutMs: 30, sleep: async () => { clock += 20; }, now: () => clock }),
    ).rejects.toBeInstanceOf(FundsLockedError);
    expect(await hasUnlockedFunds(walletWith([{ balance: 100, unlocked: 1 }]), { minBdxAtomic: 50n })).toBe(false);
    expect(await hasUnlockedFunds(walletWith([{ balance: 100, unlocked: 100 }]), { minBdxAtomic: 50n })).toBe(true);
  });
});
