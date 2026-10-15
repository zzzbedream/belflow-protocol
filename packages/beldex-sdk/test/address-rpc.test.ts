import { describe, expect, it } from 'vitest';
import { assertValidAddress, decodeAddress, encodeAddress, isValidAddress } from '../src/address/address';
import { decodeBase58, encodeBase58 } from '../src/address/base58';
import { RpcError, RpcTransportError } from '../src/errors';
import { JsonRpcClient } from '../src/rpc/JsonRpcClient';
import { buildDigestAuthorization, parseDigestChallenge } from '../src/rpc/digest';
import { parseJsonSafe, stringifyJsonSafe, toBigIntAmount } from '../src/rpc/json';
import { DaemonRpc } from '../src/rpc/daemon';
import { RpcFailure, rpcFetch } from './helpers';

// Real Monero-family testnet address (prefix 53, shared with Beldex testnet).
const REAL_TESTNET = '9wviCeWe2D8XS82k2ovp5EUYLzBt9pYNW2LXUFsZiv8S3Mt21FZ5qQaAroko1enzw3eGr9qC7X1D7Geoo2RrAotYPwq9Gm8';
const KEY_A = '11'.repeat(32);
const KEY_B = '22'.repeat(32);

describe('addresses', () => {
  it('decodes a real testnet address with a valid checksum', () => {
    const decoded = decodeAddress(REAL_TESTNET);
    expect(decoded.network).toBe('testnet');
    expect(decoded.kind).toBe('standard');
    expect(decoded.spendPublicKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('encodes mainnet addresses with the bx prefix', () => {
    const address = encodeAddress({ network: 'mainnet', kind: 'standard', spendPublicKey: KEY_A, viewPublicKey: KEY_B });
    expect(address.startsWith('bx')).toBe(true);
    expect(address).toHaveLength(97);
    expect(decodeAddress(address)).toMatchObject({ network: 'mainnet', spendPublicKey: KEY_A, viewPublicKey: KEY_B });
  });

  it('round-trips integrated and subaddresses', () => {
    const integrated = encodeAddress({
      network: 'testnet',
      kind: 'integrated',
      spendPublicKey: KEY_A,
      viewPublicKey: KEY_B,
      paymentId: '0102030405060708',
    });
    expect(decodeAddress(integrated)).toMatchObject({ kind: 'integrated', paymentId: '0102030405060708' });
    const sub = encodeAddress({ network: 'testnet', kind: 'subaddress', spendPublicKey: KEY_A, viewPublicKey: KEY_B });
    expect(decodeAddress(sub).kind).toBe('subaddress');
    expect(() => encodeAddress({ network: 'testnet', kind: 'integrated', spendPublicKey: KEY_A, viewPublicKey: KEY_B })).toThrow();
    expect(() => encodeAddress({ network: 'testnet', kind: 'standard', spendPublicKey: '11', viewPublicKey: KEY_B })).toThrow();
  });

  it('rejects tampered, foreign and malformed addresses', () => {
    const tampered = REAL_TESTNET.slice(0, 50) + (REAL_TESTNET[50] === 'a' ? 'b' : 'a') + REAL_TESTNET.slice(51);
    expect(isValidAddress(tampered)).toBe(false);
    expect(isValidAddress('short')).toBe(false);
    expect(isValidAddress('0'.repeat(95))).toBe(false);
    expect(isValidAddress(REAL_TESTNET, 'mainnet')).toBe(false);
    expect(isValidAddress(REAL_TESTNET, 'mock-devnet')).toBe(true);
    expect(() => assertValidAddress(REAL_TESTNET, 'mainnet')).toThrow(/expected mainnet/);
  });

  it('base58 round-trips partial blocks', () => {
    const data = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 250]);
    expect(decodeBase58(encodeBase58(data))).toEqual(data);
  });
});

describe('json helpers', () => {
  it('keeps uint64 precision both ways', () => {
    const parsed = parseJsonSafe<{ amount: string; small: number }>('{"amount": 18446744073709551615, "small": 5}');
    expect(parsed.amount).toBe('18446744073709551615');
    expect(parsed.small).toBe(5);
    expect(stringifyJsonSafe({ amount: 18446744073709551615n })).toBe('{"amount":18446744073709551615}');
    expect(toBigIntAmount('18446744073709551615')).toBe(18446744073709551615n);
    expect(toBigIntAmount(undefined)).toBe(0n);
    expect(() => toBigIntAmount(2 ** 60)).toThrow(RangeError);
    expect(() => toBigIntAmount('1.5')).toThrow(RangeError);
  });
});

describe('digest auth', () => {
  it('parses challenges and computes RFC 2617 responses', () => {
    const challenge = parseDigestChallenge('Digest qop="auth",algorithm=MD5,realm="monero-rpc",nonce="abc",stale=false');
    expect(challenge).toEqual({ realm: 'monero-rpc', nonce: 'abc', qop: 'auth', algorithm: 'MD5' });
    expect(parseDigestChallenge('Basic realm="x"')).toBeNull();
    expect(parseDigestChallenge(null)).toBeNull();
    // RFC 2617 section 3.5 example.
    const header = buildDigestAuthorization({
      challenge: { realm: 'testrealm@host.com', nonce: 'dcd98b7102dd2f0e8b11d0f600bfb0c093', qop: 'auth', opaque: '5ccc069c403ebaf9f0171e9517f40e41' },
      username: 'Mufasa',
      password: 'Circle Of Life',
      method: 'GET',
      uri: '/dir/index.html',
      nonceCount: 1,
      cnonce: '0a4f113b',
    });
    expect(header).toContain('response="6629fae49393a05397450978507c4ef1"');
    expect(header).toContain('nc=00000001');
  });
});

describe('JsonRpcClient', () => {
  it('calls /json_rpc and unwraps results', async () => {
    const urls: string[] = [];
    const base = rpcFetch({ get_info: () => ({ height: 10 }) });
    const client = new JsonRpcClient({
      url: 'http://node:19091/json_rpc',
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        urls.push(String(input));
        return base(input, init);
      }) as typeof fetch,
    });
    await expect(client.call('get_info')).resolves.toEqual({ height: 10 });
    expect(urls).toEqual(['http://node:19091/json_rpc']);
    expect(client.endpoint).toBe('http://node:19091');
  });

  it('raises RpcError for JSON-RPC errors and transport errors for HTTP failures', async () => {
    const client = new JsonRpcClient({ url: 'http://x', fetch: rpcFetch({}) });
    await expect(client.call('nope')).rejects.toBeInstanceOf(RpcError);

    const http500 = new JsonRpcClient({ url: 'http://x', fetch: (async () => new Response('boom', { status: 500 })) as typeof fetch });
    await expect(http500.call('a')).rejects.toMatchObject({ status: 500 });

    const notJson = new JsonRpcClient({ url: 'http://x', fetch: (async () => new Response('<html>')) as typeof fetch });
    await expect(notJson.call('a')).rejects.toBeInstanceOf(RpcTransportError);

    const noResult = new JsonRpcClient({ url: 'http://x', fetch: (async () => new Response('{"jsonrpc":"2.0"}')) as typeof fetch });
    await expect(noResult.call('a')).rejects.toThrow(/no result/);

    const down = new JsonRpcClient({ url: 'http://x', fetch: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch });
    await expect(down.call('a')).rejects.toThrow(/unreachable/);

    const slow = new JsonRpcClient({
      url: 'http://x',
      fetch: (async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); }) as typeof fetch,
    });
    await expect(slow.call('a')).rejects.toThrow(/timed out/);
  });

  it('answers a digest challenge and reuses it with an incrementing nonce count', async () => {
    const authHeaders: Array<string | null> = [];
    const ok = rpcFetch({ get_height: () => ({ height: 3 }) });
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get('authorization');
      authHeaders.push(auth);
      if (!auth) {
        return new Response('', { status: 401, headers: { 'WWW-Authenticate': 'Digest qop="auth",realm="r",nonce="n1"' } });
      }
      return ok(input, init);
    }) as typeof fetch;
    const client = new JsonRpcClient({ url: 'http://w', username: 'u', password: 'p', fetch: fetchImpl });
    await client.call('get_height');
    await client.call('get_height');
    expect(authHeaders[0]).toBeNull();
    expect(authHeaders[1]).toContain('nc=00000001');
    expect(authHeaders[2]).toContain('nc=00000002');
  });

  it('fails cleanly when a 401 has no digest challenge', async () => {
    const client = new JsonRpcClient({
      url: 'http://w',
      username: 'u',
      password: 'p',
      fetch: (async () => new Response('', { status: 401 })) as typeof fetch,
    });
    await expect(client.call('x')).rejects.toMatchObject({ status: 401 });
  });

  it('falls back to the legacy /get_transactions path when json_rpc lacks the method', async () => {
    const paths: string[] = [];
    const jsonRpc = rpcFetch({ get_fee_estimate: () => ({ fee_per_output: 1 }) });
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      paths.push(new URL(url).pathname);
      if (url.endsWith('/get_transactions')) return new Response(JSON.stringify({ txs: [{ tx_hash: 'h', flash: true }] }));
      return jsonRpc(input, init);
    }) as typeof fetch;
    const daemon = new DaemonRpc(new JsonRpcClient({ url: 'http://d', fetch: fetchImpl }));
    await expect(daemon.getTransactions(['h'])).resolves.toEqual([{ tx_hash: 'h', flash: true }]);
    expect(paths).toEqual(['/json_rpc', '/get_transactions']);
    await expect(daemon.getFeeEstimate()).resolves.toEqual({ fee_per_output: 1 });

    const failing = new DaemonRpc(new JsonRpcClient({ url: 'http://d', fetch: rpcFetch({ get_transactions: () => new RpcFailure(-1, 'busy') }) }));
    await expect(failing.getTransactions(['h'])).rejects.toThrow(/busy/);
  });

  it('posts to legacy paths', async () => {
    const client = new JsonRpcClient({
      url: 'http://d',
      fetch: (async (input: RequestInfo | URL) => new Response(JSON.stringify({ url: String(input) }))) as typeof fetch,
    });
    await expect(client.callPath('/get_transactions', {})).resolves.toEqual({ url: 'http://d/get_transactions' });
  });
});
