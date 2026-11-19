// CryptoNote / RingCT primitives needed to read Beldex privacy token outputs
// (tx_out_zyphora) from a transaction secret key. Ported from
// Beldex-Coin/beldex@feature-privacy-token (4d89104, 2026-11-14):
// src/crypto/crypto-ops.c, src/crypto/crypto.cpp, src/ringct/rctOps.cpp and
// src/cryptonote_basic/cryptonote_format_utils.cpp. The CryptoNote functions
// are checked against Monero's tests/crypto/tests.txt vectors.
import { ed25519 } from '@noble/curves/ed25519.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

const Point = ed25519.Point;
type EdPoint = InstanceType<typeof Point>;

/** Field prime 2^255 - 19 and the group order l. */
const P = 2n ** 255n - 19n;
export const CURVE_ORDER = 2n ** 252n + 27742317777372353535851937790883648493n;

const mod = (a: bigint) => ((a % P) + P) % P;

function pow(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  let b = mod(base);
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = mod(result * b);
    b = mod(b * b);
    e >>= 1n;
  }
  return result;
}

const SQRT_M1 = pow(2n, (P - 1n) / 4n);

function sqrt(value: bigint): bigint {
  const candidate = pow(value, (P + 3n) / 8n);
  if (mod(candidate * candidate) === mod(value)) return candidate;
  if (mod(candidate * candidate) === mod(-value)) return mod(candidate * SQRT_M1);
  throw new Error('Not a square in GF(p).');
}

// Constants of ge_fromfe_frombytes_vartime. The choice of square root does not
// matter: the final setsign step fixes the parity of x.
const A = 486662n;
const FE_MA = mod(-A);
const FE_MA2 = mod(-A * A);
const FE_FFFB1 = sqrt(mod(-2n * A * (A + 2n)));
const FE_FFFB2 = sqrt(mod(2n * A * (A + 2n)));
const FE_FFFB3 = sqrt(mod(-SQRT_M1 * A * (A + 2n)));
const FE_FFFB4 = sqrt(mod(SQRT_M1 * A * (A + 2n)));

const isNegative = (x: bigint) => (mod(x) & 1n) === 1n;

function bytesToNumberLE(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let i = bytes.length - 1; i >= 0; i -= 1) value = (value << 8n) | BigInt(bytes[i] as number);
  return value;
}

