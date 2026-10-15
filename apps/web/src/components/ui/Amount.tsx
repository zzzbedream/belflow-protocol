'use client';

import { formatGrouped } from '@/lib/format';
import { useBeldexStore } from '@/store/useBeldexStore';
import { cn } from './cn';

interface AmountProps {
  value: string;
  ticker?: string;
  /** Always show (public data such as an invoice total). */
  publicValue?: boolean;
  className?: string;
}

/** Confidential figure: redacted until the operator toggles "Reveal amounts". */
export function Amount({ value, ticker, publicValue = false, className }: AmountProps) {
  const reveal = useBeldexStore((state) => state.revealAmounts);
  const hidden = !publicValue && !reveal;
  const formatted = formatGrouped(value);
  return (
    <span className={cn('figures inline-flex items-baseline gap-1.5', className)}>
      <span className={cn(hidden && 'redacted')} aria-label={hidden ? 'Hidden amount' : undefined}>
        {hidden ? formatted.replace(/[0-9]/g, '0') : formatted}
      </span>
      {ticker && <span className="text-[0.72em] text-ink-3">{ticker}</span>}
    </span>
  );
}
