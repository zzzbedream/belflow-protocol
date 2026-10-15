import { LocalMockChainApi, MockChain, MockTestnetProvider } from '@belflow/sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryNonceStore, X402_HEADERS, formatProof, parseChallenge, providerPayer, withX402, type X402Config } from '../../src';

const URL_DEMO = 'http://api.test/api/x402/demo';
const CONCURRENCY = 20;

let chain: MockChain;
let agent: MockTestnetProvider;
let busd: string;
let handler: (request: Request) => Promise<Response>;

beforeEach(async () => {
  chain = new MockChain({ seed: 'aud-x402' });
  const api = new LocalMockChainApi(chain);
  const treasury = new MockTestnetProvider({ api, accountLabel: 'treasury' });
  await treasury.connectWallet();
  agent = new MockTestnetProvider({ api, accountLabel: 'agent', faucetBdx: '500' });
  const agentAddress = (await agent.connectWallet()).address;
  busd = (await treasury.mintPrivacyToken({ ticker: 'bUSD', name: 'USD', decimals: 6, totalSupply: '1000' })).tokenId;
  chain.mineBlocks(3);
  await treasury.sendConfidentialBatch([{ id: 'f', recipientInput: 'a', resolvedAddress: agentAddress, amount: '100', tokenId: busd }], false);
  chain.mineBlocks(3);
  const config: X402Config = {
    network: 'mock-devnet',
    price: { amount: '0.5', amountAtomic: 500_000n, tokenId: busd, tokenTicker: 'bUSD', decimals: 6 },
    recipient: { address: chain.createAccount('oracle') },
    store: new InMemoryNonceStore(),
    verifier: treasury.verificationSources(),
    currentHeight: async () => chain.height,
  };
  handler = withX402(async () => Response.json({ ok: true }), config);
});

const challenge = async () => parseChallenge((await handler(new Request(URL_DEMO))).headers);
const retry = (proof: string, nonce: string) => handler(new Request(URL_DEMO, { headers: { [X402_HEADERS.proof]: proof, [X402_HEADERS.nonce]: nonce } }));

describe('AUD-02 (x402): asset confusion gets a typed error', () => {
  it('answers 402 error=asset_mismatch when BDX is paid for a bUSD price', async () => {
    const c = await challenge();
    const pay = await providerPayer(agent).pay({ ...c, tokenId: 'BDX', tokenTicker: 'BDX' });
    const response = await retry(formatProof(pay), c.nonce);
    expect(response.status).toBe(402);
    const body = (await response.json()) as { error: string; failures: string[] };
    expect(body.error).toBe('asset_mismatch');
    expect(body.failures).toContain('ASSET_MISMATCH');
  });
});

describe('AUD-03 (x402): high-concurrency replay', () => {
  it(`${CONCURRENCY} concurrent retries with the same nonce and proof: exactly one 200`, async () => {
    const c = await challenge();
    const proof = formatProof(await providerPayer(agent).pay(c));
    const statuses = (await Promise.all(Array.from({ length: CONCURRENCY }, () => retry(proof, c.nonce)))).map((r) => r.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409 || s === 402)).toHaveLength(CONCURRENCY - 1);
  });

  it(`one payment replayed against ${CONCURRENCY} different nonces: exactly one 200`, async () => {
    const nonces = [];
    for (let i = 0; i < CONCURRENCY; i += 1) nonces.push((await challenge()).nonce);
    const first = await challenge();
    const proof = formatProof(await providerPayer(agent).pay(first));
    const statuses = (await Promise.all(nonces.map((nonce) => retry(proof, nonce)))).map((r) => r.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(CONCURRENCY - 1);
  });
});
