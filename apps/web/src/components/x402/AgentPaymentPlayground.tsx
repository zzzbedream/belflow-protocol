'use client';

import { Bot, CircleAlert, Play, ShieldCheck, Terminal, Zap } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { cn } from '@/components/ui/cn';
import { Field, Input } from '@/components/ui/Field';
import { HashChip } from '@/components/ui/HashChip';
import { Notice } from '@/components/ui/Notice';
import { apiPost, errorMessage } from '@/lib/api';
import { useBeldexStore } from '@/store/useBeldexStore';

interface TraceEvent {
  at: number;
  type: 'request' | 'challenge' | 'policy-approved' | 'paid' | 'retry' | 'response' | 'error' | 'funded';
  detail: Record<string, string | number | boolean>;
}

interface AgentRun {
  agentBns: string;
  tokenTicker: string;
  spent: string;
  trace: TraceEvent[];
  responses: unknown[];
}

const STEP_STYLE: Record<TraceEvent['type'], { label: string; tone: string; icon: typeof Bot }> = {
  request: { label: 'GET', tone: 'text-ink-2', icon: Terminal },
  challenge: { label: '402 Payment Required', tone: 'text-flash', icon: CircleAlert },
  'policy-approved': { label: 'Spend policy approved', tone: 'text-vault', icon: ShieldCheck },
  paid: { label: 'Flash payment broadcast', tone: 'text-flash', icon: Zap },
  retry: { label: 'Retry with X-Beldex-Payment-Proof', tone: 'text-ink-2', icon: Terminal },
  response: { label: 'Response', tone: 'text-verified', icon: ShieldCheck },
  error: { label: 'Refused', tone: 'text-danger', icon: CircleAlert },
  funded: { label: 'Treasury funded agent wallet', tone: 'text-vault', icon: Bot },
};

function TraceLine({ event, start }: { event: TraceEvent; start: number }) {
  const style = STEP_STYLE[event.type];
  const Icon = style.icon;
  const status = event.type === 'response' ? Number(event.detail.status) : null;
  return (
    <li className="animate-rise grid grid-cols-[3.5rem_1.25rem_1fr] items-start gap-2 py-1.5">
      <span className="figures text-[0.68rem] text-paper/40">+{event.at - start}ms</span>
      <Icon className={cn('mt-0.5 size-3.5', style.tone, status !== null && status >= 400 && 'text-danger')} aria-hidden />
      <div className="min-w-0">
        <p className={cn('text-[0.8rem]', style.tone, status !== null && status >= 400 && 'text-danger')}>
          {style.label}
          {status !== null && ` ${status}`}
        </p>
        <div className="figures mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[0.68rem] text-paper/60">
          {Object.entries(event.detail).map(([key, value]) =>
            key === 'txHash' ? (
              <span key={key}>
                tx <HashChip value={String(value)} className="border-paper/20 bg-paper/10 text-paper/80" />
              </span>
            ) : (
              <span key={key} className="[overflow-wrap:anywhere]">
                {key}={String(value)}
              </span>
            ),
          )}
        </div>
      </div>
    </li>
  );
}

/** Interactive x402 console: an AI agent with a BNS identity pays for an API call. */
export function AgentPaymentPlayground({ price, onRun }: { price?: { amount: string; token: string }; onRun: () => void }) {
  const network = useBeldexStore((state) => state.network);
  const [maxPerCall, setMaxPerCall] = useState('1');
  const [budget, setBudget] = useState('2');
  const [calls, setCalls] = useState(1);
  const [run, setRun] = useState<AgentRun | null>(null);
  const [rawStatus, setRawStatus] = useState<{ status: number; headers: Array<[string, string]> } | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const probe = async () => {
    setError(null);
    try {
      const response = await fetch(`/api/x402/demo?network=${network}`, { cache: 'no-store' });
      const headers = [...response.headers.entries()].filter(([key]) => key.startsWith('x-beldex'));
      setRawStatus({ status: response.status, headers });
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const launch = async () => {
    setIsBusy(true);
    setError(null);
    setRun(null);
    try {
      setRun(await apiPost<AgentRun>('/api/x402/agent', { network, calls, maxPerCall, budget, useFlash: true }));
      onRun();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setIsBusy(false);
    }
  };

  const start = run?.trace[0]?.at ?? 0;
  const lastResponse = run?.responses.at(-1);

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
      <div className="space-y-5">
        <div className="flex items-center gap-3 rounded-[10px] border border-rule bg-paper-2 p-4">
          <div className="grid size-11 place-items-center rounded-full bg-ink text-paper">
            <Bot className="size-5" aria-hidden />
          </div>
          <div>
            <p className="font-semibold text-ink">alpha-bot.bdx</p>
            <p className="text-xs text-ink-3">
              Autonomous agent · pays {price ? `${price.amount} ${price.token}` : '…'} per call with Flash
            </p>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Max per call" htmlFor="max">
            <Input id="max" inputMode="decimal" value={maxPerCall} onChange={(e) => setMaxPerCall(e.target.value)} />
          </Field>
          <Field label="Budget" htmlFor="budget">
            <Input id="budget" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} />
          </Field>
          <Field label="Calls" htmlFor="calls">
            <Input id="calls" type="number" min={1} max={5} value={calls} onChange={(e) => setCalls(Math.min(5, Math.max(1, Number(e.target.value) || 1)))} />
          </Field>
        </div>
        <p className="text-xs text-ink-3">The agent refuses to pay above its cap, beyond its budget or to a payee not on its BNS allowlist (oracle-provider.bdx).</p>
        <div className="flex flex-wrap gap-2">
          <Button onClick={launch} disabled={isBusy} variant="vault" size="lg" data-testid="run-agent">
            <Play className="size-4" aria-hidden /> {isBusy ? 'Agent paying…' : 'Run agent'}
          </Button>
          <Button onClick={probe} variant="outline" size="lg">
            Raw request
          </Button>
        </div>
        {rawStatus && (
          <div className="rounded-[8px] border border-rule bg-paper-2 p-3 text-xs" data-testid="raw-402">
            <p className="figures font-medium text-flash">HTTP {rawStatus.status}</p>
            <ul className="figures mt-2 space-y-0.5 text-ink-2">
              {rawStatus.headers.map(([key, value]) => (
                <li key={key} className="[overflow-wrap:anywhere]">
                  {key}: {value}
                </li>
              ))}
            </ul>
          </div>
        )}
        {error && <Notice tone="error">{error}</Notice>}
      </div>

      <div className="min-w-0 rounded-[12px] border border-ink bg-ink p-4 text-paper shadow-[var(--shadow)]" data-testid="agent-trace">
        <p className="figures flex items-center justify-between text-[0.66rem] uppercase tracking-[0.18em] text-paper/50">
          <span>agent trace</span>
          {run && <span>spent {run.spent} {run.tokenTicker}</span>}
        </p>
        {!run && <p className="mt-6 text-sm text-paper/50">Run the agent to watch the 402 → pay → 200 handshake.</p>}
        {run && (
          <ol className="mt-3 divide-y divide-paper/10">
            {run.trace.map((event, index) => (
              <TraceLine key={`${event.at}-${index}`} event={event} start={start} />
            ))}
          </ol>
        )}
        {lastResponse != null && (
          <pre className="figures mt-4 max-h-64 overflow-auto rounded-[8px] bg-paper/5 p-3 text-[0.68rem] leading-relaxed text-paper/80">
            {JSON.stringify(lastResponse, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}
