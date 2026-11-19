import { beforeEach, describe, expect, it } from 'vitest';
import { encodeAddress } from '../src/address/address';
import { BnsResolver, createRpcBnsBackend, hashBnsName, isBnsName } from '../src/bns/resolver';
import { verifyPayment } from '../src/compliance/verifier';
import { FundsLockedError, InsufficientFundsError, OutcomeUnknownError, UnsupportedCapabilityError, ValidationError } from '../src/errors';
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
    const blind = await provider.verifySelectiveAuditProof(result.txHash, result.txKey, ALICE);
    expect(blind).toMatchObject({ isValid: false, failures: ['ASSET_UNVERIFIABLE'] });
    const verified = await provider.verifySelectiveAuditProof(result.txHash, result.txKey, ALICE, {
      assetId: token.tokenId,
      amountAtomic: 1_250_500_000n,
      decimals: 6,
    });
    expect(verified).toMatchObject({ isValid: true, confirmedAmount: '1250.5', assetVerificationLevel: 'CRYPTOGRAPHIC_FULL' });
    const wrongAsset = await provider.verifySelectiveAuditProof(result.txHash, result.txKey, ALICE, {
      assetId: 'BDX',
      amountAtomic: 1_250_500_000n,
      decimals: 9,
    });
    expect(wrongAsset.failures).toContain('ASSET_MISMATCH');
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
  const provider = new WalletRpcProvider({
    wallet,
    ...(daemon ? { daemon } : {}),
    network: 'testnet',
  });
  return { provider, calls };
}

