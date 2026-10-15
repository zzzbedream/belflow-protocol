import type { ProviderCapabilities, ProviderKind } from './types';

/** Base class so callers can catch every SDK failure with one check. */
export class BelflowError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Reads a BelflowError code without relying on `instanceof`, which breaks
 * when bundlers load the SDK more than once (e.g. per-route bundles).
 */
export function belflowErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export class UnsupportedCapabilityError extends BelflowError {
  constructor(
    readonly capability: keyof ProviderCapabilities,
    readonly providerKind: ProviderKind,
  ) {
    super(`The ${providerKind} provider does not support "${capability}".`, 'UNSUPPORTED_CAPABILITY');
  }
}

export class ValidationError extends BelflowError {
  constructor(message: string) {
    super(message, 'VALIDATION');
  }
}

export class InsufficientFundsError extends BelflowError {
  constructor(tokenId: string) {
    super(`Insufficient unlocked balance for ${tokenId}.`, 'INSUFFICIENT_FUNDS');
  }
}

/**
 * Enough funds exist but part of them are change outputs still inside the
 * spendable-age window. The caller should wait for more blocks and retry.
 */
export class FundsLockedError extends BelflowError {
  constructor(
    tokenId: string,
    readonly unlockHeight: number,
  ) {
    super(`Funds for ${tokenId} are locked until block ${unlockHeight}.`, 'FUNDS_LOCKED');
  }
}

/**
 * A spend request timed out or the connection dropped after it was sent: the
 * wallet may have broadcast it. Never retry blindly; reconcile first.
 */
export class OutcomeUnknownError extends BelflowError {
  constructor(operation: string) {
    super(`${operation}: outcome unknown, the transaction may have been broadcast. Reconcile before retrying.`, 'OUTCOME_UNKNOWN');
  }
}

export class BnsResolutionError extends BelflowError {
  constructor(domain: string, reason: string) {
    super(`Could not resolve ${domain}: ${reason}`, 'BNS_RESOLUTION');
  }
}

/** JSON-RPC error object returned by beldexd or beldex-wallet-rpc. */
export class RpcError extends BelflowError {
  constructor(
    readonly method: string,
    readonly rpcCode: number,
    message: string,
  ) {
    super(`${method}: ${message} (code ${rpcCode})`, 'RPC_ERROR');
  }
}

/** Network, HTTP or timeout failure talking to an RPC endpoint. */
export class RpcTransportError extends BelflowError {
  constructor(
    readonly method: string,
    message: string,
    readonly status?: number,
  ) {
    super(`${method}: ${message}`, 'RPC_TRANSPORT');
  }
}
