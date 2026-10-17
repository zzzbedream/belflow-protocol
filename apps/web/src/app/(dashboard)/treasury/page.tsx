'use client';

import { BDX_DECIMALS, formatUnits } from '@belflow/sdk';
import { Radio } from 'lucide-react';
import { CapabilityMatrix } from '@/components/dashboard/CapabilityMatrix';
import { FeeRace } from '@/components/kinetic/FeeRace';
import { Reactor } from '@/components/kinetic/Reactor';
import { PageHeader } from '@/components/shell/PageHeader';
import { Amount } from '@/components/ui/Amount';
import { HashChip } from '@/components/ui/HashChip';
import { Notice } from '@/components/ui/Notice';
import { Panel } from '@/components/ui/Panel';
import { errorMessage } from '@/lib/api';
import { formatGrouped } from '@/lib/format';
import type { ActivityKind, OverviewDto } from '@/lib/types';
import { useApi } from '@/lib/useApi';

const BURN_LABELS: Record<ActivityKind, string> = {
  PAYROLL: 'Flash payroll',
  TOKEN_DEPLOY: 'Token emission',
  X402: 'x402 agents',
  INVOICE: 'Invoices',
  BNS: 'BNS',
};

function Telemetry({ overview }: { overview: OverviewDto }) {
  const telemetry = overview.telemetry;
  if (!telemetry) return <Notice tone="info">Telemetry is visible to the treasury operator only.</Notice>;
  const bdx = (atomic: string) => formatUnits(BigInt(atomic), BDX_DECIMALS, 4);
  const breakdown = (Object.keys(BURN_LABELS) as ActivityKind[]).map((kind) => ({ label: BURN_LABELS[kind], value: bdx(telemetry.burnedByKind[kind] ?? '0') }));
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      <Reactor burnedBdx={formatGrouped(bdx(telemetry.burnedTotalAtomic))} txCount={telemetry.txCount} rails={overview.capabilityMatrix} breakdown={breakdown} />
      <FeeRace telemetry={telemetry} tokens={overview.tokens} />
    </div>
  );
}

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
      <PageHeader index="01" title="Confidential treasury" aside={data && <ChainStatus overview={data} />} />
      {error && <Notice tone="error">{errorMessage(error)}</Notice>}
      {isLoading && !data && <p className="text-sm text-ink-3">Loading treasury…</p>}
      {data && (
        <div className="space-y-6">
          <Telemetry overview={data} />
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
            <Panel
              kicker={data.network === 'mock-devnet' ? 'tesoreria.bdx' : 'Wallet-RPC sidecar'}
              tone="raised"
              action={data.treasury && <HashChip value={data.treasury.address} />}
            >
              {data.treasuryError && <Notice tone="warning">{data.treasuryError}</Notice>}
              {data.treasury && (
                <ul className="flex flex-wrap gap-2" data-testid="treasury-balances">
                  {data.treasury.balances.map((balance) => (
                    <li key={balance.tokenId} className="flex items-baseline gap-2 rounded-full border border-rule bg-paper-2 px-3 py-1.5" title={balance.isNativeBdx ? 'Native coin' : balance.name}>
                      <Amount value={balance.amount} ticker={balance.ticker} className="text-base" />
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
            <Panel kicker="Which rail signs what">
              <CapabilityMatrix rows={data.capabilityMatrix} />
              {data.network === 'testnet' && !data.testnetConfigured && (
                <Notice tone="info" className="mt-4">Explorer data only. Set BELDEX_WALLET_RPC_URL for payroll, tokens and tx-key receipts.</Notice>
              )}
            </Panel>
          </div>
        </div>
      )}
    </>
  );
}
