'use client';

import { FilePlus2, Link2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { PageHeader } from '@/components/shell/PageHeader';
import { Amount } from '@/components/ui/Amount';
import { Badge, statusTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select, Textarea } from '@/components/ui/Field';
import { HashChip } from '@/components/ui/HashChip';
import { Notice } from '@/components/ui/Notice';
import { Panel } from '@/components/ui/Panel';
import { apiPost, errorMessage } from '@/lib/api';
import { encryptForLink, generateLinkKey } from '@/lib/crypto';
import type { InvoiceDto, TokenDto } from '@/lib/types';
import { useApi } from '@/lib/useApi';
import { useBeldexStore } from '@/store/useBeldexStore';

export default function InvoicesPage() {
  const network = useBeldexStore((state) => state.network);
  const refresh = useBeldexStore((state) => state.refresh);
  const { data: tokens = [] } = useApi<TokenDto[]>('/api/tokens');
  const { data: invoices } = useApi<InvoiceDto[]>('/api/invoices');
  const [tokenId, setTokenId] = useState('BDX');
  const [amount, setAmount] = useState('125.00');
  const [memo, setMemo] = useState('INV-2026-0142 · Data pipeline retainer (October)');
  const [link, setLink] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setIsBusy(true);
    setError(null);
    setLink(null);
    try {
      const key = await generateLinkKey();
      const encryptedMemo = memo.trim() ? await encryptForLink(key, memo.trim()) : undefined;
      const invoice = await apiPost<InvoiceDto>('/api/invoices', { network, tokenId, amount, ...(encryptedMemo ? { encryptedMemo } : {}) });
      setLink(`${window.location.origin}/pay/${invoice.id}#k=${key}`);
      refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        index="04"
        title="B2B invoices"
        lede="Flash checkout · memo encrypted in the browser · key only in the link fragment"
      />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <Panel kicker="New invoice" title="Create a payment link" tone="raised">
          <form onSubmit={handleSubmit} className="grid gap-4 sm:grid-cols-2" data-testid="invoice-form">
            <Field label="Token" htmlFor="token">
              <Select id="token" value={tokenId} onChange={(e) => setTokenId(e.target.value)}>
                {tokens.map((token) => (
                  <option key={token.tokenId} value={token.tokenId}>
                    {token.ticker}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Amount" htmlFor="amount">
              <Input id="amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required pattern="^\d+(\.\d+)?$" />
            </Field>
            <Field label="Private memo" htmlFor="memo" hint="AES-256-GCM encrypted before upload" className="sm:col-span-2">
              <Textarea id="memo" value={memo} onChange={(e) => setMemo(e.target.value)} maxLength={400} />
            </Field>
            <Button type="submit" size="lg" disabled={isBusy} className="sm:col-span-2">
              <FilePlus2 className="size-4" aria-hidden />
              {isBusy ? 'Encrypting…' : 'Create invoice link'}
            </Button>
          </form>
          {error && <Notice tone="error" className="mt-4">{error}</Notice>}
          {link && (
            <Notice tone="success" title="Share this link with your client" className="mt-4">
              <a href={link} target="_blank" rel="noopener noreferrer" className="figures break-all text-xs underline underline-offset-2" data-testid="invoice-link">
                {link}
              </a>
            </Notice>
          )}
        </Panel>

        <Panel kicker="Ledger" title="Invoices">
          {!invoices || invoices.length === 0 ? (
            <p className="text-sm text-ink-3">No invoices on {network} yet.</p>
          ) : (
            <ul className="divide-y divide-rule">
              {invoices.map((invoice) => (
                <li key={invoice.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0 space-y-1">
                    <p className="flex items-center gap-2 text-sm text-ink">
                      <Link2 className="size-3.5 text-ink-3" aria-hidden />
                      <span className="figures">{invoice.id.slice(-10)}</span>
                      <Badge tone={statusTone(invoice.status)}>{invoice.status}</Badge>
                    </p>
                    {invoice.paidTxHash && <HashChip value={invoice.paidTxHash} />}
                  </div>
                  <Amount value={invoice.expectedAmount} ticker={invoice.tokenTicker} className="text-lg" />
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}
