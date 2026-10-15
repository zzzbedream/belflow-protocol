'use client';

import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { cn } from './cn';

/** Truncated hash/address with copy-to-clipboard. */
export function HashChip({ value, head = 8, tail = 6, className }: { value: string; head?: number; tail?: number; className?: string }) {
  const [copied, setCopied] = useState(false);
  const short = value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  };
  return (
    <button
      type="button"
      onClick={copy}
      title={value}
      className={cn(
        'figures group inline-flex max-w-full items-center gap-1.5 rounded-[5px] border border-rule bg-paper-2 px-1.5 py-0.5 text-[0.75rem] text-ink-2 transition-colors hover:border-rule-strong hover:text-ink',
        className,
      )}
    >
      <span className="truncate">{short}</span>
      {copied ? <Check className="size-3 text-verified" aria-hidden /> : <Copy className="size-3 opacity-50 group-hover:opacity-100" aria-hidden />}
      <span className="sr-only">{copied ? 'Copied' : 'Copy to clipboard'}</span>
    </button>
  );
}
