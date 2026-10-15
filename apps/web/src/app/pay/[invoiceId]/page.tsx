'use client';

import { NATIVE_TOKEN_ID, detectExtensionProvider } from '@belflow/sdk';
import { CheckCircle2, Lock, Zap } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import useSWR from 'swr';
import { Amount } from '@/components/ui/Amount';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { HashChip } from '@/components/ui/HashChip';
import { Notice } from '@/components/ui/Notice';
import { apiGet, apiPost, errorMessage } from '@/lib/api';
import { decryptFromLink, linkKeyFromHash } from '@/lib/crypto';
import type { InvoiceDto } from '@/lib/types';
import { mockWallet } from '@/lib/wallet';

interface PayResult {
  invoice: InvoiceDto;
  verification: { isValid: boolean; isFlash: boolean; assetVerificationLevel: string | null; failures: string[] };
}

/** Pays with the mock customer wallet (devnet) or the Beldex Wallet extension (testnet, BDX only). */
async function payInvoice(invoice: InvoiceDto): Promise<{ txHash: string; txKey?: string }> {
  const recipient = {
    id: invoice.id,
    recipientInput: invoice.merchantBns ?? invoice.merchantAddress,
    resolvedAddress: invoice.merchantAddress,
    amount: invoice.expectedAmount,
    tokenId: invoice.tokenId,
  };
  if (invoice.network === 'mock-devnet') {
    const wallet = mockWallet('customer');
    await wallet.connectWallet();
    const result = await wallet.sendConfidentialBatch([recipient], true);
    return { txHash: result.txHash, txKey: result.txKey };
  }
  if (invoice.tokenId !== NATIVE_TOKEN_ID) {
    throw new Error('Paying Privacy Tokens from the browser needs transferAsset in @bdxi/web3js (proposed v1.1). Pay this invoice from a wallet-rpc wallet.');
  }
  const extension = await detectExtensionProvider({ network: 'testnet', timeoutMs: 2500 });
  if (!extension) throw new Error('Beldex Wallet extension not detected.');
  await extension.connectWallet();
  const result = await extension.sendConfidentialBatch([recipient], true);
  return { txHash: result.txHash };
}

export default function CheckoutPage() {
  const { invoiceId } = useParams<{ invoiceId: string }>();
  const { data: invoice, error: loadError, mutate } = useSWR(invoiceId ? `/api/invoices/${invoiceId}` : null, (url: string) => apiGet<InvoiceDto>(url));
  const [memo, setMemo] = useState<string | null>(null);
  const [memoError, setMemoError] = useState<string | null>(null);
  const [isPaying, setIsPaying] = useState(false);
  const [result, setResult] = useState<PayResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!invoice?.encryptedMemo) return;
    const key = linkKeyFromHash(window.location.hash);
    if (!key) {
      setMemoError('The link is missing its decryption key, so the memo stays private.');
      return;
    }
    decryptFromLink(key, invoice.encryptedMemo).then(setMemo, () => setMemoError('This link cannot decrypt the memo.'));
  }, [invoice?.encryptedMemo]);

  const handlePay = async () => {
    if (!invoice) return;
    setIsPaying(true);
    setError(null);
    try {
      const payment = await payInvoice(invoice);
      const settled = await apiPost<PayResult>(`/api/invoices/${invoice.id}/pay`, payment);
      setResult(settled);
      if (!settled.verification.isValid) setError(`Payment not accepted: ${settled.verification.failures.join(', ')}`);
      await mutate(settled.invoice, { revalidate: false });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setIsPaying(false);
    }
  };

  const isPaid = invoice?.status === 'PAID';

  return (
    <main className="relative z-10 mx-auto flex min-h-dvh max-w-xl flex-col justify-center px-4 py-10">
      <p className="text-center text-[1.2rem] font-semibold tracking-[-0.04em]">
        Bel<span className="text-vault">Flow</span> <span className="figures text-[0.65rem] uppercase tracking-[0.2em] text-ink-3">checkout</span>
      </p>
      <article className="animate-rise mt-6 overflow-hidden rounded-[14px] border border-rule bg-paper shadow-[var(--shadow)]">
        {loadError && <Notice tone="error" className="m-5">{errorMessage(loadError)}</Notice>}
        {!invoice && !loadError && <p className="p-6 text-sm text-ink-3">Loading invoice…</p>}
        {invoice && (
          <>
            <header className="border-b border-dashed border-rule-strong px-6 pb-5 pt-6">
              <div className="flex items-center justify-between">
                <span className="figures text-[0.68rem] uppercase tracking-[0.18em] text-ink-3">Invoice {invoice.id.slice(-10)}</span>
                <Badge tone={isPaid ? 'verified' : 'neutral'}>{invoice.status}</Badge>
              </div>
              <p className="mt-4 text-sm text-ink-2">Amount due</p>
              <Amount value={invoice.expectedAmount} ticker={invoice.tokenTicker} publicValue className="text-5xl font-medium tracking-tight" />
              <p className="mt-3 flex flex-wrap items-center gap-2 text-xs text-ink-3">
                Pay to {invoice.merchantBns ? <span className="figures text-ink">{invoice.merchantBns}</span> : null}
                <HashChip value={invoice.merchantAddress} />
              </p>
            </header>
            <div className="space-y-4 px-6 py-5">
              <div className="rounded-[8px] bg-paper-2 px-3.5 py-3">
                <p className="flex items-center gap-1.5 text-xs text-ink-3">
                  <Lock className="size-3" aria-hidden /> Private memo
                </p>
                <p className="mt-1 text-sm text-ink" data-testid="invoice-memo">
                  {memo ?? memoError ?? (invoice.encryptedMemo ? 'Decrypting…' : 'No memo')}
                </p>
              </div>
              {isPaid ? (
                <Notice tone="success" title="Paid">
                  <span className="flex flex-wrap items-center gap-2">
                    <CheckCircle2 className="size-4 text-verified" aria-hidden /> {invoice.paidTxHash && <HashChip value={invoice.paidTxHash} />}
                    {invoice.assetVerificationLevel && <Badge tone="verified">{invoice.assetVerificationLevel}</Badge>}
                  </span>
                </Notice>
              ) : (
                <Button size="lg" variant="vault" className="w-full" onClick={handlePay} disabled={isPaying} data-testid="pay-invoice">
                  <Zap className="size-4" aria-hidden />
                  {isPaying ? 'Waiting for wallet…' : invoice.network === 'mock-devnet' ? 'Pay with mock customer wallet' : 'Pay with Beldex Wallet (Flash)'}
                </Button>
              )}
              {error && <Notice tone="error">{error}</Notice>}
              {result?.verification.isFlash && <p className="text-center text-xs text-ink-3">Settled instantly from the mempool: Flash quorum lock.</p>}
            </div>
            <footer className="border-t border-rule px-6 py-3 text-[0.7rem] text-ink-3">
              The amount and both parties stay hidden on the Beldex explorer. Only this invoice is disclosed to you.
            </footer>
          </>
        )}
      </article>
    </main>
  );
}
