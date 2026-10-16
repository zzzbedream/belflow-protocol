'use client';

import { animate, createTimeline, svg } from 'animejs';
import { cn } from '@/components/ui/cn';
import { useAnimeScope } from './useAnimeScope';

export type CircuitOutcome = 'idle' | 'running' | 'ok' | 'blocked';

interface LaserCircuitProps {
  outcome: CircuitOutcome;
  /** Steps the real trace reached; the replay never shows more than happened. */
  steps: { challenge: boolean; paid: boolean };
  /** Shown on the red lock, e.g. "asset_mismatch". */
  blockReason?: string;
  /** Changes on every run so the replay restarts. */
  runKey: number;
}

const NODES = {
  agent: { x: 70, y: 200, label: 'alpha-bot.bdx', sub: 'AI agent' },
  api: { x: 490, y: 200, label: 'Protected API', sub: 'HTTP 402' },
  quorum: { x: 280, y: 52, label: 'Flash quorum', sub: 'masternodes · 0-conf' },
} as const;

const PATHS = {
  request: `M ${NODES.agent.x + 26} ${NODES.agent.y - 6} L ${NODES.api.x - 26} ${NODES.api.y - 6}`,
  challenge: `M ${NODES.api.x - 26} ${NODES.api.y + 8} L ${NODES.agent.x + 26} ${NODES.agent.y + 8}`,
  flash: `M ${NODES.agent.x + 18} ${NODES.agent.y - 22} L ${NODES.quorum.x - 22} ${NODES.quorum.y + 16}`,
  settle: `M ${NODES.quorum.x + 22} ${NODES.quorum.y + 16} L ${NODES.api.x - 18} ${NODES.api.y - 22}`,
};

const STEP_LABELS = [
  { key: 'request', text: '1 · GET /api/x402/demo' },
  { key: 'challenge', text: '2 · 402 + nonce' },
  { key: 'flash', text: '3 · Flash tx · priority 5' },
  { key: 'settle', text: '4 · verify → 200' },
] as const;

/**
 * Machine-to-machine payment as a laser circuit. After each run it replays
 * the real trace: request pulse, amber 402 shield, Flash shot through the
 * quorum (the surcharge burns), then a green unlock or a red lock.
 */
