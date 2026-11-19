import { NATIVE_TOKEN_ID } from '../constants';
import { FundsLockedError, InsufficientFundsError } from '../errors';
import { toBigIntAmount } from '../rpc/json';
import type { WalletBalance, WalletRpc } from '../rpc/wallet';

export interface FundsRequirement {
  /** Atomic BDX needed (amount + fee headroom). Every token send also spends BDX for the fee. */
  minBdxAtomic: bigint;
  /** Privacy token that must also be unlocked (hex token_id). */
  tokenId?: string;
  minTokenAtomic?: bigint;
  accountIndex?: number;
  pollMs?: number;
  timeoutMs?: number;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface Amounts {
  total: bigint;
  unlocked: bigint;
}

function amountsFor(balance: WalletBalance, tokenId: string): Amounts {
  if (tokenId === NATIVE_TOKEN_ID) {
    return { total: toBigIntAmount(balance.balance), unlocked: toBigIntAmount(balance.unlocked_balance) };
  }
  const entry = balance.token_balances?.find((token) => token.token_id.toLowerCase() === tokenId.toLowerCase());
  return { total: toBigIntAmount(entry?.balance), unlocked: toBigIntAmount(entry?.unlocked_balance) };
}

const DEFAULT_POLL_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Waits until enough BDX (and optionally a privacy token) is UNLOCKED. Change from a
 * previous send stays locked for 2 blocks; a token send also locks BDX change
 * (fee input). Throws InsufficientFundsError when even the total balance does
 * not cover the requirement, and FundsLockedError on timeout.
 */
export async function waitForUnlockedFunds(wallet: WalletRpc, requirement: FundsRequirement): Promise<WalletBalance> {
  const sleep = requirement.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = requirement.now ?? Date.now;
  const deadline = now() + (requirement.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const needs: Array<[string, bigint]> = [[NATIVE_TOKEN_ID, requirement.minBdxAtomic]];
  if (requirement.tokenId && requirement.minTokenAtomic !== undefined) needs.push([requirement.tokenId, requirement.minTokenAtomic]);

  for (;;) {
    const balance = await wallet.getBalance(requirement.accountIndex ?? 0);
    let ready = true;
    for (const [tokenId, needed] of needs) {
      const amounts = amountsFor(balance, tokenId);
      if (amounts.total < needed) throw new InsufficientFundsError(tokenId);
      if (amounts.unlocked < needed) ready = false;
    }
    if (ready) return balance;
    if (now() >= deadline) throw new FundsLockedError(needs.map(([id]) => id).join('+'), -1);
    await sleep(requirement.pollMs ?? DEFAULT_POLL_MS);
  }
}

/** Non-blocking check used by request handlers (e.g. the faucet). */
export async function hasUnlockedFunds(wallet: WalletRpc, requirement: Omit<FundsRequirement, 'pollMs' | 'timeoutMs' | 'sleep' | 'now'>): Promise<boolean> {
  try {
    await waitForUnlockedFunds(wallet, { ...requirement, timeoutMs: 0 });
    return true;
  } catch (error) {
    if (error instanceof FundsLockedError) return false;
    throw error;
  }
}
