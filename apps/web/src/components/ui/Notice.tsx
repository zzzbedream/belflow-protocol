import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from './cn';

type Tone = 'info' | 'success' | 'warning' | 'error';

const styles: Record<Tone, string> = {
  info: 'border-rule-strong bg-paper-2 text-ink-2',
  success: 'border-verified/40 bg-verified-soft text-ink',
  warning: 'border-flash/50 bg-flash-soft text-ink',
  error: 'border-danger/40 bg-danger-soft text-ink',
};

const icons = { info: Info, success: CheckCircle2, warning: AlertTriangle, error: AlertTriangle };

export function Notice({ tone = 'info', title, children, className }: { tone?: Tone; title?: string; children: ReactNode; className?: string }) {
  const Icon = icons[tone];
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={cn('flex gap-3 rounded-[8px] border px-3.5 py-3 text-sm', styles[tone], className)}>
      <Icon className={cn('mt-0.5 size-4 shrink-0', tone === 'success' && 'text-verified', tone === 'error' && 'text-danger', tone === 'warning' && 'text-flash')} aria-hidden />
      <div className="min-w-0 space-y-0.5">
        {title && <p className="font-semibold">{title}</p>}
        <div className="leading-relaxed [overflow-wrap:anywhere]">{children}</div>
      </div>
    </div>
  );
}
