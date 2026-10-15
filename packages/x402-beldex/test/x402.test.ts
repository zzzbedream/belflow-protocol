import { LocalMockChainApi, MockChain, MockTestnetProvider, parseUnits } from '@belflow/sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  InMemoryNonceStore,
  SpendPolicyError,
  X402_HEADERS,
  createAgentFetch,
  expressX402,
  fastifyX402,
  formatProof,
  guardRequest,
  parseChallenge,
  parseProof,
  providerPayer,
  withX402,
  type AgentEvent,
  type AgentPayer,
  type SpendPolicy,
  type X402Config,
  type X402Payment,
} from '../src';

const URL_DEMO = 'http://api.test/api/x402/demo';

interface World {
  chain: MockChain;
  agent: MockTestnetProvider;
  oracleAddress: string;
  busd: string;
  config: X402Config;
  handler: (request: Request) => Promise<Response>;
  serverFetch: typeof fetch;
  policy: SpendPolicy;
}

async function world(now?: () => number): Promise<World> {
  const chain = new MockChain({ seed: 'x402' });
  const api = new LocalMockChainApi(chain);
  const treasury = new MockTestnetProvider({ api, accountLabel: 'treasury' });
  await treasury.connectWallet();
  const agent = new MockTestnetProvider({ api, accountLabel: 'alpha-bot', faucetBdx: '500' });
  await agent.connectWallet();
  const oracleAddress = chain.createAccount('oracle-provider');
  chain.registerBns('oracle-provider.bdx', oracleAddress);
  const token = await treasury.mintPrivacyToken({ ticker: 'bUSD', name: 'USD', decimals: 6, totalSupply: '1000' });
  chain.mineBlocks(3);
  await treasury.sendConfidentialBatch(
    [{ id: 'fund', recipientInput: 'alpha-bot', resolvedAddress: agent.connectedAddress as string, amount: '100', tokenId: token.tokenId }],
    false,
  );
  chain.mineBlocks(3);
  const config: X402Config = {
    network: 'mock-devnet',
    price: { amount: '0.50', amountAtomic: 500_000n, tokenId: token.tokenId, tokenTicker: 'bUSD', decimals: 6 },
    recipient: { address: oracleAddress, bns: 'oracle-provider.bdx' },
    store: new InMemoryNonceStore(),
    verifier: treasury.verificationSources(),
    ...(now ? { now } : {}),
  };
  const handler = withX402(async (_request, payment) => Response.json({ data: 'premium inference', paidWith: payment.txHash }), config);
  const serverFetch = (async (input: RequestInfo | URL, init?: RequestInit) => handler(new Request(input, init))) as typeof fetch;
  const policy: SpendPolicy = {
    networks: ['mock-devnet'],
    maxPerCall: { [token.tokenId]: 1_000_000n },
    budget: { [token.tokenId]: 1_200_000n },
    allowedRecipients: ['oracle-provider.bdx'],
  };
  return { chain, agent, oracleAddress, busd: token.tokenId, config, handler, serverFetch, policy };
}

