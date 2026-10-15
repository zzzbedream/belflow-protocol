import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

/** Deterministic 32-byte hex digest of the joined parts. */
export function digestHex(...parts: Array<string | number>): string {
  return bytesToHex(sha256(utf8ToBytes(parts.join('|'))));
}

export function hmacHex(keyHex: string, message: string): string {
  return bytesToHex(hmac(sha256, utf8ToBytes(keyHex), utf8ToBytes(message)));
}

/** Constant-time comparison for equal-length hex strings. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
