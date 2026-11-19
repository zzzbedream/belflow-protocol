import { beforeEach, describe, expect, it } from 'vitest';
import { isValidAddress } from '../src/address/address';
import { FundsLockedError, InsufficientFundsError, ValidationError } from '../src/errors';
import { HttpMockChainApi, LocalMockChainApi } from '../src/mock/api';
import { MOCK_BRIDGE_METHODS, dispatchMockRpc } from '../src/mock/bridge';
import { MockChain } from '../src/mock/MockChain';

const BDX = 1_000_000_000n;

describe('MockChain', () => {
  let chain: MockChain;
  let treasury: string;
  let alice: string;

  beforeEach(() => {
    chain = new MockChain({ seed: 'test-seed' });
    treasury = chain.createAccount('treasury');
    alice = chain.createAccount('alice');
    chain.faucet(treasury, 1_000n * BDX);
  });

  it('is deterministic for the same seed and call sequence', () => {
    const other = new MockChain({ seed: 'test-seed' });
    const otherTreasury = other.createAccount('treasury');
    other.faucet(otherTreasury, 1_000n * BDX);
    other.createAccount('alice');
    const a = chain.transfer(treasury, [{ address: alice, assetId: 'BDX', amount: BDX }], { flash: false });
    const b = other.transfer(otherTreasury, [{ address: alice, assetId: 'BDX', amount: BDX }], { flash: false });
    expect(a.txHash).toBe(b.txHash);
    expect(a.txKey).toBe(b.txKey);
    expect(otherTreasury).toBe(treasury);
    expect(new MockChain({ seed: 'other' }).createAccount('treasury')).not.toBe(treasury);
  });

  it('generates valid testnet-format addresses', () => {
    expect(isValidAddress(treasury, 'testnet')).toBe(true);
  });

  it('moves BDX, charges fees and confirms with check_tx_key', () => {
    const tx = chain.transfer(treasury, [{ address: alice, assetId: 'BDX', amount: 5n * BDX }], { flash: false });
    expect(tx.height).toBe(chain.height);
    const check = chain.checkTxKey(tx.txHash, tx.txKey, alice);
    expect(check).toMatchObject({ receivedAtomic: 5n * BDX, tokenReceived: [], inPool: false, confirmations: 1 });
    expect(chain.getBalances(alice).BDX?.total).toBe(5n * BDX);
    expect(chain.getBalances(treasury).BDX?.total).toBe(995n * BDX - BigInt(tx.fee));
    expect(chain.checkTxKey(tx.txHash, 'f'.repeat(64), alice).receivedAtomic).toBe(0n);
    expect(chain.checkTxKey(tx.txHash, 'not-hex', alice).receivedAtomic).toBe(0n);
    expect(chain.checkTxKey(tx.txHash, tx.txKey, treasury).receivedAtomic).toBe(0n);
  });

  it('keeps flash transactions in the mempool until the next block', () => {
    const tx = chain.transfer(treasury, [{ address: alice, assetId: 'BDX', amount: BDX }], { flash: true });
    expect(chain.getTransaction(tx.txHash)).toMatchObject({ inPool: true, flash: true });
    expect(BigInt(tx.burned)).toBeGreaterThan(0n);
    chain.mineBlocks(1);
    expect(chain.getTransaction(tx.txHash)).toMatchObject({ inPool: false, blockHeight: chain.height });
    expect(chain.getTransaction('0'.repeat(64))).toBeNull();
  });

  it('locks change outputs for the spendable-age window', () => {
    chain.transfer(treasury, [{ address: alice, assetId: 'BDX', amount: BDX }], { flash: false });
    expect(() => chain.transfer(treasury, [{ address: alice, assetId: 'BDX', amount: BDX }], { flash: false })).toThrow(
      FundsLockedError,
    );
    chain.mineBlocks(2);
    expect(() => chain.transfer(treasury, [{ address: alice, assetId: 'BDX', amount: BDX }], { flash: false })).not.toThrow();
    expect(() => chain.transfer(alice, [{ address: treasury, assetId: 'BDX', amount: 1_000n * BDX }], { flash: false })).toThrow(
      InsufficientFundsError,
    );
  });

  it('deploys privacy tokens, sends them per token and reports them in tokenReceived', () => {
    const { asset } = chain.deployAsset(treasury, { ticker: 'bUSD', name: 'Beldex Confidential USD', decimals: 6, supply: 1_000_000n });
    chain.mineBlocks(2);
    const tx = chain.transfer(treasury, [{ address: alice, assetId: asset.assetId, amount: 250_000n }], { flash: false });
    expect(chain.checkTxKey(tx.txHash, tx.txKey, alice)).toMatchObject({ receivedAtomic: 0n, tokenReceived: [{ tokenId: asset.assetId, amountAtomic: 250_000n }] });
    expect(chain.getIncomingTransfers(tx.txHash, alice)).toEqual([{ assetId: asset.assetId, amount: 250_000n }]);
    expect(chain.getIncomingTransfers('0'.repeat(64), alice)).toEqual([]);
    expect(chain.getAsset(asset.assetId)?.ticker).toBe('bUSD');
    expect(() => chain.deployAsset(treasury, { ticker: 'busd', name: 'dup', decimals: 6, supply: 1n })).toThrow(/already exists/);
    expect(() => chain.deployAsset(treasury, { ticker: 'BDX', name: 'x', decimals: 6, supply: 1n })).toThrow(/reserved/);
    expect(() => chain.deployAsset(treasury, { ticker: 'x', name: 'x', decimals: 6, supply: 1n })).toThrow(/Ticker/);
    expect(() => chain.deployAsset(treasury, { ticker: 'ZERO', name: 'x', decimals: 6, supply: 0n })).toThrow(/positive/);
  });

  it('validates transfers', () => {
    expect(() => chain.transfer(treasury, [], { flash: false })).toThrow(ValidationError);
    expect(() => chain.transfer(treasury, [{ address: 'bad', assetId: 'BDX', amount: 1n }], { flash: false })).toThrow();
    expect(() => chain.transfer(treasury, [{ address: alice, assetId: 'BDX', amount: 0n }], { flash: false })).toThrow(/positive/);
    expect(() => chain.transfer(treasury, [{ address: alice, assetId: 'nope', amount: 1n }], { flash: false })).toThrow(/Unknown asset/);
    const many = Array.from({ length: 16 }, () => ({ address: alice, assetId: 'BDX', amount: 1n }));
    expect(() => chain.transfer(treasury, many, { flash: false })).toThrow(/At most/);
    expect(() => chain.transfer(alice.replace(/.$/, ''), [{ address: treasury, assetId: 'BDX', amount: 1n }], { flash: false })).toThrow();
  });

  it('never resolves prototype keys', () => {
    expect(chain.hasAccount('constructor')).toBe(false);
    expect(chain.resolveBns('__proto__')).toBeNull();
    expect(chain.getAsset('constructor')).toBeNull();
    expect(chain.getBalances('constructor').BDX?.total).toBe(0n);
    expect(() => chain.transfer(treasury, [{ address: alice, assetId: 'constructor', amount: 1n }], { flash: false })).toThrow(/Unknown asset/);
  });

  it('signs and verifies only for accounts it holds keys for', () => {
    const signature = chain.sign(treasury, 'hello');
    expect(chain.verify('hello', treasury, signature)).toBe(true);
    expect(chain.verify('hello!', treasury, signature)).toBe(false);
    expect(chain.verify('hello', treasury, 'garbage')).toBe(false);
    const external = new MockChain({ seed: 'elsewhere' }).createAccount('x');
    chain.faucet(external, 1n);
    expect(() => chain.sign(external, 'hello')).toThrow(/keys/);
  });

  it('exports tx keys only to the sender', () => {
    const tx = chain.transfer(treasury, [{ address: alice, assetId: 'BDX', amount: BDX }], { flash: false });
    expect(chain.getTxKey(tx.txHash, treasury)).toBe(tx.txKey);
    expect(() => chain.getTxKey(tx.txHash, alice)).toThrow(/sender/);
    expect(() => chain.getTxKey('0'.repeat(64), treasury)).toThrow(/not found/);
  });

  it('round-trips snapshots and resolves BNS', () => {
    chain.registerBns('DevTeam.bdx', alice);
    const restored = MockChain.fromSnapshot(chain.snapshot());
    expect(restored.resolveBns('devteam.bdx')).toBe(alice);
    expect(restored.resolveBns('missing.bdx')).toBeNull();
    expect(restored.getBalances(treasury)).toEqual(chain.getBalances(treasury));
    expect(restored.getBalances('unknown').BDX?.total).toBe(0n);
    expect(() => MockChain.fromSnapshot({ ...chain.snapshot(), version: 2 as 1 })).toThrow(/version/);
    expect(restored.getInfo()).toMatchObject({ nettype: 'mock-devnet', height: chain.height });
  });
});

