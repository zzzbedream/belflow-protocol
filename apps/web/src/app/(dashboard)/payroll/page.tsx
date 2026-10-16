'use client';

import { planBatches, type BatchPaymentRecipient } from '@belflow/sdk';
import { RotateCcw, Send } from 'lucide-react';
import { useState } from 'react';
import { RingMixer, type MixerPhase } from '@/components/kinetic/RingMixer';
import { BatchCsvUploader } from '@/components/payroll/BatchCsvUploader';
import { BatchPlan } from '@/components/payroll/BatchPlan';
import { JobStatus } from '@/components/payroll/JobStatus';
import { RecipientTable } from '@/components/payroll/RecipientTable';
import { useRecipientResolution } from '@/components/payroll/useRecipientResolution';
import { PageHeader } from '@/components/shell/PageHeader';
import { Button } from '@/components/ui/Button';
import { Notice } from '@/components/ui/Notice';
import { Panel } from '@/components/ui/Panel';
import { apiPost, errorMessage } from '@/lib/api';
import type { PayrollRow } from '@/lib/csv';
import type { PayrollJobDto, PayrollRunDto, TokenDto } from '@/lib/types';
import { useApi } from '@/lib/useApi';
import { saveReceipts, type PaymentReceipt } from '@/lib/vault';
import { useBeldexStore } from '@/store/useBeldexStore';

interface Draft {
  rows: PayrollRow[];
  /** Stable for this exact payload; editing the draft creates a new key. */
  idempotencyKey: string;
}

const newDraft = (rows: PayrollRow[]): Draft => ({ rows, idempotencyKey: crypto.randomUUID() });

function toReceipts(run: PayrollRunDto, recipients: BatchPaymentRecipient[], tokens: TokenDto[], network: string): PaymentReceipt[] {
  const byId = new Map(recipients.map((r) => [r.id, r]));
  return run.sent.flatMap((part) =>
    part.recipientIds.flatMap((recipientId) => {
      const recipient = byId.get(recipientId);
      const token = tokens.find((t) => t.tokenId === recipient?.tokenId);
      if (!recipient || !token || !part.txKey) return [];
      return [
        {
          id: `${part.txHash}:${recipientId}`,
          network,
          jobId: run.job.id,
          txHash: part.txHash,
          txKey: part.txKey,
          recipientId,
          recipientInput: recipient.recipientInput,
          recipientAddress: recipient.resolvedAddress,
          ...(recipient.recipientInput.endsWith('.bdx') ? { recipientBns: recipient.recipientInput.toLowerCase() } : {}),
          amount: recipient.amount,
          tokenId: token.tokenId,
          tokenTicker: token.ticker,
          tokenDecimals: token.decimals,
          ...(recipient.memo ? { memo: recipient.memo } : {}),
          createdAt: Date.now(),
        },
      ];
    }),
  );
}

