// Single-use payment challenges. Implementations MUST make consume() atomic:
// a nonce unlocks one response, and a txHash can settle one nonce only.

export interface StoredChallenge {
  nonce: string;
  network: string;
  resourcePath: string;
  amountAtomic: string;
  tokenId: string;
  tokenTicker: string;
  recipientAddress: string;
  expiresAt: number;
  consumed: boolean;
  consumedByTxHash?: string;
  agentBns?: string;
}

export type ConsumeResult = 'ok' | 'unknown' | 'expired' | 'already-consumed' | 'tx-reused';

export interface NonceStore {
  create(challenge: StoredChallenge): Promise<void>;
  get(nonce: string): Promise<StoredChallenge | null>;
  consume(nonce: string, txHash: string, now: number, agentBns?: string): Promise<ConsumeResult>;
}

/** Process-local store for tests and single-instance servers. */
export class InMemoryNonceStore implements NonceStore {
  private readonly challenges = new Map<string, StoredChallenge>();
  private readonly spentTx = new Set<string>();

  async create(challenge: StoredChallenge): Promise<void> {
    this.challenges.set(challenge.nonce, { ...challenge });
  }

  async get(nonce: string): Promise<StoredChallenge | null> {
    const found = this.challenges.get(nonce);
    return found ? { ...found } : null;
  }

  /** Synchronous check-and-set: atomic within one JS event loop. */
  async consume(nonce: string, txHash: string, now: number, agentBns?: string): Promise<ConsumeResult> {
    const challenge = this.challenges.get(nonce);
    if (!challenge) return 'unknown';
    if (challenge.consumed) return 'already-consumed';
    if (challenge.expiresAt <= now) return 'expired';
    if (this.spentTx.has(txHash)) return 'tx-reused';
    this.spentTx.add(txHash);
    this.challenges.set(nonce, { ...challenge, consumed: true, consumedByTxHash: txHash, ...(agentBns ? { agentBns } : {}) });
    return 'ok';
  }
}
