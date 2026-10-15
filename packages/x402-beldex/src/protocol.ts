// x402-beldex wire protocol: HTTP 402 challenge headers and the payment
// proof header an agent sends on retry.

export const X402_HEADERS = {
  recipient: 'X-Beldex-Recipient',
  recipientAddress: 'X-Beldex-Recipient-Address',
  amount: 'X-Beldex-Amount',
  amountAtomic: 'X-Beldex-Amount-Atomic',
  token: 'X-Beldex-Token',
  tokenId: 'X-Beldex-Token-Id',
  decimals: 'X-Beldex-Token-Decimals',
  network: 'X-Beldex-Network',
  nonce: 'X-Beldex-Payment-Nonce',
  expires: 'X-Beldex-Payment-Expires',
  proof: 'X-Beldex-Payment-Proof',
} as const;

/** Server-issued price quote. Mirrors X402PaymentChallenge from @belflow/sdk with wire details. */
export interface X402Challenge {
  status: 402;
  /** BNS name when the provider has one, otherwise the address. */
  recipientBnsOrAddress: string;
  recipientAddress: string;
  amountRequired: string;
  amountAtomic: bigint;
  tokenId: string;
  tokenTicker: string;
  decimals: number;
  network: string;
  nonce: string;
  expiresAt: number;
}

export interface PaymentProof {
  txHash: string;
  txKey: string;
  agentBns?: string;
}

export class X402ProtocolError extends Error {
  readonly code = 'X402_PROTOCOL';
  constructor(message: string) {
    super(message);
    this.name = 'X402ProtocolError';
  }
}

const HEX64 = /^[0-9a-f]{64}$/i;
const NONCE = /^[0-9a-f-]{36}$/i;
const BNS = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.bdx$/;
const DECIMAL = /^\d{1,20}(\.\d{1,12})?$/;

export function challengeHeaders(challenge: X402Challenge): Record<string, string> {
  return {
    [X402_HEADERS.recipient]: challenge.recipientBnsOrAddress,
    [X402_HEADERS.recipientAddress]: challenge.recipientAddress,
    [X402_HEADERS.amount]: challenge.amountRequired,
    [X402_HEADERS.amountAtomic]: challenge.amountAtomic.toString(),
    [X402_HEADERS.token]: challenge.tokenTicker,
    [X402_HEADERS.tokenId]: challenge.tokenId,
    [X402_HEADERS.decimals]: String(challenge.decimals),
    [X402_HEADERS.network]: challenge.network,
    [X402_HEADERS.nonce]: challenge.nonce,
    [X402_HEADERS.expires]: String(challenge.expiresAt),
  };
}

function required(headers: Headers, name: string): string {
  const value = headers.get(name);
  if (!value) throw new X402ProtocolError(`Missing ${name} header.`);
  return value.trim();
}

/** Parses and validates a 402 challenge from response headers. */
export function parseChallenge(headers: Headers): X402Challenge {
  const amountRequired = required(headers, X402_HEADERS.amount);
  const amountAtomicText = required(headers, X402_HEADERS.amountAtomic);
  const decimals = Number(required(headers, X402_HEADERS.decimals));
  const tokenId = required(headers, X402_HEADERS.tokenId);
  const nonce = required(headers, X402_HEADERS.nonce);
  const expiresAt = Number(required(headers, X402_HEADERS.expires));
  if (!DECIMAL.test(amountRequired) || !/^\d{1,30}$/.test(amountAtomicText)) throw new X402ProtocolError('Invalid amount.');
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new X402ProtocolError('Invalid token decimals.');
  if (tokenId !== 'BDX' && !HEX64.test(tokenId)) throw new X402ProtocolError('Invalid token id.');
  if (!NONCE.test(nonce)) throw new X402ProtocolError('Invalid nonce.');
  if (!Number.isSafeInteger(expiresAt)) throw new X402ProtocolError('Invalid expiry.');
  return {
    status: 402,
    recipientBnsOrAddress: required(headers, X402_HEADERS.recipient),
    recipientAddress: required(headers, X402_HEADERS.recipientAddress),
    amountRequired,
    amountAtomic: BigInt(amountAtomicText),
    tokenId,
    tokenTicker: required(headers, X402_HEADERS.token),
    decimals,
    network: required(headers, X402_HEADERS.network),
    nonce,
    expiresAt,
  };
}

/** `<txHash>:<txKey>:<agentBnsDomain>` (PRD wire format; the BNS part may be empty). */
export function formatProof(proof: PaymentProof): string {
  return [proof.txHash.toLowerCase(), proof.txKey.toLowerCase(), proof.agentBns ?? ''].join(':');
}

export function parseProof(header: string): PaymentProof {
  const [txHash, txKey, agentBns, ...rest] = header.trim().split(':');
  if (rest.length > 0 || !txHash || !txKey || !HEX64.test(txHash) || !HEX64.test(txKey)) {
    throw new X402ProtocolError('Malformed X-Beldex-Payment-Proof header.');
  }
  if (agentBns && !BNS.test(agentBns)) throw new X402ProtocolError('Invalid agent BNS name.');
  return { txHash: txHash.toLowerCase(), txKey: txKey.toLowerCase(), ...(agentBns ? { agentBns } : {}) };
}