export default function PayrollPage() {
  const network = useBeldexStore((state) => state.network);
  const refresh = useBeldexStore((state) => state.refresh);
  const { data: tokens = [] } = useApi<TokenDto[]>('/api/tokens');
  const { data: jobs } = useApi<PayrollJobDto[]>('/api/treasury/payroll');
  const [draft, setDraft] = useState<Draft>(() => newDraft([]));
  const [useFlash, setUseFlash] = useState(true);
  const [run, setRun] = useState<PayrollRunDto | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolutions = useRecipientResolution(draft.rows, network);

  const tokenFor = (row: PayrollRow) => {
    const needle = row.token.toLowerCase();
    return tokens.find((t) => t.ticker.toLowerCase() === needle || t.tokenId === needle);
  };

  const recipients: BatchPaymentRecipient[] = draft.rows.flatMap((row) => {
    const resolution = resolutions[row.id];
    const token = tokenFor(row);
    if (resolution?.state !== 'ok' || !token) return [];
    return [{ id: row.id, recipientInput: row.recipientInput, resolvedAddress: resolution.address, amount: row.amount, tokenId: token.tokenId, ...(row.memo ? { memo: row.memo } : {}) }];
  });
  const isReady = draft.rows.length > 0 && recipients.length === draft.rows.length;
  const chunks = isReady ? planBatches(recipients) : [];

  const execute = async () => {
    setIsBusy(true);
    setError(null);
    try {
      const result = await apiPost<PayrollRunDto>('/api/treasury/payroll', {
        network,
        idempotencyKey: draft.idempotencyKey,
        useFlash,
        recipients: recipients.map(({ memo: _memo, ...rest }) => rest),
      });
      setRun(result);
      await saveReceipts(toReceipts(result, recipients, tokens, network));
      refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setIsBusy(false);
    }
  };

  const canResume = run && ['WAITING_UTXO_UNLOCK', 'FAILED'].includes(run.job.status);
  const phase: MixerPhase = isBusy
    ? 'broadcasting'
    : run?.job.status === 'WAITING_UTXO_UNLOCK'
      ? 'locked'
      : run && ['CONFIRMED', 'SUBMITTED'].includes(run.job.status)
        ? 'confirmed'
        : 'preview';

  return (
    <>
      <PageHeader index="03" title="Confidential payroll" lede="15 stealth outputs per tx · ring size 10 · tx keys stay in this browser" />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="space-y-6">
          <Panel kicker="Step 1" title="Load the payroll">
            <BatchCsvUploader onRows={(rows) => { setRun(null); setDraft(newDraft(rows)); }} />
          </Panel>
          {draft.rows.length > 0 && (
            <Panel
              kicker="Step 2"
              title={`Recipients (${draft.rows.length})`}
              action={
                <Button variant="ghost" size="sm" onClick={() => { setRun(null); setDraft(newDraft([])); }}>
                  <RotateCcw className="size-3.5" aria-hidden /> Clear
                </Button>
              }
            >
              <RecipientTable
                rows={draft.rows}
                resolutions={resolutions}
                tokenFor={tokenFor}
                onRemove={(id) => setDraft(newDraft(draft.rows.filter((row) => row.id !== id)))}
              />
            </Panel>
          )}
        </div>

        <div className="space-y-6">
          <Panel kicker="Step 3" title="Batch plan" tone="raised">
            {chunks.length === 0 ? (
              <p className="text-sm text-ink-3">
                {draft.rows.length === 0 ? 'Load a CSV.' : 'Resolving recipients…'}
              </p>
            ) : (
              <>
                <RingMixer labels={draft.rows.map((row) => row.recipientInput)} phase={phase} className="mb-5" />
                <BatchPlan chunks={chunks} tokens={tokens} useFlash={useFlash} onToggleFlash={setUseFlash} />
                <Button size="lg" className="mt-5 w-full" onClick={execute} disabled={isBusy || !isReady} data-testid="run-payroll">
                  <Send className="size-4" aria-hidden />
                  {isBusy ? 'Signing & broadcasting…' : canResume ? 'Resume payroll' : `Pay ${recipients.length} recipients`}
                </Button>
              </>
            )}
            {error && <Notice tone="error" className="mt-4">{error}</Notice>}
          </Panel>
          {run && (
            <Panel kicker="Execution" title="Payroll job">
              <JobStatus job={run.job} events={run.events} />
              {run.sent.length > 0 && (
                <Notice tone="success" className="mt-4">
                  {run.sent.length} tx key(s) encrypted into this browser&apos;s vault. Generate receipts in Compliance.
                </Notice>
              )}
            </Panel>
          )}
          {jobs && jobs.length > 0 && (
            <Panel kicker="History" title="Recent payroll jobs">
              <ul className="space-y-4">
                {jobs.slice(0, 5).map((job) => (
                  <li key={job.id} className="border-b border-rule pb-4 last:border-0 last:pb-0">
                    <JobStatus job={job} />
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </div>
      </div>
    </>
  );
}
