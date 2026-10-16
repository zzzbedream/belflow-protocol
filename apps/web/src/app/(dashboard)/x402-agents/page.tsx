'use client';

import { PageHeader } from '@/components/shell/PageHeader';
import { Panel } from '@/components/ui/Panel';
import { AgentPaymentPlayground } from '@/components/x402/AgentPaymentPlayground';
import { useApi } from '@/lib/useApi';
import { useBeldexStore } from '@/store/useBeldexStore';

interface Metrics {
  challengesIssued: number;
  paidCalls: number;
  expired: number;
  distinctAgents: number;
  conversionRate: number;
  price: { amount: string; token: string; tokenId: string };
  recipient: string;
}

const STATS: Array<{ key: keyof Metrics; label: string; format?: (value: number) => string }> = [
  { key: 'challengesIssued', label: '402 challenges' },
  { key: 'paidCalls', label: 'Paid calls' },
  { key: 'conversionRate', label: 'Pay-through', format: (value) => `${Math.round(value * 100)}%` },
  { key: 'distinctAgents', label: 'Agents' },
  { key: 'expired', label: 'Expired nonces' },
];

export default function X402AgentsPage() {
  const refresh = useBeldexStore((state) => state.refresh);
  const { data: metrics } = useApi<Metrics>('/api/x402/metrics');

  return (
    <>
      <PageHeader
        index="06"
        title="x402 agent rails"
        lede="HTTP 402 · Flash 0-conf · private settlement"
      />
      <div className="space-y-6">
        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-[10px] border border-rule bg-rule sm:grid-cols-5" data-testid="x402-metrics">
          {STATS.map((stat) => {
            const value = metrics?.[stat.key];
            return (
              <div key={stat.key} className="bg-paper px-4 py-3">
                <dt className="figures text-[0.64rem] uppercase tracking-[0.14em] text-ink-3">{stat.label}</dt>
                <dd className="figures mt-1 text-2xl text-ink">{typeof value === 'number' ? (stat.format ? stat.format(value) : value) : '—'}</dd>
              </div>
            );
          })}
        </dl>
        <Panel kicker="Playground" title={`GET /api/x402/demo · ${metrics ? `${metrics.price.amount} ${metrics.price.token} to ${metrics.recipient}` : 'loading price…'}`} tone="raised">
          <AgentPaymentPlayground price={metrics ? { amount: metrics.price.amount, token: metrics.price.token } : undefined} onRun={refresh} />
        </Panel>
      </div>
    </>
  );
}
