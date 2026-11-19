'use client';

import { Sparkles } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { RingMixer } from '@/components/kinetic/RingMixer';
import { PageHeader } from '@/components/shell/PageHeader';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';
import { HashChip } from '@/components/ui/HashChip';
import { Notice } from '@/components/ui/Notice';
import { Panel } from '@/components/ui/Panel';
import { apiPost, errorMessage } from '@/lib/api';
import type { TokenDto } from '@/lib/types';
import { useApi } from '@/lib/useApi';
import { useBeldexStore } from '@/store/useBeldexStore';

const PRESETS = [
  { ticker: 'bUSD', name: 'Beldex Confidential USD', decimals: 6, totalSupply: '1000000' },
  { ticker: 'bCLP', name: 'Peso chileno confidencial', decimals: 0, totalSupply: '500000000' },
  { ticker: 'bBRL', name: 'Real brasileiro confidencial', decimals: 2, totalSupply: '2000000' },
];

export default function TokensPage() {
  const network = useBeldexStore((state) => state.network);
  const refresh = useBeldexStore((state) => state.refresh);
  const { data: tokens } = useApi<TokenDto[]>('/api/tokens');
  const [form, setForm] = useState(PRESETS[0] as (typeof PRESETS)[number]);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minted, setMinted] = useState<TokenDto | null>(null);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setIsBusy(true);
    setError(null);
    setMinted(null);
    try {
      const token = await apiPost<TokenDto>('/api/treasury/tokens', { network, token: { ...form, decimals: Number(form.decimals) } });
      setMinted(token);
      refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setIsBusy(false);
    }
  };

  const privacyTokens = (tokens ?? []).filter((token) => !token.isNativeBdx);

  return (
    <>
      <PageHeader index="02" title="Token Studio" lede="Privacy Tokens on Proto (HF 22) · register_privacy_token" />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <Panel kicker="register_privacy_token" title="Register a Privacy Token" tone="raised">
          <RingMixer labels={[form.ticker]} phase={isBusy ? 'broadcasting' : minted ? 'confirmed' : 'preview'} className="mb-4" />
          <div className="mb-4 flex flex-wrap gap-2">
            {PRESETS.map((preset) => (
              <button
                key={preset.ticker}
                type="button"
                onClick={() => setForm(preset)}
                className="figures rounded-full border border-rule-strong px-3 py-1 text-xs text-ink-2 transition-colors hover:border-vault hover:text-vault aria-pressed:border-vault aria-pressed:bg-vault-soft aria-pressed:text-vault"
                aria-pressed={form.ticker === preset.ticker}
              >
                {preset.ticker}
              </button>
            ))}
          </div>
          <form onSubmit={handleSubmit} className="grid gap-4 sm:grid-cols-2" data-testid="mint-form">
            <Field label="Ticker" htmlFor="ticker" hint="2-12 letters or digits">
              <Input id="ticker" value={form.ticker} onChange={(e) => setForm({ ...form, ticker: e.target.value })} required maxLength={12} />
            </Field>
            <Field label="Decimals" htmlFor="decimals">
              <Input id="decimals" type="number" min={0} max={12} value={form.decimals} onChange={(e) => setForm({ ...form, decimals: Number(e.target.value) })} />
            </Field>
            <Field label="Name" htmlFor="name" className="sm:col-span-2">
              <Input id="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={64} />
            </Field>
            <Field label="Initial supply" htmlFor="supply" hint="Credited to the treasury wallet" className="sm:col-span-2">
              <Input id="supply" inputMode="decimal" value={form.totalSupply} onChange={(e) => setForm({ ...form, totalSupply: e.target.value })} required />
            </Field>
            <div className="sm:col-span-2">
              <Button type="submit" variant="vault" size="lg" disabled={isBusy} className="w-full">
                <Sparkles className="size-4" aria-hidden />
                {isBusy ? 'Deploying…' : `Deploy ${form.ticker} on ${network === 'mock-devnet' ? 'MockChain' : 'Testnet Proto'}`}
              </Button>
            </div>
          </form>
          {error && <Notice tone="error" className="mt-4">{error}</Notice>}
          {minted && (
            <Notice tone="success" title={`${minted.ticker} deployed`} className="mt-4">
              Token id <HashChip value={minted.tokenId} />
            </Notice>
          )}
        </Panel>

        <Panel kicker="Registry" title={`Privacy Tokens on ${network}`}>
          {privacyTokens.length === 0 ? (
            <p className="text-sm text-ink-3">No Privacy Tokens yet.</p>
          ) : (
            <ul className="divide-y divide-rule" data-testid="token-registry">
              {privacyTokens.map((token) => (
                <li key={token.tokenId} className="grid gap-1 py-3 sm:grid-cols-[auto_1fr_auto] sm:items-center sm:gap-4">
                  <span className="text-lg font-semibold tracking-tight text-ink">{token.ticker}</span>
                  <span className="text-sm text-ink-2">{token.name}</span>
                  <span className="flex items-center gap-2">
                    <Badge tone="vault">{token.decimals} dp</Badge>
                    <HashChip value={token.tokenId} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}
