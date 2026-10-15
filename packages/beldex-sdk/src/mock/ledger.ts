import { FundsLockedError, InsufficientFundsError } from '../errors';
import type { MockUtxo } from './state';

const amountOf = (utxo: MockUtxo): bigint => BigInt(utxo.amount);

export function totalOf(utxos: readonly MockUtxo[]): bigint {
  return utxos.reduce((sum, utxo) => sum + amountOf(utxo), 0n);
}

export function spendableOf(utxos: readonly MockUtxo[], height: number): bigint {
  return totalOf(utxos.filter((utxo) => utxo.unlockHeight <= height));
}

export function credit(utxos: readonly MockUtxo[], amount: bigint, unlockHeight: number): MockUtxo[] {
  return [...utxos, { amount: amount.toString(), unlockHeight }];
}

/**
 * Spends `needed` from the spendable outputs (largest first) like a CryptoNote
 * wallet, returning the new output set with a locked change output.
 */
export function spend(params: {
  utxos: readonly MockUtxo[];
  needed: bigint;
  height: number;
  changeUnlockHeight: number;
  tokenId: string;
}): MockUtxo[] {
  const { utxos, needed, height, changeUnlockHeight, tokenId } = params;
  const spendable = utxos
    .map((utxo, index) => ({ utxo, index }))
    .filter(({ utxo }) => utxo.unlockHeight <= height)
    .sort((a, b) => (amountOf(b.utxo) > amountOf(a.utxo) ? 1 : -1));

  const selected = new Set<number>();
  let gathered = 0n;
  for (const { utxo, index } of spendable) {
    if (gathered >= needed) break;
    selected.add(index);
    gathered += amountOf(utxo);
  }

  if (gathered < needed) {
    if (totalOf(utxos) >= needed) {
      const nextUnlock = Math.min(...utxos.filter((u) => u.unlockHeight > height).map((u) => u.unlockHeight));
      throw new FundsLockedError(tokenId, nextUnlock);
    }
    throw new InsufficientFundsError(tokenId);
  }

  const remaining = utxos.filter((_utxo, index) => !selected.has(index));
  const change = gathered - needed;
  return change > 0n ? credit(remaining, change, changeUnlockHeight) : remaining;
}
