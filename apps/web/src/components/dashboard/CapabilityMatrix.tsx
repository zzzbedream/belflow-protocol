import type { ProviderCapabilities } from '@belflow/sdk';
import { Check, Minus } from 'lucide-react';
import { cn } from '@/components/ui/cn';
import type { CapabilityRow } from '@/lib/types';

const COLUMNS: Array<{ key: keyof ProviderCapabilities; label: string }> = [
  { key: 'batch', label: 'Multi-output' },
  { key: 'txKeys', label: 'Tx keys' },
  { key: 'assets', label: 'Privacy Tokens' },
  { key: 'flash', label: 'Flash' },
  { key: 'bns', label: 'BNS' },
  { key: 'signMessage', label: 'Sign' },
  { key: 'verify', label: 'Verify' },
];

/** Which provider is live and what each one can actually do. */
export function CapabilityMatrix({ rows }: { rows: CapabilityRow[] }) {
  return (
    <div className="overflow-x-auto" data-testid="capability-matrix">
      <table className="w-full min-w-[640px] border-collapse text-sm">
        <caption className="sr-only">Active capability matrix</caption>
        <thead>
          <tr className="text-left">
            <th scope="col" className="pb-2 pr-3 font-normal text-ink-3">
              Provider
            </th>
            {COLUMNS.map((column) => (
              <th key={column.key} scope="col" className="figures pb-2 text-center text-[0.65rem] font-normal uppercase tracking-[0.1em] text-ink-3">
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.kind} className={cn('border-t border-rule', row.active && 'bg-vault-soft/60')}>
              <th scope="row" className="py-3 pr-3 text-left align-top font-normal">
                <span className="flex items-center gap-2">
                  <span
                    className={cn('size-2 rounded-full', row.active ? 'bg-verified shadow-[0_0_0_3px_var(--verified-soft)]' : row.available ? 'bg-ink-3' : 'bg-rule-strong')}
                    aria-hidden
                  />
                  <span className={cn('font-medium', row.active ? 'text-ink' : 'text-ink-2')}>{row.label}</span>
                  {row.active && <span className="figures text-[0.62rem] uppercase tracking-[0.14em] text-verified">active</span>}
                  {!row.available && <span className="figures text-[0.62rem] uppercase tracking-[0.14em] text-ink-3">not configured</span>}
                </span>
                <span className="mt-0.5 block pl-4 text-xs text-ink-3">{row.role}</span>
              </th>
              {COLUMNS.map((column) => (
                <td key={column.key} className="py-3 text-center align-top">
                  {row.capabilities[column.key] ? (
                    <Check className={cn('mx-auto size-4', row.active ? 'text-verified' : 'text-ink-3')} aria-label="supported" />
                  ) : (
                    <Minus className="mx-auto size-4 text-rule-strong" aria-label="not supported" />
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
