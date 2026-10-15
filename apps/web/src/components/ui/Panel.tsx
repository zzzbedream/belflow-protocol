import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';

interface PanelProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  /** Small uppercase label above the title, e.g. a section number. */
  kicker?: string;
  title?: ReactNode;
  action?: ReactNode;
  tone?: 'paper' | 'raised' | 'vault';
}

/** Ledger page: hairline frame, optional kicker/title row and action slot. */
export function Panel({ kicker, title, action, tone = 'paper', className, children, ...props }: PanelProps) {
  return (
    <section
      className={cn(
        'relative min-w-0 rounded-[10px] border border-rule',
        tone === 'paper' && 'bg-paper',
        tone === 'raised' && 'bg-paper shadow-[var(--shadow)]',
        tone === 'vault' && 'border-vault/40 bg-vault-soft',
        className,
      )}
      {...props}
    >
      {(kicker || title || action) && (
        <header className="flex items-start justify-between gap-4 border-b border-rule px-5 pb-3 pt-4">
          <div className="min-w-0">
            {kicker && <p className="figures text-[0.68rem] uppercase tracking-[0.18em] text-ink-3">{kicker}</p>}
            {title && <h2 className="mt-0.5 text-base font-semibold tracking-tight text-ink">{title}</h2>}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </header>
      )}
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}
