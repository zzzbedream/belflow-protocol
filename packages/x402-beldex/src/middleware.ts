import { verifyPayment, type PaymentVerification, type VerificationSources } from '@belflow/sdk';
import type { NonceStore } from './nonce-store';
import { X402_HEADERS, X402ProtocolError, challengeHeaders, parseProof, type X402Challenge } from './protocol';

export interface X402Price {
  /** Display amount, e.g. "0.50". */
  amount: string;
  amountAtomic: bigint;
  tokenId: string;
  tokenTicker: string;
  decimals: number;
}

export interface X402Config {
  network: string;
  price: X402Price;
  recipient: { address: string; bns?: string };
  store: NonceStore;
  /** Dual verification sources (check_tx_key + asset attribution). */
  verifier: VerificationSources;
  /** Challenge lifetime. Default 5 minutes. */
  ttlMs?: number;
  /** Settle Flash transactions from the mempool (0-conf). Default true. */
  allowFlashInPool?: boolean;
  now?: () => number;
  nonceFactory?: () => string;
  /**
   * Current chain height. When provided, each challenge records it and a
   * payment already mined before the challenge was issued is rejected, so an
   * old unrelated transfer to the same address cannot unlock a new call.
   */
  currentHeight?: () => Promise<number | null>;
}

export interface X402Payment {
  txHash: string;
  agentBns?: string;
  nonce: string;
  verification: PaymentVerification;
}

export type GuardResult = { status: 'paid'; payment: X402Payment } | { status: 'blocked'; response: Response };

const DEFAULT_TTL_MS = 5 * 60 * 1000;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });
}

async function issueChallenge(resourcePath: string, config: X402Config, reason?: string, failures?: string[]): Promise<Response> {
  const now = (config.now ?? Date.now)();
  const challenge: X402Challenge = {
    status: 402,
    recipientBnsOrAddress: config.recipient.bns ?? config.recipient.address,
    recipientAddress: config.recipient.address,
    amountRequired: config.price.amount,
    amountAtomic: config.price.amountAtomic,
    tokenId: config.price.tokenId,
    tokenTicker: config.price.tokenTicker,
    decimals: config.price.decimals,
    network: config.network,
    nonce: (config.nonceFactory ?? (() => crypto.randomUUID()))(),
    expiresAt: now + (config.ttlMs ?? DEFAULT_TTL_MS),
  };
  const issuedAtHeight = config.currentHeight ? await config.currentHeight().catch(() => null) : null;
  await config.store.create({
    ...(typeof issuedAtHeight === 'number' ? { issuedAtHeight } : {}),
    nonce: challenge.nonce,
    network: config.network,
    resourcePath,
    amountAtomic: challenge.amountAtomic.toString(),
    tokenId: challenge.tokenId,
    tokenTicker: challenge.tokenTicker,
    recipientAddress: challenge.recipientAddress,
    expiresAt: challenge.expiresAt,
    consumed: false,
  });
  return json(
    402,
    {
      error: 'payment_required',
      ...(reason ? { reason } : {}),
      ...(failures ? { failures } : {}),
      challenge: { ...challenge, amountAtomic: challenge.amountAtomic.toString() },
    },
    challengeHeaders(challenge),
  );
}

/**
 * Core x402-beldex guard on Web Request/Response (Next.js route handlers,
 * Edge, Deno, Bun). Without a proof it answers 402 with a fresh challenge.
 * With a proof it checks the nonce, verifies the payment (amount + asset +
 * recipient, Flash 0-conf allowed) and only then consumes the nonce
 * atomically, so a nonce and a txHash each unlock exactly one response.
 */
