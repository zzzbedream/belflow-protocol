import 'server-only';
import { BDX_DECIMALS, CHANGE_UNLOCK_BLOCKS, NATIVE_TOKEN_ID, formatUnits, parseUnits } from '@belflow/sdk';
import {
  createAgentFetch,
  providerPayer,
  type AgentEvent,
  type ConsumeResult,
  type NonceStore,
  type StoredChallenge,
  type X402Config,
} from '@belflow/x402';
import { z } from 'zod';
import { recordActivity } from './activity';
import { db } from './db';
import { serverEnv } from './env';
import { MOCK_ACCOUNTS } from './mockChain';
import { getRuntime, networkSchema, type AppNetwork } from './runtime';
import { findToken } from './tokens';

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

/**
 * Prisma-backed nonce store. consume() is a single conditional UPDATE
 * (isConsumed = false AND expiresAt > now) that must affect exactly one row;
 * consumedByTxHash is UNIQUE, so one payment can never unlock two challenges
 * even under concurrent requests.
 */
export class PrismaNonceStore implements NonceStore {
  async create(challenge: StoredChallenge): Promise<void> {
    await db.x402PaymentNonce.create({
      data: {
        nonce: challenge.nonce,
        network: challenge.network,
        resourcePath: challenge.resourcePath,
        requiredAmount: challenge.amountAtomic,
        tokenTicker: challenge.tokenTicker,
        tokenId: challenge.tokenId,
        recipientAddress: challenge.recipientAddress,
        expiresAt: new Date(challenge.expiresAt),
      },
    });
  }

  async get(nonce: string): Promise<StoredChallenge | null> {
    const row = await db.x402PaymentNonce.findUnique({ where: { nonce } });
    if (!row) return null;
    return {
      nonce: row.nonce,
      network: row.network,
      resourcePath: row.resourcePath,
      amountAtomic: row.requiredAmount,
      tokenId: row.tokenId,
      tokenTicker: row.tokenTicker,
      recipientAddress: row.recipientAddress,
      expiresAt: row.expiresAt.getTime(),
      consumed: row.isConsumed,
      ...(row.consumedByTxHash ? { consumedByTxHash: row.consumedByTxHash } : {}),
      ...(row.agentBns ? { agentBns: row.agentBns } : {}),
    };
  }

  async consume(nonce: string, txHash: string, now: number, agentBns?: string): Promise<ConsumeResult> {
    try {
      const result = await db.x402PaymentNonce.updateMany({
        where: { nonce, isConsumed: false, expiresAt: { gt: new Date(now) } },
        data: { isConsumed: true, consumedByTxHash: txHash, agentBns: agentBns ?? null, consumedAt: new Date(now) },
      });
      if (result.count === 1) return 'ok';
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') return 'tx-reused';
      throw error;
    }
    const row = await db.x402PaymentNonce.findUnique({ where: { nonce } });
    if (!row) return 'unknown';
    if (row.isConsumed) return 'already-consumed';
    return 'expired';
  }
}

/** Price and payee for the demo resource on each network. */
export async function x402Config(network: AppNetwork): Promise<X402Config> {
  const env = serverEnv();
  const runtime = await getRuntime(network);
  // On testnet check_tx_key cannot attribute assets yet, so the demo charges BDX there.
  const configured = network === 'mock-devnet' ? await findToken(network, env.X402_TOKEN_TICKER) : undefined;
  const token = configured ?? { tokenId: NATIVE_TOKEN_ID, ticker: 'BDX', decimals: BDX_DECIMALS };
  const amountAtomic = parseUnits(env.X402_PRICE, token.decimals);
  const recipient =
    network === 'mock-devnet'
      ? { address: (await runtime.bns.resolve(MOCK_ACCOUNTS.oracle.bns)).resolvedAddress, bns: MOCK_ACCOUNTS.oracle.bns }
      : { address: runtime.treasuryAddress };
  return {
    network,
    price: { amount: formatUnits(amountAtomic, token.decimals), amountAtomic, tokenId: token.tokenId, tokenTicker: token.ticker, decimals: token.decimals },
    recipient,
    store: new PrismaNonceStore(),
    verifier: runtime.verification,
    ttlMs: CHALLENGE_TTL_MS,
    allowFlashInPool: true,
  };
}

