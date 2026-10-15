'use client';

import { BDX_DECIMALS, formatUnits } from '@belflow/sdk';
import { Badge, statusTone } from '@/components/ui/Badge';
import { HashChip } from '@/components/ui/HashChip';
import type { PayrollJobDto } from '@/lib/types';

const CHUNK_TONE = { SENT: 'verified', PENDING: 'neutral', SUBMITTING: 'flash', UNKNOWN: 'danger' } as const;

/** Live state of an idempotent payroll job and its chunks. */
export function JobStatus({ job, events }: { job: PayrollJobDto; events?: string[] }) {
  return (
    <div className="space-y-4" data-testid="job-status">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={statusTone(job.status)}>{job.status}</Badge>
        <span className="text-xs text-ink-3">
          {job.recipientsCount} recipients · {job.totalChunks} tx · key <span className="figures">{job.idempotencyKey.slice(0, 8)}</span>
        </span>
      </div>
      <ol className="space-y-1.5">
        {job.chunks.map((chunk) => (
          <li key={chunk.index} className="flex flex-wrap items-center gap-2 text-xs">
            <span className="figures w-10 text-ink-3">tx {String(chunk.index + 1).padStart(2, '0')}</span>
            <Badge tone={CHUNK_TONE[chunk.status]}>{chunk.status}</Badge>
            {chunk.txHashes.map((hash) => (
              <HashChip key={hash} value={hash} />
            ))}
            {chunk.needsReconciliation && <Badge tone="danger">reconcile</Badge>}
          </li>
        ))}
      </ol>
      <dl className="grid grid-cols-2 gap-2 text-xs">
        <dt className="text-ink-3">Fees paid</dt>
        <dd className="figures text-right">{formatUnits(BigInt(job.feeTotalAtomic), BDX_DECIMALS, 4)} BDX</dd>
        <dt className="text-ink-3">BDX burned</dt>
        <dd className="figures text-right text-flash">{formatUnits(BigInt(job.burnedAtomic), BDX_DECIMALS, 4)} BDX</dd>
        {job.lockedUntilHeight && (
          <>
            <dt className="text-ink-3">Change unlocks at</dt>
            <dd className="figures text-right">block {job.lockedUntilHeight.toLocaleString('en-US')}</dd>
          </>
        )}
      </dl>
      {job.lastError && <p className="rounded-[6px] bg-paper-2 px-2.5 py-2 text-xs text-ink-2">{job.lastError}</p>}
      {events && events.length > 0 && (
        <ol className="figures space-y-1 border-l-2 border-vault/40 pl-3 text-[0.72rem] text-ink-2">
          {events.map((event, index) => (
            <li key={`${index}-${event}`}>{event}</li>
          ))}
        </ol>
      )}
    </div>
  );
}
