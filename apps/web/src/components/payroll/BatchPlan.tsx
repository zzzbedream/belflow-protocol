'use client';

import { BDX_DECIMALS, MAX_RECIPIENTS_PER_TX, RING_SIZE, estimateBatchFees, formatUnits, parseUnits, type BatchChunk } from '@belflow/sdk';
import { Zap } from 'lucide-react';
import { Amount } from '@/components/ui/Amount';
import { cn } from '@/components/ui/cn';
import type { TokenDto } from '@/lib/types';

interface BatchPlanProps {
  chunks: BatchChunk[];
  tokens: TokenDto[];
  useFlash: boolean;
  onToggleFlash: (value: boolean) => void;
}

/** Transactions that will be built, their outputs and the estimated fee and burn. */
export function BatchPlan({ chunks, tokens, useFlash, onToggleFlash }: BatchPlanProps) {
  const fee = estimateBatchFees(chunks.map((chunk) => chunk.recipients.length), useFlash);
  const totals = new Map<string, bigint>();
  for (const chunk of chunks) {
    const token = tokens.find((t) => t.tokenId === chunk.tokenId);
    if (!token) continue;
    const sum = chunk.recipients.reduce((acc, r) => acc + parseUnits(r.amount, token.decimals), 0n);
    totals.set(chunk.tokenId, (totals.get(chunk.tokenId) ?? 0n) + sum);
  }

  return (
    <div className="space-y-4" data-testid="batch-plan">
      <label className="flex cursor-pointer items-center justify-between gap-4 rounded-[8px] border border-rule bg-paper-2 px-3 py-2.5">
        <span>
          <span className="flex items-center gap-1.5 text-sm font-medium text-ink">
            <Zap className={cn('size-4', useFlash ? 'text-flash' : 'text-ink-3')} aria-hidden /> Flash transactions
          </span>
          <span className="figures block text-[0.62rem] uppercase tracking-[0.12em] text-ink-3">priority 5 · surcharge burned</span>
        </span>
        <input type="checkbox" className="size-4 accent-[var(--vault)]" checked={useFlash} onChange={(e) => onToggleFlash(e.target.checked)} />
      </label>

      <ol className="space-y-2">
        {chunks.map((chunk) => {
          const token = tokens.find((t) => t.tokenId === chunk.tokenId);
          return (
            <li key={chunk.index} className="flex items-center justify-between gap-3 rounded-[8px] border border-rule px-3 py-2 text-sm">
              <span className="figures text-xs text-ink-3">tx {String(chunk.index + 1).padStart(2, '0')}</span>
              <span className="flex-1 text-ink-2">
                {chunk.recipients.length} stealth outputs + change · {token?.ticker ?? 'unknown'}
              </span>
              <span className="figures text-xs text-ink-3">ring {RING_SIZE}</span>
            </li>
          );
        })}
      </ol>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-rule pt-3 text-sm">
        {[...totals].map(([tokenId, amount]) => {
          const token = tokens.find((t) => t.tokenId === tokenId);
          return token ? (
            <div key={tokenId} className="contents">
              <dt className="text-ink-3">Total {token.ticker}</dt>
              <dd className="text-right">
                <Amount value={formatUnits(amount, token.decimals)} ticker={token.ticker} publicValue />
              </dd>
            </div>
          ) : null;
        })}
        <dt className="text-ink-3">Estimated fee</dt>
        <dd className="figures text-right text-ink">{formatUnits(fee.totalAtomic, BDX_DECIMALS, 4)} BDX</dd>
        <dt className="text-ink-3">Estimated burn</dt>
        <dd className={cn('figures text-right', useFlash ? 'text-flash' : 'text-ink-3')}>{formatUnits(fee.burnedAtomic, BDX_DECIMALS, 4)} BDX</dd>
      </dl>
      <p className="figures text-[0.62rem] uppercase tracking-[0.12em] text-ink-3">≤ {MAX_RECIPIENTS_PER_TX} outputs + change per tx · fee estimated</p>
    </div>
  );
}
