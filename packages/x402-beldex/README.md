# @belflow/x402

HTTP 402 Payment Required rails for AI agents, settled privately on Beldex.

## Server

```ts
import { withX402, InMemoryNonceStore } from '@belflow/x402';

export const GET = withX402(
  (request, payment) => Response.json({ data: 'premium', paidWith: payment.txHash }),
  {
    network: 'testnet',
    price: { amount: '0.50', amountAtomic: 500_000_000n, tokenId: 'BDX', tokenTicker: 'BDX', decimals: 9 },
    recipient: { address: 'A…', bns: 'oracle-provider.bdx' },
    store: new InMemoryNonceStore(),              // use an atomic DB store in production
    verifier: walletRpcProvider.verificationSources(),
    currentHeight: () => daemon.getInfo().then((i) => i.height),
  },
);
```

Without a proof, the guard answers `402` with `X-Beldex-Recipient`, `X-Beldex-Amount`, `X-Beldex-Token`, `X-Beldex-Payment-Nonce` and related headers.

With `X-Beldex-Payment-Proof: <txHash>:<txKey>:<agent.bdx>`, the guard:

1. Checks the nonce: known, unexpired, same path and network.
2. Verifies amount, asset and recipient. A Flash tx is accepted from the mempool only when the daemon flags it as flash.
3. Rejects payments mined before the challenge.
4. Consumes the nonce atomically. One nonce and one tx each unlock exactly one response.

`expressX402(config)` and `fastifyX402(config)` adapt the same guard to Express and Fastify.

## Agent

```ts
import { createAgentFetch, providerPayer } from '@belflow/x402';

const agentFetch = createAgentFetch({
  payer: providerPayer(walletRpcProvider),
  agentBns: 'alpha-bot.bdx',
  resolveBns: (name) => walletRpcProvider.resolveBNS(name),
  policy: {
    networks: ['testnet'],
    maxPerCall: { BDX: 1_000_000_000n },
    budget: { BDX: 10_000_000_000n },
    allowedRecipients: ['oracle-provider.bdx'],   // resolved by the agent, not trusted from the server
  },
});
const response = await agentFetch('https://api.example/premium');
```

The client throws `SpendPolicyError` instead of paying when the network, token, cap, budget or payee is outside policy.