describe('x402-beldex end to end', () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });

  it('answers 402, pays with a flash tx and unlocks the resource', async () => {
    const events: AgentEvent[] = [];
    const agentFetch = createAgentFetch({
      payer: providerPayer(w.agent),
      policy: w.policy,
      agentBns: 'alpha-bot.bdx',
      resolveBns: (name) => w.agent.resolveBNS(name),
      fetch: w.serverFetch,
      onEvent: (event) => events.push(event),
    });
    const response = await agentFetch(URL_DEMO);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { data: string }).data).toBe('premium inference');
    expect(response.headers.get('X-Beldex-Payment-Receipt')).toMatch(/^[0-9a-f]{64}$/);
    expect(events.map((e) => e.type)).toEqual(['request', 'challenge', 'policy-approved', 'paid', 'retry', 'response']);
    expect(agentFetch.spent()[w.busd]).toBe(500_000n);
    const paid = events.find((e) => e.type === 'paid');
    expect(paid && 'burnedAtomic' in paid && BigInt(paid.burnedAtomic ?? '0')).toBeGreaterThan(0n);
    // Settled from the mempool: the flash tx is not mined yet.
    expect(w.chain.getTransaction((paid as { txHash: string }).txHash)?.inPool).toBe(true);
  });

  it('enforces the budget across calls', async () => {
    const agentFetch = createAgentFetch({ payer: providerPayer(w.agent), policy: w.policy, resolveBns: (n) => w.agent.resolveBNS(n), fetch: w.serverFetch });
    await agentFetch(URL_DEMO);
    w.chain.mineBlocks(3);
    await agentFetch(URL_DEMO);
    w.chain.mineBlocks(3);
    await expect(agentFetch(URL_DEMO)).rejects.toThrow(/Budget/);
  });

  it('rejects replays of a used nonce and reuse of one tx for another nonce', async () => {
    const first = await w.handler(new Request(URL_DEMO));
    const challenge = parseChallenge(first.headers);
    const pay = await providerPayer(w.agent).pay(challenge);
    const proof = formatProof({ ...pay, agentBns: 'alpha-bot.bdx' });
    const headers = { [X402_HEADERS.proof]: proof, [X402_HEADERS.nonce]: challenge.nonce };
    expect((await w.handler(new Request(URL_DEMO, { headers }))).status).toBe(200);

    const replay = await w.handler(new Request(URL_DEMO, { headers }));
    expect(replay.status).toBe(402);
    expect(((await replay.json()) as { reason: string }).reason).toBe('nonce_already_used');

    const fresh = parseChallenge((await w.handler(new Request(URL_DEMO))).headers);
    const reuse = await w.handler(new Request(URL_DEMO, { headers: { [X402_HEADERS.proof]: proof, [X402_HEADERS.nonce]: fresh.nonce } }));
    expect(reuse.status).toBe(409);
    expect(((await reuse.json()) as { reason: string }).reason).toBe('tx-reused');
  });

  it('rejects a payment mined before the challenge was issued', async () => {
    const bound = withX402(async () => Response.json({ ok: true }), { ...w.config, currentHeight: async () => w.chain.height });
    // An unrelated earlier transfer to the provider, already confirmed.
    const earlier = await w.agent.sendConfidentialBatch(
      [{ id: 'old', recipientInput: 'oracle', resolvedAddress: w.oracleAddress, amount: '0.5', tokenId: w.busd }],
      false,
    );
    w.chain.mineBlocks(3);
    const challenge = parseChallenge((await bound(new Request(URL_DEMO))).headers);
    const response = await bound(
      new Request(URL_DEMO, { headers: { [X402_HEADERS.proof]: formatProof({ txHash: earlier.txHash, txKey: earlier.txKey }), [X402_HEADERS.nonce]: challenge.nonce } }),
    );
    expect(response.status).toBe(402);
    expect(((await response.json()) as { reason: string }).reason).toBe('payment_predates_challenge');

    // A payment made after the challenge still works.
    const fresh = parseChallenge((await bound(new Request(URL_DEMO))).headers);
    const pay = await providerPayer(w.agent).pay(fresh);
    const ok = await bound(new Request(URL_DEMO, { headers: { [X402_HEADERS.proof]: formatProof(pay), [X402_HEADERS.nonce]: fresh.nonce } }));
    expect(ok.status).toBe(200);
  });

  it('lets exactly one of two concurrent retries through', async () => {
    const challenge = parseChallenge((await w.handler(new Request(URL_DEMO))).headers);
    const pay = await providerPayer(w.agent).pay(challenge);
    const headers = { [X402_HEADERS.proof]: formatProof(pay), [X402_HEADERS.nonce]: challenge.nonce };
    const statuses = (await Promise.all([w.handler(new Request(URL_DEMO, { headers })), w.handler(new Request(URL_DEMO, { headers }))])).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
  });

  it('refuses underpayment and asset confusion (BDX for a bUSD price)', async () => {
    const underpay: AgentPayer = {
      pay: (challenge) => providerPayer(w.agent).pay({ ...challenge, amountRequired: '0.1', amountAtomic: 100_000n }),
    };
    const under = await createAgentFetch({ payer: underpay, policy: w.policy, resolveBns: (n) => w.agent.resolveBNS(n), fetch: w.serverFetch })(URL_DEMO);
    expect(under.status).toBe(402);
    expect(((await under.json()) as { failures: string[] }).failures).toContain('AMOUNT_INSUFFICIENT');

    w.chain.mineBlocks(3);
    const wrongAsset: AgentPayer = { pay: (challenge) => providerPayer(w.agent).pay({ ...challenge, tokenId: 'BDX', tokenTicker: 'BDX' }) };
    const confused = await createAgentFetch({ payer: wrongAsset, policy: w.policy, resolveBns: (n) => w.agent.resolveBNS(n), fetch: w.serverFetch })(URL_DEMO);
    expect(confused.status).toBe(402);
    expect(((await confused.json()) as { failures: string[] }).failures).toContain('ASSET_MISMATCH');
  });

  it('rejects unknown, expired and malformed proofs', async () => {
    const proof = formatProof({ txHash: 'a'.repeat(64), txKey: 'b'.repeat(64) });
    const unknown = await w.handler(new Request(URL_DEMO, { headers: { [X402_HEADERS.proof]: proof, [X402_HEADERS.nonce]: crypto.randomUUID() } }));
    expect(((await unknown.json()) as { reason: string }).reason).toBe('unknown_nonce');
    const malformed = await w.handler(new Request(URL_DEMO, { headers: { [X402_HEADERS.proof]: 'nope' } }));
    expect(malformed.status).toBe(400);

    let clock = 1_000;
    const timed = await world(() => clock);
    const challenge = parseChallenge((await timed.handler(new Request(URL_DEMO))).headers);
    clock += 10 * 60 * 1000;
    const expired = await timed.handler(new Request(URL_DEMO, { headers: { [X402_HEADERS.proof]: proof, [X402_HEADERS.nonce]: challenge.nonce } }));
    expect(((await expired.json()) as { reason: string }).reason).toBe('nonce_expired');

    const other = await guardRequest(
      new Request('http://api.test/other', { headers: { [X402_HEADERS.proof]: proof, [X402_HEADERS.nonce]: parseChallenge((await w.handler(new Request(URL_DEMO))).headers).nonce } }),
      w.config,
    );
    expect(other.status).toBe('blocked');
    expect(other.status === 'blocked' && ((await other.response.json()) as { reason: string }).reason).toBe('nonce_scope_mismatch');
  });
});

