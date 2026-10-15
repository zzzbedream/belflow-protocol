import type { ReactNode } from 'react';
import { cn } from './cn';

type Tone = 'neutral' | 'vault' | 'verified' | 'flash' | 'danger';

const tones: Record<Tone, string> = {
  neutral: 'border-rule-strong bg-paper-2 text-ink-2',
  vault: 'border-vault/35 bg-vault-soft text-vault',
  verified: 'border-verified/35 bg-verified-soft text-verified',
  flash: 'border-flash/45 bg-flash-soft text-ink',
  danger: 'border-danger/35 bg-danger-soft text-danger',
};

export function Badge({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cn('figures inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[0.68rem] uppercase tracking-[0.08em]', tones[tone], className)}>
      {children}
    </span>
  );
}

export function statusTone(status: string): Tone {
  switch (status) {
    case 'CONFIRMED':
    case 'PAID':
    case 'AUDITED':
    case 'CRYPTOGRAPHIC_FULL':
      return 'verified';
    case 'WAITING_UTXO_UNLOCK':
    case 'SUBMITTED':
    case 'DAEMON_EXTRACTED':
      return 'flash';
    case 'FAILED':
      return 'danger';
    case 'ISSUER_SIGNED_DECLARATION':
      return 'vault';
    default:
      return 'neutral';
  }
}