describe('WalletRpcProvider', () => {
  const ASSET = 'd'.repeat(64);

  it('reports balances including privacy tokens', async () => {
    const { provider } = walletProvider({
      get_address: () => ({ address: ALICE }),
      get_balance: () => ({ balance: 2_500_000_000, unlocked_balance: 1, token_balances: [{ token_id: ASSET, ticker: 'bUSD', balance: 1_500_000, unlocked_balance: 0 }] }),
      get_owned_tokens: () => ({ tokens: [{ token_id: ASSET, full_name: 'USD', ticker: 'bUSD', decimal_point: 6 }] }),
    });
    await expect(provider.connectWallet()).resolves.toEqual({ address: ALICE, network: 'testnet' });
    await expect(provider.getBalances()).resolves.toEqual({ BDX: '2.5', [ASSET]: '1.5' });
  });

  it('registers privacy tokens with an inline descriptor (register_privacy_token json_string)', async () => {
    const { provider } = walletProvider({
      register_privacy_token: (p) => {
        expect(p).toMatchObject({ priority: 1, get_tx_key: true, account_index: 0 });
        expect(p.json_filename).toBeUndefined();
        expect(JSON.parse(p.json_string as string)).toEqual({
          version: 1,
          ticker: 'bUSD',
          full_name: 'USD',
          total_max_supply: 10_000_000,
          current_supply: 10_000_000,
          decimal_point: 6,
          meta_info: '',
        });
        return { token_id: ASSET, tx_hash: HASH_A, ticker: 'bUSD', full_name: 'USD', tx_fee: 100_000_000_000 };
      },
      store: () => ({}),
    });
    await expect(provider.mintPrivacyToken({ ticker: 'bUSD', name: 'USD', decimals: 6, totalSupply: '10' })).resolves.toMatchObject({
      tokenId: ASSET,
      totalSupply: '10',
      deployTxHash: HASH_A,
      deployFeeAtomic: '100000000000',
    });

    const failing = walletProvider({ register_privacy_token: () => new RpcFailure(-1, 'nope') });
    await expect(failing.provider.mintPrivacyToken({ ticker: 'X1', name: 'X', decimals: 0, totalSupply: '1' })).rejects.toThrow(/nope/);
    const broke = walletProvider({ register_privacy_token: () => new RpcFailure(-16, 'not enough money') });
    await expect(broke.provider.mintPrivacyToken({ ticker: 'X1', name: 'X', decimals: 0, totalSupply: '1' })).rejects.toBeInstanceOf(InsufficientFundsError);
    await expect(provider.mintPrivacyToken({ ticker: 'X', name: 'X', decimals: 0 })).rejects.toBeInstanceOf(ValidationError);
  });

  it('sends a chunk with token ids, flash priority and tx keys', async () => {
    const { provider } = walletProvider({
      get_owned_tokens: () => ({ tokens: [{ token_id: ASSET, full_name: 'USD', ticker: 'bUSD', decimal_point: 6 }] }),
      transfer: (p) => {
        expect(p).toMatchObject({ priority: 5, get_tx_key: true });
        expect((p.destinations as Array<Record<string, unknown>>)[0]).toMatchObject({ address: ALICE, amount: 2_000_000, token_id: ASSET });
        return { tx_hash: HASH_A, tx_key: 'key', fee: 50_000_000 };
      },
    });
    const parts = await provider.sendBatchChunk([recipient('a', ALICE, '2', ASSET)], true);
    expect(parts).toEqual([
      { txHash: HASH_A, txKey: 'key', feeAtomic: '50000000', burnedAtomic: '40000000', recipientIds: ['a'], inPool: true, blockHeight: null },
    ]);
    await expect(provider.sendBatchChunk([recipient('a', ALICE, '1'), recipient('b', BOB, '1', ASSET)], false)).rejects.toThrow(/single token/);
  });

  it('reads decimals of tokens it did not register from the daemon (get_token_info)', async () => {
    const { provider } = walletProvider(
      {
        get_owned_tokens: () => ({ tokens: [] }),
        transfer: (p) => {
          expect((p.destinations as Array<Record<string, unknown>>)[0]).toMatchObject({ amount: 1_500, token_id: ASSET });
          return { tx_hash: HASH_A, tx_key: 'key', fee: 1 };
        },
        store: () => ({}),
      },
      { get_token_info: (p) => ({ token_id: p.token_id, ticker: 'AUR', full_name: 'Aurora', current_supply: 1, total_max_supply: 1, decimal_point: 3 }) },
    );
    await expect(provider.sendBatchChunk([recipient('a', ALICE, '1.5', ASSET)], false)).resolves.toHaveLength(1);
    const unknown = walletProvider({ get_owned_tokens: () => ({ tokens: [] }) });
    await expect(unknown.provider.sendBatchChunk([recipient('a', ALICE, '1', ASSET)], false)).rejects.toThrow(/Unknown decimals/);
  });

  it('flags a split for reconciliation when the mapping is ambiguous or the amounts do not add up', async () => {
    // ALICE is paid twice and the wallet split her two payments across both txs.
    const ambiguous = walletProvider({
      transfer: () => new RpcFailure(-4, 'transaction would be too large'),
      transfer_split: () => ({ tx_hash_list: [HASH_A, HASH_B], tx_key_list: ['ka', 'kb'], fee_list: [1, 2] }),
      check_tx_key: (p) => ({ received: p.address === ALICE ? 1_000_000_000 : p.txid === HASH_B ? 1_000_000_000 : 0, in_pool: true, confirmations: 0 }),
      store: () => ({}),
    });
    const split = await ambiguous.provider.sendBatchChunk([recipient('a1', ALICE, '1'), recipient('a2', ALICE, '1'), recipient('b', BOB, '1')], false);
    expect(split.map((p) => p.txHash)).toEqual([HASH_A, HASH_B]);
    expect(split.every((p) => p.needsReconciliation)).toBe(true);
    expect(split.flatMap((p) => p.recipientIds).sort()).toEqual(['a1', 'a2', 'b']);

    // BOB received more than he was sent: the mapping is not trustworthy.
    const overpaid = walletProvider({
      transfer: () => new RpcFailure(-4, 'transaction would be too large'),
      transfer_split: () => ({ tx_hash_list: [HASH_A, HASH_B], tx_key_list: ['ka', 'kb'], fee_list: [1, 2] }),
      check_tx_key: (p) => ({ received: p.txid === HASH_A ? (p.address === ALICE ? 1_000_000_000 : 0) : p.address === BOB ? 2_000_000_000 : 0, in_pool: true, confirmations: 0 }),
      store: () => ({}),
    });
    const parts = await overpaid.provider.sendBatchChunk([recipient('a', ALICE, '1'), recipient('b', BOB, '1')], false);
    expect(parts.map((p) => [p.txHash, p.recipientIds])).toEqual([
      [HASH_A, ['a']],
      [HASH_B, ['b']],
    ]);
    expect(parts.every((p) => p.needsReconciliation)).toBe(true);
  });

  it('attributes a split token payroll with token_received', async () => {
    const { provider } = walletProvider({
      get_owned_tokens: () => ({ tokens: [{ token_id: ASSET, full_name: 'USD', ticker: 'bUSD', decimal_point: 6 }] }),
      transfer: () => new RpcFailure(-4, 'transaction would be too large'),
      transfer_split: () => ({ tx_hash_list: [HASH_A, HASH_B], tx_key_list: ['ka', 'kb'], fee_list: [1, 2] }),
      check_tx_key: (p) => ({
        received: 0,
        token_received: (p.txid === HASH_A) === (p.address === ALICE) ? [{ token_id: ASSET.toUpperCase(), amount: 1_000_000 }] : [],
        in_pool: true,
        confirmations: 0,
      }),
      store: () => ({}),
    });
    const parts = await provider.sendBatchChunk([recipient('a', ALICE, '1', ASSET), recipient('b', BOB, '1', ASSET)], false);
    expect(parts.map((p) => [p.txHash, p.recipientIds])).toEqual([
      [HASH_A, ['a']],
      [HASH_B, ['b']],
    ]);
    expect(parts.every((p) => !p.needsReconciliation)).toBe(true);
  });

  it('falls back to transfer_split and attributes recipients with check_tx_key', async () => {
    const { provider, calls } = walletProvider({
      transfer: () => new RpcFailure(-4, 'transaction would be too large'),
      transfer_split: (p) => {
        expect(p.get_tx_keys).toBe(true);
        return { tx_hash_list: [HASH_A, HASH_B], tx_key_list: ['ka', 'kb'], fee_list: [1, 2] };
      },
      check_tx_key: (p) => ({ received: (p.txid === HASH_A) === (p.address === ALICE) ? 1_000_000_000 : 0, in_pool: true, confirmations: 0 }),
    });
    const parts = await provider.sendBatchChunk([recipient('a', ALICE, '1'), recipient('b', BOB, '1')], false);
    expect(parts.map((p) => [p.txHash, p.recipientIds])).toEqual([
      [HASH_A, ['a']],
      [HASH_B, ['b']],
    ]);
    expect(calls.filter((c) => c === 'transfer_split')).toHaveLength(1);
    expect(parts.every((p) => !p.needsReconciliation)).toBe(true);
  });

  it('never loses broadcast split txs when attribution fails', async () => {
    const { provider } = walletProvider({
      transfer: () => new RpcFailure(-4, 'tx too big'),
      transfer_split: () => ({ tx_hash_list: [HASH_A, HASH_B], fee_list: [1, 2] }),
    });
    const parts = await provider.sendBatchChunk([recipient('a', ALICE, '1'), recipient('b', BOB, '1')], false);
    expect(parts.map((p) => p.txHash)).toEqual([HASH_A, HASH_B]);
    expect(parts.every((p) => p.needsReconciliation)).toBe(true);

    const failingCheck = walletProvider({
      transfer: () => new RpcFailure(-4, 'tx too big'),
      transfer_split: () => ({ tx_hash_list: [HASH_A, HASH_B], tx_key_list: ['ka', 'kb'], fee_list: [1, 2] }),
      check_tx_key: () => new RpcFailure(-1, 'daemon down'),
    });
    const flagged = await failingCheck.provider.sendBatchChunk([recipient('a', ALICE, '1')], false);
    expect(flagged).toHaveLength(2);
    expect(flagged[0]?.needsReconciliation).toBe(true);
  });

  it('reports an unknown outcome when transfer_split succeeds without tx hashes', async () => {
    const { provider } = walletProvider({
      transfer: () => new RpcFailure(-4, 'transaction would be too large'),
      transfer_split: () => ({ fee_list: [1] }),
      store: () => ({}),
    });
    await expect(provider.sendBatchChunk([recipient('a', ALICE, '1')], false)).rejects.toBeInstanceOf(OutcomeUnknownError);
  });

  it('reports an unknown outcome when a transfer times out', async () => {
    const wallet = new WalletRpc(
      new JsonRpcClient({
        url: 'http://w',
        fetch: (async () => {
          throw Object.assign(new Error('t'), { name: 'TimeoutError' });
        }) as typeof fetch,
      }),
    );
    const provider = new WalletRpcProvider({ wallet, network: 'testnet' });
    await expect(provider.sendBatchChunk([recipient('a', ALICE, '1')], false)).rejects.toBeInstanceOf(OutcomeUnknownError);
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
        check_tx_key: () => ({ received: 0, token_received: [{ token_id: ASSET, amount: 2_000_000 }], in_pool: false, confirmations: 4 }),
        get_transfer_by_txid: () => ({ transfer: { txid: HASH_A, type: 'in', amount: 2_000_000, address: ALICE, token_id: ASSET } }),
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
    await expect(sources.checkTxKey(HASH_A, 'k', ALICE)).resolves.toMatchObject({
      receivedAtomic: 0n,
      tokenReceived: [{ tokenId: ASSET, amountAtomic: 2_000_000n }],
      blockHeight: 100,
    });
    const result = await verifyPayment(
      { txHash: HASH_A, txKey: 'k', recipientAddress: ALICE, assetId: ASSET, amountAtomic: 2_000_000n },
      sources,
      { amountMatch: 'exact' },
    );
    expect(result.assetVerificationLevel).toBe('CRYPTOGRAPHIC_FULL');
    await expect(
      provider.verifySelectiveAuditProof(HASH_A, 'k', ALICE, { assetId: ASSET.toUpperCase(), amountAtomic: 2_000_000n, decimals: 6 }),
    ).resolves.toMatchObject({ isValid: true, blockHeight: 100, confirmedAmount: '2' });
    await expect(provider.signMessage('m')).resolves.toEqual({ signature: 'SigV1x', address: ALICE });
    await expect(provider.getTxKey(HASH_A)).resolves.toBe('kk');
  });

  it('sends the feature-privacy-token request shapes for token operations and reads', async () => {
    const seen: Record<string, Record<string, unknown>> = {};
    const record = (method: string, result: unknown) => (p: Record<string, unknown>) => {
      seen[method] = p;
      return result;
    };
    const wallet = new WalletRpc(
      new JsonRpcClient({
        url: 'http://w',
        fetch: rpcFetch({
          mint_token: record('mint_token', { tx_hash: HASH_A, tx_key: 'k', fee: 1 }),
          burn_token: record('burn_token', { tx_hash: HASH_B, fee: 0 }),
          update_token: record('update_token', { tx_hash: HASH_A }),
          get_owned_tokens: record('get_owned_tokens', { tokens: [{ token_id: ASSET, full_name: 'USD', ticker: 'bUSD', decimal_point: 6 }] }),
          get_transfers: record('get_transfers', { out: [] }),
          get_height: record('get_height', { height: 9 }),
        }),
      }),
    );
    await expect(wallet.mintToken(ASSET, 5n, 1, 2)).resolves.toMatchObject({ tx_hash: HASH_A });
    expect(seen.mint_token).toEqual({ token_id: ASSET, amount: 5, priority: 1, account_index: 2, get_tx_key: true });
    await wallet.burnToken(ASSET, 3n, 1);
    expect(seen.burn_token).toEqual({ token_id: ASSET, amount: 3, priority: 1, account_index: 0, get_tx_key: true });
    await wallet.updateToken(ASSET, { ticker: 'bUSD', full_name: 'USD v2', total_max_supply: 10n, current_supply: 10n, decimal_point: 6, meta_info: 'm' }, 1);
    expect(JSON.parse(seen.update_token?.json_string as string)).toMatchObject({ version: 1, full_name: 'USD v2', meta_info: 'm' });
    expect(seen.update_token).toMatchObject({ token_id: ASSET, priority: 1, account_index: 0 });
    await expect(wallet.getOwnedTokens()).resolves.toMatchObject({ tokens: [{ token_id: ASSET }] });
    await wallet.getTransfers({ minHeight: 100, accountIndex: 1, pool: false });
    expect(seen.get_transfers).toEqual({ out: true, pending: true, pool: false, in: false, account_index: 1, filter_by_height: true, min_height: 100 });
    await wallet.getTransfers({});
    expect(seen.get_transfers).toEqual({ out: true, pending: true, pool: true, in: false, account_index: 0 });
    await expect(wallet.getHeight()).resolves.toEqual({ height: 9 });
  });

  it('reads token metadata and the token list from the daemon', async () => {
    const daemon = new DaemonRpc(
      new JsonRpcClient({
        url: 'http://d',
        fetch: rpcFetch({
          get_token_info: (p) => ({ token_id: p.token_id, ticker: 'AUR', full_name: 'Aurora', current_supply: 1, total_max_supply: 2, decimal_point: 8 }),
          get_token_list: (p) => ({ token_ids: [`${p.offset}:${p.count}`] }),
        }),
      }),
    );
    await expect(daemon.getTokenInfo(ASSET)).resolves.toMatchObject({ token_id: ASSET, ticker: 'AUR', decimal_point: 8 });
    await expect(daemon.getTokenList()).resolves.toEqual({ token_ids: ['0:100'] });
    await expect(daemon.getTokenList(20, 5)).resolves.toEqual({ token_ids: ['20:5'] });
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

  it('rejects a wallet on the wrong network and foreign recipient addresses', async () => {
    const mainnet = new ExtensionProvider(client({ connect: async () => ({ address: ALICE, network: 'mainnet' }) }));
    await expect(mainnet.connectWallet()).rejects.toThrow(/switch it to testnet/);
    const main = encodeAddress({ network: 'mainnet', kind: 'standard', spendPublicKey: '33'.repeat(32), viewPublicKey: '44'.repeat(32) });
    await expect(new ExtensionProvider(client()).sendConfidentialBatch([recipient('a', main, '1')], false)).rejects.toThrow(/expected testnet/);
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
