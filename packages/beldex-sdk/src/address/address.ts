import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { ADDRESS_PREFIXES } from '../constants';
import { ValidationError } from '../errors';
import type { BeldexNetwork } from '../types';
import { decodeBase58, encodeBase58 } from './base58';

export type AddressKind = 'standard' | 'integrated' | 'subaddress';
export type AddressNetwork = 'mainnet' | 'testnet';

export interface DecodedAddress {
  network: AddressNetwork;
  kind: AddressKind;
  spendPublicKey: string;
  viewPublicKey: string;
  paymentId?: string;
}

const KEY_BYTES = 32;
const PAYMENT_ID_BYTES = 8;
const CHECKSUM_BYTES = 4;
const MIN_ADDRESS_LENGTH = 95;
const MAX_ADDRESS_LENGTH = 110;

function encodeVarint(value: number): Uint8Array {
  const bytes: number[] = [];
  let remaining = value;
  while (remaining >= 0x80) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining >>>= 7;
  }
  bytes.push(remaining);
  return Uint8Array.from(bytes);
}

function decodeVarint(data: Uint8Array): { value: number; length: number } {
  let value = 0;
  for (let i = 0; i < Math.min(data.length, 4); i++) {
    const byte = data[i] as number;
    value |= (byte & 0x7f) << (7 * i);
    if ((byte & 0x80) === 0) return { value, length: i + 1 };
  }
  throw new ValidationError('Malformed address prefix.');
}

function lookupPrefix(prefix: number): { network: AddressNetwork; kind: AddressKind } | null {
  for (const network of ['mainnet', 'testnet'] as const) {
    for (const kind of ['standard', 'integrated', 'subaddress'] as const) {
      if (ADDRESS_PREFIXES[network][kind] === prefix) return { network, kind };
    }
  }
  return null;
}

/** Mock devnet reuses testnet prefixes so generated addresses look like real testnet ones. */
export function addressNetworkFor(network: BeldexNetwork): AddressNetwork {
  return network === 'mainnet' ? 'mainnet' : 'testnet';
}

export function encodeAddress(params: {
  network: AddressNetwork;
  kind: AddressKind;
  spendPublicKey: string;
  viewPublicKey: string;
  paymentId?: string;
}): string {
  const prefix = encodeVarint(ADDRESS_PREFIXES[params.network][params.kind]);
  const spend = hexToBytes(params.spendPublicKey);
  const view = hexToBytes(params.viewPublicKey);
  if (spend.length !== KEY_BYTES || view.length !== KEY_BYTES) {
    throw new ValidationError('Public keys must be 32 bytes.');
  }
  const paymentId = params.kind === 'integrated' ? hexToBytes(params.paymentId ?? '') : new Uint8Array();
  if (params.kind === 'integrated' && paymentId.length !== PAYMENT_ID_BYTES) {
    throw new ValidationError('Integrated addresses need an 8-byte payment id.');
  }
  const body = new Uint8Array([...prefix, ...spend, ...view, ...paymentId]);
  const checksum = keccak_256(body).subarray(0, CHECKSUM_BYTES);
  return encodeBase58(new Uint8Array([...body, ...checksum]));
}

/** Decodes and fully validates an address (alphabet, prefix, length and checksum). */
export function decodeAddress(address: string): DecodedAddress {
  const trimmed = address.trim();
  if (trimmed.length < MIN_ADDRESS_LENGTH || trimmed.length > MAX_ADDRESS_LENGTH) {
    throw new ValidationError('Address has an invalid length.');
  }
  let data: Uint8Array;
  try {
    data = decodeBase58(trimmed);
  } catch (error) {
    throw new ValidationError(`Address is not valid base58: ${(error as Error).message}`);
  }
  const { value: prefix, length: prefixLength } = decodeVarint(data);
  const match = lookupPrefix(prefix);
  if (!match) throw new ValidationError('Address prefix is not a known Beldex network.');

  const expectedLength =
    prefixLength + 2 * KEY_BYTES + (match.kind === 'integrated' ? PAYMENT_ID_BYTES : 0) + CHECKSUM_BYTES;
  if (data.length !== expectedLength) throw new ValidationError('Address payload has the wrong size.');

  const body = data.subarray(0, data.length - CHECKSUM_BYTES);
  const checksum = data.subarray(data.length - CHECKSUM_BYTES);
  const expected = keccak_256(body).subarray(0, CHECKSUM_BYTES);
  if (bytesToHex(checksum) !== bytesToHex(expected)) throw new ValidationError('Address checksum mismatch.');

  const keysStart = prefixLength;
  return {
    network: match.network,
    kind: match.kind,
    spendPublicKey: bytesToHex(body.subarray(keysStart, keysStart + KEY_BYTES)),
    viewPublicKey: bytesToHex(body.subarray(keysStart + KEY_BYTES, keysStart + 2 * KEY_BYTES)),
    ...(match.kind === 'integrated'
      ? { paymentId: bytesToHex(body.subarray(keysStart + 2 * KEY_BYTES)) }
      : {}),
  };
}

/** True when the address is well formed and, if given, belongs to the network. */
export function isValidAddress(address: string, network?: BeldexNetwork): boolean {
  try {
    const decoded = decodeAddress(address);
    return network === undefined || decoded.network === addressNetworkFor(network);
  } catch {
    return false;
  }
}

export function assertValidAddress(address: string, network: BeldexNetwork): void {
  const decoded = decodeAddress(address);
  if (decoded.network !== addressNetworkFor(network)) {
    throw new ValidationError(`Address belongs to ${decoded.network}, expected ${addressNetworkFor(network)}.`);
  }
}
