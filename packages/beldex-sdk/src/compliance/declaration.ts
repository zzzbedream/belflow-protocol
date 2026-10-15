import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { ValidationError } from '../errors';

/** Matches the wallet signing policy: single line, ≤ 512 chars, no control characters. */
export const MAX_SIGNABLE_CHARS = 512;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
const HEX64 = /^[0-9a-f]{64}$/i;
const DECLARATION_PREFIX = 'belflow-proof-v1';

export interface PaymentDeclaration {
  txHash: string;
  assetId: string;
  amountAtomic: bigint;
  recipientAddress: string;
}

/**
 * Canonical issuer declaration that binds txHash + asset + amount + recipient:
 * `belflow-proof-v1|<txHash>|<assetId>|<amountAtomic>|<recipient>`.
 */
export function buildPaymentDeclaration(declaration: PaymentDeclaration): string {
  if (!HEX64.test(declaration.txHash)) throw new ValidationError('txHash must be 64 hex characters.');
  if (declaration.amountAtomic <= 0n) throw new ValidationError('Declared amount must be positive.');
  const fields = [
    DECLARATION_PREFIX,
    declaration.txHash.toLowerCase(),
    declaration.assetId,
    declaration.amountAtomic.toString(),
    declaration.recipientAddress,
  ];
  if (fields.some((field) => field.includes('|'))) throw new ValidationError('Declaration fields cannot contain "|".');
  const message = fields.join('|');
  assertSignable(message);
  return message;
}

export function parsePaymentDeclaration(message: string): PaymentDeclaration {
  const [prefix, txHash, assetId, amount, recipientAddress, ...rest] = message.split('|');
  if (prefix !== DECLARATION_PREFIX || rest.length > 0 || !txHash || !assetId || !amount || !recipientAddress) {
    throw new ValidationError('Not a belflow-proof-v1 declaration.');
  }
  if (!/^\d+$/.test(amount)) throw new ValidationError('Declaration amount is not an integer.');
  return { txHash, assetId, amountAtomic: BigInt(amount), recipientAddress };
}

export function assertSignable(message: string): void {
  if (message.length === 0 || message.length > MAX_SIGNABLE_CHARS) {
    throw new ValidationError(`Signable messages must be 1-${MAX_SIGNABLE_CHARS} characters.`);
  }
  if (CONTROL_CHARS.test(message)) throw new ValidationError('Signable messages cannot contain control characters.');
}

/** Deterministic JSON: object keys sorted, bigint as decimal strings. */
export function canonicalJson(value: unknown): string {
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

export function sha256Hex(text: string): string {
  return bytesToHex(sha256(utf8ToBytes(text)));
}
