// CryptoNote base58: data is split into 8-byte blocks, each encoded to a
// fixed-width 11-character group. This is not Bitcoin base58.

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ALPHABET_INDEX = new Map([...ALPHABET].map((char, index) => [char, BigInt(index)] as const));
const FULL_BLOCK_SIZE = 8;
const FULL_ENCODED_BLOCK_SIZE = 11;
/** Encoded length for a block of N bytes (index = N). */
const ENCODED_BLOCK_SIZES = [0, 2, 3, 5, 6, 7, 9, 10, 11] as const;
const BASE = 58n;

function encodeBlock(block: Uint8Array): string {
  let value = 0n;
  for (const byte of block) value = (value << 8n) | BigInt(byte);
  const width = ENCODED_BLOCK_SIZES[block.length] ?? 0;
  const chars: string[] = new Array<string>(width).fill(ALPHABET[0] as string);
  for (let i = width - 1; i >= 0 && value > 0n; i--) {
    chars[i] = ALPHABET[Number(value % BASE)] as string;
    value /= BASE;
  }
  return chars.join('');
}

function decodeBlock(group: string): Uint8Array {
  const size = ENCODED_BLOCK_SIZES.indexOf(group.length as (typeof ENCODED_BLOCK_SIZES)[number]);
  if (size <= 0) throw new Error('Invalid base58 block length.');
  let value = 0n;
  for (const char of group) {
    const digit = ALPHABET_INDEX.get(char);
    if (digit === undefined) throw new Error(`Invalid base58 character "${char}".`);
    value = value * BASE + digit;
  }
  if (value >= 1n << BigInt(size * 8)) throw new Error('Base58 block overflow.');
  const out = new Uint8Array(size);
  for (let i = size - 1; i >= 0; i--) {
    out[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return out;
}

export function encodeBase58(data: Uint8Array): string {
  let result = '';
  for (let offset = 0; offset < data.length; offset += FULL_BLOCK_SIZE) {
    result += encodeBlock(data.subarray(offset, offset + FULL_BLOCK_SIZE));
  }
  return result;
}

export function decodeBase58(encoded: string): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < encoded.length; offset += FULL_ENCODED_BLOCK_SIZE) {
    chunks.push(decodeBlock(encoded.slice(offset, offset + FULL_ENCODED_BLOCK_SIZE)));
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let position = 0;
  for (const chunk of chunks) {
    out.set(chunk, position);
    position += chunk.length;
  }
  return out;
}
