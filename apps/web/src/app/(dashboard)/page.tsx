'use client';

import { Radio } from 'lucide-react';
import { CapabilityMatrix } from '@/components/dashboard/CapabilityMatrix';
import { TelemetryCards } from '@/components/dashboard/TelemetryCards';
import { PageHeader } from '@/components/shell/PageHeader';
import { Amount } from '@/components/ui/Amount';
import { HashChip } from '@/components/ui/HashChip';
import { Notice } from '@/components/ui/Notice';
import { Panel } from '@/components/ui/Panel';
import { errorMessage } from '@/lib/api';
import type { OverviewDto } from '@/lib/types';
import { useApi } from '@/lib/useApi';

function ChainStatus({ overview }: { overview: OverviewDto }) {
  const height = overview.treasury?.height ?? overview.explorer?.height;
  const pastFork = height !== undefined && (overview.network === 'mock-devnet' || height >= overview.protoForkHeight);
  return (
    <div className="flex items-center gap-3 rounded-[8px] border border-rule bg-paper-2 px-3 py-2" data-testid="chain-status">
      <Radio className="size-4 text-verified" aria-hidden />
      <div>
        <p className="figures text-[0.62rem] uppercase tracking-[0.16em] text-ink-3">
          {overview.network === 'mock-devnet' ? 'MockChain height' : `Testnet height · HF ${overview.explorer?.hardFork ?? '?'}`}
        </p>
        <p className="figures text-sm text-ink">
          {height?.toLocaleString('en-US') ?? 'unreachable'}
          {overview.network === 'testnet' && pastFork && <span className="ml-2 text-xs text-verified">Proto active</span>}
        </p>
      </div>
    </div>
  );
}

export default function TreasuryPage() {
  const { data, error, isLoading } = useApi<OverviewDto>('/api/overview', { refreshInterval: 20_000 });

  return (
    <>
      <PageHeader
        index="01"
        title="Confidential treasury"
        lede="Balances live in RingCT outputs, not on a public explorer. Everything below is visible only to this workspace."
        aside={data && <ChainStatus overview={data} />}
      />
      {error && <Notice tone="error">{errorMessage(error)}</Notice>}
      {isLoading && !data && <p className="text-sm text-ink-3">Loading treasury…</p>}
      {data && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
            <Panel
              kicker="Treasury wallet"
              title={data.network === 'mock-devnet' ? 'tesoreria.bdx' : 'Wallet-RPC sidecar'}
              tone="raised"
              action={data.treasury && <HashChip value={data.treasury.address} />}
            >
              {data.treasuryError && <Notice tone="warning">{data.treasuryError}</Notice>}
              {data.treasury && (
                <ul className="divide-y divide-rule" data-testid="treasury-balances">
                  {data.treasury.balances.map((balance) => (
                    <li key={balance.tokenId} className="flex items-baseline justify-between gap-4 py-3">
                      <div>
                        <p className="font-medium text-ink">{balance.ticker}</p>
                        <p className="text-xs text-ink-3">{balance.isNativeBdx ? 'Native coin' : balance.name}</p>
                      </div>
                      <Amount value={balance.amount} ticker={balance.ticker} className="text-xl" />
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
            {data.telemetry ? (
              <TelemetryCards overview={data} />
            ) : (
              <Notice tone="info">Telemetry is visible to the treasury operator only.</Notice>
            )}
          </div>
          <Panel kicker="Active capability matrix" title="Which rail signs what">
            <CapabilityMatrix rows={data.capabilityMatrix} />
            {data.network === 'testnet' && !data.testnetConfigured && (
              <Notice tone="info" className="mt-4">
                Public testnet data comes from the explorer. Configure BELDEX_WALLET_RPC_URL to enable the enterprise sidecar for payroll, Privacy Tokens and tx-key receipts.
              </Notice>
            )}
          </Panel>
        </div>
      )}
    </>
  );
}