describe('mock JSON-RPC bridge', () => {
  const setup = () => {
    const chain = new MockChain({ seed: 'bridge' });
    let saves = 0;
    const api = new LocalMockChainApi(chain, () => {
      saves += 1;
    });
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(await dispatchMockRpc(api, body)));
    }) as typeof fetch;
    return { chain, api, http: new HttpMockChainApi('http://app/api/rpc', fetchImpl), saves: () => saves };
  };

  it('runs a full flow over HTTP and persists after mutations', async () => {
    const { http, saves } = setup();
    const treasury = await http.createAccount('treasury');
    const alice = await http.createAccount('alice');
    await http.faucet(treasury, (100n * BDX).toString());
    const { asset } = await http.deployAsset(treasury, { ticker: 'bCLP', name: 'Peso', decimals: 0, supplyAtomic: '1000' }, false);
    await http.mineBlocks(2);
    const tx = await http.transfer(treasury, [{ address: alice, assetId: asset.assetId, amountAtomic: '10' }], true);
    const check = await http.checkTxKey(tx.txHash, tx.txKey, alice);
    expect(check).toMatchObject({ receivedAtomic: '0', tokenReceived: [{ tokenId: asset.assetId, amountAtomic: '10' }], inPool: true });
    expect(await http.getTransaction(tx.txHash)).toMatchObject({ flash: true, inPool: true });
    expect(await http.getIncomingTransfers(tx.txHash, alice)).toEqual([{ assetId: asset.assetId, amountAtomic: '10' }]);
    expect(await http.getTxKey(tx.txHash, treasury)).toBe(tx.txKey);
    expect((await http.getBalances(alice))[asset.assetId]?.total).toBe('10');
    expect(await http.listAssets()).toHaveLength(1);
    expect(await http.resolveBns('nobody.bdx')).toBeNull();
    expect((await http.getInfo()).nettype).toBe('mock-devnet');
    expect(await http.verify('m', treasury, 'MockSigV1x')).toBe(false);
    expect(saves()).toBeGreaterThan(4);
  });

  it('posts to the bridge URL exactly as given (query string included)', async () => {
    const urls: string[] = [];
    const { api } = setup();
    const http = new HttpMockChainApi('/api/rpc?network=mock-devnet', (async (input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(input));
      return new Response(JSON.stringify(await dispatchMockRpc(api, JSON.parse(String(init?.body)))));
    }) as typeof fetch);
    await http.getInfo();
    expect(urls).toEqual(['/api/rpc?network=mock-devnet']);
  });

  it('maps typed errors across the wire', async () => {
    const { http } = setup();
    const treasury = await http.createAccount('treasury');
    const alice = await http.createAccount('alice');
    await http.faucet(treasury, (10n * BDX).toString());
    await http.transfer(treasury, [{ address: alice, assetId: 'BDX', amountAtomic: BDX.toString() }], false);
    await expect(http.transfer(treasury, [{ address: alice, assetId: 'BDX', amountAtomic: BDX.toString() }], false)).rejects.toBeInstanceOf(
      FundsLockedError,
    );
    await expect(http.transfer(alice, [{ address: treasury, assetId: 'BDX', amountAtomic: (50n * BDX).toString() }], false)).rejects.toBeInstanceOf(
      InsufficientFundsError,
    );
    await expect(http.faucet(treasury, (2_000_000n * BDX).toString())).rejects.toBeInstanceOf(ValidationError);
  });

  it('validates parameters and never exposes signing', async () => {
    const { api } = setup();
    const call = (method: string, params?: unknown) => dispatchMockRpc(api, { id: 1, method, params });
    expect((await call('mock_sign', { address: 'a', message: 'b' })).error?.code).toBe(-32601);
    expect((await call('mock___proto__')).error?.code).toBe(-32601);
    expect((await call('get_info')).error?.code).toBe(-32601);
    expect((await call('mock_createAccount', { label: '' })).error?.code).toBe(-32602);
    expect((await call('mock_checkTxKey', { txHash: 'zz', txKey: 'a', address: 'b' })).error?.code).toBe(-32602);
    expect((await call('mock_mineBlocks', { count: 1000 })).error?.code).toBe(-32602);
    expect((await call('mock_transfer', { from: 'a', outputs: [] })).error?.code).toBe(-32602);
    expect((await call('mock_deployAsset', { owner: 'a', params: { decimals: 40 } })).error?.code).toBe(-32602);
    expect((await call('mock_faucet', { address: 'a', amountAtomic: '1.5' })).error?.code).toBe(-32602);
    const badAsset = await call('mock_transfer', { from: 'a', outputs: [{ address: 'b', assetId: 'constructor', amountAtomic: '1' }] });
    expect(badAsset.error?.code).toBe(-32602);
    expect((await call('mock_getInfo')).result).toMatchObject({ nettype: 'mock-devnet' });
    expect(MOCK_BRIDGE_METHODS).not.toContain('mock_sign');
  });
});
