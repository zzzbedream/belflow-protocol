'use client';

import { Droplets } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { PageHeader } from '@/components/shell/PageHeader';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';
import { HashChip } from '@/components/ui/HashChip';
import { Notice } from '@/components/ui/Notice';
import { Panel } from '@/components/ui/Panel';
import { apiPost, errorMessage } from '@/lib/api';
import { useApi } from '@/lib/useApi';
import { useBeldexStore } from '@/store/useBeldexStore';

interface FaucetConfig {
  enabled: boolean;
  grants: Array<{ ticker: string; amount: string }>;
  windowHours: number;
}

interface FaucetResult {
  claimId: string;
  recipient: string;
  status: 'SENT' | 'PARTIAL';
  grants: Array<{ ticker: string; amount: string; txHash: string | null }>;
}

export default function FaucetPage() {
  const network = useBeldexStore((state) => state.network);
  const wallet = useBeldexStore((state) => state.wallet);
  const refresh = useBeldexStore((state) => state.refresh);
  const { data: config } = useApi<FaucetConfig>('/api/faucet');
  const [recipient, setRecipient] = useState('');
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FaucetResult | null>(null);

  useEffect(() => {
    if (wallet?.network === network && !recipient) setRecipient(wallet.bns ?? wallet.address);
  }, [wallet, network, recipient]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setIsBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await apiPost<FaucetResult>('/api/faucet', { network, recipient }));
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
        index="07"
        title="Evaluator faucet"
        lede="A fixed test package for grant reviewers: Privacy Tokens to try payroll and invoices, plus BDX for Flash fees. One claim per address and per connection every 24 hours."
      />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Panel kicker={network === 'mock-devnet' ? 'Mock devnet' : 'Testnet · Proto'} title="Request test funds" tone="raised">
          {config && !config.enabled && (
            <Notice tone="info" className="mb-4">
              The testnet faucet is disabled on this deployment. Switch to Mock devnet, or enable BELFLOW_FAUCET_ENABLED with a funded faucet account.
            </Notice>
          )}
          <form onSubmit={handleSubmit} className="space-y-4" data-testid="faucet-form">
            <Field label="Recipient" htmlFor="recipient" hint="A Beldex address or a .bdx name, e.g. juan.bdx">
              <Input id="recipient" value={recipient} onChange={(e) => setRecipient(e.target.value)} required maxLength={120} autoComplete="off" />
            </Field>
            <ul className="flex flex-wrap gap-2">
              {config?.grants.map((grant) => (
                <li key={grant.ticker}>
                  <Badge tone="vault">
                    {grant.amount} {grant.ticker}
                  </Badge>
                </li>
              ))}
            </ul>
            <Button type="submit" variant="vault" size="lg" className="w-full" disabled={isBusy || config?.enabled === false} data-testid="claim-faucet">
              <Droplets className="size-4" aria-hidden />
              {isBusy ? 'Sending…' : 'Claim test package'}
            </Button>
          </form>
          {error && <Notice tone="error" className="mt-4">{error}</Notice>}
        </Panel>

        <Panel kicker="Receipt" title="What was sent">
          {!result ? (
            <p className="text-sm text-ink-3">Claims show their transactions here. Amounts are fixed by the server.</p>
          ) : (
            <div className="space-y-3" data-testid="faucet-result">
              <Badge tone={result.status === 'SENT' ? 'verified' : 'flash'}>{result.status}</Badge>
              <ul className="space-y-2">
                {result.grants.map((grant) => (
                  <li key={grant.ticker} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span className="figures">
                      {grant.amount} {grant.ticker}
                    </span>
                    {grant.txHash ? <HashChip value={grant.txHash} /> : <span className="text-xs text-ink-3">queued: retry after unlock</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
