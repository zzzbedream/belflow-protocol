import { beforeEach, describe, expect, it } from 'vitest';
import { encodeAddress } from '../src/address/address';
import { BnsResolver, createRpcBnsBackend, hashBnsName, isBnsName } from '../src/bns/resolver';
import { verifyPayment } from '../src/compliance/verifier';
import { FundsLockedError, InsufficientFundsError, UnsupportedCapabilityError, ValidationError } from '../src/errors';
import { LocalMockChainApi } from '../src/mock/api';
import { MockChain } from '../src/mock/MockChain';
import { PartialBatchError, executeBatch } from '../src/providers/batch';
import { ExtensionProvider, type ExtensionClient } from '../src/providers/ExtensionProvider';
import { MockTestnetProvider, decimalsOf } from '../src/providers/MockTestnetProvider';
import { WalletRpcProvider } from '../src/providers/WalletRpcProvider';
import { DaemonRpc } from '../src/rpc/daemon';
import { JsonRpcClient } from '../src/rpc/JsonRpcClient';
import { WalletRpc } from '../src/rpc/wallet';
import type { BatchPaymentRecipient, ConfidentialTxPart } from '../src/types';
import { HASH_A, HASH_B, RpcFailure, rpcFetch, type RpcHandler } from './helpers';

const addressFor = (seed: string) =>
  encodeAddress({ network: 'testnet', kind: 'standard', spendPublicKey: seed.repeat(64).slice(0, 64), viewPublicKey: 'ab'.repeat(32) });
const ALICE = addressFor('1');
const BOB = addressFor('2');

const recipient = (id: string, address: string, amount: string, tokenId = 'BDX'): BatchPaymentRecipient => ({
  id,
  recipientInput: address,
  resolvedAddress: address,
  amount,
  tokenId,
});

describe('MockTestnetProvider', () => {
  let chain: MockChain;
  let provider: MockTestnetProvider;
  let treasury: string;

  beforeEach(async () => {
    chain = new MockChain({ seed: 'provider' });
    provider = new MockTestnetProvider({ api: new LocalMockChainApi(chain) });
    treasury = (await provider.connectWallet()).address;
  });

  it('connects with a funded deterministic account', async () => {
    expect(provider.connectedAddress).toBe(treasury);
    expect((await provider.getBalances(treasury)).BDX).toBe('10000');
    await provider.connectWallet();
    expect((await provider.getBalances(treasury)).BDX).toBe('10000');
  });

  it('mints a privacy token and pays a batch with tx keys', async () => {
    const token = await provider.mintPrivacyToken({ ticker: 'bUSD', name: 'Beldex Confidential USD', decimals: 6, totalSupply: '50000' });
    expect(token).toMatchObject({ ticker: 'bUSD', decimals: 6, totalSupply: '50000', isNativeBdx: false });
    chain.mineBlocks(2);
    const result = await provider.sendConfidentialBatch(
      [recipient('a', ALICE, '1250.50', token.tokenId), recipient('b', BOB, '99', token.tokenId)],
      false,
    );
    expect(result).toMatchObject({ recipientsCount: 2, ringSize: 10, feeBurnedBdx: '0' });
    expect(result.transactions).toHaveLength(1);
    const verified = await provider.verifySelectiveAuditProof(result.txHash, result.txKey, ALICE);
    expect(verified).toMatchObject({ isValid: true, confirmedAmount: '1250.5' });
    expect((await provider.getBalances(ALICE))[token.tokenId]).toBe('1250.5');

    const dual = await verifyPayment(
      { txHash: result.txHash, txKey: result.txKey, recipientAddress: ALICE, assetId: token.tokenId, amountAtomic: 1_250_500_000n },
      provider.verificationSources(),
      { amountMatch: 'exact' },
    );
    expect(dual.assetVerificationLevel).toBe('CRYPTOGRAPHIC_FULL');
    await expect(provider.getTxKey(result.txHash)).resolves.toBe(result.txKey);
  });

  it('burns BDX on flash payments and signs messages server-side', async () => {
    const result = await provider.sendConfidentialBatch([recipient('a', ALICE, '1')], true);
    expect(Number(result.feeBurnedBdx)).toBeGreaterThan(0);
    expect(result.transactions?.[0]?.inPool).toBe(true);
    const { signature, address } = await provider.signMessage('hello');
    expect(await provider.verificationSources().verifySignature?.('hello', address, signature)).toBe(true);
  });

  it('surfaces locked change as FundsLockedError inside a partial batch', async () => {
    const many = Array.from({ length: 16 }, (_, i) => recipient(`r${i}`, i % 2 ? ALICE : BOB, '1'));
    const error = await provider.sendConfidentialBatch(many, false).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PartialBatchError);
    expect((error as PartialBatchError).completed).toHaveLength(1);
    expect((error as PartialBatchError).cause).toBeInstanceOf(FundsLockedError);
  });

  it('resolves seeded BNS names and validates inputs', async () => {
    chain.registerBns('devteam.bdx', ALICE);
    await expect(provider.resolveBNS('DevTeam.bdx')).resolves.toMatchObject({ resolvedAddress: ALICE, source: 'mock' });
    await expect(provider.resolveBNS('ghost.bdx')).rejects.toThrow(/not registered/);
    await expect(provider.resolveBNS('bad name')).rejects.toThrow(ValidationError);
  });

  it('requires a connection before spending and rejects unknown tokens', async () => {
    const fresh = new MockTestnetProvider({ api: new LocalMockChainApi(new MockChain()) });
    await expect(fresh.sendBatchChunk([recipient('a', ALICE, '1')], false)).rejects.toThrow(/connectWallet/);
    expect(() => decimalsOf('missing', [])).toThrow(/Unknown token/);
  });
});

