'use client';

import { BDX_DECIMALS, formatUnits } from '@belflow/sdk';
import { Flame, Scale } from 'lucide-react';
import { formatGrouped } from '@/lib/format';
import {
  BELDEX_SHIELDING_BPS,
  ECONOMICS_SOURCES,
  RAILGUN_PROTOCOL_ROUND_TRIP_BPS,
  RAILGUN_REPORTED_LOCK_MINUTES,
  RAILGUN_WITH_RELAYER_BPS,
  isUsdStable,
  zkPoolCostAtomic,
} from '@/lib/economics';
import type { ActivityKind, OverviewDto } from '@/lib/types';

const BURN_LABELS: Record<ActivityKind, string> = {
  PAYROLL: 'Flash payroll',
  TOKEN_DEPLOY: 'Token emission',
  X402: 'x402 agent calls',
  INVOICE: 'Invoices',
  BNS: 'BNS',
};

type Telemetry = NonNullable<OverviewDto['telemetry']>;

function BurnCard({ telemetry }: { telemetry: Telemetry }) {
  const total = BigInt(telemetry.burnedTotalAtomic);
  const parts = (Object.keys(BURN_LABELS) as ActivityKind[]).map((kind) => ({ kind, value: BigInt(telemetry.burnedByKind[kind] ?? '0') }));
  return (
    <article className="relative overflow-hidden rounded-[10px] border border-rule bg-ink p-5 text-paper shadow-[var(--shadow)]" data-testid="burn-card">
      <Flame className="absolute -right-4 -top-4 size-28 text-flash opacity-15" aria-hidden />
      <p className="figures text-[0.66rem] uppercase tracking-[0.2em] text-paper/60">Total BDX burned</p>
      <p className="figures mt-2 break-all text-[clamp(1.6rem,1rem+1.4vw,2.2rem)] font-medium tracking-tight">
        {formatGrouped(formatUnits(total, BDX_DECIMALS, 4))}
        <span className="ml-1.5 text-base text-paper/60">BDX</span>
      </p>
      <ul className="mt-4 space-y-1.5 border-t border-paper/15 pt-3 text-xs">
        {parts.map(({ kind, value }) => (
          <li key={kind} className="flex justify-between gap-3">
            <span className="text-paper/65">{BURN_LABELS[kind]}</span>
            <span className="figures">{formatUnits(value, BDX_DECIMALS, 4)}</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[0.68rem] leading-snug text-paper/50">
        {telemetry.txCount} transactions observed by this workspace. Flash surcharges are removed from supply.
      </p>
    </article>
  );
}

function SavingsCard({ telemetry, tokens }: { telemetry: Telemetry; tokens: OverviewDto['tokens'] }) {
  const stable = tokens.filter((token) => isUsdStable(token.ticker));
  const rows = stable.map((token) => {
    const volume = BigInt(telemetry.volumeByToken[token.tokenId] ?? '0');
    return {
      token,
      volume,
      low: zkPoolCostAtomic(volume, RAILGUN_PROTOCOL_ROUND_TRIP_BPS),
      high: zkPoolCostAtomic(volume, RAILGUN_WITH_RELAYER_BPS),
    };
  });
  const fees = BigInt(telemetry.feesTotalAtomic);
  return (
    <article className="rounded-[10px] border border-rule bg-paper p-5 shadow-[var(--shadow)]" data-testid="savings-card">
      <div className="flex items-center justify-between">
        <p className="figures text-[0.66rem] uppercase tracking-[0.2em] text-ink-3">Privacy cost vs. EVM ZK-pools</p>
        <Scale className="size-4 text-vault" aria-hidden />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <div className="rounded-[8px] bg-vault-soft p-3">
          <p className="text-[0.7rem] text-ink-2">Beldex shielding</p>
          <p className="figures text-2xl text-vault">{BELDEX_SHIELDING_BPS} bps</p>
          <p className="text-[0.68rem] text-ink-3">private by default · no pool lock</p>
        </div>
        <div className="rounded-[8px] bg-paper-2 p-3">
          <p className="text-[0.7rem] text-ink-2">Railgun round trip</p>
          <p className="figures text-2xl text-ink">
            {RAILGUN_PROTOCOL_ROUND_TRIP_BPS}–{RAILGUN_WITH_RELAYER_BPS} bps
          </p>
          <p className="text-[0.68rem] text-ink-3">+ ~{RAILGUN_REPORTED_LOCK_MINUTES} min reported shield lock</p>
        </div>
      </div>
      <ul className="mt-4 space-y-2 border-t border-rule pt-3 text-sm">
        {rows.length === 0 && <li className="text-xs text-ink-3">Deploy a USD Privacy Token and run a payroll to measure savings.</li>}
        {rows.map((row) => (
          <li key={row.token.tokenId} className="flex flex-wrap items-baseline justify-between gap-x-3">
            <span className="text-ink-2">
              Saved on {formatGrouped(formatUnits(row.volume, row.token.decimals, 2))} {row.token.ticker}
            </span>
            <span className="figures text-verified">
              {formatGrouped(formatUnits(row.low, row.token.decimals, 2))}–{formatGrouped(formatUnits(row.high, row.token.decimals, 2))} {row.token.ticker}
            </span>
          </li>
        ))}
        <li className="flex justify-between gap-3 text-xs text-ink-3">
          <span>Beldex network fees paid</span>
          <span className="figures">{formatUnits(fees, BDX_DECIMALS, 4)} BDX</span>
        </li>
      </ul>
      <p className="mt-3 text-[0.66rem] leading-snug text-ink-3">
        50 bps = 0.25% shield + 0.25% unshield protocol fees; 75 bps adds an assumed relayer fee; the lock is unverified.{' '}
        {ECONOMICS_SOURCES.map((source, index) => (
          <span key={source.url}>
            {index > 0 && ' · '}
            <a href={source.url} target="_blank" rel="noopener noreferrer" className="underline decoration-rule-strong underline-offset-2 hover:text-ink">
              {source.label}
            </a>
          </span>
        ))}
      </p>
    </article>
  );
}

export function TelemetryCards({ overview }: { overview: OverviewDto }) {
  if (!overview.telemetry) return null;
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
      <BurnCard telemetry={overview.telemetry} />
      <SavingsCard telemetry={overview.telemetry} tokens={overview.tokens} />
    </div>
  );
}
