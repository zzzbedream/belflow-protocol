import type { BNSResolution, IBeldexProvider } from '@belflow/sdk';
import { X402_HEADERS, formatProof, parseChallenge, type X402Challenge } from './protocol';

/** Pays a challenge and returns what the server needs to verify it. */
export interface AgentPayer {
  pay(challenge: X402Challenge): Promise<{ txHash: string; txKey: string; feeAtomic?: string; burnedAtomic?: string }>;
}

/**
 * Mandatory spending policy. Without it an agent would pay whatever a
 * (possibly malicious) server asks, to whatever address it names.
 */
export interface SpendPolicy {
  /** Networks the agent may pay on, e.g. ["testnet"]. */
  networks: string[];
  /** Max atomic amount per call, keyed by token id ("BDX" or asset id). Unlisted tokens are refused. */
  maxPerCall: Record<string, bigint>;
  /** Total atomic budget per token for the lifetime of this client. */
  budget: Record<string, bigint>;
  /** Allowed payees: addresses or .bdx names (names are resolved by the agent, not trusted from the server). */
  allowedRecipients: string[];
}

export type AgentEvent =
  | { type: 'request'; url: string }
  | { type: 'challenge'; challenge: X402Challenge }
  | { type: 'policy-approved'; spentAtomic: bigint; remainingAtomic: bigint }
  | { type: 'paid'; txHash: string; feeAtomic?: string; burnedAtomic?: string }
  | { type: 'retry'; url: string }
  | { type: 'response'; status: number };

export class SpendPolicyError extends Error {
  readonly code = 'X402_POLICY';
  constructor(message: string) {
    super(message);
    this.name = 'SpendPolicyError';
  }
}

export interface AgentFetchOptions {
  payer: AgentPayer;
  policy: SpendPolicy;
  agentBns?: string;
  /** Resolves allowlisted .bdx names to addresses (agent-side resolution). */
  resolveBns?: (name: string) => Promise<BNSResolution>;
  fetch?: typeof fetch;
  onEvent?: (event: AgentEvent) => void;
}

export interface AgentFetch {
  (input: string | URL, init?: RequestInit): Promise<Response>;
  /** Atomic amount spent so far per token. */
  spent(): Record<string, bigint>;
}

async function recipientAllowed(challenge: X402Challenge, options: AgentFetchOptions): Promise<boolean> {
  for (const entry of options.policy.allowedRecipients) {
    if (!entry.endsWith('.bdx')) {
      if (entry === challenge.recipientAddress) return true;
      continue;
    }
    if (!options.resolveBns) continue;
    const resolution = await options.resolveBns(entry).catch(() => null);
    if (resolution?.isValid && resolution.resolvedAddress === challenge.recipientAddress) return true;
  }
  return false;
}

/**
 * fetch() for autonomous agents: on HTTP 402 it checks the challenge against
 * the spend policy, pays once with the Beldex payer, and retries with
 * X-Beldex-Payment-Proof + nonce. Throws SpendPolicyError instead of paying
 * when anything is outside policy.
 */
export function createAgentFetch(options: AgentFetchOptions): AgentFetch {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const spent: Record<string, bigint> = {};
  const emit = (event: AgentEvent) => options.onEvent?.(event);

  const agentFetch = async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    emit({ type: 'request', url });
    const first = await doFetch(input, init);
    if (first.status !== 402) {
      emit({ type: 'response', status: first.status });
      return first;
    }

    const challenge = parseChallenge(first.headers);
    emit({ type: 'challenge', challenge });
    const { policy } = options;
    if (!policy.networks.includes(challenge.network)) throw new SpendPolicyError(`Network ${challenge.network} is not allowed.`);
    if (challenge.expiresAt <= Date.now()) throw new SpendPolicyError('Challenge already expired.');
    const cap = policy.maxPerCall[challenge.tokenId];
    const budget = policy.budget[challenge.tokenId];
    if (cap === undefined || budget === undefined) throw new SpendPolicyError(`Token ${challenge.tokenTicker} is not allowed.`);
    if (challenge.amountAtomic > cap) throw new SpendPolicyError(`Price ${challenge.amountRequired} ${challenge.tokenTicker} exceeds the per-call cap.`);
    const already = spent[challenge.tokenId] ?? 0n;
    if (already + challenge.amountAtomic > budget) throw new SpendPolicyError(`Budget for ${challenge.tokenTicker} exhausted.`);
    if (!(await recipientAllowed(challenge, options))) {
      throw new SpendPolicyError(`Recipient ${challenge.recipientBnsOrAddress} is not on the allowlist.`);
    }
    emit({ type: 'policy-approved', spentAtomic: already, remainingAtomic: budget - already - challenge.amountAtomic });

    const payment = await options.payer.pay(challenge);
    spent[challenge.tokenId] = already + challenge.amountAtomic;
    emit({ type: 'paid', txHash: payment.txHash, ...(payment.feeAtomic ? { feeAtomic: payment.feeAtomic } : {}), ...(payment.burnedAtomic ? { burnedAtomic: payment.burnedAtomic } : {}) });

    const headers = new Headers(init.headers);
    headers.set(X402_HEADERS.proof, formatProof({ txHash: payment.txHash, txKey: payment.txKey, ...(options.agentBns ? { agentBns: options.agentBns } : {}) }));
    headers.set(X402_HEADERS.nonce, challenge.nonce);
    emit({ type: 'retry', url });
    const second = await doFetch(input, { ...init, headers });
    emit({ type: 'response', status: second.status });
    return second;
  };

  return Object.assign(agentFetch, { spent: () => ({ ...spent }) });
}

/** Pays challenges with any IBeldexProvider that exposes tx keys (wallet-rpc sidecar or mock). */
export function providerPayer(provider: IBeldexProvider, options: { useFlash?: boolean } = {}): AgentPayer {
  return {
    async pay(challenge) {
      if (!provider.capabilities.txKeys) throw new SpendPolicyError(`${provider.kind} cannot export tx keys, which x402 verification needs.`);
      const result = await provider.sendConfidentialBatch(
        [
          {
            id: `x402-${challenge.nonce}`,
            recipientInput: challenge.recipientBnsOrAddress,
            resolvedAddress: challenge.recipientAddress,
            amount: challenge.amountRequired,
            tokenId: challenge.tokenId,
          },
        ],
        options.useFlash ?? true,
      );
      const part = result.transactions?.[0];
      return {
        txHash: result.txHash,
        txKey: result.txKey,
        ...(part ? { feeAtomic: part.feeAtomic, burnedAtomic: part.burnedAtomic } : {}),
      };
    },
  };
}
