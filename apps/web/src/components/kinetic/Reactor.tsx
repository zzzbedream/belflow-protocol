'use client';

import { animate, stagger, type Target } from 'animejs';
import { Flame } from 'lucide-react';
import { cn } from '@/components/ui/cn';
import type { CapabilityRow } from '@/lib/types';
import { TweenNumber } from './TweenNumber';
import { useAnimeScope } from './useAnimeScope';

const SIZE = 440;
const CENTER = SIZE / 2;
const RINGS = [190, 150, 110];
const PARTICLES = 18;
const SATELLITE_RADIUS = 190;

interface ReactorProps {
  burnedBdx: string;
  txCount: number;
  rails: CapabilityRow[];
  breakdown: Array<{ label: string; value: string }>;
}

/** Point on a circle around the reactor core; angle in degrees, 0 = top. */
function orbit(radius: number, degrees: number) {
  const radians = ((degrees - 90) * Math.PI) / 180;
  return { x: CENTER + radius * Math.cos(radians), y: CENTER + radius * Math.sin(radians) };
}

/**
 * Overview "reactor": the BDX burned by Flash surcharges sits in the core,
 * particles fall into it, and the three signing rails orbit as satellites.
 */
export function Reactor({ burnedBdx, txCount, rails, breakdown }: ReactorProps) {
  const ref = useAnimeScope<HTMLDivElement>(
    ({ ms, isReduced }) => {
      if (isReduced) return;
      animate('.reactor-ring', { rotate: (_?: Target, i = 0) => (i % 2 ? -360 : 360), duration: (_?: Target, i = 0) => 40_000 + i * 12_000, ease: 'linear', loop: true });
      animate('.reactor-particle', {
        r: [0, 3.5, 0],
        opacity: [0, 1, 0],
        translateX: (el?: Target) => [Number((el as SVGElement).dataset.dx), 0],
        translateY: (el?: Target) => [Number((el as SVGElement).dataset.dy), 0],
        duration: ms(2600),
        delay: stagger(140),
        ease: 'inQuad',
        loop: true,
      });
      animate('.reactor-core', { scale: [1, 1.06, 1], duration: ms(2200), ease: 'inOutSine', loop: true });
      animate('.reactor-satellite-on', { opacity: [0.55, 1], duration: ms(1100), ease: 'inOutSine', alternate: true, loop: true });
    },
    [rails.length],
  );

  const particles = Array.from({ length: PARTICLES }, (_, i) => {
    // Deterministic jitter: the SVG is server-rendered, so no randomness here.
    const angle = (360 / PARTICLES) * i + ((i * 37) % 17) - 8;
    const start = orbit(RINGS[0] ?? 190, angle);
    return { key: i, dx: start.x - CENTER, dy: start.y - CENTER };
  });

  return (
    <article ref={ref} className="relative overflow-hidden rounded-[14px] border border-rule bg-ink text-paper shadow-[var(--shadow)]" data-testid="burn-card">
      <div className="kinetic-grid pointer-events-none absolute inset-0 opacity-40" aria-hidden />
      <div className="relative grid gap-4 p-5 md:grid-cols-[minmax(0,1fr)_minmax(0,0.75fr)] md:items-center">
        <div className="relative mx-auto aspect-square w-full max-w-[440px]">
          <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="absolute inset-0 size-full" role="img" aria-label="Flash surcharges flowing into the burn reactor">
            <defs>
              <radialGradient id="reactor-glow">
                <stop offset="0%" stopColor="var(--flash)" stopOpacity="0.55" />
                <stop offset="70%" stopColor="var(--flash)" stopOpacity="0" />
              </radialGradient>
            </defs>
            <circle cx={CENTER} cy={CENTER} r={96} fill="url(#reactor-glow)" className="reactor-core" style={{ transformOrigin: 'center', transformBox: 'fill-box' }} />
            {RINGS.map((radius, i) => (
              <g key={radius} className="reactor-ring" style={{ transformOrigin: `${CENTER}px ${CENTER}px` }}>
                <circle cx={CENTER} cy={CENTER} r={radius} fill="none" stroke="currentColor" strokeOpacity={0.18 + i * 0.06} strokeDasharray={i === 1 ? '2 10' : '1 5'} />
                <circle cx={CENTER + radius} cy={CENTER} r={2.5} fill="var(--vault)" />
              </g>
            ))}
            {particles.map((p) => (
              <circle key={p.key} className="reactor-particle" cx={CENTER} cy={CENTER} r={0} fill="var(--flash)" data-dx={p.dx} data-dy={p.dy} />
            ))}
            {rails.map((rail, i) => {
              const point = orbit(SATELLITE_RADIUS, 210 + i * 60);
              return (
                <g key={rail.kind} className={rail.active ? 'reactor-satellite-on' : undefined}>
                  <circle cx={point.x} cy={point.y} r={7} fill={rail.active ? 'var(--verified)' : 'var(--rule-strong)'} />
                  <circle cx={point.x} cy={point.y} r={13} fill="none" stroke={rail.active ? 'var(--verified)' : 'var(--rule-strong)'} strokeOpacity={0.5} />
                </g>
              );
            })}
          </svg>
          <div className="absolute inset-0 grid place-items-center text-center">
            <div>
              <Flame className="mx-auto size-5 text-flash" aria-hidden />
              <p className="figures mt-1 text-[0.6rem] uppercase tracking-[0.22em] text-paper/60">Total BDX burned</p>
              <p className="figures text-[clamp(1.5rem,1rem+1.2vw,2.1rem)] font-medium tracking-tight">
                <TweenNumber value={burnedBdx} />
              </p>
              <p className="figures text-[0.62rem] text-paper/50">{txCount} tx · flash surcharge</p>
            </div>
          </div>
        </div>
        <div className="space-y-4">
          <ul className="space-y-1.5" aria-label="Signing rails">
            {rails.map((rail) => (
              <li key={rail.kind} className={cn('flex items-center gap-2 rounded-full border px-3 py-1 text-xs', rail.active ? 'border-verified/60 text-paper' : 'border-paper/15 text-paper/50')}>
                <span className={cn('size-1.5 rounded-full', rail.active ? 'bg-verified' : 'bg-paper/30')} aria-hidden />
                {rail.label}
                {rail.active && <span className="figures ml-auto text-[0.58rem] uppercase tracking-[0.14em] text-verified">live</span>}
              </li>
            ))}
          </ul>
          <ul className="space-y-1 border-t border-paper/15 pt-3 text-xs" aria-label="Burn by activity">
            {breakdown.map((part) => (
              <li key={part.label} className="flex justify-between gap-3">
                <span className="text-paper/60">{part.label}</span>
                <span className="figures">{part.value}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </article>
  );
}