export const agentRunSchema = z
  .object({
    network: networkSchema,
    calls: z.number().int().min(1).max(5).default(1),
    maxPerCall: z.string().regex(/^\d{1,12}(\.\d{1,12})?$/),
    budget: z.string().regex(/^\d{1,12}(\.\d{1,12})?$/),
    useFlash: z.boolean().default(true),
  })
  .strict();

export interface AgentTraceEvent {
  at: number;
  type: AgentEvent['type'] | 'error';
  detail: Record<string, string | number | boolean>;
}

function serialize(event: AgentEvent): AgentTraceEvent['detail'] {
  switch (event.type) {
    case 'challenge':
      return {
        status: 402,
        recipient: event.challenge.recipientBnsOrAddress,
        amount: event.challenge.amountRequired,
        token: event.challenge.tokenTicker,
        nonce: event.challenge.nonce,
        expiresAt: event.challenge.expiresAt,
      };
    case 'policy-approved':
      return { spentAtomic: event.spentAtomic.toString(), remainingAtomic: event.remainingAtomic.toString() };
    case 'paid':
      return { txHash: event.txHash, feeAtomic: event.feeAtomic ?? '0', burnedAtomic: event.burnedAtomic ?? '0' };
    case 'request':
    case 'retry':
      return { url: event.url };
    case 'response':
      return { status: event.status };
  }
}

/**
 * Runs the demo AI agent (alpha-bot.bdx) server-side: it calls the protected
 * resource over HTTP, receives 402, checks its spend policy, pays with a
 * Flash transaction and retries with the proof.
 */
export async function runAgent(input: z.infer<typeof agentRunSchema>, origin: string) {
  const runtime = await getRuntime(input.network);
  const config = await x402Config(input.network);
  const { tokenId, decimals, tokenTicker } = config.price;
  const trace: AgentTraceEvent[] = [];
  const agentFetch = createAgentFetch({
    payer: providerPayer(runtime.agent, { useFlash: input.useFlash }),
    policy: {
      networks: [input.network],
      maxPerCall: { [tokenId]: parseUnits(input.maxPerCall, decimals) },
      budget: { [tokenId]: parseUnits(input.budget, decimals) },
      allowedRecipients: [config.recipient.bns ?? config.recipient.address],
    },
    agentBns: runtime.agentBns,
    resolveBns: (name) => runtime.bns.resolve(name),
    onEvent: (event) => trace.push({ at: Date.now(), type: event.type, detail: serialize(event) }),
  });

  const responses: unknown[] = [];
  for (let i = 0; i < input.calls; i += 1) {
    // A single-UTXO agent wallet must wait for its change to unlock between
    // payments. Mock devnet simulates that time; real agents pre-split UTXOs.
    if (i > 0 && runtime.advanceBlocks) await runtime.advanceBlocks(CHANGE_UNLOCK_BLOCKS + 1);
    try {
      const response = await agentFetch(`${origin}/api/x402/demo?network=${input.network}`);
      responses.push(await response.json().catch(() => null));
    } catch (error) {
      trace.push({ at: Date.now(), type: 'error', detail: { message: (error as Error).message } });
      break;
    }
  }

  for (const event of trace) {
    if (event.type !== 'paid') continue;
    await recordActivity({
      network: input.network,
      kind: 'X402',
      txHash: String(event.detail.txHash),
      feeAtomic: String(event.detail.feeAtomic),
      burnedAtomic: String(event.detail.burnedAtomic),
      tokenId,
      volumeAtomic: config.price.amountAtomic.toString(),
    });
  }
  const spent = agentFetch.spent()[tokenId] ?? 0n;
  return { agentBns: runtime.agentBns, tokenTicker, spent: formatUnits(spent, decimals), trace, responses };
}

export async function x402Metrics(network: AppNetwork) {
  const now = new Date();
  const [issued, settled, expired] = await Promise.all([
    db.x402PaymentNonce.count({ where: { network } }),
    db.x402PaymentNonce.findMany({ where: { network, isConsumed: true }, select: { requiredAmount: true, tokenTicker: true, agentBns: true } }),
    db.x402PaymentNonce.count({ where: { network, isConsumed: false, expiresAt: { lte: now } } }),
  ]);
  const agents = new Set(settled.map((row) => row.agentBns).filter(Boolean));
  return { challengesIssued: issued, paidCalls: settled.length, expired, distinctAgents: agents.size, conversionRate: issued === 0 ? 0 : settled.length / issued };
}