function numberToBytesLE(value: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = value;
  for (let i = 0; i < 32; i += 1) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** (u / v)^((p + 3) / 8), as fe_divpowm1. */
const divPowM1 = (u: bigint, v: bigint) => mod(u * pow(v, 3n) * pow(mod(u * pow(v, 7n)), (P - 5n) / 8n));

/**
 * Map 32 bytes to a curve point (crypto-ops.c ge_fromfe_frombytes_vartime).
 * Unlike fe_frombytes, the top bit is not cleared: the input is read as a
 * 256-bit integer and reduced mod p.
 */
export function geFromFeFromBytesVartime(input: Uint8Array): Uint8Array {
  const u = mod(bytesToNumberLE(input));
  const v = mod(2n * u * u);
  const w = mod(v + 1n);
  let x = mod(w * w + FE_MA2 * v);
  let rX = divPowM1(w, x);
  x = mod(rX * rX * x);
  let z = FE_MA;
  let sign: 0 | 1;
  if (mod(w - x) !== 0n) {
    if (mod(w + x) !== 0n) {
      x = mod(x * SQRT_M1);
      rX = mod(rX * (mod(w - x) !== 0n ? FE_FFFB3 : FE_FFFB4));
      sign = 1;
    } else {
      rX = mod(rX * FE_FFFB1 * u);
      z = mod(z * v);
      sign = 0;
    }
  } else {
    rX = mod(rX * FE_FFFB2 * u);
    z = mod(z * v);
    sign = 0;
  }
  if ((isNegative(rX) ? 1 : 0) !== sign) rX = mod(-rX);
  const y = mod((z - w) * pow(mod(z + w), P - 2n));
  const out = numberToBytesLE(y);
  if (isNegative(rX)) out[31] = (out[31] as number) | 0x80;
  return out;
}

export const keccak = (data: Uint8Array) => keccak_256(data);

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function varint(value: number): Uint8Array {
  const bytes: number[] = [];
  let v = value;
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  bytes.push(v);
  return Uint8Array.from(bytes);
}

const reduce = (value: bigint) => value % CURVE_ORDER;
export const scalarToBytes = (value: bigint) => numberToBytesLE(value);

/** H_s: keccak then sc_reduce32. */
export const hashToScalar = (data: Uint8Array) => reduce(bytesToNumberLE(keccak(data)));

function decodePoint(hex: string): EdPoint | null {
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
  try {
    return Point.fromHex(hex.toLowerCase());
  } catch {
    return null;
  }
}

const pointHex = (point: EdPoint) => bytesToHex(point.toBytes());
const times = (point: EdPoint, scalar: bigint) => (reduce(scalar) === 0n ? Point.ZERO : point.multiplyUnsafe(reduce(scalar)));

/** hash_to_ec: keccak, map to the curve, clear the cofactor. */
export function hashToEc(data: Uint8Array): Uint8Array {
  return Point.fromBytes(geFromFeFromBytesVartime(keccak(data))).multiply(8n).toBytes();
}

/** Public key of a secret scalar. */
export const secretToPublic = (secret: bigint) => pointHex(times(Point.BASE, secret));

/** generate_key_derivation: 8 * secret * public. Null when the public key is invalid. */
export function generateKeyDerivation(publicKeyHex: string, secretKeyHex: string): string | null {
  const point = decodePoint(publicKeyHex);
  if (!point || !/^[0-9a-f]{64}$/i.test(secretKeyHex)) return null;
  return pointHex(times(point, bytesToNumberLE(hexToBytes(secretKeyHex.toLowerCase()))).multiply(8n));
}

/** derivation_to_scalar: H_s(derivation || varint(index)). */
export const derivationToScalar = (derivationHex: string, index: number) => hashToScalar(concat(hexToBytes(derivationHex), varint(index)));

/** derive_public_key: H_s(derivation, index) * G + base. Null when the base is invalid. */
export function derivePublicKey(derivationHex: string, index: number, baseHex: string): string | null {
  const base = decodePoint(baseHex);
  if (!base || !/^[0-9a-f]{64}$/i.test(derivationHex)) return null;
  return pointHex(times(Point.BASE, derivationToScalar(derivationHex, index)).add(base));
}

/**
 * zyphora_derivation_to_scalar (cryptonote_format_utils.cpp): keccak of
 * derivation_to_scalar(derivation, index) || domain, then sc_reduce32. The
 * wallet uses the domains "token_blind", "amount_mask" and "enc_amount".
 */
export function zyphoraDerivationToScalar(derivationHex: string, index: number, domain: string): bigint {
  const base = scalarToBytes(derivationToScalar(derivationHex, index));
  return reduce(bytesToNumberLE(keccak(concat(base, new TextEncoder().encode(domain)))));
}

/** X = 8 * hash_to_curve("beldex_token_id_blinding_generator") (rctOps.cpp, init_ge_p3_X). */
const X = Point.fromBytes(hashToEc(new TextEncoder().encode('beldex_token_id_blinding_generator')));

function requirePoint(hex: string, label: string): EdPoint {
  const point = decodePoint(hex);
  if (!point) throw new Error(`Invalid ${label} point.`);
  return point;
}

/** rct::blindTokenId: T = token_id + r * X. */
export const blindTokenId = (tokenIdHex: string, r: bigint) => pointHex(requirePoint(tokenIdHex, 'token id').add(times(X, r)));

/** decode_zyphora_output step 2: token_id = T - r * X. */
export const unblindTokenId = (blindedHex: string, r: bigint) => pointHex(requirePoint(blindedHex, 'blinded token id').subtract(times(X, r)));

/**
 * rct::commitToken: C = amount * T + mask * G, where T is the output's own
 * BLINDED token id (not the plaintext id).
 */
export function commitToken(mask: bigint, blindedTokenIdHex: string, amount: bigint): string {
  return pointHex(times(requirePoint(blindedTokenIdHex, 'blinded token id'), amount).add(times(Point.BASE, mask)));
}
