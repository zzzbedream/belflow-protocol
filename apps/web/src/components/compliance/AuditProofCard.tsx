'use client';

import { Download, ExternalLink, ShieldCheck } from 'lucide-react';
import { Amount } from '@/components/ui/Amount';
import { Badge, statusTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { HashChip } from '@/components/ui/HashChip';

export interface IssuedProof {
  proofId: string;
  link: string;
  txHash: string;
  recipient: string;
  amount: string;
  ticker: string;
  assetVerificationLevel: string | null;
  blockHeight: number | null;
  /** Full package including the tx key, for the auditor's offline copy. */
  packageJson: string;
}

export function downloadJson(filename: string, json: string): void {
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** The shareable receipt: one payment disclosed, the rest of the wallet untouched. */
export function AuditProofCard({ proof }: { proof: IssuedProof }) {
  return (
    <article className="animate-rise relative overflow-hidden rounded-[12px] border border-verified/40 bg-paper p-5 shadow-[var(--shadow)]" data-testid="audit-proof-card">
      <ShieldCheck className="absolute -right-6 -top-6 size-32 text-verified opacity-[0.07]" aria-hidden />
      <p className="figures text-[0.66rem] uppercase tracking-[0.2em] text-verified">Selective audit proof</p>
      <div className="mt-2 flex flex-wrap items-baseline justify-between gap-3">
        <Amount value={proof.amount} ticker={proof.ticker} publicValue className="text-3xl font-medium" />
        {proof.assetVerificationLevel && <Badge tone={statusTone(proof.assetVerificationLevel)}>{proof.assetVerificationLevel}</Badge>}
      </div>
      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-ink-3">Recipient</dt>
        <dd className="min-w-0 truncate text-ink">{proof.recipient}</dd>
        <dt className="text-ink-3">Transaction</dt>
        <dd>
          <HashChip value={proof.txHash} />
        </dd>
        <dt className="text-ink-3">Block</dt>
        <dd className="figures">{proof.blockHeight ? `#${proof.blockHeight.toLocaleString('en-US')}` : 'mempool'}</dd>
      </dl>
      <div className="mt-5 flex flex-wrap gap-2">
        <Button size="sm" variant="vault" data-testid="proof-link" data-href={proof.link} onClick={() => window.open(proof.link, '_blank', 'noopener,noreferrer')}>
          <ExternalLink className="size-3.5" aria-hidden /> Open auditor link
        </Button>
        <Button size="sm" variant="outline" onClick={() => navigator.clipboard.writeText(proof.link).catch(() => undefined)}>
          Copy link
        </Button>
        <Button size="sm" variant="ghost" onClick={() => downloadJson(`belflow-proof-${proof.proofId}.json`, proof.packageJson)}>
          <Download className="size-3.5" aria-hidden /> JSON package
        </Button>
      </div>
      <p className="mt-3 text-[0.7rem] leading-snug text-ink-3">
        The tx key in this link decrypts only in the auditor&apos;s browser and proves this single output. Balances and every other payment stay hidden.
      </p>
    </article>
  );
}