describe('executeBatch', () => {
  const part = (hash: string): ConfidentialTxPart => ({
    txHash: hash,
    txKey: 'k',
    feeAtomic: '1',
    burnedAtomic: '0',
    recipientIds: [],
    inPool: false,
  });

  it('rethrows the original error when nothing was sent', async () => {
    const boom = new Error('boom');
    await expect(executeBatch([recipient('a', ALICE, '1')], false, async () => Promise.reject(boom))).rejects.toBe(boom);
  });

  it('collects every chunk', async () => {
    const recipients = Array.from({ length: 17 }, (_, i) => recipient(`r${i}`, ALICE, '1'));
    const parts = await executeBatch(recipients, false, async () => [part(HASH_A)]);
    expect(parts).toHaveLength(2);
  });
});

describe('BnsResolver', () => {
  it('validates names, caches results and rejects foreign addresses', async () => {
    let lookups = 0;
    let now = 0;
    const resolver = new BnsResolver(
      {
        lookup: async (name) => {
          lookups += 1;
          return name === 'alice.bdx' ? { address: ALICE, source: 'daemon' } : name === 'bad.bdx' ? { address: 'x', source: 'daemon' } : null;
        },
      },
      { network: 'testnet', ttlMs: 1000, now: () => now },
    );
    await resolver.resolve('alice.bdx');
    await resolver.resolve('ALICE.bdx');
    expect(lookups).toBe(1);
    now = 2000;
    await resolver.resolve('alice.bdx');
    expect(lookups).toBe(2);
    await expect(resolver.resolve('bad.bdx')).rejects.toThrow(/valid address/);
    await expect(resolver.resolveRecipient('alice.bdx')).resolves.toEqual({ address: ALICE, bns: 'alice.bdx' });
    await expect(resolver.resolveRecipient(BOB)).resolves.toEqual({ address: BOB });
    await expect(resolver.resolveRecipient('nonsense')).rejects.toThrow(/neither/);
  });

  it('recognizes .bdx names', () => {
    expect(isBnsName('agente01.bdx')).toBe(true);
    expect(isBnsName('-bad.bdx')).toBe(false);
    expect(isBnsName('bad.com')).toBe(false);
    expect(hashBnsName('Alice.bdx')).toBe(hashBnsName('alice.bdx'));
    expect(hashBnsName('alice.bdx')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('resolves through daemon + wallet RPC, retrying without the nonce', async () => {
    const decryptCalls: string[] = [];
    const daemon = new DaemonRpc(
      new JsonRpcClient({
        url: 'http://d',
        fetch: rpcFetch({
          bns_resolve: (p) => (p.name_hash === hashBnsName('alice.bdx') ? { encrypted_value: 'ee', nonce: 'nn' } : {}),
        }),
      }),
    );
    const wallet = new WalletRpc(
      new JsonRpcClient({
        url: 'http://w',
        fetch: rpcFetch({
          bns_decrypt_value: (p) => {
            decryptCalls.push(String(p.encrypted_value));
            return p.encrypted_value === 'ee' ? { value: ALICE } : new RpcFailure(-1, 'bad');
          },
        }),
      }),
    );
    const backend = createRpcBnsBackend(daemon, wallet);
    await expect(backend.lookup('alice.bdx')).resolves.toEqual({ address: ALICE, source: 'daemon' });
    expect(decryptCalls).toEqual(['eenn', 'ee']);
    await expect(backend.lookup('nobody.bdx')).resolves.toBeNull();
  });
});

function walletProvider(handlers: Record<string, RpcHandler>, daemonHandlers?: Record<string, RpcHandler>, calls: string[] = []) {
  const wallet = new WalletRpc(new JsonRpcClient({ url: 'http://w', fetch: rpcFetch(handlers, calls) }));
  const daemon = daemonHandlers ? new DaemonRpc(new JsonRpcClient({ url: 'http://d', fetch: rpcFetch(daemonHandlers) })) : undefined;
  const cleaned: string[] = [];
  const provider = new WalletRpcProvider({
    wallet,
    ...(daemon ? { daemon } : {}),
    network: 'testnet',
    writeAssetDescriptor: async (descriptor) => ({
      path: `/assets/${descriptor.ticker}.json`,
      cleanup: async () => {
        cleaned.push(descriptor.ticker);
      },
    }),
  });
  return { provider, cleaned, calls };
}

describe('WalletRpcProvider', () => {
  const ASSET = 'd'.repeat(64);

  it('reports balances including privacy tokens', async () => {
    const { provider } = walletProvider({
      get_address: () => ({ address: ALICE }),
      get_balance: () => ({ balance: 2_500_000_000, unlocked_balance: 1, asset_balances: [{ asset_id: ASSET, balance: 1_500_000, unlocked_balance: 0 }] }),
      get_owned_assets: () => ({ assets: [{ asset_id: ASSET, full_name: 'USD', ticker: 'bUSD', decimal_point: 6 }] }),
    });
    await expect(provider.connectWallet()).resolves.toEqual({ address: ALICE, network: 'testnet' });
    await expect(provider.getBalances()).resolves.toEqual({ BDX: '2.5', [ASSET]: '1.5' });
  });

  it('deploys assets through a descriptor file and always cleans up', async () => {
    const { provider, cleaned } = walletProvider({
      deploy_new_asset: (p) => {
        expect(p).toMatchObject({ json_filename: '/assets/bUSD.json', get_tx_key: true });
        return { asset_id: ASSET, tx_hash: HASH_A, ticker: 'bUSD', full_name: 'USD' };
      },
    });
    await expect(provider.mintPrivacyToken({ ticker: 'bUSD', name: 'USD', decimals: 6, totalSupply: '10' })).resolves.toMatchObject({
      tokenId: ASSET,
      totalSupply: '10',
    });
    expect(cleaned).toEqual(['bUSD']);

    const failing = walletProvider({ deploy_new_asset: () => new RpcFailure(-1, 'nope') });
    await expect(failing.provider.mintPrivacyToken({ ticker: 'X1', name: 'X', decimals: 0, totalSupply: '1' })).rejects.toThrow(/nope/);
    expect(failing.cleaned).toEqual(['X1']);

    const noWriter = new WalletRpcProvider({ wallet: new WalletRpc(new JsonRpcClient({ url: 'http://w', fetch: rpcFetch({}) })), network: 'testnet' });
    await expect(noWriter.mintPrivacyToken({ ticker: 'X', name: 'X', decimals: 0 })).rejects.toBeInstanceOf(UnsupportedCapabilityError);
  });

  it('sends a chunk with asset ids, flash priority and tx keys', async () => {
    const { provider } = walletProvider({
      get_owned_assets: () => ({ assets: [{ asset_id: ASSET, full_name: 'USD', ticker: 'bUSD', decimal_point: 6 }] }),
      transfer: (p) => {
        expect(p).toMatchObject({ priority: 5, get_tx_key: true });
        expect((p.destinations as Array<Record<string, unknown>>)[0]).toMatchObject({ address: ALICE, amount: 2_000_000, asset_id: ASSET });
        return { tx_hash: HASH_A, tx_key: 'key', fee: 50_000_000 };
      },
    });
    const parts = await provider.sendBatchChunk([recipient('a', ALICE, '2', ASSET)], true);
    expect(parts).toEqual([
      { txHash: HASH_A, txKey: 'key', feeAtomic: '50000000', burnedAtomic: '40000000', recipientIds: ['a'], inPool: true, blockHeight: null },
    ]);
    await expect(provider.sendBatchChunk([recipient('a', ALICE, '1'), recipient('b', BOB, '1', ASSET)], false)).rejects.toThrow(/single asset/);
  });

  it('falls back to transfer_split and attributes recipients with check_tx_key', async () => {
    const { provider, calls } = walletProvider({
      transfer: () => new RpcFailure(-4, 'transaction would be too large'),
      transfer_split: (p) => {
        expect(p.get_tx_keys).toBe(true);
        return { tx_hash_list: [HASH_A, HASH_B], tx_key_list: ['ka', 'kb'], fee_list: [1, 2] };
      },
      check_tx_key: (p) => ({ received: (p.txid === HASH_A) === (p.address === ALICE) ? 1 : 0, in_pool: true, confirmations: 0 }),
    });
    const parts = await provider.sendBatchChunk([recipient('a', ALICE, '1'), recipient('b', BOB, '1')], false);
    expect(parts.map((p) => [p.txHash, p.recipientIds])).toEqual([
      [HASH_A, ['a']],
      [HASH_B, ['b']],
    ]);
    expect(calls.filter((c) => c === 'transfer_split')).toHaveLength(1);
  });

  it('translates wallet funding errors', async () => {
    const locked = walletProvider({ transfer: () => new RpcFailure(-37, 'not enough unlocked money') });
    await expect(locked.provider.sendBatchChunk([recipient('a', ALICE, '1')], false)).rejects.toBeInstanceOf(FundsLockedError);
    const broke = walletProvider({ transfer: () => new RpcFailure(-16, 'not enough money') });
    await expect(broke.provider.sendBatchChunk([recipient('a', ALICE, '1')], false)).rejects.toBeInstanceOf(InsufficientFundsError);
    const other = walletProvider({ transfer: () => new RpcFailure(-1, 'daemon busy') });
    await expect(other.provider.sendBatchChunk([recipient('a', ALICE, '1')], false)).rejects.toThrow(/daemon busy/);
  });

  it('verifies with check_tx_key, receiver view, daemon inspection and signatures', async () => {
    const { provider } = walletProvider(
      {
        check_tx_key: () => ({ received: 2_000_000, in_pool: false, confirmations: 4 }),
        get_transfer_by_txid: () => ({ transfer: { txid: HASH_A, type: 'in', amount: 2_000_000, address: ALICE, asset_id: ASSET } }),
        verify: () => ({ good: true }),
        sign: () => ({ signature: 'SigV1x' }),
        get_address: () => ({ address: ALICE }),
        get_tx_key: () => ({ tx_key: 'kk' }),
      },
      {
        get_info: () => ({ height: 104 }),
        get_transactions: () => ({ txs: [{ tx_hash: HASH_A, in_pool: false, flash: false, block_height: 100, as_json: '{"vout":[]}' }] }),
      },
    );
    const sources = provider.verificationSources();
    await expect(sources.checkTxKey(HASH_A, 'k', ALICE)).resolves.toMatchObject({ receivedAtomic: 2_000_000n, blockHeight: 100 });
    const result = await verifyPayment(
      { txHash: HASH_A, txKey: 'k', recipientAddress: ALICE, assetId: ASSET, amountAtomic: 2_000_000n },
      sources,
      { amountMatch: 'exact' },
    );
    expect(result.assetVerificationLevel).toBe('CRYPTOGRAPHIC_FULL');
    await expect(provider.verifySelectiveAuditProof(HASH_A, 'k', ALICE)).resolves.toMatchObject({ isValid: true, blockHeight: 100 });
    await expect(provider.signMessage('m')).resolves.toEqual({ signature: 'SigV1x', address: ALICE });
    await expect(provider.getTxKey(HASH_A)).resolves.toBe('kk');
  });

  it('needs a daemon for BNS', () => {
    const { provider } = walletProvider({});
    expect(() => provider.resolveBNS('alice.bdx')).toThrow(/DAEMON/);
  });
});

describe('ExtensionProvider', () => {
  const client = (overrides: Partial<ExtensionClient> = {}): ExtensionClient => ({
    connect: async () => ({ address: ALICE, network: 'testnet' }),
    getBalance: async () => ({ total: 3_000_000_000n, unlocked: 1n }),
    sendTransaction: async () => ({ txHash: HASH_A, fee: '1000' }),
    resolveBns: async (name) => ({ name, address: BOB, verified: false }),
    signMessage: async () => ({ signature: 'SigV1', address: ALICE }),
    ...overrides,
  });

  it('connects, reads BDX and resolves BNS (unverified)', async () => {
    const provider = new ExtensionProvider(client());
    await expect(provider.connectWallet()).resolves.toEqual({ address: ALICE, network: 'testnet' });
    expect(provider.network).toBe('testnet');
    await expect(provider.getBalances()).resolves.toEqual({ BDX: '3' });
    await expect(provider.resolveBNS('Shop.bdx')).resolves.toMatchObject({ domain: 'shop.bdx', isValid: true, source: 'extension' });
    await expect(provider.resolveBNS('nope')).rejects.toThrow(ValidationError);
    await expect(provider.signMessage('m')).resolves.toMatchObject({ signature: 'SigV1' });
  });

  it('pays exactly one BDX recipient with an idempotency key', async () => {
    const sent: unknown[] = [];
    const provider = new ExtensionProvider(
      client({
        sendTransaction: async (params) => {
          sent.push(params);
          return { txHash: HASH_A, fee: 1000n };
        },
      }),
    );
    const result = await provider.sendConfidentialBatch([recipient('inv-1', BOB, '1.5')], true);
    expect(sent[0]).toEqual({ to: BOB, amount: 1_500_000_000n, priority: 5, idempotencyKey: 'inv-1' });
    expect(result).toMatchObject({ txHash: HASH_A, txKey: '' });
  });

  it('refuses what the extension cannot do', async () => {
    const provider = new ExtensionProvider(client());
    await expect(provider.sendConfidentialBatch([recipient('a', BOB, '1'), recipient('b', ALICE, '1')], false)).rejects.toBeInstanceOf(
      UnsupportedCapabilityError,
    );
    await expect(provider.sendConfidentialBatch([recipient('a', BOB, '1', 'x')], false)).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    await expect(provider.mintPrivacyToken({ ticker: 'X', name: 'X', decimals: 0 })).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    await expect(provider.verifySelectiveAuditProof()).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    expect(provider.capabilities.batch).toBe(false);
  });
});