describe('spend policy', () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });
  const run = (policy: Partial<SpendPolicy>, extra: Partial<Parameters<typeof createAgentFetch>[0]> = {}) =>
    createAgentFetch({ payer: providerPayer(w.agent), policy: { ...w.policy, ...policy }, resolveBns: (n) => w.agent.resolveBNS(n), fetch: w.serverFetch, ...extra })(URL_DEMO);

  it('refuses before paying when anything is outside policy', async () => {
    await expect(run({ networks: ['testnet'] })).rejects.toBeInstanceOf(SpendPolicyError);
    await expect(run({ maxPerCall: { [w.busd]: 1n } })).rejects.toThrow(/per-call cap/);
    await expect(run({ maxPerCall: {}, budget: {} })).rejects.toThrow(/not allowed/);
    await expect(run({ allowedRecipients: ['someone-else.bdx'] })).rejects.toThrow(/allowlist/);
    await expect(run({}, { resolveBns: undefined })).rejects.toThrow(/allowlist/);
    expect(w.chain.getBalances(w.agent.connectedAddress as string)[w.busd]?.total).toBe(parseUnits('100', 6));
  });

  it('accepts raw addresses on the allowlist and passes non-402 responses through', async () => {
    const response = await run({ allowedRecipients: [w.oracleAddress] });
    expect(response.status).toBe(200);
    const plain = createAgentFetch({ payer: providerPayer(w.agent), policy: w.policy, fetch: (async () => new Response('ok')) as typeof fetch });
    expect((await plain(URL_DEMO)).status).toBe(200);
  });

  it('refuses providers that cannot export tx keys', async () => {
    const extensionLike = { ...w.agent, kind: 'browser-extension', capabilities: { ...w.agent.capabilities, txKeys: false } } as unknown as MockTestnetProvider;
    await expect(run({}, { payer: providerPayer(extensionLike) })).rejects.toThrow(/tx keys/);
  });
});

