import { blake2b } from '@noble/hashes/blake2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { isValidAddress } from '../address/address';
import { BNS_TYPE_WALLET } from '../constants';
import { BnsResolutionError, RpcError, ValidationError } from '../errors';
import type { DaemonRpc } from '../rpc/daemon';
import type { WalletRpc } from '../rpc/wallet';
import type { BNSResolution, BeldexNetwork } from '../types';

/** Lowercase label (1-63 chars, inner hyphens allowed) followed by ".bdx". */
export const BNS_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.bdx$/;

export function normalizeBnsName(input: string): string {
  return input.trim().toLowerCase();
}

export function isBnsName(input: string): boolean {
  return BNS_NAME_PATTERN.test(normalizeBnsName(input));
}

/** 32-byte BLAKE2b hash of the lowercase name, as bns_resolve expects. */
export function hashBnsName(name: string): string {
  return bytesToHex(blake2b(utf8ToBytes(normalizeBnsName(name)), { dkLen: 32 }));
}

export interface BnsLookup {
  address: string;
  source: NonNullable<BNSResolution['source']>;
}

/** Pluggable backend: daemon + wallet RPC, the browser extension, or the mock chain. */
export interface BnsBackend {
  lookup(name: string): Promise<BnsLookup | null>;
}

export interface BnsResolverOptions {
  network: BeldexNetwork;
  ttlMs?: number;
  now?: () => number;
}

const DEFAULT_TTL_MS = 60_000;

/** Resolves .bdx names with validation and a small TTL cache. */
export class BnsResolver {
  private readonly cache = new Map<string, { value: BNSResolution; expiresAt: number }>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly backend: BnsBackend,
    private readonly options: BnsResolverOptions,
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  async resolve(domain: string): Promise<BNSResolution> {
    const name = normalizeBnsName(domain);
    if (!BNS_NAME_PATTERN.test(name)) throw new ValidationError(`"${domain}" is not a valid .bdx name.`);

    const cached = this.cache.get(name);
    if (cached && cached.expiresAt > this.now()) return cached.value;

    const found = await this.backend.lookup(name);
    if (!found) throw new BnsResolutionError(name, 'name is not registered');
    if (!isValidAddress(found.address, this.options.network)) {
      throw new BnsResolutionError(name, 'record does not hold a valid address for this network');
    }
    const resolution: BNSResolution = {
      domain: name,
      resolvedAddress: found.address,
      ownerBnsHash: hashBnsName(name),
      isValid: true,
      source: found.source,
    };
    this.cache.set(name, { value: resolution, expiresAt: this.now() + this.ttlMs });
    return resolution;
  }

  /** Accepts either a .bdx name or an address and returns the payable address. */
  async resolveRecipient(input: string): Promise<{ address: string; bns?: string }> {
    const trimmed = input.trim();
    if (isBnsName(trimmed)) {
      const resolution = await this.resolve(trimmed);
      return { address: resolution.resolvedAddress, bns: resolution.domain };
    }
    if (!isValidAddress(trimmed, this.options.network)) {
      throw new ValidationError(`"${trimmed}" is neither a .bdx name nor a valid ${this.options.network} address.`);
    }
    return { address: trimmed };
  }
}

/**
 * Real resolution: hash locally, fetch the encrypted record from the daemon,
 * then decrypt it with wallet-rpc's bns_decrypt_value.
 */
export function createRpcBnsBackend(daemon: DaemonRpc, wallet: WalletRpc): BnsBackend {
  return {
    async lookup(name) {
      const record = await daemon.bnsResolve(hashBnsName(name), BNS_TYPE_WALLET);
      if (!record.encrypted_value) return null;
      const candidates = record.nonce
        ? [record.encrypted_value + record.nonce, record.encrypted_value]
        : [record.encrypted_value];
      for (const candidate of candidates) {
        try {
          const { value } = await wallet.bnsDecryptValue(name, BNS_TYPE_WALLET, candidate);
          return { address: value, source: 'daemon' };
        } catch (error) {
          if (!(error instanceof RpcError)) throw error;
        }
      }
      throw new BnsResolutionError(name, 'the wallet could not decrypt the record');
    },
  };
}