export async function guardRequest(request: Request, config: X402Config): Promise<GuardResult> {
  const resourcePath = new URL(request.url).pathname;
  const proofHeader = request.headers.get(X402_HEADERS.proof);
  if (!proofHeader) return { status: 'blocked', response: await issueChallenge(resourcePath, config) };

  const nonce = request.headers.get(X402_HEADERS.nonce)?.trim() ?? '';
  let proof;
  try {
    proof = parseProof(proofHeader);
  } catch (error) {
    return { status: 'blocked', response: json(400, { error: 'invalid_proof', message: (error as X402ProtocolError).message }) };
  }

  const now = (config.now ?? Date.now)();
  const stored = nonce ? await config.store.get(nonce) : null;
  if (!stored || stored.consumed || stored.expiresAt <= now) {
    const reason = !stored ? 'unknown_nonce' : stored.consumed ? 'nonce_already_used' : 'nonce_expired';
    return { status: 'blocked', response: await issueChallenge(resourcePath, config, reason) };
  }
  if (stored.resourcePath !== resourcePath || stored.network !== config.network) {
    return { status: 'blocked', response: await issueChallenge(resourcePath, config, 'nonce_scope_mismatch') };
  }

  const verification = await verifyPayment(
    {
      txHash: proof.txHash,
      txKey: proof.txKey,
      recipientAddress: stored.recipientAddress,
      assetId: stored.tokenId,
      amountAtomic: BigInt(stored.amountAtomic),
    },
    config.verifier,
    { amountMatch: 'at-least', allowFlashInPool: config.allowFlashInPool ?? true },
  );
  if (!verification.isValid) {
    return { status: 'blocked', response: await issueChallenge(resourcePath, config, 'payment_invalid', verification.failures) };
  }
  const minedBefore =
    stored.issuedAtHeight !== undefined && !verification.inPool && verification.blockHeight !== null && verification.blockHeight < stored.issuedAtHeight;
  if (minedBefore) {
    return { status: 'blocked', response: await issueChallenge(resourcePath, config, 'payment_predates_challenge') };
  }

  const consumed = await config.store.consume(nonce, proof.txHash, now, proof.agentBns);
  if (consumed !== 'ok') {
    return { status: 'blocked', response: json(409, { error: 'replay_rejected', reason: consumed }) };
  }
  return {
    status: 'paid',
    payment: { txHash: proof.txHash, nonce, verification, ...(proof.agentBns ? { agentBns: proof.agentBns } : {}) },
  };
}

/** Next.js / Edge adapter: wraps a route handler behind HTTP 402. */
export function withX402(
  handler: (request: Request, payment: X402Payment) => Promise<Response> | Response,
  config: X402Config | ((request: Request) => Promise<X402Config> | X402Config),
): (request: Request) => Promise<Response> {
  return async (request) => {
    const resolved = typeof config === 'function' ? await config(request) : config;
    const result = await guardRequest(request, resolved);
    if (result.status === 'blocked') return result.response;
    const response = await handler(request, result.payment);
    try {
      response.headers.set('X-Beldex-Payment-Receipt', result.payment.txHash);
    } catch {
      // Immutable headers (e.g. Response.redirect): the receipt header is optional.
    }
    return response;
  };
}

// ---- Node framework adapters (structural types: no runtime dependency) ----

interface NodeLikeRequest {
  method?: string;
  protocol?: string;
  originalUrl?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
}

function toWebRequest(req: NodeLikeRequest): Request {
  const host = String(req.headers.host ?? 'localhost');
  const url = `${req.protocol ?? 'http'}://${host}${req.originalUrl ?? req.url ?? '/'}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  return new Request(url, { method: req.method ?? 'GET', headers });
}

interface ExpressLikeResponse {
  status(code: number): ExpressLikeResponse;
  setHeader(name: string, value: string): unknown;
  send(body: string): unknown;
  locals?: Record<string, unknown>;
}

/** Express middleware: sets res.locals.x402Payment and calls next() when paid. */
export function expressX402(config: X402Config) {
  return async (req: NodeLikeRequest, res: ExpressLikeResponse, next: (error?: unknown) => void): Promise<void> => {
    try {
      const result = await guardRequest(toWebRequest(req), config);
      if (result.status === 'paid') {
        if (res.locals) res.locals.x402Payment = result.payment;
        next();
        return;
      }
      result.response.headers.forEach((value, key) => res.setHeader(key, value));
      res.status(result.response.status).send(await result.response.text());
    } catch (error) {
      next(error);
    }
  };
}

interface FastifyLikeReply {
  code(status: number): FastifyLikeReply;
  header(name: string, value: string): FastifyLikeReply;
  send(body: string): unknown;
}

/** Fastify preHandler hook: decorates request.x402Payment when paid. */
export function fastifyX402(config: X402Config) {
  return async (request: NodeLikeRequest & { x402Payment?: X402Payment }, reply: FastifyLikeReply): Promise<void> => {
    const result = await guardRequest(toWebRequest(request), config);
    if (result.status === 'paid') {
      request.x402Payment = result.payment;
      return;
    }
    result.response.headers.forEach((value, key) => reply.header(key, value));
    await reply.code(result.response.status).send(await result.response.text());
  };
}
