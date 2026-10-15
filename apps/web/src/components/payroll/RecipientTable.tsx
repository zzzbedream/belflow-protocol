'use client';

import { CheckCircle2, CircleDashed, Trash2, XCircle } from 'lucide-react';
import { Amount } from '@/components/ui/Amount';
import { cn } from '@/components/ui/cn';
import type { PayrollRow } from '@/lib/csv';
import type { TokenDto } from '@/lib/types';
import type { Resolution } from './useRecipientResolution';

interface RecipientTableProps {
  rows: PayrollRow[];
  resolutions: Record<string, Resolution>;
  tokenFor: (row: PayrollRow) => TokenDto | undefined;
  onRemove: (id: string) => void;
}

function ResolutionCell({ resolution }: { resolution: Resolution }) {
  if (resolution.state === 'pending') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-ink-3">
        <CircleDashed className="size-3.5 animate-spin" aria-hidden /> resolving
      </span>
    );
  }
  if (resolution.state === 'error') {
    return (
      <span className="inline-flex items-start gap-1.5 text-xs text-danger">
        <XCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden /> {resolution.message}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-ink-2">
      <CheckCircle2 className="size-3.5 text-verified" aria-hidden />
      <span className="figures">{`${resolution.address.slice(0, 8)}…${resolution.address.slice(-6)}`}</span>
    </span>
  );
}

export function RecipientTable({ rows, resolutions, tokenFor, onRemove }: RecipientTableProps) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[680px] border-collapse text-sm" data-testid="recipient-table">
        <caption className="sr-only">Payroll recipients</caption>
        <thead>
          <tr className="figures text-left text-[0.64rem] uppercase tracking-[0.12em] text-ink-3">
            <th scope="col" className="pb-2 pr-3 font-normal">Recipient</th>
            <th scope="col" className="pb-2 pr-3 font-normal">Stealth target</th>
            <th scope="col" className="pb-2 pr-3 text-right font-normal">Amount</th>
            <th scope="col" className="pb-2 pr-3 font-normal">Memo</th>
            <th scope="col" className="pb-2"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const token = tokenFor(row);
            return (
              <tr key={row.id} className="border-t border-rule align-top">
                <td className="py-2.5 pr-3 font-medium text-ink">{row.recipientInput}</td>
                <td className="py-2.5 pr-3">
                  <ResolutionCell resolution={resolutions[row.id] ?? { state: 'pending' }} />
                </td>
                <td className={cn('py-2.5 pr-3 text-right', !token && 'text-danger')}>
                  {token ? <Amount value={row.amount} ticker={token.ticker} publicValue /> : <span className="text-xs">unknown token “{row.token}”</span>}
                </td>
                <td className="max-w-[16ch] truncate py-2.5 pr-3 text-xs text-ink-3">{row.memo || '—'}</td>
                <td className="py-2 text-right">
                  <button
                    type="button"
                    onClick={() => onRemove(row.id)}
                    className="rounded-[5px] p-1 text-ink-3 transition-colors hover:bg-danger-soft hover:text-danger"
                    aria-label={`Remove ${row.recipientInput}`}
                  >
                    <Trash2 className="size-3.5" aria-hidden />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