describe('protocol parsing', () => {
  it('validates challenge headers and proofs', () => {
    expect(() => parseChallenge(new Headers())).toThrow(/Missing/);
    const base = {
      [X402_HEADERS.recipient]: 'x.bdx',
      [X402_HEADERS.recipientAddress]: 'addr',
      [X402_HEADERS.amount]: '0.5',
      [X402_HEADERS.amountAtomic]: '500000',
      [X402_HEADERS.token]: 'bUSD',
      [X402_HEADERS.tokenId]: 'c'.repeat(64),
      [X402_HEADERS.decimals]: '6',
      [X402_HEADERS.network]: 'testnet',
      [X402_HEADERS.nonce]: crypto.randomUUID(),
      [X402_HEADERS.expires]: '123',
    };
    expect(parseChallenge(new Headers(base)).amountAtomic).toBe(500_000n);
    expect(() => parseChallenge(new Headers({ ...base, [X402_HEADERS.amount]: '-1' }))).toThrow(/amount/);
    expect(() => parseChallenge(new Headers({ ...base, [X402_HEADERS.decimals]: '40' }))).toThrow(/decimals/);
    expect(() => parseChallenge(new Headers({ ...base, [X402_HEADERS.tokenId]: 'x' }))).toThrow(/token id/);
    expect(() => parseChallenge(new Headers({ ...base, [X402_HEADERS.nonce]: 'n' }))).toThrow(/nonce/);
    expect(() => parseChallenge(new Headers({ ...base, [X402_HEADERS.expires]: 'soon' }))).toThrow(/expiry/);
    expect(parseProof(`${'A'.repeat(64)}:${'b'.repeat(64)}:`)).toEqual({ txHash: 'a'.repeat(64), txKey: 'b'.repeat(64) });
    expect(() => parseProof(`${'a'.repeat(64)}:${'b'.repeat(64)}:BAD NAME`)).toThrow(/BNS/);
    expect(() => parseProof('a:b:c:d')).toThrow(/Malformed/);
  });
});

describe('Node adapters', () => {
  it('express: challenges with 402 and calls next() once paid', async () => {
    const w = await world();
    const middleware = expressX402(w.config);
    const res = { statusCode: 0, headers: {} as Record<string, string>, body: '', locals: {} as Record<string, unknown> };
    const fakeRes = {
      status(code: number) { res.statusCode = code; return fakeRes; },
      setHeader(name: string, value: string) { res.headers[name.toLowerCase()] = value; },
      send(body: string) { res.body = body; },
      locals: res.locals,
    };
    let nextCalls = 0;
    await middleware({ method: 'GET', originalUrl: '/api/x402/demo', headers: { host: 'api.test' } }, fakeRes, () => { nextCalls += 1; });
    expect(res.statusCode).toBe(402);
    const challenge = parseChallenge(new Headers(res.headers));
    const pay = await providerPayer(w.agent).pay(challenge);
    await middleware(
      { method: 'GET', originalUrl: '/api/x402/demo', headers: { host: 'api.test', [X402_HEADERS.proof.toLowerCase()]: formatProof(pay), [X402_HEADERS.nonce.toLowerCase()]: challenge.nonce } },
      fakeRes,
      () => { nextCalls += 1; },
    );
    expect(nextCalls).toBe(1);
    expect(res.locals.x402Payment).toMatchObject({ txHash: pay.txHash });
    let failure: unknown;
    await expressX402({ ...w.config, store: { create: async () => { throw new Error('db down'); }, get: async () => null, consume: async () => 'unknown' } })(
      { headers: { host: 'api.test' } },
      fakeRes,
      (error) => { failure = error; },
    );
    expect(String(failure)).toMatch(/db down/);
  });

  it('fastify: replies 402 and decorates the request when paid', async () => {
    const w = await world();
    const hook = fastifyX402(w.config);
    const reply = { status: 0, headers: {} as Record<string, string>, sent: '' };
    const fakeReply = {
      code(status: number) { reply.status = status; return fakeReply; },
      header(name: string, value: string) { reply.headers[name] = value; return fakeReply; },
      send(body: string) { reply.sent = body; },
    };
    await hook({ url: '/api/x402/demo', headers: { host: 'api.test' } }, fakeReply);
    expect(reply.status).toBe(402);
    const challenge = parseChallenge(new Headers(reply.headers));
    const pay = await providerPayer(w.agent).pay(challenge);
    const request: { url: string; headers: Record<string, string>; x402Payment?: X402Payment } = {
      url: '/api/x402/demo',
      headers: { host: 'api.test', [X402_HEADERS.proof]: formatProof(pay), [X402_HEADERS.nonce]: challenge.nonce },
    };
    await hook(request, fakeReply);
    expect(request.x402Payment).toMatchObject({ txHash: pay.txHash });
  });
});