export function LaserCircuit({ outcome, steps, blockReason, runKey }: LaserCircuitProps) {
  const ref = useAnimeScope<HTMLDivElement>(
    ({ ms, isReduced }) => {
      if (outcome === 'running' && !isReduced) {
        animate('.lc-node-agent', { scale: [1, 1.12, 1], duration: 700, loop: true, ease: 'inOutSine' });
        animate(svg.createDrawable('.lc-path-request'), { draw: ['0 0', '0 1', '1 1'], duration: 900, loop: true, ease: 'inOutQuad' });
        return;
      }
      if (outcome === 'idle') return;
      const timeline = createTimeline({ defaults: { duration: ms(520), ease: 'inOutQuad' } });
      const shoot = (key: keyof typeof PATHS) => {
        timeline.add(svg.createDrawable(`.lc-path-${key}`), { draw: ['0 0', '0 1'] });
        if (!isReduced) timeline.add(`.lc-spark-${key}`, { ...svg.createMotionPath(`.lc-path-${key}`), opacity: [1, 0], duration: ms(420) }, '<<');
        timeline.add(`.lc-step-${key}`, { opacity: [0.3, 1], translateY: [4, 0], duration: ms(240) }, '<<');
      };
      shoot('request');
      if (steps.challenge) {
        shoot('challenge');
        timeline.add('.lc-shield', { scale: [0, 1], opacity: [0, 1], duration: ms(500), ease: 'outBack(2.5)' }, '<');
      }
      if (steps.paid) {
        shoot('flash');
        timeline.add('.lc-burn', { scale: [0.2, 1.4, 1], opacity: [0, 1], duration: ms(600), ease: 'outExpo' }, '<');
        shoot('settle');
      }
      if (outcome === 'ok') timeline.add('.lc-unlock', { scale: [0, 1], opacity: [0, 1], duration: ms(700), ease: 'outElastic(1, .5)' });
      if (outcome === 'blocked') timeline.add('.lc-lock', { scale: [1.8, 1], opacity: [0, 1], duration: ms(700), ease: 'outElastic(1, .4)' });
    },
    [outcome, runKey, steps.challenge, steps.paid],
  );

  const final = outcome === 'ok' ? 'var(--verified)' : outcome === 'blocked' ? 'var(--danger)' : 'currentColor';

  return (
    <div ref={ref} className="relative overflow-hidden rounded-[12px] border border-ink bg-ink text-paper" data-testid="laser-circuit" data-outcome={outcome}>
      <div className="kinetic-grid pointer-events-none absolute inset-0 opacity-40" aria-hidden />
      <svg viewBox="0 0 560 250" className="relative block h-auto w-full" role="img" aria-label="x402 payment circuit between the agent, the protected API and the Flash quorum">
        {Object.entries(PATHS).map(([key, d]) => (
          <g key={key}>
            <path d={d} fill="none" stroke="currentColor" strokeOpacity={0.12} strokeWidth={2} />
            <path
              className={`lc-path-${key}`}
              d={d}
              fill="none"
              stroke={key === 'flash' || key === 'challenge' ? 'var(--flash)' : key === 'settle' ? final : 'var(--vault)'}
              strokeWidth={3}
              strokeLinecap="round"
              style={{ strokeDasharray: 1, strokeDashoffset: outcome === 'idle' ? 1 : 0 }}
              pathLength={1}
            />
            <circle className={`lc-spark-${key}`} r={5} fill={key === 'flash' ? 'var(--flash)' : 'var(--paper)'} opacity={0} />
          </g>
        ))}
        {(Object.keys(NODES) as Array<keyof typeof NODES>).map((key) => {
          const node = NODES[key];
          return (
            <g key={key} transform={`translate(${node.x} ${node.y})`}>
              <circle className={cn(`lc-node-${key}`, 'kinetic-svg-origin')} r={24} fill="var(--paper-3)" fillOpacity={0.12} stroke={key === 'api' ? final : 'currentColor'} strokeOpacity={0.7} strokeWidth={2} />
              <text y={44} textAnchor="middle" fontSize={13} fill="currentColor" className="figures">
                {node.label}
              </text>
              <text y={60} textAnchor="middle" fontSize={10} fill="currentColor" opacity={0.55}>
                {node.sub}
              </text>
            </g>
          );
        })}
        <g transform={`translate(${NODES.api.x} ${NODES.api.y})`}>
          <path className="lc-shield kinetic-svg-origin" d="M0 -14 L11 -9 L11 1 C11 8 5 12 0 14 C-5 12 -11 8 -11 1 L-11 -9 Z" fill="var(--flash)" opacity={0} />
          <path className="lc-unlock kinetic-svg-origin" d="M-7 0 L-2 6 L8 -6" fill="none" stroke="var(--verified)" strokeWidth={4} strokeLinecap="round" opacity={0} />
          <g className="lc-lock kinetic-svg-origin" opacity={0}>
            <rect x={-9} y={-3} width={18} height={14} rx={3} fill="var(--danger)" />
            <path d="M-5 -3 V-7 A5 5 0 0 1 5 -7 V-3" fill="none" stroke="var(--danger)" strokeWidth={3} />
          </g>
        </g>
        <circle className="lc-burn kinetic-svg-origin" cx={NODES.quorum.x} cy={NODES.quorum.y} r={30} fill="none" stroke="var(--flash)" strokeWidth={2} opacity={0} />
      </svg>
      <ol className="relative flex flex-wrap gap-x-4 gap-y-1 border-t border-paper/10 px-4 py-2 text-[0.68rem]">
        {STEP_LABELS.map((step) => (
          <li key={step.key} className={cn(`lc-step-${step.key}`, 'figures', outcome === 'idle' ? 'opacity-30' : 'opacity-90')}>
            {step.text}
          </li>
        ))}
        {outcome === 'blocked' && <li className="figures font-semibold text-danger">✕ {blockReason ?? 'refused'}</li>}
      </ol>
    </div>
  );
}
