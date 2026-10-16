'use client';

import { BDX_DECIMALS, formatUnits } from '@belflow/sdk';
import { animate, stagger } from 'animejs';
import { formatGrouped } from '@/lib/format';
import {
  BELDEX_SHIELDING_BPS,
  ECONOMICS_SOURCES,
  RAILGUN_PROTOCOL_ROUND_TRIP_BPS,
  RAILGUN_WITH_RELAYER_BPS,
  isUsdStable,
  zkPoolCostAtomic,
} from '@/lib/economics';
import type { OverviewDto } from '@/lib/types';
import { useAnimeScope } from './useAnimeScope';

type Telemetry = NonNullable<OverviewDto['telemetry']>;

const BARS = [
  { key: 'beldex', label: 'Beldex native', bps: BELDEX_SHIELDING_BPS, tone: 'bg-vault', note: 'private by default' },
  { key: 'railgun', label: 'EVM ZK-pool', bps: RAILGUN_PROTOCOL_ROUND_TRIP_BPS, tone: 'bg-ink-3', note: '25 shield + 25 unshield' },
  { key: 'relayer', label: '+ relayer', bps: RAILGUN_WITH_RELAYER_BPS, tone: 'bg-rule-strong', note: 'assumed' },
] as const;

const MAX_BPS = RAILGUN_WITH_RELAYER_BPS;

/** Privacy cost race: Beldex's 0 bps stub against EVM shield/unshield fees. */
export function FeeRace({ telemetry, tokens }: { telemetry: Telemetry; tokens: OverviewDto['tokens'] }) {
  const ref = useAnimeScope<HTMLElement>(
    ({ ms }) => {
      animate('.fee-bar', { scaleY: [0, 1], duration: ms(1200), delay: stagger(160), ease: 'outElastic(1, .7)' });
    },
    [],
  );

  const savings = tokens
    .filter((token) => isUsdStable(token.ticker))
    .map((token) => {
      const volume = BigInt(telemetry.volumeByToken[token.tokenId] ?? '0');
      return { token, low: zkPoolCostAtomic(volume, RAILGUN_PROTOCOL_ROUND_TRIP_BPS) };
    })
    .filter((row) => row.low > 0n);

  return (
    <article ref={ref} className="rounded-[14px] border border-rule bg-paper p-5 shadow-[var(--shadow)]" data-testid="savings-card">
      <p className="figures text-[0.62rem] uppercase tracking-[0.2em] text-ink-3">Privacy cost · round trip</p>
      <div className="mt-4 flex h-40 items-end gap-4" role="img" aria-label={`Beldex ${BELDEX_SHIELDING_BPS} bps versus ${RAILGUN_PROTOCOL_ROUND_TRIP_BPS} bps on an EVM ZK-pool`}>
        {BARS.map((bar) => (
          <div key={bar.key} className="flex h-full flex-1 flex-col justify-end gap-1.5 text-center">
            <p className="figures text-lg text-ink">{bar.bps} bps</p>
            <div
              className={`fee-bar origin-bottom rounded-t-[6px] ${bar.tone}`}
              style={{ height: `${Math.max(4, (bar.bps / MAX_BPS) * 100)}%` }}
              aria-hidden
            />
            <p className="text-[0.68rem] leading-tight text-ink-2">{bar.label}</p>
            <p className="figures text-[0.58rem] uppercase tracking-[0.1em] text-ink-3">{bar.note}</p>
          </div>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-rule pt-3 text-xs">
        {savings.map((row) => (
          <span key={row.token.tokenId} className="figures rounded-full bg-verified-soft px-2.5 py-0.5 text-verified">
            saved ≥ {formatGrouped(formatUnits(row.low, row.token.decimals, 2))} {row.token.ticker}
          </span>
        ))}
        <span className="figures rounded-full bg-paper-2 px-2.5 py-0.5 text-ink-2">fees {formatUnits(BigInt(telemetry.feesTotalAtomic), BDX_DECIMALS, 4)} BDX</span>
        {ECONOMICS_SOURCES.map((source) => (
          <a key={source.url} href={source.url} target="_blank" rel="noopener noreferrer" className="figures text-[0.62rem] text-ink-3 underline decoration-rule-strong underline-offset-2 hover:text-ink">
            {source.label}
          </a>
        ))}
      </div>
    </article>
  );
}
